"""Policy CRUD, approval workflow, status transitions, and renewals."""

from __future__ import annotations

import re

from datetime import datetime, timedelta, timezone
from typing import Optional

from beanie import PydanticObjectId
from pydantic import BaseModel
from fastapi import (
    APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile,
    status,
)
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_any_permission,
    require_permission,
)
from app.core.enums import (
    AccountType,
    AuditAction,
    BuyerType,
    DocumentStatus,
    LedgerTxnType,
    PolicyStatus,
    REWARD_REVERSAL_STATES,
    RewardBasis,
    RewardStatus,
)
from app.core.permissions import (
    can,
    can_any,
    EXPORT_DATA,
    MANAGE_RENEWALS,
    MANAGE_POLICIES,
    VIEW_AGENCY_PROFIT,
    VIEW_RENEWALS,
    FINANCE_VIEW_ANY,
    VIEW_POLICIES,
)
from app.models.base import utcnow
from app.models.customer import Customer
from app.models.document import DocumentRecord
from app.models.broker import Broker
from app.models.finance import LedgerTxn, PolicyFinance
from app.models.insurer import Insurer
from app.models.master import COMMISSIONABLE_BASE, PolicyCategory
from app.models.policy import Policy, RewardTerms
from app.models.reward import Reward
from app.models.user import User
from app.routers._helpers import (
    build_scope_query,
    default_owner_id,
    ensure_can_access,
    parse_object_id,
    read_upload,
    search_regex,
)
from app.schemas.common import Page
from app.schemas.document import DocumentOut
from app.schemas.policy import (
    PolicyCreate,
    PolicyOut,
    PolicyRenew,
    PolicyStatusUpdate,
    PolicyUpdate,
)
from app.schemas.reward import RewardStatusUpdate
from app.services import apilog
from app.services import bank as bank_svc
from app.services import policy_columns
from app.services import policy_scope
from app.services import email as email_svc
from app.services import finance as finance_svc
from app.services import s3
from app.services import target_alerts
from app.services import targets as target_svc
from app.services.exporters import export_response
from app.services import wallet as wallet_svc
from app.services.audit import describe_changes, diff_dict_async, log_action
from app.services.categories import labels_for_path, leaf_key, path_is_valid
from app.services.custom_fields import (
    FieldValidationError,
    resolve_reward_base_field,
    validate_details,
)
from app.services.codes import next_code
from app.services.notifications import create_notification
from app.services.money import paise_to_rupees
from app.services.policy_ops import (
    ensure_policy_number_unique as _ensure_policy_number_unique,
    resolve_reward_terms,
    stamp_manager as _stamp_manager,
    sync_reward,
)
from app.services import finance_reports as fr

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/policies", tags=["policies"],
                   dependencies=[Depends(get_inhouse_user)])


# A picked bound is an Indian calendar date (shared reader — see the note in
# services/finance_reports). It used to be attached to UTC here, which put the
# `custom` branch of resolve_period 5h30m out of step with every one of its own
# presets — all of which build their bounds in IST.
_parse_dt = fr.parse_ist_bound


def _created_range(period: str | None, date_from: str | None,
                   date_to: str | None) -> dict | None:
    """Resolve the Policies date filter to a Mongo range on `created_at` (when a
    policy was entered into the CRM — owner's choice). Returns None for no filter."""
    if not period:
        return None
    df = fr.parse_ist_bound(date_from)
    dt = fr.parse_ist_end_of_day(date_to)   # inclusive end-of-day
    lo, hi, _label = fr.resolve_period(period, utcnow(), df, dt)
    return {"$gte": lo, "$lte": hi}


def _hide_agency(actor: User) -> bool:
    """Channel partners never see the agency's insurer rate."""
    return actor.account_type == AccountType.CHANNEL_PARTNER


async def _broker_display(broker_id: str | None) -> tuple[str | None, str | None]:
    """Resolve a broker's (name, short_code) for a policy response."""
    if not broker_id:
        return None, None
    try:
        b = await Broker.get(PydanticObjectId(broker_id))
    except Exception:  # noqa: BLE001 — malformed id
        return None, None
    return (b.name, b.short_code) if b else (None, None)


async def _broker_map(policies: list[Policy]) -> dict[str, tuple[str, str]]:
    """Bulk-resolve {broker_id: (name, short_code)} for a page of policies."""
    ids = set()
    for p in policies:
        if p.broker_id:
            try:
                ids.add(PydanticObjectId(p.broker_id))
            except Exception:  # noqa: BLE001
                continue
    if not ids:
        return {}
    return {str(b.id): (b.name, b.short_code)
            for b in await Broker.find({"_id": {"$in": list(ids)}}).to_list()}


async def _name_of(model, raw_id: str | None, field: str) -> str | None:
    """`field` off one referenced document, or None if it isn't there.

    A dangling id is normal (the insurer was deleted, the partner archived) and
    must not 500 the record it hangs off.
    """
    if not raw_id:
        return None
    try:
        doc = await model.get(PydanticObjectId(raw_id))
    except Exception:  # noqa: BLE001 — malformed id in an old row
        return None
    return getattr(doc, field) if doc else None


async def _policy_out(pol: Policy, actor: User, *,
                      reward_status: str | None = None,
                      customer_name: str | None = None,
                      insurer_name: str | None = None) -> PolicyOut:
    """Serialize ONE policy, resolving every display name on it.

    The list endpoint bulk-resolves customer / insurer / partner names into maps
    before serialising; this is the single-record path, and until 2026-08-04 it
    resolved only the broker. Every screen that reads one policy — the policy
    page above all — therefore showed "—" where the customer and insurer should
    be, while the list one click away showed them correctly.
    Resolving here rather than at each of the seven call sites is what stops the
    next endpoint added below from having the same hole.
    """
    broker_name, broker_code = await _broker_display(pol.broker_id)
    if customer_name is None:
        customer_name = await _name_of(Customer, pol.customer_id, "name")
    if insurer_name is None:
        insurer_name = await _name_of(Insurer, pol.insurer_id, "name")
    partner_name = await _name_of(User, pol.partner_id, "full_name")
    return PolicyOut.from_model(
        pol, customer_name=customer_name, insurer_name=insurer_name,
        broker_name=broker_name, broker_code=broker_code,
        partner_name=partner_name,
        reward_status=reward_status, hide_agency=_hide_agency(actor))


async def _validate_refs(payload_category: str, subcategory_path: list[str],
                         insurer_id: str, customer_id: str,
                         actor: User) -> tuple[PolicyCategory, Insurer, Customer]:
    cat = await PolicyCategory.find_one(PolicyCategory.key == payload_category)
    if not cat:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Unknown policy category.")
    if subcategory_path and not path_is_valid(cat.children, subcategory_path):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Unknown sub-type path for this policy type.")
    insurer = await Insurer.get(await parse_object_id(insurer_id))
    if insurer is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown insurer.")
    if not insurer.active:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This insurer is disabled; no new policies can be created under it.")
    customer = await Customer.get(await parse_object_id(customer_id))
    if customer is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown customer.")
    await ensure_can_access(actor, customer)
    return cat, insurer, customer


async def _validate_partner(partner_id: str) -> User:
    partner = await User.get(partner_id)
    if partner is None or partner.account_type != AccountType.CHANNEL_PARTNER \
            or getattr(partner, "is_deleted", False):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown partner.")
    return partner


async def _validate_broker(broker_id: str) -> Broker:
    """The Broker a policy is placed through must exist and be active."""
    broker = await Broker.get(await parse_object_id(broker_id))
    if broker is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown broker.")
    if not broker.active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This broker is disabled.")
    return broker


def _forbid_cancelled(pol: Policy) -> None:
    """Cancellation is final (owner Q4): a cancelled policy is read-only, so its
    wiped premium bookkeeping can never be resurrected by a re-book."""
    if pol.status == PolicyStatus.CANCELLED:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This policy is cancelled and read-only. Book a new policy "
            "instead.")


def _ensure_no_partner_discount(partner_id, discount_value) -> None:
    """Discounts are a direct-sale tool only (owner Q5): on partner-attributed
    policies the partner prices his own customer, so a discount is not allowed."""
    if partner_id and (discount_value or 0) > 0:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Discounts are not available on partner-attributed policies — "
            "remove the discount or the channel partner.")


def _ensure_discount_within_premium(premium_amount, discount_basis,
                                    discount_value) -> None:
    """A discount can never exceed the premium (owner's 1.15 cap): flat is
    capped at the gross premium; percent at 100%."""
    from app.core.enums import RewardBasis
    from app.services.finance import discount_amount
    value = discount_value or 0
    if value <= 0:
        return
    disc = discount_amount(premium_amount or 0, discount_basis, value)
    if disc > (premium_amount or 0):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Discount cannot exceed the premium (100% of the policy premium).")
    if discount_basis == RewardBasis.PERCENT and value > 100 * 100:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Discount cannot exceed 100% of the premium.")


def _recheck_targets(background: BackgroundTasks, *policies) -> None:
    """Re-run the target milestone check for everyone these policies count for.

    Anything that moves a policy's contribution — booking, editing, cancelling,
    renewing, or changing a reward outcome — can also carry someone across
    50 / 90 / 100% of their monthly target, so every one of those paths ends
    here. It runs after the response and swallows its own errors (see
    services/target_alerts), so a congratulation that fails to send can never
    fail the policy that earned it.

    "Everyone" is three people at most and usually one: the employee it is
    booked under, the channel partner it is credited to (partners carry targets
    and see them in the portal since 2026-08-06), and — for partner business —
    that partner's frozen relationship manager, whose own goal is fed by their
    team (services/targets.employees_credited). The set is deduplicated, so an
    in-house sale still fires exactly one check.
    """
    people: set[str] = set()
    for pol in policies:
        if pol is None:
            continue
        people |= target_svc.employees_credited(pol)
        if pol.partner_id:
            people.add(pol.partner_id)
    for user_id in people:
        background.add_task(target_alerts.check_milestones, user_id)


# The longest window a renewals-only user may ask for. One number, so the list
# and the export cannot disagree about what "the expiring book" means.
RENEWAL_WINDOW_DAYS = 90


# view_renewals is accepted here as well as view_policies, and the body then
# FORCES the expiring-soon window for anyone who holds only the former. Doing it
# server-side is the whole point: gating the Renewals page on a flag while its
# data came from an unrestricted /policies call would have made view_renewals
# decorative — drop the query param and you get the entire book.
@router.get("", response_model=Page[PolicyOut],
            dependencies=[Depends(
                require_any_permission(VIEW_POLICIES, VIEW_RENEWALS))])
async def list_policies(
    actor: User = Depends(get_active_user),
    status_filter: PolicyStatus | None = Query(default=None, alias="status"),
    category_key: str | None = Query(default=None),
    customer_id: str | None = Query(default=None),
    insurer_id: str | None = Query(default=None),
    broker_id: str | None = Query(default=None),
    partner_id: str | None = Query(default=None),
    period: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    expiring_in_days: int | None = Query(default=None, ge=1, le=365),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[PolicyOut]:
    base: dict = {}
    if not can(actor, VIEW_POLICIES):
        # Renewals-only: they may read the expiring book and nothing else.
        # Clamped rather than rejected so the page works unchanged, and clamped
        # to a default when the caller sends no window at all.
        expiring_in_days = min(expiring_in_days or RENEWAL_WINDOW_DAYS,
                               RENEWAL_WINDOW_DAYS)
    if status_filter:
        base["status"] = status_filter.value
    if category_key:
        base["category_key"] = category_key
    if customer_id:
        base["customer_id"] = customer_id
    if insurer_id:
        base["insurer_id"] = insurer_id
    if broker_id:
        base["broker_id"] = broker_id
    if partner_id:
        base["partner_id"] = partner_id
    if (created := _created_range(period, date_from, date_to)) is not None:
        base["created_at"] = created
    if expiring_in_days is not None:
        # Policies coming up for renewal: still live and expiring within the window.
        now = utcnow()
        base["status"] = {"$in": [PolicyStatus.ACTIVE.value,
                                  PolicyStatus.RENEWAL_DUE.value]}
        base["expiry_date"] = {"$gte": now,
                               "$lte": now + timedelta(days=expiring_in_days)}
    if q:
        rx = search_regex(q)
        or_clauses = [{"code": rx}, {"policy_number": rx}]
        # Also match by customer name — that's how staff think of a policy.
        matching_customers = await Customer.find(
            {"name": rx}).limit(300).to_list()
        if matching_customers:
            or_clauses.append({"customer_id": {
                "$in": [str(c.id) for c in matching_customers]}})
        base["$or"] = or_clauses
    # THE SCOPE, and it goes in the QUERY (owner 2026-08-24). Without
    # `view_all_policies` this is the caller's own book: what they booked, plus
    # what the channel partners on their roster booked, plus anything a live
    # access grant covers. `merge` rather than `base.update` because `base` may
    # already carry its OWN `$or` from the search box, and one would silently
    # replace the other — see the note on policy_scope.merge.
    query = policy_scope.merge(base, await policy_scope.visible_filter(actor))
    sort_key = "+expiry_date" if expiring_in_days is not None else "-created_at"
    total = await Policy.find(query).count()
    items = (await Policy.find(query).sort(sort_key)
             .skip((page - 1) * page_size).limit(page_size).to_list())

    cust_ids = {PydanticObjectId(p.customer_id) for p in items if p.customer_id}
    ins_ids = {PydanticObjectId(p.insurer_id) for p in items if p.insurer_id}
    cust_map = {str(c.id): c.name for c in
                await Customer.find({"_id": {"$in": list(cust_ids)}}).to_list()}
    ins_map = {str(i.id): i.name for i in
               await Insurer.find({"_id": {"$in": list(ins_ids)}}).to_list()}
    brk_map = await _broker_map(items)
    # Resolve channel-partner names for the list's partner column.
    partner_ids = {PydanticObjectId(p.partner_id) for p in items if p.partner_id}
    partner_map = {str(u.id): u.full_name for u in
                   await User.find({"_id": {"$in": list(partner_ids)}}).to_list()}
    reward_map = {r.policy_id: (r.status.value if hasattr(r.status, "value")
                                else r.status)
                  for r in await Reward.find(
                      {"policy_id": {"$in": [str(p.id) for p in items]}}).to_list()}

    return Page[PolicyOut](
        items=[PolicyOut.from_model(
            p, customer_name=cust_map.get(p.customer_id),
            insurer_name=ins_map.get(p.insurer_id),
            broker_name=brk_map.get(p.broker_id, (None, None))[0],
            broker_code=brk_map.get(p.broker_id, (None, None))[1],
            partner_name=partner_map.get(p.partner_id),
            reward_status=reward_map.get(str(p.id)),
            hide_agency=_hide_agency(actor)) for p in items],
        total=total, page=page, page_size=page_size,
    )


# How a reward reads in a column lives in services/policy_columns, shared with
# the business report — the two had already drifted once (that report's Policies
# sheet carried no rate and no base at all).
_REVERSAL_STATE_VALUES = policy_columns.REVERSAL_STATE_VALUES
_reward_pct = policy_columns.reward_pct
_reward_base_label = policy_columns.reward_base_label
_eligibility = policy_columns.eligibility


class PolicyNumberCheck(BaseModel):
    """Is this policy number free? Advisory only — see the endpoint."""

    number: str
    available: bool
    # What it collides with, so the answer is actionable. "Already exists" makes
    # somebody hunt for it; "already on AG-POL-000045" is one click.
    used_by_code: Optional[str] = None


class PolicyScopeOut(BaseModel):
    """What this person is looking at, said in one sentence.

    A scoped list that does not SAY it is scoped reads as a list with rows
    missing, and the first assumption anybody makes is that the software lost
    them. Computed server-side so the page cannot invent a different sentence
    from the one the query actually applied.
    """

    scoped: bool
    partner_count: int = 0
    label: str = ""


# BEFORE /{policy_id} — a static path registered after a dynamic one is
# shadowed by it, and this router already carries that scar (see /export).
@router.get("/scope", response_model=PolicyScopeOut,
            dependencies=[Depends(require_any_permission(
                VIEW_POLICIES, VIEW_RENEWALS))])
async def policy_scope_note(actor: User = Depends(get_active_user)
                            ) -> PolicyScopeOut:
    return PolicyScopeOut(**await policy_scope.scope_note(actor))


@router.get("/number-available", response_model=PolicyNumberCheck,
            dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def policy_number_available(
    number: str = Query(default="", max_length=120),
    exclude_id: str | None = Query(default=None),
) -> PolicyNumberCheck:
    """Tell the booking form, while it is being typed, that this number is taken.

    The rule is already enforced twice — `ensure_policy_number_unique` on every
    write, and the `policy_number_unique` index underneath it. What neither can
    do is tell somebody BEFORE they have filled in a broker, an insurer, a
    premium, four custom fields and a mandatory PDF upload, only to have Save
    come back with a 409 on the field they typed first.

    Advisory, deliberately. It is a read, so it races anybody typing the same
    number at the same moment; the write-time check and the index are what
    actually decide. A green tick here is "nothing found", never a reservation.
    """
    number = (number or "").strip()
    if not number:
        return PolicyNumberCheck(number=number, available=True)
    existing = await Policy.find_one(
        {"policy_number": {"$regex": f"^{re.escape(number)}$",
                           "$options": "i"}})
    if existing is None or str(existing.id) == (exclude_id or ""):
        return PolicyNumberCheck(number=number, available=True)
    return PolicyNumberCheck(number=number, available=False,
                             used_by_code=existing.code)


@router.get("/export",
            dependencies=[Depends(require_permission(VIEW_POLICIES)),
                          Depends(require_permission(EXPORT_DATA))])
async def export_policies(
    background: BackgroundTasks,
    actor: User = Depends(get_active_user),
    status_filter: PolicyStatus | None = Query(default=None, alias="status"),
    category_key: str | None = Query(default=None),
    insurer_id: str | None = Query(default=None),
    broker_id: str | None = Query(default=None),
    partner_id: str | None = Query(default=None),
    period: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    fmt: str = Query(default="excel", pattern="^(excel|xlsx|csv)$"),
):
    """Download the policy list (respecting the active filters + the caller's data
    scope). Gated by export_data and audited."""
    # No renewals-only clamp here: the route already demands VIEW_POLICIES, so a
    # renewals-only user never reaches it. Exporting is a separate decision from
    # reading (export_data), and "the expiring book, as a spreadsheet" is not
    # something the Renewals page offers.
    base: dict = {}
    if status_filter:
        base["status"] = status_filter.value
    if category_key:
        base["category_key"] = category_key
    if insurer_id:
        base["insurer_id"] = insurer_id
    if broker_id:
        base["broker_id"] = broker_id
    if partner_id:
        base["partner_id"] = partner_id
    if (created := _created_range(period, date_from, date_to)) is not None:
        base["created_at"] = created
    # The SAME scope the list applies. An export that ignored it would be the
    # single easiest way around the whole feature — one button, the entire book,
    # as a spreadsheet.
    query = policy_scope.merge(base, await policy_scope.visible_filter(actor))
    items = await Policy.find(query).sort("-created_at").limit(20000).to_list()

    cust_ids = {PydanticObjectId(p.customer_id) for p in items if p.customer_id}
    ins_ids = {PydanticObjectId(p.insurer_id) for p in items if p.insurer_id}
    cust_map = {str(c.id): c.name for c in
                await Customer.find({"_id": {"$in": list(cust_ids)}}).to_list()}
    ins_map = {str(i.id): i.name for i in
               await Insurer.find({"_id": {"$in": list(ins_ids)}}).to_list()}
    brk_map = await _broker_map(items)
    # Channel-partner names for the partner column.
    partner_ids = {PydanticObjectId(p.partner_id) for p in items if p.partner_id}
    partner_map = {str(u.id): u.full_name for u in
                   await User.find({"_id": {"$in": list(partner_ids)}}).to_list()}
    # Policy-type docs (label + sub-type tree + custom fields for the base label).
    cat_keys = {p.category_key for p in items if p.category_key}
    cat_map = {c.key: c for c in await PolicyCategory.find(
        {"key": {"$in": list(cat_keys)}}).to_list()}
    reward_map = {r.policy_id: (r.status.value if hasattr(r.status, "value")
                                else r.status)
                  for r in await Reward.find(
                      {"policy_id": {"$in": [str(p.id) for p in items]}}).to_list()}

    hide_agency = _hide_agency(actor)
    # The finance block ends in a Net Profit column → gate it on the agency-profit
    # right, not just view_finance (owner Q-A2).
    show_finance = (can_any(actor, *FINANCE_VIEW_ANY)
                    and can(actor, VIEW_AGENCY_PROFIT)
                    and not hide_agency)
    fin_map: dict[str, PolicyFinance] = {}
    if show_finance:
        fin_map = {f.policy_id: f for f in await PolicyFinance.find(
            {"policy_id": {"$in": [str(p.id) for p in items]}}).to_list()}

    headers = ["Policy No", "Customer", "Category", "Sub Category", "Insurer",
               "Broker", "Premium (Rs)", "Commissionable Premium (Rs)",
               "Reward Base", "Agency Reward %", "Partner %", "Channel Partner",
               "Start Date", "Expiry", "Reward Eligibility"]
    if show_finance:
        headers += ["Agency Reward (Rs)", "Channel Partner Amount (Rs)",
                    "Net Profit (Rs)"]

    def _row(p: Policy) -> list:
        cat = cat_map.get(p.category_key)
        cat_label = cat.label if cat else p.category_key
        sub = " › ".join(labels_for_path(cat.children, p.subcategory_path)) \
            if cat and p.subcategory_path else ""
        agency_pct = "" if hide_agency else _reward_pct(
            p.reward.agency_basis, p.reward.agency_value,
            p.commissionable_premium)
        partner_pct = _reward_pct(
            p.reward.partner_basis, p.reward.partner_value,
            p.commissionable_premium) if p.partner_id else ""
        row = [
            p.policy_number or "",
            cust_map.get(p.customer_id, ""),
            cat_label,
            sub,
            ins_map.get(p.insurer_id, ""),
            brk_map.get(p.broker_id, ("", ""))[0],
            f"{p.premium_amount / 100:.2f}",
            f"{p.commissionable_premium / 100:.2f}",
            _reward_base_label(p.reward_base_field, cat),
            agency_pct,
            partner_pct,
            partner_map.get(p.partner_id, "") if p.partner_id else "",
            p.start_date.strftime("%Y-%m-%d") if p.start_date else "",
            p.expiry_date.strftime("%Y-%m-%d") if p.expiry_date else "",
            _eligibility(reward_map.get(str(p.id))),
        ]
        if show_finance:
            fin = fin_map.get(str(p.id))
            row += [
                f"{fin.agency_reward / 100:.2f}" if fin else "",
                f"{fin.partner_share / 100:.2f}" if fin else "",
                f"{fin.house_profit / 100:.2f}" if fin else "",
            ]
        return row

    rows = [_row(p) for p in items]

    background.add_task(
        log_action, AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", summary=f"Exported {len(items)} policies ({fmt})",
        meta={"filters": base})
    return export_response(fmt, "policies", headers, rows,
                           sheet_title="Policies")


@router.get("/{policy_id}", response_model=PolicyOut,
            dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def get_policy(policy_id: str,
                     actor: User = Depends(get_active_user)) -> PolicyOut:
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)
    reward = await Reward.find_one(Reward.policy_id == str(pol.id))
    return await _policy_out(
        pol, actor, reward_status=reward.status.value if reward else None)


@router.patch("/{policy_id}/reward-status", response_model=PolicyOut,
              dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def set_reward_status(policy_id: str, payload: RewardStatusUpdate,
                            background: BackgroundTasks,
                            actor: User = Depends(get_active_user)) -> PolicyOut:
    """Set a policy's reward outcome (received / rejected / not eligible / 0% /
    refunded / pending). Reconciles the partner's wallet — reversal outcomes pull
    the reward out of the partner's net balance automatically; Received releases
    it as payable. The agency's cash 'commission received' stays a separate
    Transactions entry (owner decision)."""
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)
    _forbid_cancelled(pol)
    reward = await Reward.find_one(Reward.policy_id == str(pol.id))
    if reward is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "No reward booked for this policy yet.")

    previous = reward.status
    reward.status = payload.status
    if payload.reference is not None:
        reward.reference = payload.reference
    if payload.status == RewardStatus.RECEIVED and reward.received_at is None:
        reward.received_at = utcnow()
    reward.updated_at = utcnow()
    await reward.save()

    # Reconcile the partner wallet (and thus the partner's net balance).
    await wallet_svc.apply_reward_outcome(
        reward, payload.status, actor_id=str(actor.id))

    # Eligibility drives the finance snapshot: re-book so a not-eligible reward is
    # zeroed out of every commission/profit aggregate, and post/remove the visible
    # "reward cancelled" ledger row on the broker.
    await finance_svc.book_policy_finance(pol, reward)
    await finance_svc.sync_reward_cancellation(pol, reward)

    background.add_task(
        log_action,
        AuditAction.REWARD_STATUS_CHANGED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="reward", entity_id=str(reward.id),
        summary=f"Policy {pol.code} reward {previous.value} -> "
                f"{payload.status.value}",
        meta={"policy_id": str(pol.id), "reference": payload.reference})
    _recheck_targets(background, pol)
    return await _policy_out(pol, actor, reward_status=reward.status.value)


@router.post("", response_model=PolicyOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def create_policy(payload: PolicyCreate, background: BackgroundTasks,
                        actor: User = Depends(get_active_user)) -> PolicyOut:
    cat, _insurer, _customer = await _validate_refs(
        payload.category_key, payload.subcategory_path, payload.insurer_id,
        payload.customer_id, actor)
    if payload.broker_id:
        await _validate_broker(payload.broker_id)
    await _ensure_policy_number_unique(payload.policy_number)

    # Validate the type-specific custom fields and pin the reward base.
    try:
        clean_details = validate_details(cat.custom_fields, payload.details)
    except FieldValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    reward_base = resolve_reward_base_field(
        cat.custom_fields, payload.reward_base_field)

    data = payload.model_dump(exclude={"reward", "owner_user_id"})
    data["policy_number"] = payload.policy_number.strip()
    data["details"] = clean_details
    data["reward_base_field"] = reward_base
    # Deepest chosen sub-type key, kept for display / analytics / reward ledger.
    data["subcategory_key"] = leaf_key(payload.subcategory_path)

    # Staff only — this whole router carries get_inhouse_user, so a channel
    # partner never reaches here. Their submission path is
    # Staff-only: this router carries get_inhouse_user. A channel partner
    # cannot book a policy at all — they raise a quote request and the team
    # books it from here (owner A1/A3, 2026-08-05).
    if data.get("partner_id"):
        await _validate_partner(data["partner_id"])
    owner_id = default_owner_id(actor, payload.owner_user_id)

    _ensure_no_partner_discount(data.get("partner_id"),
                                data.get("discount_value"))
    _ensure_discount_within_premium(data.get("premium_amount"),
                                    payload.discount_basis,
                                    data.get("discount_value"))
    pol = Policy(
        code=await next_code("policy"),
        owner_user_id=owner_id,
        created_by=str(actor.id),
        **data,
    )
    # Freeze the relationship manager onto the policy (attribution only). A
    # copy, not a live lookup: reassigning a partner to another manager later
    # must not rewrite what their old manager is credited with.
    await _stamp_manager(pol, owner_id)
    if payload.reward is not None:
        pol.reward = payload.reward
    pol.reward = await resolve_reward_terms(pol)
    pol.buyer_type = (BuyerType.CHANNEL_PARTNER if pol.partner_id
                      else BuyerType.DIRECT)
    await pol.insert()
    reward = await sync_reward(pol)

    # Every policy here is real the moment it is saved, so the partner (if any)
    # is credited and the finance snapshot booked immediately. There is no
    # longer a pending state to wait for — see models/policy.py.
    if pol.partner_id:
        await wallet_svc.credit_reward(reward)
    await finance_svc.book_policy_finance(pol, reward)

    # Audit doesn't affect the response — run it after the response is sent so
    # "Create Policy" returns as soon as the record is saved.
    background.add_task(
        log_action,
        AuditAction.POLICY_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", entity_id=str(pol.id), entity_code=pol.code,
        summary=f"Created policy {pol.code} ({pol.category_key})",
    )
    _recheck_targets(background, pol)
    return await _policy_out(
        pol, actor, reward_status=reward.status.value if reward else None)


@router.post("/{policy_id}/document", response_model=DocumentOut,
             dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def upload_policy_document(policy_id: str,
                                 background: BackgroundTasks,
                                 file: UploadFile = File(...),
                                 actor: User = Depends(get_active_user)
                                 ) -> DocumentOut:
    """Attach the policy PDF (or replace it). Accessible to whoever can access the
    policy, so the channel partner who booked it can upload too."""
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)

    data = await read_upload(file, 20 * 1024 * 1024, label="Document")

    # Re-upload replaces the existing policy PDF (single slot).
    old = await DocumentRecord.find(
        DocumentRecord.entity_type == "policy",
        DocumentRecord.entity_id == policy_id,
        DocumentRecord.doc_key == "policy_pdf",
    ).to_list()
    for o in old:
        background.add_task(s3.delete_object, o.s3_key)   # best-effort cleanup
        await o.delete()

    key = s3.build_key("policy", policy_id, file.filename or "policy.pdf")
    # boto3 is synchronous; run the upload off the event loop so it doesn't block
    # other requests while a (potentially large) PDF streams to S3.
    import time as _time
    _t0 = _time.perf_counter()
    await run_in_threadpool(
        s3.get_s3_client().put_object,
        Bucket=settings.aws_bucket_name, Key=key, Body=data,
        ContentType=file.content_type or "application/pdf",
    )
    apilog.track("s3", "put_object", bytes_transferred=len(data),
                 duration_ms=int((_time.perf_counter() - _t0) * 1000),
                 actor_id=str(actor.id), related_type="policy",
                 related_id=policy_id)
    doc = DocumentRecord(
        entity_type="policy",
        entity_id=policy_id,
        doc_key="policy_pdf",
        label="Policy PDF",
        s3_key=key,
        filename=file.filename or "policy.pdf",
        content_type=file.content_type,
        size_bytes=len(data),
        status=DocumentStatus.UPLOADED,
        uploaded_by=str(actor.id),
    )
    await doc.insert()
    background.add_task(
        log_action,
        AuditAction.DOCUMENT_UPLOADED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", entity_id=policy_id, entity_code=pol.code,
        summary=f"Uploaded policy PDF for {pol.code}",
    )
    # On the FIRST policy PDF (not a replacement), auto-send it to the customer /
    # channel partner per the owner's WhatsApp settings. Runs in the background.
    if not old:
        from app.services import messaging
        background.add_task(messaging.send_policy_document, pol, trigger="auto")
    return DocumentOut.from_model(doc)


@router.post("/{policy_id}/documents", response_model=DocumentOut,
             dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def upload_policy_extra_document(
    policy_id: str,
    background: BackgroundTasks,
    doc_key: str = Query(...),
    label: str = Query(...),
    file: UploadFile = File(...),
    actor: User = Depends(get_active_user),
) -> DocumentOut:
    """Attach an EXTRA supporting document (an RC book, previous policy, ID proof —
    the type's configured `required_documents`) to a policy. Unlike the primary
    policy PDF these are kept for the record and never auto-sent; re-uploading the
    same slot replaces it."""
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)

    data = await read_upload(file, 20 * 1024 * 1024, label="Document")

    # A slot is identified by (policy + doc_key): re-upload replaces the old file.
    old = await DocumentRecord.find(
        DocumentRecord.entity_type == "policy",
        DocumentRecord.entity_id == policy_id,
        DocumentRecord.doc_key == doc_key,
    ).to_list()
    for o in old:
        background.add_task(s3.delete_object, o.s3_key)
        await o.delete()

    key = s3.build_key("policy", policy_id, file.filename or f"{doc_key}")
    await run_in_threadpool(
        s3.get_s3_client().put_object,
        Bucket=settings.aws_bucket_name, Key=key, Body=data,
        ContentType=file.content_type or "application/octet-stream",
    )
    doc = DocumentRecord(
        entity_type="policy",
        entity_id=policy_id,
        doc_key=doc_key,
        label=label,
        s3_key=key,
        filename=file.filename or doc_key,
        content_type=file.content_type,
        size_bytes=len(data),
        status=DocumentStatus.UPLOADED,
        uploaded_by=str(actor.id),
    )
    await doc.insert()
    background.add_task(
        log_action,
        AuditAction.DOCUMENT_UPLOADED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", entity_id=policy_id, entity_code=pol.code,
        summary=f"Uploaded '{label}' for {pol.code}",
    )
    return DocumentOut.from_model(doc)


@router.patch("/{policy_id}", response_model=PolicyOut,
              dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def update_policy(policy_id: str, payload: PolicyUpdate,
                        background: BackgroundTasks,
                        actor: User = Depends(get_active_user)) -> PolicyOut:
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)
    _forbid_cancelled(pol)

    # NOTE: this router is staff-only (get_inhouse_user), so the old "if the
    # actor is a channel partner" branch here was unreachable and has gone with
    # partner policy submission.
    data = payload.model_dump(exclude_unset=True)
    changed_keys = set(data.keys())
    # Snapshot the simple (non-nested) fields for an old -> new audit diff.
    _audit_keys = [k for k in changed_keys if k not in ("reward", "details")]
    before_audit = {k: getattr(pol, k, None) for k in _audit_keys}
    if data.get("partner_id"):
        await _validate_partner(data["partner_id"])
    if data.get("broker_id"):
        await _validate_broker(data["broker_id"])
    if "policy_number" in data and data["policy_number"]:
        await _ensure_policy_number_unique(
            data["policy_number"], exclude_id=str(pol.id))
        data["policy_number"] = data["policy_number"].strip()
    # Validate a changed sub-type path against the policy's type tree.
    if "subcategory_path" in changed_keys:
        cat = await PolicyCategory.find_one(
            PolicyCategory.key == pol.category_key)
        new_path = data.get("subcategory_path") or []
        if cat and new_path and not path_is_valid(cat.children, new_path):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Unknown sub-type path for this policy type.")

    # Re-validate custom fields and/or re-pin the reward base when either changes.
    if {"details", "reward_base_field"} & changed_keys:
        cat = await PolicyCategory.find_one(
            PolicyCategory.key == pol.category_key)
        specs = list(cat.custom_fields) if cat else []
        if "details" in changed_keys:
            try:
                data["details"] = validate_details(specs, data.get("details"))
            except FieldValidationError as e:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
        # Resolve the base against the effective details (new if given, else stored).
        effective_specs = specs
        requested_base = data.get("reward_base_field",
                                  getattr(pol, "reward_base_field",
                                          "commissionable"))
        data["reward_base_field"] = resolve_reward_base_field(
            effective_specs, requested_base)

    # Rebuild the nested reward terms as a model (model_dump gives a plain dict).
    if "reward" in data:
        reward_val = data.pop("reward")
        if reward_val is not None:
            pol.reward = RewardTerms(**reward_val)
    for field, value in data.items():
        setattr(pol, field, value)
    if "subcategory_path" in changed_keys:
        pol.subcategory_key = leaf_key(pol.subcategory_path)
    if "partner_id" in changed_keys:
        pol.buyer_type = (BuyerType.CHANNEL_PARTNER if pol.partner_id
                          else BuyerType.DIRECT)
    # If the broker or sub-type changed (and no explicit reward was given),
    # re-price from the rate card.
    if ("reward" not in changed_keys
            and ({"broker_id", "subcategory_path"} & changed_keys)):
        pol.reward = RewardTerms()
        pol.reward = await resolve_reward_terms(pol)
    # No discount on partner-attributed policies (owner Q5) — enforced when the
    # edit touches either side, so untouched legacy rows stay editable.
    if {"partner_id", "discount_value", "discount_basis"} & changed_keys:
        _ensure_no_partner_discount(pol.partner_id, pol.discount_value)
    if {"discount_value", "discount_basis", "premium_amount"} & changed_keys:
        _ensure_discount_within_premium(pol.premium_amount, pol.discount_basis,
                                        pol.discount_value)
    pol.updated_at = utcnow()
    await pol.save()

    # Recompute reward + re-book finance when money/terms/partner/discount changed.
    finance_keys = {"premium_amount", "commissionable_premium", "gst_percent",
                    "reward", "partner_id", "payer", "discount_basis",
                    "discount_value", "broker_id", "subcategory_path",
                    "reward_base_field", "details"}
    if finance_keys & changed_keys:
        # Snapshot the reward's wallet position BEFORE re-pricing: if the partner
        # share (or the partner) changes after the wallet was credited, the old
        # credit must be pulled back and the new amount re-credited — otherwise
        # the partner keeps being owed the stale amount.
        old_reward = await Reward.find_one(Reward.policy_id == str(pol.id))
        old_state = None
        if old_reward is not None and old_reward.wallet_credited:
            old_state = (old_reward.partner_id, old_reward.partner_amount,
                         old_reward.wallet_available)
        reward = await sync_reward(pol)
        if old_state is not None and (
                old_state[0] != reward.partner_id
                or old_state[1] != reward.partner_amount):
            await wallet_svc.remove_stale_credit(
                old_state[0], old_state[1], old_state[2],
                ref_id=str(reward.id), actor_id=str(actor.id))
            reward.wallet_credited = False
            reward.wallet_available = False
            reward.updated_at = utcnow()
            await reward.save()
            await wallet_svc.apply_reward_outcome(
                reward, reward.status, actor_id=str(actor.id))
        await finance_svc.book_policy_finance(pol, reward)
        await finance_svc.sync_reward_cancellation(pol, reward)

    changes = await diff_dict_async(before_audit, {k: getattr(pol, k, None)
                                                    for k in _audit_keys})
    if "reward" in changed_keys:
        changes["reward"] = {"from": "…", "to": "re-priced"}
    clause = describe_changes(changes)
    background.add_task(
        log_action,
        AuditAction.POLICY_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", entity_id=str(pol.id), entity_code=pol.code,
        summary=f"Updated policy {pol.code}" + (f": {clause}" if clause else ""),
        meta={"changes": changes},
    )
    _recheck_targets(background, pol)
    reward = await Reward.find_one(Reward.policy_id == str(pol.id))
    return await _policy_out(
        pol, actor, reward_status=reward.status.value if reward else None)


@router.patch("/{policy_id}/status", response_model=PolicyOut,
              dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def change_status(policy_id: str, payload: PolicyStatusUpdate,
                        background: BackgroundTasks,
                        actor: User = Depends(get_active_user)) -> PolicyOut:
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)

    if payload.status == PolicyStatus.CANCELLED and \
            not can(actor, MANAGE_POLICIES):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You don't have permission to cancel policies.")
    # Cancellation is final (owner Q4): no transition out of CANCELLED.
    if pol.status == PolicyStatus.CANCELLED:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This policy is cancelled — cancellation is final. Book a new "
            "policy instead.")

    previous = pol.status
    pol.status = payload.status
    pol.updated_at = utcnow()
    await pol.save()

    # Cancelling a policy reverses any partner wallet credit, cancels the reward,
    # re-books the finance snapshot so the cancelled policy drops out of
    # commission/profit aggregates and the broker's pending-to-collect, and
    # wipes the buyer's premium due (owner Q3: option b).
    if payload.status == PolicyStatus.CANCELLED:
        reward = await Reward.find_one(Reward.policy_id == str(pol.id))
        if reward:
            await wallet_svc.reverse_reward(reward, actor_id=str(actor.id))
            reward.status = RewardStatus.CANCELLED
            reward.updated_at = utcnow()
            await reward.save()
            await finance_svc.book_policy_finance(pol, reward)
            await finance_svc.sync_reward_cancellation(pol, reward)
        await finance_svc.remove_policy_premium_artifacts(pol)
        # Nothing is left to collect for a cancelled policy.
        pf = await PolicyFinance.find_one(
            PolicyFinance.policy_id == str(pol.id))
        if pf is not None:
            from app.core.enums import SettlementStatus
            pf.settlement_status = SettlementStatus.SETTLED
            pf.updated_at = utcnow()
            await pf.save()

    # Money already taken on a policy that no longer exists.
    #
    # Cancelling correctly unwinds the AGENCY's side — the reward, the wallet
    # credit, the P&L snapshot, the premium due. It does nothing about premium
    # the customer has already PAID, and nothing should: refunding is a
    # decision, often a partial one, and inventing a ledger row here would be
    # the app deciding it. But nothing SAID so either, so a cancellation with
    # ₹40,000 sitting collected against it looked exactly like one with nothing
    # collected, and the refund was remembered or it was not.
    #
    # A notification, to the person who cancelled it. Not a blocking dialog: the
    # cancellation is right and complete, and the refund is a separate action
    # taken at whatever moment the agency decides.
    if payload.status == PolicyStatus.CANCELLED:
        collected = await _premium_collected(str(pol.id))
        if collected > 0:
            background.add_task(
                create_notification, str(actor.id),
                f"Refund may be due on {pol.code}",
                body=f"Rs {collected / 100:,.2f} of premium was collected on "
                     f"this policy before it was cancelled.",
                category="finance",
                link="/finance/transactions/new")

    action = (AuditAction.POLICY_CANCELLED
              if payload.status == PolicyStatus.CANCELLED
              else AuditAction.POLICY_STATUS_CHANGED)
    background.add_task(
        log_action,
        action, actor_id=str(actor.id), actor_name=actor.full_name,
        actor_role=actor.account_type.value, entity_type="policy",
        entity_id=str(pol.id), entity_code=pol.code,
        summary=f"Policy {pol.code}: {previous.value} -> {payload.status.value}",
        meta={"reason": payload.reason},
    )
    _recheck_targets(background, pol)
    reward = await Reward.find_one(Reward.policy_id == str(pol.id))
    return await _policy_out(
        pol, actor, reward_status=reward.status.value if reward else None)


@router.delete("/{policy_id}",
               dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def delete_policy(policy_id: str, background: BackgroundTasks,
                        actor: User = Depends(get_active_user)) -> dict:
    """Hard-delete a policy and unwind its finance: reverse any partner wallet
    credit, drop its reward + P&L snapshot, remove its ledger rows (recomputing
    the affected party balances), and purge its uploaded documents from S3 so
    nothing is left dangling (owner 2026-07-17)."""
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)

    # Purge the policy's S3 objects + their document records (best-effort S3).
    async for doc in DocumentRecord.find(
            DocumentRecord.entity_type == "policy",
            DocumentRecord.entity_id == str(pol.id)):
        background.add_task(s3.delete_object, doc.s3_key)
        await doc.delete()

    reward = await Reward.find_one(Reward.policy_id == str(pol.id))
    if reward is not None:
        # Pull back any reward credited to the partner's wallet/net balance.
        await wallet_svc.reverse_reward(reward, actor_id=str(actor.id))
        await reward.delete()

    pf = await PolicyFinance.find_one(PolicyFinance.policy_id == str(pol.id))
    if pf is not None:
        await pf.delete()

    # TDS events recorded against this policy's commission go with it, so the
    # TDS report never counts a deleted policy.
    from app.models.finance import TdsEntry
    async for e in TdsEntry.find(TdsEntry.policy_id == str(pol.id)):
        await e.delete()

    # Remove this policy's ledger rows and recompute the balances they touched.
    #
    # `bank_svc.unpost` FIRST, and it is not optional. A ledger row carries two
    # effects: the counterparty's running balance, which is rebuilt below from
    # the rows that remain, and the BANK ACCOUNT's `balance_paise`, which is a
    # cached running total maintained by an atomic $inc and is NOT rebuilt by
    # anything here. Deleting the row without backing that off left the account
    # holding money whose evidence had just been deleted — collect ₹50,000 of
    # premium into HDFC, delete the policy, and Bank & Cash goes on reporting
    # the ₹50,000 for ever. No error, no log line, and the only repair was for
    # somebody to happen to press "Rebuild balance" on that account.
    #
    # Every other delete path already did this (finance.delete_ledger_txn); this
    # one was written before bank accounts existed and never caught up.
    impacted: set[tuple] = set()
    async for t in LedgerTxn.find(LedgerTxn.policy_id == str(pol.id)):
        impacted.add((t.party_type, t.party_id))
        await bank_svc.unpost(t)
        await t.delete()
    for party_type, party_id in impacted:
        await finance_svc.recompute_party_account(party_type, party_id)

    code = pol.code
    # Capture who this policy counted for BEFORE it is gone — the roll-up needs
    # the partner and the frozen manager, not just the booking employee.
    affected = (pol,)
    await pol.delete()
    await log_action(
        AuditAction.POLICY_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", entity_id=policy_id, entity_code=code,
        summary=f"Deleted policy {code}")
    _recheck_targets(background, *affected)
    return {"detail": "Policy deleted."}


async def _premium_collected(policy_id: str) -> int:
    """Premium cash actually cleared against a policy, in paise.

    Same shape as `routers/finance._sum_collected`: PREMIUM_COLLECTED rows are
    stored NEGATIVE (the ledger's sign is the party-receivable view, not the
    cash direction), and a same-type reversal nets out against the original —
    so a payment that was taken and refunded correctly reports zero here rather
    than prompting for a second refund.
    """
    rows = await LedgerTxn.find(
        {"policy_id": policy_id,
         "txn_type": LedgerTxnType.PREMIUM_COLLECTED.value}).to_list()
    return sum(-t.amount_paise for t in rows)


async def _copy_supporting_documents(old: Policy, new: Policy,
                                     actor: User) -> int:
    """Carry a policy's supporting documents onto its renewal. Returns how many.

    NOT the policy PDF. That document describes ONE term's cover — copying it
    forward would hand the customer last year's certificate under this year's
    policy number, and `lib/policyDocs` treats the PDF as replace-only for the
    same reason.

    Each file is COPIED in S3 rather than the two records sharing a key:
    deleting a policy purges its objects, so a shared key would mean deleting
    the expiring policy silently emptied the renewal's KYC.

    Best-effort per document. A storage failure on one attachment must not
    unwind a renewal that has already booked its finance — the policy is real,
    and a missing copy is visible on the document list as an empty slot, which
    is exactly the state it would have been in without this feature.
    """
    from starlette.concurrency import run_in_threadpool

    copied = 0
    async for doc in DocumentRecord.find(
            DocumentRecord.entity_type == "policy",
            DocumentRecord.entity_id == str(old.id)):
        if doc.doc_key == "policy_pdf" or not doc.doc_key:
            continue
        dest = s3.build_key("policy", str(new.id), doc.filename)
        try:
            ok = await run_in_threadpool(s3.copy_object, doc.s3_key, dest)
        except Exception:  # noqa: BLE001
            ok = False
        if not ok:
            continue
        await DocumentRecord(
            entity_type="policy", entity_id=str(new.id),
            doc_key=doc.doc_key, label=doc.label, s3_key=dest,
            filename=doc.filename, content_type=doc.content_type,
            size_bytes=doc.size_bytes, status=doc.status,
            uploaded_by=str(actor.id)).insert()
        copied += 1
    return copied


@router.post("/{policy_id}/notify",
             dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def notify_policy(
    policy_id: str, background: BackgroundTasks,
    to: str = Query(default="customer", pattern="^(customer|partner)$"),
    actor: User = Depends(get_active_user),
) -> dict:
    """Send the policy document + summary to the customer or the attributed
    channel partner over WhatsApp + email (owner 2026-07-17). Delivery is
    best-effort in the background: it no-ops with a logged reason when the
    owner hasn't configured a sender yet, so the button is safe to ship now
    and starts working the moment credentials/templates are added."""
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)
    if to == "partner" and not pol.partner_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This policy has no channel partner attributed.")
    from app.services import messaging
    background.add_task(
        messaging.send_policy_document, pol, trigger="manual",
        to_customer=(to == "customer"), to_partner=(to == "partner"))
    await log_action(
        AuditAction.POLICY_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", entity_id=str(pol.id), entity_code=pol.code,
        summary=f"Notified {to} for policy {pol.code}")
    return {"detail": f"Sending the policy to the {to} (WhatsApp + email)…"}


@router.post("/{policy_id}/renew", response_model=PolicyOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def renew_policy(policy_id: str, payload: PolicyRenew,
                       background: BackgroundTasks,
                       actor: User = Depends(get_active_user)) -> PolicyOut:
    old = await Policy.get(await parse_object_id(policy_id))
    if old is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, old)
    _forbid_cancelled(old)
    if payload.policy_number:
        await _ensure_policy_number_unique(payload.policy_number)

    # Custom fields for the new term: re-collect if the form sent them (validated
    # against the type), else carry the old policy's values forward unchanged.
    cat = await PolicyCategory.find_one(
        PolicyCategory.key == old.category_key)
    specs = list(cat.custom_fields) if cat else []
    if payload.details is not None:
        try:
            new_details = validate_details(specs, payload.details)
        except FieldValidationError as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    else:
        new_details = old.details
    new_reward_base = resolve_reward_base_field(
        specs, payload.reward_base_field
        or getattr(old, "reward_base_field", "commissionable"))

    new = Policy(
        code=await next_code("policy"),
        policy_number=payload.policy_number,
        category_key=old.category_key,
        subcategory_path=old.subcategory_path,
        subcategory_key=old.subcategory_key,
        insurer_id=old.insurer_id,
        broker_id=old.broker_id,
        customer_id=old.customer_id,
        status=PolicyStatus.ACTIVE,
        premium_amount=payload.premium_amount,
        commissionable_premium=payload.commissionable_premium,
        gst_percent=old.gst_percent,
        sum_insured=old.sum_insured,
        issue_date=utcnow(),
        start_date=payload.start_date,
        expiry_date=payload.expiry_date,
        # Blank terms re-look-up the CURRENT rate under the Broker below; an
        # explicit reward from the caller (an edited renewal) is respected.
        reward=payload.reward or RewardTerms(),
        details=new_details,
        reward_base_field=new_reward_base,
        owner_user_id=old.owner_user_id,
        partner_id=old.partner_id,
        buyer_type=old.buyer_type,
        payer=old.payer,
        discount_basis=old.discount_basis,
        # No discount on partner-attributed policies (owner Q5) — a legacy
        # partner+discount policy renews clean instead of erroring.
        discount_value=0 if old.partner_id else old.discount_value,
        renewed_from_policy_id=str(old.id),
        created_by=str(actor.id),
    )
    # A renewal is new business for whoever holds the relationship TODAY, so
    # the stamp is taken fresh rather than copied off the expiring policy.
    await _stamp_manager(new, old.owner_user_id)
    _ensure_discount_within_premium(new.premium_amount, new.discount_basis,
                                    new.discount_value)
    new.reward = await resolve_reward_terms(new)
    await new.insert()
    reward = await sync_reward(new)
    if new.partner_id:
        await wallet_svc.credit_reward(reward)
    await finance_svc.book_policy_finance(new, reward)

    old.status = PolicyStatus.RENEWED
    old.updated_at = utcnow()
    await old.save()

    if payload.copy_documents:
        # Last year's RC book, KYC and supporting files, brought onto the new
        # term. Without this a renewal started with an EMPTY document set, so
        # paperwork that had not changed in a year had to be found and
        # re-uploaded — and the type's required-document slots showed as missing
        # on a policy where nothing was actually missing.
        await _copy_supporting_documents(old, new, actor)

    background.add_task(
        log_action,
        AuditAction.POLICY_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", entity_id=str(new.id), entity_code=new.code,
        summary=f"Renewed {old.code} -> {new.code}",
    )
    _recheck_targets(background, new, old)
    return await _policy_out(
        new, actor, reward_status=reward.status.value if reward else None)


@router.get("/{policy_id}/renewal-chain", response_model=list[PolicyOut],
            dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def renewal_chain(policy_id: str,
                        actor: User = Depends(get_active_user)) -> list[PolicyOut]:
    """The full renewal history for a policy: oldest term first, newest last."""
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    await ensure_can_access(actor, pol)

    # Walk back to the root term.
    root = pol
    guard = 0
    while root.renewed_from_policy_id and guard < 50:
        prev = await Policy.get(root.renewed_from_policy_id)
        if prev is None:
            break
        root = prev
        guard += 1

    # Walk forward collecting each successive renewal.
    chain: list[Policy] = [root]
    seen = {str(root.id)}
    cursor = root
    while len(chain) < 50:
        child = await Policy.find_one(
            Policy.renewed_from_policy_id == str(cursor.id))
        if child is None or str(child.id) in seen:
            break
        chain.append(child)
        seen.add(str(child.id))
        cursor = child

    cust = await Customer.get(pol.customer_id)
    insurer = await Insurer.get(await parse_object_id(pol.insurer_id))
    brk_map = await _broker_map(chain)
    return [PolicyOut.from_model(
        p, customer_name=cust.name if cust else None,
        insurer_name=insurer.name if insurer else None,
        broker_name=brk_map.get(p.broker_id, (None, None))[0],
        broker_code=brk_map.get(p.broker_id, (None, None))[1],
        hide_agency=_hide_agency(actor)) for p in chain]
