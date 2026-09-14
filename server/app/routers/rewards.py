"""Reward ledger (formerly commission): list earnings and update settlement."""

from __future__ import annotations

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import (
    AccountType, AuditAction, PolicyStatus, RewardStatus,
)
from app.core.permissions import (
    can,
    MANAGE_POLICIES,
    VIEW_AGENCY_PROFIT,
    VIEW_TRANSACTIONS,
)
from app.models.base import utcnow
from app.models.customer import Customer
from app.models.policy import Policy
from app.models.reward import Reward
from app.models.user import User
from app.routers._helpers import build_scope_query, ensure_can_access, parse_object_id
from app.schemas.common import Page
from app.schemas.reward import RewardOut, RewardStatusUpdate
from app.services import wallet as wallet_svc
from app.services.audit import log_action

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/rewards", tags=["rewards"],
                   dependencies=[Depends(get_inhouse_user)])


def _can_view_house(user: User) -> bool:
    return can(user, VIEW_AGENCY_PROFIT)


def _require_reward_view(user: User) -> None:
    allowed = {VIEW_TRANSACTIONS, VIEW_AGENCY_PROFIT}
    if not (allowed & set(user.permissions)):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You can't view rewards.")


@router.get("", response_model=Page[RewardOut])
async def list_rewards(
    actor: User = Depends(get_active_user),
    status_filter: RewardStatus | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[RewardOut]:
    _require_reward_view(actor)
    base: dict = {}
    if status_filter:
        base["status"] = status_filter.value
    query = await build_scope_query(actor, base)
    # Channel Partners only ever see their own reward rows.
    if actor.account_type == AccountType.CHANNEL_PARTNER:
        query = {"$and": [query, {"partner_id": str(actor.id)}]}

    include_house = _can_view_house(actor)
    include_agency = actor.account_type != AccountType.CHANNEL_PARTNER
    total = await Reward.find(query).count()
    items = (await Reward.find(query).sort("-created_at")
             .skip((page - 1) * page_size).limit(page_size).to_list())

    # Resolve policy codes + customer names so rows read like the business.
    def _oids(values: set[str]) -> list[PydanticObjectId]:
        out = []
        for v in values:
            try:
                out.append(PydanticObjectId(v))
            except Exception:  # noqa: BLE001
                continue
        return out
    pol_map = {str(p.id): p.code for p in await Policy.find(
        {"_id": {"$in": _oids({r.policy_id for r in items})}}).to_list()}
    cust_map = {str(c.id): c.name for c in await Customer.find(
        {"_id": {"$in": _oids({r.customer_id for r in items})}}).to_list()}

    return Page[RewardOut](
        items=[RewardOut.from_model(
            r, include_house, include_agency,
            policy_code=pol_map.get(r.policy_id),
            customer_name=cust_map.get(r.customer_id))
            for r in items],
        total=total, page=page, page_size=page_size,
    )


@router.get("/{reward_id}", response_model=RewardOut)
async def get_reward(reward_id: str,
                     actor: User = Depends(get_active_user)) -> RewardOut:
    _require_reward_view(actor)
    rec = await Reward.get(await parse_object_id(reward_id))
    if rec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reward not found.")
    await ensure_can_access(actor, rec)
    if actor.account_type == AccountType.CHANNEL_PARTNER \
            and rec.partner_id != str(actor.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Outside your scope.")
    return RewardOut.from_model(
        rec, _can_view_house(actor),
        include_agency=actor.account_type != AccountType.CHANNEL_PARTNER)


@router.patch("/{reward_id}/status", response_model=RewardOut,
              dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def update_reward_status(
    reward_id: str, payload: RewardStatusUpdate,
    actor: User = Depends(get_active_user),
) -> RewardOut:
    rec = await Reward.get(await parse_object_id(reward_id))
    if rec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reward not found.")
    await ensure_can_access(actor, rec)
    # Cancellation is final (owner Q4): a cancelled policy's reward is frozen.
    if rec.policy_id:
        _pol = await Policy.get(await parse_object_id(rec.policy_id))
        if _pol is not None and _pol.status == PolicyStatus.CANCELLED:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "This policy is cancelled and read-only. Book a new policy "
                "instead.")

    previous = rec.status
    rec.status = payload.status
    rec.reference = payload.reference
    if payload.status == RewardStatus.RECEIVED and rec.received_at is None:
        rec.received_at = utcnow()
    if payload.status == RewardStatus.PAID_OUT and rec.paid_out_at is None:
        rec.paid_out_at = utcnow()
    rec.updated_at = utcnow()
    await rec.save()

    # Reconcile the partner wallet from ANY prior state (same logic as the
    # policy reward-status endpoint) and re-book the finance snapshot so
    # reversal outcomes drop out of every commission/profit aggregate. The
    # wallet is only touched once the policy is APPROVED — a pending partner
    # policy must never earn wallet credit through this endpoint.
    pol = await Policy.get(await parse_object_id(rec.policy_id)) \
        if rec.policy_id else None
    if pol is not None:
        await wallet_svc.apply_reward_outcome(
            rec, payload.status, actor_id=str(actor.id))
        from app.services import finance as finance_svc
        await finance_svc.book_policy_finance(pol, rec)
        await finance_svc.sync_reward_cancellation(pol, rec)
    elif payload.status in (RewardStatus.CANCELLED,) or rec.wallet_credited:
        # Dangling reward (no policy) — at least keep the wallet consistent.
        await wallet_svc.apply_reward_outcome(
            rec, payload.status, actor_id=str(actor.id))

    await log_action(
        AuditAction.REWARD_STATUS_CHANGED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="reward", entity_id=str(rec.id),
        summary=f"Reward {previous.value} -> {payload.status.value}",
        meta={"reference": payload.reference},
    )
    return RewardOut.from_model(rec, _can_view_house(actor))
