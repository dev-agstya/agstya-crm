"""Rate rules — the reward rate card under a Broker.

CRUD for the rate card plus a `/preview` endpoint the policy form uses to show the
reward the engine would apply for a given scenario (Broker + policy type + insurer
company + chosen sub-type path): the most specific matching rate rule, with no other
fallback.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AccountType, AuditAction
from app.core.permissions import (
    MANAGE_RATE_CARDS, VIEW_POLICIES, VIEW_RATE_CARDS,
)
from app.models.base import utcnow
from app.models.broker import Broker
from app.models.rate_rule import RateRule
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.rate_rule import (
    RatePreview,
    RateRuleCreate,
    RateRuleOut,
    RateRuleUpdate,
)
from app.services.audit import log_action
from app.services.rates import find_rate_rule

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/rate-rules", tags=["rate-rules"],
                   dependencies=[Depends(get_inhouse_user)])


@router.get("", response_model=list[RateRuleOut],
            dependencies=[Depends(require_permission(VIEW_RATE_CARDS))])
async def list_rules(
    broker_id: str = Query(...),
    category_key: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> list[RateRuleOut]:
    if actor.account_type == AccountType.CHANNEL_PARTNER:
        # The rate card carries the agency's broker rates — staff only.
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Rate cards are internal to the agency.")
    query: dict = {"broker_id": broker_id}
    if category_key:
        query["category_key"] = category_key
    items = await RateRule.find(query).sort("+category_key", "-created_at").to_list()
    return [RateRuleOut.from_model(r) for r in items]


@router.get("/preview", response_model=RatePreview,
            dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def preview_rate(
    broker_id: str = Query(...),
    category_key: str = Query(...),
    subcategory_path: list[str] = Query(default=[]),
    insurer_id: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> RatePreview:
    # A channel partner may preview only their OWN share of a matched rate; the
    # agency side (and thus the house spread) stays hidden.
    is_partner = actor.account_type == AccountType.CHANNEL_PARTNER

    def _sanitize(p: RatePreview) -> RatePreview:
        if is_partner:
            p.agency_value = 0
            if not p.partner_value:
                p.source = "none"
                p.rule_id = None
                p.label = None
        return p

    rule = await find_rate_rule(
        broker_id, category_key, subcategory_path, insurer_id=insurer_id or None)
    if rule and (rule.agency_value or rule.partner_value):
        return _sanitize(RatePreview(
            source="rate_rule", rule_id=str(rule.id), label=rule.label,
            agency_basis=rule.agency_basis, agency_value=rule.agency_value,
            partner_basis=rule.partner_basis, partner_value=rule.partner_value))

    return RatePreview(source="none")


async def _load_broker(broker_id: str) -> Broker:
    broker = await Broker.get(await parse_object_id(broker_id))
    if broker is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Broker not found.")
    return broker


@router.post("", response_model=RateRuleOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_RATE_CARDS))])
async def create_rule(payload: RateRuleCreate,
                      actor: User = Depends(get_active_user)) -> RateRuleOut:
    broker = await _load_broker(payload.broker_id)
    rule = RateRule(created_by=str(actor.id), **payload.model_dump())
    await rule.insert()
    await log_action(
        AuditAction.RATE_RULE_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="rate_rule", entity_id=str(rule.id),
        entity_code=broker.short_code,
        summary=f"Added rate rule for {broker.short_code} ({rule.category_key})",
        meta={"subcategory_path": rule.subcategory_path,
              "insurer_id": rule.insurer_id},
    )
    return RateRuleOut.from_model(rule)


@router.patch("/{rule_id}", response_model=RateRuleOut,
              dependencies=[Depends(require_permission(MANAGE_RATE_CARDS))])
async def update_rule(rule_id: str, payload: RateRuleUpdate,
                      actor: User = Depends(get_active_user)) -> RateRuleOut:
    rule = await RateRule.get(await parse_object_id(rule_id))
    if rule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rate rule not found.")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(rule, field, value)
    rule.updated_at = utcnow()
    await rule.save()
    await log_action(
        AuditAction.RATE_RULE_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="rate_rule", entity_id=str(rule.id),
        summary=f"Updated rate rule ({rule.category_key})",
    )
    return RateRuleOut.from_model(rule)


@router.delete("/{rule_id}",
               dependencies=[Depends(require_permission(MANAGE_RATE_CARDS))])
async def delete_rule(rule_id: str,
                      actor: User = Depends(get_active_user)) -> dict:
    rule = await RateRule.get(await parse_object_id(rule_id))
    if rule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rate rule not found.")
    await rule.delete()
    await log_action(
        AuditAction.RATE_RULE_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="rate_rule", entity_id=rule_id,
        summary=f"Deleted rate rule ({rule.category_key})",
    )
    return {"detail": "Rate rule deleted."}
