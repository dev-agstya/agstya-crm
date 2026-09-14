"""Brokers — the brokerages/aggregators the agency places business through.

CRUD + a live short-code-availability check. A broker owns its rate card (see
rate_rules) and a TDS %, and is the finance counterparty for premium + reward.
Managed by users who can manage insurers (same admin persona). Never exposed to
channel partners — the rate card / TDS are internal to the agency.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AccountType, AuditAction
from app.core.permissions import MANAGE_BROKERS, VIEW_BROKERS
from app.models.base import utcnow
from app.models.broker import Broker
from app.models.user import User
from app.routers._helpers import parse_object_id, search_regex
from app.schemas.common import Message
from app.schemas.broker import (
    BrokerCreate,
    BrokerOut,
    BrokerUpdate,
    ShortCodeAvailability,
)
from app.services.audit import log_action
from app.services.codes import next_code
from app.services import references

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/brokers", tags=["brokers"],
                   dependencies=[Depends(get_inhouse_user)])


def _forbid_partner(actor: User) -> None:
    if actor.account_type == AccountType.CHANNEL_PARTNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Brokers are internal to the agency.")


async def _short_code_taken(short_code: str,
                            exclude_id: str | None = None) -> bool:
    existing = await Broker.find_one(Broker.short_code == short_code)
    return existing is not None and str(existing.id) != (exclude_id or "")


@router.get("", response_model=list[BrokerOut],
            dependencies=[Depends(require_permission(VIEW_BROKERS))])
async def list_brokers(
    q: str | None = Query(default=None),
    active_only: bool = Query(default=False),
    actor: User = Depends(get_active_user),
) -> list[BrokerOut]:
    _forbid_partner(actor)
    query: dict = {}
    if active_only:
        query["active"] = True
    if q:
        rx = search_regex(q)
        query["$or"] = [{"name": rx}, {"short_code": rx}]
    items = await Broker.find(query).sort("+name").to_list()
    # Which brokers anything points at — the page offers Delete only for the
    # ones where it would actually succeed.
    used = await references.brokers_in_use(str(b.id) for b in items)
    return [BrokerOut.from_model(b, in_use=str(b.id) in used) for b in items]


@router.get("/short-code-available", response_model=ShortCodeAvailability,
            dependencies=[Depends(require_permission(MANAGE_BROKERS))])
async def short_code_available(
    short_code: str = Query(min_length=2, max_length=20),
    exclude_id: str | None = Query(default=None),
    _: User = Depends(get_active_user),
) -> ShortCodeAvailability:
    normalized = short_code.strip().upper()
    return ShortCodeAvailability(
        short_code=normalized,
        available=not await _short_code_taken(normalized, exclude_id))


@router.get("/{broker_id}", response_model=BrokerOut,
            dependencies=[Depends(require_permission(VIEW_BROKERS))])
async def get_broker(broker_id: str,
                     actor: User = Depends(get_active_user)) -> BrokerOut:
    _forbid_partner(actor)
    broker = await Broker.get(await parse_object_id(broker_id))
    if broker is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Broker not found.")
    return BrokerOut.from_model(
        broker, in_use=references.in_use(await references.broker_refs(broker_id)))


@router.post("", response_model=BrokerOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_BROKERS))])
async def create_broker(payload: BrokerCreate,
                        actor: User = Depends(get_active_user)) -> BrokerOut:
    if await Broker.find_one(Broker.name == payload.name):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "A broker with this name already exists.")
    if await _short_code_taken(payload.short_code):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Broker short code '{payload.short_code}' is already in use.")

    broker = Broker(code=await next_code("broker"), created_by=str(actor.id),
                    **payload.model_dump())
    await broker.insert()
    await log_action(
        AuditAction.BROKER_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="broker", entity_id=str(broker.id), entity_code=broker.code,
        summary=f"Added broker {broker.name} ({broker.short_code})",
    )
    # Brand new: nothing can point at it yet.
    return BrokerOut.from_model(broker, in_use=False)


@router.patch("/{broker_id}", response_model=BrokerOut,
              dependencies=[Depends(require_permission(MANAGE_BROKERS))])
async def update_broker(broker_id: str, payload: BrokerUpdate,
                        actor: User = Depends(get_active_user)) -> BrokerOut:
    broker = await Broker.get(await parse_object_id(broker_id))
    if broker is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Broker not found.")

    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes and changes["name"] != broker.name:
        if await Broker.find_one(Broker.name == changes["name"]):
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "A broker with this name already exists.")
    if "short_code" in changes and changes["short_code"] != broker.short_code:
        if await _short_code_taken(changes["short_code"], exclude_id=broker_id):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Broker short code '{changes['short_code']}' is already in use.")
    for field, value in changes.items():
        setattr(broker, field, value)
    broker.updated_at = utcnow()
    await broker.save()
    await log_action(
        AuditAction.BROKER_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="broker", entity_id=str(broker.id), entity_code=broker.code,
        summary=f"Updated broker {broker.name}",
    )
    return BrokerOut.from_model(
        broker, in_use=references.in_use(await references.broker_refs(broker_id)))


@router.delete("/{broker_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_BROKERS))])
async def delete_broker(broker_id: str,
                        actor: User = Depends(get_active_user)) -> Message:
    """Permanently remove a broker that nothing points at.

    Whether this is allowed is decided by the LINKS, not by who is asking
    (owner 2026-07-26). A broker is the agency's finance counterparty as well as
    the rate-card owner, so the check covers policies, rate cards, TDS entries
    AND ledger rows — not just policies, which is all the old guard looked at.
    """
    broker = await Broker.get(await parse_object_id(broker_id))
    if broker is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Broker not found.")
    refs = await references.broker_refs(broker_id)
    if references.in_use(refs):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            references.blocked_message("broker", refs))
    name, code = broker.name, broker.code
    await broker.delete()
    await log_action(
        AuditAction.BROKER_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="broker", entity_id=broker_id, entity_code=code,
        summary=f"Permanently deleted unused broker {name}",
    )
    return Message(detail="Broker deleted.")
