"""The Channel Partner portal — the ONLY surface a partner can reach.

Every staff router carries `get_inhouse_user` at the router level, so a
partner's token is refused everywhere else in the API. That makes this file the
entire attack surface of the portal, which is the point: it can be read end to
end, and a new staff endpoint elsewhere is closed by default.

THREE RULES, applied to every response here:

  1. SCOPE — a partner sees only records where partner_id == their own id. The
     scope is applied in the QUERY, never in the serialiser, so a bug in a
     response model cannot leak another partner's row.

  2. MONEY — a partner sees the premium, THEIR OWN earning in rupees, and where
     they stand with the agency. Never the agency's reward from the insurer,
     never house profit, never a rate card, never a broker, never a discount,
     and never a percentage (owner E1). The partner-facing schemas below simply
     have no field for those numbers, so there is nothing to forget to blank.

  3. READ-ONLY, ALMOST. A partner can write exactly two things: a QUOTE REQUEST
     and a CLAIM. That is the entire write surface (owner A1, 2026-08-05).
     Policies, premiums, rewards, customers, leads and payouts are written by
     staff on staff screens. The partner used to be able to submit a finished
     policy; they never had the policy number, the insurer or the rate, so the
     form only ever worked as retrospective data entry. Withdrawal requests went
     the same way — payouts are made by the team and appear here as
     transactions once they are recorded.

Every rupee shown here is read through a function that already exists and is
already tested: `finance_balance.partner_net_balance` and
`finance_balance.partner_ledger` are the SAME functions behind the agency's own
Balance Sheet and the partner statement PDF. A partner and the agency reading
different numbers for the same relationship is the worst bug this app can have,
and one shared function is how that is prevented rather than promised.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from beanie import PydanticObjectId
from fastapi import (
    APIRouter, Depends, File, HTTPException, Query, UploadFile, status,
)
from pydantic import BaseModel, Field, field_validator

from app.config import settings as app_settings
from app.core.dependencies import get_active_user, require_account_type
from app.core.enums import (
    QUOTE_CANCELLABLE,
    AccountType,
    AuditAction,
    ClaimStage,
    DocumentStatus,
    PolicyStatus,
    QuoteStage,
)
from app.models.announcement import Announcement
from app.models.base import utcnow
from app.models.claim import Claim, ClaimEvent
from app.models.customer import Customer
from app.models.document import DocumentRecord
from app.models.finance import PartyAccount
from app.models.insurer import Insurer
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.quote_request import QuoteEvent, QuoteRequest, option_expired
from app.models.reward import Reward
from app.models.user import User
from app.models.wallet import Wallet
from app.routers._helpers import parse_object_id, read_upload, search_regex
from app.schemas.common import Message, Page
from app.schemas.document import DocumentOut, DownloadUrlResponse
from app.services import apilog, s3, settings_svc
from app.services import targets as target_svc
from app.services.audit import log_action
from app.services.categories import path_is_valid
from app.services.codes import next_code
from app.services.finance_balance import partner_ledger, partner_net_balance
from app.services.finance_reports import IST, resolve_period, to_ist
from app.services.notifications import create_notification, notify_permission

router = APIRouter(
    prefix="/api/portal", tags=["portal"],
    # Partners only. Staff have their own, richer screens; letting an owner in
    # here would mean two code paths for the same data and two chances to
    # disagree about a number.
    dependencies=[Depends(require_account_type(AccountType.CHANNEL_PARTNER))])

# Cover expiring inside this window is "coming up for renewal".
RENEWAL_HORIZON_DAYS = 60
# Live cover, and therefore renewable.
_LIVE_STATUSES = (PolicyStatus.ACTIVE, PolicyStatus.RENEWAL_DUE)
# Uploads here are phone photos of an RC book or a dented bumper, not scanned
# policy documents — 10 MB is generous for that and mean for anything else.
_MAX_UPLOAD = 10 * 1024 * 1024
# The desk that owns each kind of work. Quote requests and claims got their
# OWN permission pairs in the 2026-08-07 split, and every notification here kept
# firing on `manage_policies` — so an employee hired to work quotes was told
# about none of them, while a policy-booking employee with no quote access was
# notified about a page that refuses to open for them. The link and the audience
# have to name the same permission.
_QUOTE_DESK = "manage_quotes"
_CLAIM_DESK = "manage_claims"


_OPEN_QUOTE_STAGES = (QuoteStage.SUBMITTED, QuoteStage.IN_REVIEW,
                      QuoteStage.INFO_NEEDED, QuoteStage.QUOTED,
                      QuoteStage.ACCEPTED)
_OPEN_CLAIM_STAGES = (ClaimStage.INTIMATED, ClaimStage.REGISTERED,
                      ClaimStage.DOCS_PENDING, ClaimStage.SURVEY,
                      ClaimStage.APPROVED)


# --- Capability gate ---------------------------------------------------------------


async def _capabilities():
    return (await settings_svc.get_settings()).partner_portal


async def _require(capability: str) -> None:
    """Refuse an action the owner has switched off for partners."""
    caps = await _capabilities()
    if not getattr(caps, capability, False):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This is not available in your portal. Contact your relationship "
            "manager.")


def _me(actor: User) -> dict:
    """The scope clause. Every query in this file starts from it."""
    return {"partner_id": str(actor.id)}


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return to_ist(dt if dt.tzinfo else dt.replace(tzinfo=IST))


def _enum(value) -> str:
    return value.value if hasattr(value, "value") else str(value)


def _window(period: str, date_from: Optional[str], date_to: Optional[str]):
    """The app's shared date presets, so "last month" means the same thing here
    as on every staff screen. A picked date is a CALENDAR date and therefore
    IST — attaching UTC to "2026-07-01" starts the range at 05:30 and silently
    drops half a day."""
    def _ist(value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return dt.replace(tzinfo=IST) if dt.tzinfo is None else dt

    return resolve_period(period, to_ist(datetime.now(tz=IST)),
                          _ist(date_from), _ist(date_to))


# --- Partner-safe response shapes ---------------------------------------------------
# These carry no agency reward, no house profit, no broker, no rate and no
# discount. The omission IS the safeguard: there is no field here that could
# leak, however the code below changes.


class PortalPolicy(BaseModel):
    id: str
    code: str
    policy_number: Optional[str] = None
    customer_name: Optional[str] = None
    customer_mobile: Optional[str] = None
    insurer_name: Optional[str] = None
    category_key: str
    category_label: Optional[str] = None
    subcategory_label: Optional[str] = None
    status: str
    premium_amount: int = 0
    sum_insured: int = 0
    start_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    # THEIR earning, in paise. Never a percentage (owner E1).
    my_earning: int = 0
    is_renewal: bool = False
    created_at: datetime


class PortalPolicyDetail(PortalPolicy):
    """One policy, fully: the type's own collected fields and its documents —
    everything about the record except the agency's side of the money."""

    details: dict[str, Any] = Field(default_factory=dict)
    field_labels: dict[str, str] = Field(default_factory=dict)
    documents: list[DocumentOut] = Field(default_factory=list)
    notes: Optional[str] = None
    days_to_expiry: Optional[int] = None
    open_claims: int = 0


class PortalRenewal(BaseModel):
    policy_id: str
    code: str
    policy_number: Optional[str] = None
    customer_name: Optional[str] = None
    customer_mobile: Optional[str] = None
    category_label: Optional[str] = None
    insurer_name: Optional[str] = None
    premium_amount: int = 0
    expiry_date: Optional[datetime] = None
    days_left: int = 0
    # True once a renewal enquiry exists, so the partner is not asked to chase
    # the same case twice.
    quote_requested: bool = False


class PortalMoney(BaseModel):
    """Where the partner stands with the agency, said in both directions.

    `net_balance` is `finance_balance.partner_net_balance`. > 0 the agency owes
    them, < 0 they owe the agency. BOTH SIDES are always shown (owner E2):
    hiding what they owe makes what they are owed wrong by subtraction, and
    that is how every payout ends in an argument.
    """

    net_balance: int = 0
    reward_earned_unpaid: int = 0     # reward the agency owes them
    premium_owed: int = 0             # premium they collected and still hold
    lifetime_earned: int = 0
    lifetime_paid: int = 0


class PortalSummary(BaseModel):
    """The Home screen. One request, everything above the fold."""

    period_label: str = ""
    policies: int = 0
    premium: int = 0
    my_earning: int = 0
    money: PortalMoney = Field(default_factory=PortalMoney)
    renewals_30d: int = 0
    renewals_7d: int = 0
    open_quotes: int = 0
    quotes_awaiting_me: int = 0       # info needed / quoted — ball with them
    open_claims: int = 0
    unread_notices: int = 0
    latest_notice: Optional[dict] = None
    recent_policies: list[PortalPolicy] = Field(default_factory=list)


class PortalTargetMetric(BaseModel):
    """One goal on a partner's target, with how far along they are.

    Deliberately NOT a re-export of `schemas.target.TargetMetricRow`: this is a
    partner-facing shape, and the rule in this file is that a partner-facing
    schema has no field for a number they may not see. The rows are already
    filtered server-side (allow_profit=False), and this shape is the second
    guarantee — there is no `house_profit` label to leak because there is
    nothing here that could carry the agency's margin.
    """

    metric: str
    label: str
    is_money: bool
    target_value: int
    actual_value: int = 0
    attainment_pct: float = 0.0


class PortalTarget(BaseModel):
    """What the agency asked this partner for, and where they have got to.

    A partner carries a target because their relationship manager splits their
    own goal across the roster (owner B1) — so this is the partner's half of a
    conversation they are already having on the phone. Showing them the number
    is the point: a target nobody can see is a spreadsheet, not a target.
    """

    window: str = "current"
    label: str = ""
    has_target: bool = False
    attainment_pct: float = 0.0
    metrics: list[PortalTargetMetric] = Field(default_factory=list)


class PortalEarningsRow(BaseModel):
    policy_id: str
    code: str
    policy_number: Optional[str] = None
    customer_name: Optional[str] = None
    category_label: Optional[str] = None
    booked_at: Optional[datetime] = None
    premium_amount: int = 0
    my_earning: int = 0


class PortalEarnings(BaseModel):
    period_label: str = ""
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    policies: int = 0
    premium: int = 0
    my_earning: int = 0
    rows: list[PortalEarningsRow] = Field(default_factory=list)


class PortalLedgerEntry(BaseModel):
    date: Optional[datetime] = None
    label: str = ""
    reference: Optional[str] = None
    policy: Optional[str] = None
    # Signed, in the partner-favour view: + the agency owes them more, − less.
    amount: int = 0
    balance: int = 0


class PortalTransactions(BaseModel):
    period_label: str = ""
    opening: int = 0
    closing: int = 0
    entries: list[PortalLedgerEntry] = Field(default_factory=list)


class PortalQuoteOption(BaseModel):
    id: str
    insurer_name: Optional[str] = None
    premium_amount: int = 0
    sum_insured: int = 0
    cover_from: Optional[datetime] = None
    cover_to: Optional[datetime] = None
    inclusions: Optional[str] = None
    my_earning: int = 0
    valid_until: Optional[datetime] = None
    expired: bool = False
    accepted_at: Optional[datetime] = None
    declined_at: Optional[datetime] = None


class PortalEvent(BaseModel):
    """One timeline entry, on a quote request or a claim."""

    at: datetime
    stage: Optional[str] = None
    by_name: Optional[str] = None
    by_side: str = "agency"
    message: Optional[str] = None


class PortalQuoteRequest(BaseModel):
    id: str
    code: str
    stage: str
    customer_name: str
    customer_mobile: str
    category_key: str
    category_label: Optional[str] = None
    subcategory_label: Optional[str] = None
    is_renewal: bool = False
    note: Optional[str] = None
    options: list[PortalQuoteOption] = Field(default_factory=list)
    can_cancel: bool = False
    created_at: datetime
    updated_at: datetime
    # NOTE: no `internal_notes`, no `assigned_to`, no `manager_id`. Who inside
    # the agency is handling it, and what they said to each other, is not the
    # partner's business.


class PortalQuoteDetail(PortalQuoteRequest):
    details: dict[str, Any] = Field(default_factory=dict)
    field_labels: dict[str, str] = Field(default_factory=dict)
    timeline: list[PortalEvent] = Field(default_factory=list)
    documents: list[DocumentOut] = Field(default_factory=list)
    policy_id: Optional[str] = None
    closed_reason: Optional[str] = None


class PortalClaim(BaseModel):
    id: str
    code: str
    stage: str
    policy_id: str
    policy_number: Optional[str] = None
    customer_name: Optional[str] = None
    category_label: Optional[str] = None
    incident_at: Optional[datetime] = None
    description: Optional[str] = None
    estimated_loss: int = 0
    insurer_claim_no: Optional[str] = None
    settlement_mode: Optional[str] = None
    surveyor_name: Optional[str] = None
    approved_amount: int = 0
    settled_amount: int = 0
    settled_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class PortalClaimDetail(PortalClaim):
    incident_location: Optional[str] = None
    timeline: list[PortalEvent] = Field(default_factory=list)
    documents: list[DocumentOut] = Field(default_factory=list)
    required_documents: list[dict] = Field(default_factory=list)


class PortalNotice(BaseModel):
    id: str
    code: str
    title: str
    body: str
    category: str
    valid_until: Optional[datetime] = None
    read_at: Optional[datetime] = None
    created_at: datetime


class PortalDocSlot(BaseModel):
    key: str
    label: str
    required: bool = False


class PortalCategory(BaseModel):
    key: str
    label: str
    children: list[dict] = Field(default_factory=list)
    fields: list[dict] = Field(default_factory=list)
    documents: list[PortalDocSlot] = Field(default_factory=list)


class PortalProfile(BaseModel):
    id: str
    code: str
    full_name: str
    email: str
    mobile: Optional[str] = None
    relationship_manager: Optional[str] = None
    relationship_manager_mobile: Optional[str] = None
    joined_at: Optional[datetime] = None
    capabilities: dict


# --- Request bodies — the ENTIRE write surface ----------------------------------------


class QuoteRequestIn(BaseModel):
    """What a partner may ask for.

    What is ABSENT is the design: no policy number, no insurer, no premium, no
    sum insured, no broker, no reward, no discount. Every one of those is an
    OUTPUT of quoting, which is the agency's job, and a field that does not
    exist cannot be smuggled in.

    There is deliberately no "expected premium" either — it becomes a promise to
    the customer that the team then has to break.
    """

    customer_name: str = Field(min_length=2, max_length=120)
    customer_mobile: str = Field(min_length=10, max_length=10)
    customer_email: Optional[str] = None
    category_key: str
    subcategory_path: list[str] = Field(default_factory=list)
    # The type's own fields. Collected, never enforced — this is an enquiry, and
    # refusing one over a missing field is how a partner stops sending them
    # (owner B6).
    details: dict[str, Any] = Field(default_factory=dict)
    note: Optional[str] = Field(default=None, max_length=2000)
    renewal_of_policy_id: Optional[str] = None

    @field_validator("customer_mobile")
    @classmethod
    def _mobile(cls, v: str) -> str:
        digits = "".join(ch for ch in str(v) if ch.isdigit())
        if len(digits) != 10:
            raise ValueError("Mobile must be exactly 10 digits.")
        return digits

    @field_validator("customer_name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Please enter the customer's name.")
        return v


class ReplyIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


class QuoteDecisionIn(BaseModel):
    option_id: str
    accept: bool
    reason: Optional[str] = Field(default=None, max_length=500)


class ClaimIn(BaseModel):
    policy_id: str
    incident_at: datetime
    incident_location: Optional[str] = Field(default=None, max_length=200)
    description: str = Field(min_length=5, max_length=2000)
    estimated_loss: int = Field(default=0, ge=0)     # paise


# --- Shared serialisers ---------------------------------------------------------------


async def _category_map() -> dict[str, PolicyCategory]:
    return {c.key: c async for c in PolicyCategory.find_all()}


def _sub_label(cat: Optional[PolicyCategory], path: list[str]) -> Optional[str]:
    """Human path down the type's sub-tree, e.g. "Four Wheeler > Zone A"."""
    if not cat or not path:
        return None
    labels, nodes = [], cat.children
    for key in path:
        node = next((n for n in nodes if n.key == key), None)
        if node is None:
            break
        labels.append(node.label)
        nodes = node.children
    return " > ".join(labels) or None


def _field_labels(cat: Optional[PolicyCategory]) -> dict[str, str]:
    return {f.key: f.label for f in (cat.custom_fields if cat else [])}


def _claim_slots(cat: Optional[PolicyCategory]) -> list[dict]:
    """The type's claim checklist (owner C3), so a partner is told what to bring
    instead of guessing and being asked twice."""
    return [{"key": d.key, "label": d.label, "required": d.required}
            for d in (cat.claim_documents if cat else [])]


def _oids(values) -> list[PydanticObjectId]:
    out = []
    for v in values:
        try:
            out.append(PydanticObjectId(v))
        except Exception:  # noqa: BLE001 — a malformed id resolves to nothing
            continue
    return out


async def _customers_for(policies) -> dict[str, Customer]:
    ids = _oids([p.customer_id for p in policies if p.customer_id])
    if not ids:
        return {}
    return {str(c.id): c async for c in Customer.find({"_id": {"$in": ids}})}


async def _insurers_for(policies) -> dict[str, str]:
    ids = _oids([p.insurer_id for p in policies if p.insurer_id])
    if not ids:
        return {}
    return {str(i.id): i.name async for i in Insurer.find({"_id": {"$in": ids}})}


async def _earnings_for(policy_ids: list[str]) -> dict[str, int]:
    """What the partner earns on each of these policies, in paise.

    Read off `Reward.partner_amount` — the figure that was BOOKED, not a
    recomputation from the rate. The partner's screen and the agency's wallet
    have to be the same number or the first payout is a dispute.
    """
    if not policy_ids:
        return {}
    return {r.policy_id: r.partner_amount
            async for r in Reward.find({"policy_id": {"$in": policy_ids}})}


def _portal_policy(p: Policy, *, earning: int, cat: Optional[PolicyCategory],
                   customer=None, insurer_name: Optional[str] = None
                   ) -> PortalPolicy:
    return PortalPolicy(
        id=str(p.id), code=p.code, policy_number=p.policy_number,
        customer_name=getattr(customer, "name", None),
        customer_mobile=getattr(customer, "mobile", None),
        insurer_name=insurer_name,
        category_key=p.category_key,
        category_label=cat.label if cat else p.category_key,
        subcategory_label=_sub_label(cat, p.subcategory_path),
        status=_enum(p.status),
        premium_amount=p.premium_amount, sum_insured=p.sum_insured,
        start_date=p.start_date, expiry_date=p.expiry_date,
        my_earning=earning,
        is_renewal=bool(p.renewed_from_policy_id),
        created_at=p.created_at,
    )


def _portal_option(o, now: datetime) -> PortalQuoteOption:
    return PortalQuoteOption(
        id=o.id, insurer_name=o.insurer_name,
        premium_amount=o.premium_amount, sum_insured=o.sum_insured,
        cover_from=o.cover_from, cover_to=o.cover_to,
        inclusions=o.inclusions, my_earning=o.partner_earning,
        valid_until=o.valid_until,
        # models/quote_request.option_expired — one rule, shared with the staff
        # queue's Expired flag and with the re-quote action below.
        expired=option_expired(o, now),
        accepted_at=o.accepted_at, declined_at=o.declined_at)


def _portal_quote(q: QuoteRequest, cat: Optional[PolicyCategory],
                  *, now: datetime) -> PortalQuoteRequest:
    return PortalQuoteRequest(
        id=str(q.id), code=q.code, stage=_enum(q.stage),
        customer_name=q.customer_name, customer_mobile=q.customer_mobile,
        category_key=q.category_key,
        category_label=cat.label if cat else q.category_key,
        subcategory_label=_sub_label(cat, q.subcategory_path),
        is_renewal=q.is_renewal, note=q.note,
        options=[_portal_option(o, now) for o in q.options],
        can_cancel=q.stage in QUOTE_CANCELLABLE,
        created_at=q.created_at, updated_at=q.updated_at)


def _timeline(events) -> list[PortalEvent]:
    return [PortalEvent(at=e.at, stage=e.stage, by_name=e.by_name,
                        by_side=e.by_side, message=e.message)
            for e in events]


def _portal_claim(c: Claim, cat: Optional[PolicyCategory]) -> PortalClaim:
    return PortalClaim(
        id=str(c.id), code=c.code, stage=_enum(c.stage),
        policy_id=c.policy_id, policy_number=c.policy_number,
        customer_name=c.customer_name,
        category_label=cat.label if cat else c.category_key,
        incident_at=c.incident_at, description=c.description,
        estimated_loss=c.estimated_loss, insurer_claim_no=c.insurer_claim_no,
        settlement_mode=_enum(c.settlement_mode) if c.settlement_mode else None,
        surveyor_name=c.surveyor_name,
        approved_amount=c.approved_amount, settled_amount=c.settled_amount,
        settled_at=c.settled_at, rejection_reason=c.rejection_reason,
        created_at=c.created_at, updated_at=c.updated_at)


async def _docs_for(entity_type: str, entity_id: str) -> list[DocumentOut]:
    return [DocumentOut.from_model(d) async for d in DocumentRecord.find(
        {"entity_type": entity_type, "entity_id": entity_id}
    ).sort("+created_at")]


async def _money(actor: User) -> PortalMoney:
    """Where the partner stands, both sides, one definition."""
    wallet = await Wallet.find_one(Wallet.partner_id == str(actor.id))
    account = await PartyAccount.find_one(
        PartyAccount.party_type == "channel_partner",
        PartyAccount.party_id == str(actor.id))
    reward_owed = (wallet.available_paise + wallet.pending_paise) if wallet else 0
    premium_owed = account.balance_paise if account else 0
    return PortalMoney(
        net_balance=partner_net_balance(reward_owed, premium_owed),
        reward_earned_unpaid=reward_owed,
        premium_owed=premium_owed,
        lifetime_earned=wallet.lifetime_earned_paise if wallet else 0,
        lifetime_paid=wallet.lifetime_withdrawn_paise if wallet else 0)


async def _upload_to(entity_type: str, entity_id: str, file: UploadFile,
                     actor: User, doc_key: str, label: str) -> DocumentOut:
    """Shared upload for quote-request and claim attachments."""
    data = await read_upload(file, _MAX_UPLOAD, label="File")
    key = s3.build_key(entity_type, entity_id, file.filename or "upload")
    s3.get_s3_client().put_object(
        Bucket=app_settings.aws_bucket_name, Key=key, Body=data,
        ContentType=file.content_type or "application/octet-stream")
    apilog.track("s3", "put_object", bytes_transferred=len(data),
                 actor_id=str(actor.id), related_type=entity_type,
                 related_id=entity_id)
    doc = DocumentRecord(
        entity_type=entity_type, entity_id=entity_id,
        doc_key=doc_key or None, label=label or "Document", s3_key=key,
        filename=file.filename or "upload", content_type=file.content_type,
        size_bytes=len(data), status=DocumentStatus.UPLOADED,
        uploaded_by=str(actor.id))
    await doc.insert()
    return DocumentOut.from_model(doc)


# --- Home -----------------------------------------------------------------------------


@router.get("/summary", response_model=PortalSummary)
async def summary(actor: User = Depends(get_active_user),
                  period: str = Query(default="current_month"),
                  date_from: str | None = Query(default=None),
                  date_to: str | None = Query(default=None)) -> PortalSummary:
    """Everything above the fold on Home, in ONE request.

    A partner opens this on a phone, on mobile data. Four round trips to draw
    one screen is the difference between a portal they use and one they give up
    on, so this is deliberately a single fat read.
    """
    lo, hi, label = _window(period, date_from, date_to)
    now = datetime.now(tz=IST)
    mine = _me(actor)

    policies = await Policy.find(mine).sort("-created_at").to_list()
    cats = await _category_map()
    earnings = await _earnings_for([str(p.id) for p in policies])

    in_window = [p for p in policies if lo <= _aware(p.created_at) <= hi]
    horizon_30, horizon_7 = now + timedelta(days=30), now + timedelta(days=7)
    renew_30 = renew_7 = 0
    for p in policies:
        expiry = _aware(p.expiry_date)
        if expiry is None or p.status not in _LIVE_STATUSES:
            continue
        if now <= expiry <= horizon_30:
            renew_30 += 1
            if expiry <= horizon_7:
                renew_7 += 1

    open_quotes = await QuoteRequest.find({
        **mine, "stage": {"$in": [s.value for s in _OPEN_QUOTE_STAGES]}}).count()
    awaiting = await QuoteRequest.find({
        **mine, "stage": {"$in": [QuoteStage.INFO_NEEDED.value,
                                  QuoteStage.QUOTED.value]}}).count()
    open_claims = await Claim.find({
        **mine, "stage": {"$in": [s.value for s in _OPEN_CLAIM_STAGES]}}).count()

    notices = await Announcement.find(
        {"receipts.partner_id": str(actor.id), "withdrawn_at": None}
    ).sort("-created_at").limit(20).to_list()
    unread, latest = 0, None
    for a in notices:
        receipt = next((r for r in a.receipts
                        if r.partner_id == str(actor.id)), None)
        if receipt and receipt.read_at is None:
            unread += 1
        if latest is None:
            latest = {"id": str(a.id), "title": a.title,
                      "category": _enum(a.category),
                      "created_at": a.created_at.isoformat(),
                      "read": bool(receipt and receipt.read_at)}

    recent = policies[:5]
    customers = await _customers_for(recent)
    insurers = await _insurers_for(recent)
    return PortalSummary(
        period_label=label,
        policies=len(in_window),
        premium=sum(p.premium_amount for p in in_window),
        my_earning=sum(earnings.get(str(p.id), 0) for p in in_window),
        money=await _money(actor),
        renewals_30d=renew_30, renewals_7d=renew_7,
        open_quotes=open_quotes, quotes_awaiting_me=awaiting,
        open_claims=open_claims,
        unread_notices=unread, latest_notice=latest,
        recent_policies=[
            _portal_policy(p, earning=earnings.get(str(p.id), 0),
                           cat=cats.get(p.category_key),
                           customer=customers.get(p.customer_id),
                           insurer_name=insurers.get(p.insurer_id))
            for p in recent])


@router.get("/target", response_model=PortalTarget)
async def my_target(actor: User = Depends(get_active_user),
                    window: str = Query(default="current",
                                        pattern="^(current|prev1|prev2)$")
                    ) -> PortalTarget:
    """This partner's own target for one month (owner E1-E3, 2026-08-06).

    Its own request rather than a field on /summary, for one reason: the card
    has a month switcher, and /summary's window is a *date filter* over the
    policy book, not a target period. Folding the two together would mean two
    ways of deciding what "last month" means, which is how the card and the
    tiles below it end up disagreeing.

    Every figure is read through `services/targets` — the SAME functions behind
    the staff dashboard and the Team tab, scored against `Policy.partner_id`.
    A partner and their relationship manager reading different percentages for
    the same month is the argument this endpoint exists to prevent.

    HOUSE PROFIT NEVER REACHES HERE: `allow_profit=False` strips the row before
    it is serialised, and PortalTargetMetric has no field that could carry it
    even if it did not.
    """
    lo, hi, label = target_svc.progress_window(window, utcnow())
    targets = await target_svc.targets_for([str(actor.id)], lo, hi)
    # The FULL month's goal, never a slice of elapsed time — see
    # services/targets.full_goals for the bug that distinction fixes.
    goals = target_svc.full_goals(targets, lo, hi)
    _emp, by_partner = await target_svc.actuals_by_assignee(lo, hi)
    rows = target_svc.metric_rows(
        goals, by_partner.get(str(actor.id), target_svc.blank_metrics()),
        allow_profit=False)
    return PortalTarget(
        window=window, label=label, has_target=bool(goals),
        attainment_pct=target_svc.overall_attainment(rows),
        metrics=[PortalTargetMetric(
            metric=r["metric"], label=r["label"], is_money=r["is_money"],
            target_value=r["target_value"], actual_value=r["actual_value"],
            attainment_pct=r["attainment_pct"]) for r in rows])


@router.get("/profile", response_model=PortalProfile)
async def profile(actor: User = Depends(get_active_user)) -> PortalProfile:
    caps = await _capabilities()
    manager = mobile = None
    if actor.relationship_manager_id:
        try:
            rm = await User.get(PydanticObjectId(actor.relationship_manager_id))
        except Exception:  # noqa: BLE001
            rm = None
        if rm:
            manager, mobile = rm.full_name, rm.mobile
    return PortalProfile(
        id=str(actor.id), code=actor.code, full_name=actor.full_name,
        email=actor.email, mobile=actor.mobile,
        relationship_manager=manager, relationship_manager_mobile=mobile,
        joined_at=actor.created_at,
        capabilities=caps.model_dump(exclude={"access_backfilled_at"}))


# --- Policies (read-only, always) ------------------------------------------------------


@router.get("/policies", response_model=Page[PortalPolicy])
async def my_policies(
    actor: User = Depends(get_active_user),
    q: str | None = Query(default=None),
    category_key: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    period: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[PortalPolicy]:
    query: dict = dict(_me(actor))
    if category_key:
        query["category_key"] = category_key
    if status_filter:
        query["status"] = status_filter
    if period:
        lo, hi, _ = _window(period, date_from, date_to)
        query["created_at"] = {"$gte": lo, "$lte": hi}
    if q:
        query["$or"] = [{"policy_number": search_regex(q)},
                        {"code": search_regex(q)}]

    total = await Policy.find(query).count()
    rows = (await Policy.find(query).sort("-created_at")
            .skip((page - 1) * page_size).limit(page_size).to_list())
    cats = await _category_map()
    earnings = await _earnings_for([str(p.id) for p in rows])
    customers = await _customers_for(rows)
    insurers = await _insurers_for(rows)
    return Page[PortalPolicy](
        items=[_portal_policy(p, earning=earnings.get(str(p.id), 0),
                              cat=cats.get(p.category_key),
                              customer=customers.get(p.customer_id),
                              insurer_name=insurers.get(p.insurer_id))
               for p in rows],
        total=total, page=page, page_size=page_size)


async def _own_policy(actor: User, policy_id: str) -> Policy:
    """Load a policy that belongs to THIS partner, or 404.

    A 403 would confirm the record exists, which is itself a leak on a numbered
    resource — so somebody else's policy is indistinguishable from one that
    does not exist.
    """
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None or pol.partner_id != str(actor.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    return pol


@router.get("/policies/{policy_id}", response_model=PortalPolicyDetail)
async def my_policy(policy_id: str, actor: User = Depends(get_active_user)
                    ) -> PortalPolicyDetail:
    pol = await _own_policy(actor, policy_id)
    cats = await _category_map()
    cat = cats.get(pol.category_key)
    earnings = await _earnings_for([str(pol.id)])
    customers = await _customers_for([pol])
    insurers = await _insurers_for([pol])
    base = _portal_policy(pol, earning=earnings.get(str(pol.id), 0), cat=cat,
                          customer=customers.get(pol.customer_id),
                          insurer_name=insurers.get(pol.insurer_id))

    caps = await _capabilities()
    docs = await _docs_for("policy", str(pol.id)) \
        if caps.can_download_policy_pdf else []
    expiry = _aware(pol.expiry_date)
    days = (expiry - datetime.now(tz=IST)).days if expiry else None
    open_claims = await Claim.find({
        "policy_id": str(pol.id), **_me(actor),
        "stage": {"$in": [s.value for s in _OPEN_CLAIM_STAGES]}}).count()

    return PortalPolicyDetail(
        **base.model_dump(), details=pol.details or {},
        field_labels=_field_labels(cat), documents=docs, notes=pol.notes,
        days_to_expiry=days, open_claims=open_claims)


@router.get("/policies/{policy_id}/documents/{document_id}",
            response_model=DownloadUrlResponse)
async def download_my_policy_document(
    policy_id: str, document_id: str,
    actor: User = Depends(get_active_user),
) -> DownloadUrlResponse:
    """A presigned link to one of THEIR policy's documents (owner Q9).

    Scoped twice on purpose: the policy must be theirs AND the document must
    belong to that policy. Either check alone lets a crafted id through.
    """
    await _require("can_download_policy_pdf")
    pol = await _own_policy(actor, policy_id)
    doc = await DocumentRecord.get(await parse_object_id(document_id))
    if doc is None or doc.entity_type != "policy" \
            or doc.entity_id != str(pol.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    return DownloadUrlResponse(
        url=s3.presigned_download(doc.s3_key, doc.filename),
        expires_in=app_settings.s3_presign_expire_seconds)


# --- Renewals ---------------------------------------------------------------------------


@router.get("/renewals", response_model=list[PortalRenewal])
async def my_renewals(actor: User = Depends(get_active_user),
                      days: int = Query(default=RENEWAL_HORIZON_DAYS,
                                        ge=1, le=365)) -> list[PortalRenewal]:
    """Their book expiring soon, soonest first.

    The highest-value screen in the portal: the agency's renewal book, chased
    by the person who sold it.
    """
    await _require("can_view_renewals")
    now = datetime.now(tz=IST)
    horizon = now + timedelta(days=days)
    rows = await Policy.find({
        **_me(actor),
        "status": {"$in": [s.value for s in _LIVE_STATUSES]}}).to_list()
    cats = await _category_map()
    customers = await _customers_for(rows)
    insurers = await _insurers_for(rows)
    asked = {q.renewal_of_policy_id async for q in QuoteRequest.find({
        **_me(actor), "renewal_of_policy_id": {"$ne": None},
        "stage": {"$nin": [QuoteStage.CANCELLED.value, QuoteStage.LOST.value]}})}

    out: list[PortalRenewal] = []
    for p in rows:
        expiry = _aware(p.expiry_date)
        if expiry is None or not (now <= expiry <= horizon):
            continue
        cat = cats.get(p.category_key)
        cust = customers.get(p.customer_id)
        out.append(PortalRenewal(
            policy_id=str(p.id), code=p.code, policy_number=p.policy_number,
            customer_name=getattr(cust, "name", None),
            customer_mobile=getattr(cust, "mobile", None),
            category_label=cat.label if cat else p.category_key,
            insurer_name=insurers.get(p.insurer_id),
            premium_amount=p.premium_amount, expiry_date=p.expiry_date,
            days_left=(expiry - now).days,
            quote_requested=str(p.id) in asked))
    out.sort(key=lambda r: r.days_left)
    return out


# --- Earnings ---------------------------------------------------------------------------


@router.get("/earnings", response_model=PortalEarnings)
async def my_earnings(actor: User = Depends(get_active_user),
                      period: str = Query(default="current_month"),
                      date_from: str | None = Query(default=None),
                      date_to: str | None = Query(default=None)
                      ) -> PortalEarnings:
    """The monthly report: what they wrote in the period and what it earned,
    policy by policy — so the total can be CHECKED rather than trusted."""
    await _require("can_view_earnings")
    lo, hi, label = _window(period, date_from, date_to)
    rows = await Policy.find({
        **_me(actor), "created_at": {"$gte": lo, "$lte": hi}}
    ).sort("-created_at").to_list()
    cats = await _category_map()
    earnings = await _earnings_for([str(p.id) for p in rows])
    customers = await _customers_for(rows)

    items = [PortalEarningsRow(
        policy_id=str(p.id), code=p.code, policy_number=p.policy_number,
        customer_name=getattr(customers.get(p.customer_id), "name", None),
        category_label=(cats[p.category_key].label
                        if p.category_key in cats else p.category_key),
        booked_at=p.created_at, premium_amount=p.premium_amount,
        my_earning=earnings.get(str(p.id), 0)) for p in rows]
    return PortalEarnings(
        period_label=label, date_from=lo, date_to=hi, policies=len(items),
        premium=sum(i.premium_amount for i in items),
        my_earning=sum(i.my_earning for i in items), rows=items)


@router.get("/money", response_model=PortalMoney)
async def my_money(actor: User = Depends(get_active_user)) -> PortalMoney:
    await _require("can_view_earnings")
    return await _money(actor)


@router.get("/transactions", response_model=PortalTransactions)
async def my_transactions(actor: User = Depends(get_active_user),
                          period: str = Query(default="current_month"),
                          date_from: str | None = Query(default=None),
                          date_to: str | None = Query(default=None)
                          ) -> PortalTransactions:
    """Every movement between this partner and the agency.

    `finance_balance.partner_ledger` — the SAME function behind the staff-side
    partner statement PDF. A partner holding a statement that disagrees with
    the agency's own report is the worst argument to have.
    """
    await _require("can_view_earnings")
    lo, hi, label = _window(period, date_from, date_to)
    codes = {str(p.id): p.code async for p in Policy.find(_me(actor))}
    data = await partner_ledger(str(actor.id), lo, hi, codes)
    return PortalTransactions(
        period_label=label,
        opening=data.get("opening", 0), closing=data.get("closing", 0),
        entries=[PortalLedgerEntry(
            date=e.get("date"), label=e.get("label", ""),
            reference=e.get("reference"), policy=e.get("policy"),
            amount=e.get("amount", 0), balance=e.get("balance", 0))
            for e in data.get("entries", [])])


# --- Quote requests (WRITE) --------------------------------------------------------------


@router.get("/quote-options", response_model=list[PortalCategory])
async def quote_form_options() -> list[PortalCategory]:
    """The policy types a partner may ask about, with the sub-tree, the type's
    own fields, and the documents to bring.

    Reuses YOUR configured `PolicyCategory` — not a second taxonomy.
    Configuring "Motor needs an RC book" on the Policy Types page automatically
    tells every partner what to attach, for free.
    """
    await _require("can_request_quotes")
    out = []
    async for c in PolicyCategory.find({"active": True}).sort("+sort_order"):
        out.append(PortalCategory(
            key=c.key, label=c.label,
            children=[n.model_dump() for n in c.children],
            # All of the type's fields (owner B6), none marked required: this is
            # an enquiry, not a booking.
            fields=[{"key": f.key, "label": f.label, "type": f.type,
                     "options": f.options, "hint": f.hint}
                    for f in c.custom_fields],
            documents=[PortalDocSlot(key=d.key, label=d.label, required=False)
                       for d in c.required_documents]))
    return out


@router.get("/quotes", response_model=Page[PortalQuoteRequest])
async def my_quotes(actor: User = Depends(get_active_user),
                    stage: str | None = Query(default=None),
                    page: int = Query(default=1, ge=1),
                    page_size: int = Query(default=20, ge=1, le=100)
                    ) -> Page[PortalQuoteRequest]:
    query: dict = dict(_me(actor))
    if stage:
        query["stage"] = stage
    total = await QuoteRequest.find(query).count()
    rows = (await QuoteRequest.find(query).sort("-created_at")
            .skip((page - 1) * page_size).limit(page_size).to_list())
    cats = await _category_map()
    now = datetime.now(tz=IST)
    return Page[PortalQuoteRequest](
        items=[_portal_quote(q, cats.get(q.category_key), now=now)
               for q in rows],
        total=total, page=page, page_size=page_size)


async def _own_quote(actor: User, quote_id: str) -> QuoteRequest:
    q = await QuoteRequest.get(await parse_object_id(quote_id))
    if q is None or q.partner_id != str(actor.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Request not found.")
    return q


async def _quote_detail(q: QuoteRequest, cat: Optional[PolicyCategory],
                        *, with_docs: bool = True) -> PortalQuoteDetail:
    base = _portal_quote(q, cat, now=datetime.now(tz=IST))
    return PortalQuoteDetail(
        **base.model_dump(), details=q.details or {},
        field_labels=_field_labels(cat), timeline=_timeline(q.timeline),
        documents=await _docs_for("quote_request", str(q.id))
        if with_docs else [],
        policy_id=q.policy_id, closed_reason=q.closed_reason)


@router.get("/quotes/{quote_id}", response_model=PortalQuoteDetail)
async def my_quote(quote_id: str, actor: User = Depends(get_active_user)
                   ) -> PortalQuoteDetail:
    q = await _own_quote(actor, quote_id)
    cats = await _category_map()
    return await _quote_detail(q, cats.get(q.category_key))


@router.post("/quotes", response_model=PortalQuoteDetail,
             status_code=status.HTTP_201_CREATED)
async def raise_quote_request(payload: QuoteRequestIn,
                              actor: User = Depends(get_active_user)
                              ) -> PortalQuoteDetail:
    """A partner asks the agency to price a case.

    Nothing is earned, priced or booked here. This creates an ENQUIRY and puts
    it on somebody's desk — the partner's relationship manager by default, and
    workable by anyone with the permission (owner B4.1).
    """
    await _require("can_request_quotes")
    cat = await PolicyCategory.find_one(
        PolicyCategory.key == payload.category_key)
    if cat is None or not cat.active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown policy type.")
    if payload.subcategory_path and not path_is_valid(
            cat.children, payload.subcategory_path):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Unknown sub-type for this policy type.")

    renewal_of = None
    if payload.renewal_of_policy_id:
        # Their own policy only, through the same 404-not-403 rule.
        renewal_of = str((await _own_policy(
            actor, payload.renewal_of_policy_id)).id)

    manager = None
    if actor.relationship_manager_id:
        try:
            manager = await User.get(
                PydanticObjectId(actor.relationship_manager_id))
        except Exception:  # noqa: BLE001
            manager = None

    q = QuoteRequest(
        code=await next_code("quote"),
        partner_id=str(actor.id), partner_name=actor.full_name,
        manager_id=str(manager.id) if manager else None,
        manager_name=manager.full_name if manager else None,
        assigned_to_id=str(manager.id) if manager else None,
        assigned_to_name=manager.full_name if manager else None,
        customer_name=payload.customer_name,
        customer_mobile=payload.customer_mobile,
        customer_email=(payload.customer_email or "").strip() or None,
        category_key=payload.category_key,
        subcategory_path=payload.subcategory_path,
        details=payload.details or {},
        is_renewal=bool(renewal_of), renewal_of_policy_id=renewal_of,
        note=payload.note,
        timeline=[QuoteEvent(stage=QuoteStage.SUBMITTED.value,
                             by_id=str(actor.id), by_name=actor.full_name,
                             by_side="partner", message="Request submitted")])
    await q.insert()

    await notify_permission(
        _QUOTE_DESK,
        title=f"New quote request from {actor.full_name}",
        body=f"{cat.label} for {payload.customer_name}",
        category="quote", link=f"/quotes/{q.id}")
    await log_action(
        AuditAction.POLICY_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="quote_request", entity_id=str(q.id), entity_code=q.code,
        summary=f"Quote request {q.code} raised ({cat.label})")
    return await _quote_detail(q, cat, with_docs=False)


@router.post("/quotes/{quote_id}/documents", response_model=DocumentOut)
async def attach_quote_document(
    quote_id: str,
    doc_key: str = Query(default=""),
    label: str = Query(default="Document"),
    file: UploadFile = File(...),
    actor: User = Depends(get_active_user),
) -> DocumentOut:
    """Attach a photo or PDF to their own request — the RC book, the previous
    policy, the vehicle photos."""
    await _require("can_request_quotes")
    q = await _own_quote(actor, quote_id)
    if q.stage in (QuoteStage.ISSUED, QuoteStage.CANCELLED, QuoteStage.LOST):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This request is closed.")
    return await _upload_to("quote_request", str(q.id), file, actor,
                            doc_key, label)


@router.post("/quotes/{quote_id}/reply", response_model=Message)
async def reply_on_quote(quote_id: str, payload: ReplyIn,
                         actor: User = Depends(get_active_user)) -> Message:
    """Answer a "we need X". Keeps the conversation on the record rather than
    in somebody's WhatsApp."""
    q = await _own_quote(actor, quote_id)
    if q.stage in (QuoteStage.ISSUED, QuoteStage.CANCELLED):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This request is closed.")
    # INFO_NEEDED means "waiting on the partner". Answering is exactly the event
    # that stops being true, and nothing moved the stage back — so the queue went
    # on reading "waiting on them" while the ball was with the agency, and the
    # partner's own screen kept showing the amber "Agastya needs something from
    # you" strip after they had sent it. The reply IS the response.
    answered = q.stage == QuoteStage.INFO_NEEDED
    if answered:
        q.stage = QuoteStage.IN_REVIEW
    q.timeline.append(QuoteEvent(
        # Stamped only when the stage actually moved: a plain message on an
        # already-in-review request is a comment, not a transition, and a
        # timeline full of "In review" against every line stops being readable.
        stage=QuoteStage.IN_REVIEW.value if answered else None,
        by_id=str(actor.id), by_name=actor.full_name, by_side="partner",
        message=payload.message))
    q.updated_at = utcnow()
    await q.save()
    await notify_permission(
        _QUOTE_DESK,
        title=(f"{q.partner_name or 'The partner'} answered — {q.code}"
               if answered else f"Reply on {q.code}"),
        body=payload.message[:140], category="quote", link=f"/quotes/{q.id}")
    return Message(detail="Sent.")


@router.post("/quotes/{quote_id}/decision", response_model=PortalQuoteDetail)
async def decide_on_quote(quote_id: str, payload: QuoteDecisionIn,
                          actor: User = Depends(get_active_user)
                          ) -> PortalQuoteDetail:
    """Accept or decline a quoted option.

    Accepting does NOT create a policy — staff book it from the normal form
    with the broker and the rate card (owner A3). What it does is tell them to.
    """
    q = await _own_quote(actor, quote_id)
    if q.stage != QuoteStage.QUOTED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "There is nothing to decide on right now.")
    option = next((o for o in q.options if o.id == payload.option_id), None)
    if option is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Quote not found.")
    valid = _aware(option.valid_until)
    if payload.accept and valid and valid < datetime.now(tz=IST):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This quote has expired. Ask for a fresh one — premiums move.")

    now = utcnow()
    if payload.accept:
        option.accepted_at = now
        q.stage = QuoteStage.ACCEPTED
        message = "Quote accepted"
    else:
        option.declined_at = now
        option.decline_reason = payload.reason
        q.stage = QuoteStage.LOST
        q.closed_reason = payload.reason or "Declined by customer"
        message = "Quote declined"
    q.timeline.append(QuoteEvent(
        stage=q.stage.value, by_id=str(actor.id), by_name=actor.full_name,
        by_side="partner", message=message))
    q.updated_at = now
    await q.save()

    await notify_permission(
        _QUOTE_DESK, title=f"{message}: {q.code}",
        body=f"{q.customer_name} — {q.partner_name}",
        category="quote", link=f"/quotes/{q.id}")
    cats = await _category_map()
    return await _quote_detail(q, cats.get(q.category_key))


@router.get("/quotes/{quote_id}/documents/{document_id}",
            response_model=DownloadUrlResponse)
async def download_my_quote_document(
    quote_id: str, document_id: str,
    actor: User = Depends(get_active_user),
) -> DownloadUrlResponse:
    """A presigned link to a document on THEIR OWN quote request.

    This did not exist until 2026-08-19, and the portal screen said so out loud:
    tapping any attachment showed "Ask your relationship manager for a copy of
    this document." The partner had uploaded the file themselves, minutes
    earlier, off their own phone — and then could not check what they had sent.

    Scoped twice, exactly like the policy download above: the request must be
    theirs AND the document must belong to that request. Either check on its own
    lets a crafted id through, and someone else's document is a 404 rather than
    a 403 (a 403 confirms it exists).
    """
    from app.config import settings as app_settings

    q = await _own_quote(actor, quote_id)
    doc = await DocumentRecord.get(await parse_object_id(document_id))
    if doc is None or doc.entity_type != "quote_request"             or doc.entity_id != str(q.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    return DownloadUrlResponse(
        url=s3.presigned_download(doc.s3_key, doc.filename),
        expires_in=app_settings.s3_presign_expire_seconds)


@router.post("/quotes/{quote_id}/refresh", response_model=PortalQuoteDetail)
async def ask_for_fresh_quote(quote_id: str,
                              actor: User = Depends(get_active_user)
                              ) -> PortalQuoteDetail:
    """"That quotation expired — please re-price it."

    A quotation is good for `quote_validity_days` (3 by default) because
    premiums move. Past that the portal told the partner to "ask for a fresh
    one" and gave them nothing to ask WITH, so the request sat in QUOTED for
    ever: not closed, not workable, and invisible on the staff queue among the
    live ones. This is the ask.

    It re-opens the SAME request rather than making a new one — the customer,
    the documents and the whole conversation are already here, and a second
    request for one case is how a partner ends up quoted twice.
    """
    await _require("can_request_quotes")
    q = await _own_quote(actor, quote_id)
    if q.stage != QuoteStage.QUOTED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "There is no quotation waiting on this request.")
    if not any(option_expired(o) for o in q.options):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This quotation has not expired yet — you can still accept it.")

    q.stage = QuoteStage.IN_REVIEW
    # The expired option is KEPT. The partner should still be able to see what
    # they were quoted last time, and staff re-pricing it replaces the option
    # anyway (send_quote assigns a fresh single-item list, owner B1).
    q.timeline.append(QuoteEvent(
        stage=q.stage.value, by_id=str(actor.id), by_name=actor.full_name,
        by_side="partner", message="Asked for a fresh quotation"))
    q.updated_at = utcnow()
    await q.save()
    body = f"{q.customer_name} — the last quotation expired"
    if q.assigned_to_id:
        await create_notification(
            q.assigned_to_id, f"Re-quote asked for — {q.code}",
            body=body, category="quote", link=f"/quotes/{q.id}")
    await notify_permission(
        _QUOTE_DESK, title=f"Re-quote asked for — {q.code}", body=body,
        category="quote", link=f"/quotes/{q.id}",
        exclude_user_id=q.assigned_to_id or None)
    cats = await _category_map()
    return await _quote_detail(q, cats.get(q.category_key))


@router.post("/quotes/{quote_id}/cancel", response_model=Message)
async def cancel_quote(quote_id: str, actor: User = Depends(get_active_user)
                       ) -> Message:
    """The customer went elsewhere. Better said than left for the team to
    chase (owner B5)."""
    q = await _own_quote(actor, quote_id)
    if q.stage not in QUOTE_CANCELLABLE:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This request can no longer be cancelled.")
    q.stage = QuoteStage.CANCELLED
    q.closed_reason = "Cancelled by partner"
    q.timeline.append(QuoteEvent(
        stage=q.stage.value, by_id=str(actor.id), by_name=actor.full_name,
        by_side="partner", message="Request cancelled"))
    q.updated_at = utcnow()
    await q.save()
    # This told NOBODY until 2026-08-19. Somebody is very likely mid-way through
    # pricing it — chasing an underwriter, or about to ring the customer whose
    # business has already gone elsewhere. The assignee is notified by name
    # first, because it is their work that just stopped being needed; the rest
    # of the desk gets it too so an unassigned request is not silently dropped.
    body = f"{q.customer_name} — {q.partner_name or 'channel partner'}"
    told = set()
    if q.assigned_to_id:
        await create_notification(
            q.assigned_to_id, f"Cancelled by the partner — {q.code}",
            body=body, category="quote", link=f"/quotes/{q.id}")
        told.add(q.assigned_to_id)
    await notify_permission(
        _QUOTE_DESK, title=f"Cancelled by the partner — {q.code}",
        body=body, category="quote", link=f"/quotes/{q.id}",
        exclude_user_id=q.assigned_to_id if told else None)
    return Message(detail="Request cancelled.")


# --- Claims (WRITE) -----------------------------------------------------------------------


def _partner_event(actor: User, stage: Optional[str],
                   message: str) -> ClaimEvent:
    return ClaimEvent(stage=stage, by_id=str(actor.id),
                      by_name=actor.full_name, by_side="partner",
                      message=message)


@router.get("/claims", response_model=Page[PortalClaim])
async def my_claims(actor: User = Depends(get_active_user),
                    stage: str | None = Query(default=None),
                    page: int = Query(default=1, ge=1),
                    page_size: int = Query(default=20, ge=1, le=100)
                    ) -> Page[PortalClaim]:
    query: dict = dict(_me(actor))
    if stage:
        query["stage"] = stage
    total = await Claim.find(query).count()
    rows = (await Claim.find(query).sort("-created_at")
            .skip((page - 1) * page_size).limit(page_size).to_list())
    cats = await _category_map()
    return Page[PortalClaim](
        items=[_portal_claim(c, cats.get(c.category_key)) for c in rows],
        total=total, page=page, page_size=page_size)


async def _own_claim(actor: User, claim_id: str) -> Claim:
    c = await Claim.get(await parse_object_id(claim_id))
    if c is None or c.partner_id != str(actor.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Claim not found.")
    return c


@router.get("/claims/{claim_id}", response_model=PortalClaimDetail)
async def my_claim(claim_id: str, actor: User = Depends(get_active_user)
                   ) -> PortalClaimDetail:
    c = await _own_claim(actor, claim_id)
    cat = (await _category_map()).get(c.category_key)
    return PortalClaimDetail(
        **_portal_claim(c, cat).model_dump(),
        incident_location=c.incident_location, timeline=_timeline(c.timeline),
        documents=await _docs_for("claim", str(c.id)),
        required_documents=_claim_slots(cat))


@router.post("/claims", response_model=PortalClaimDetail,
             status_code=status.HTTP_201_CREATED)
async def raise_claim(payload: ClaimIn, actor: User = Depends(get_active_user)
                      ) -> PortalClaimDetail:
    """Report an incident on one of their own policies (owner C1).

    Raising it with photos attached, at the scene, is most of the value — so
    this asks for as little as possible and lets the documents follow.
    """
    await _require("can_raise_claims")
    pol = await _own_policy(actor, payload.policy_id)
    cust = (await _customers_for([pol])).get(pol.customer_id)

    c = Claim(
        code=await next_code("claim"),
        policy_id=str(pol.id), policy_number=pol.policy_number,
        customer_id=pol.customer_id,
        customer_name=getattr(cust, "name", None),
        category_key=pol.category_key,
        raised_by_id=str(actor.id), raised_by_name=actor.full_name,
        raised_by_side="partner", partner_id=str(actor.id),
        incident_at=payload.incident_at,
        incident_location=payload.incident_location,
        description=payload.description,
        estimated_loss=payload.estimated_loss,
        assigned_to_id=actor.relationship_manager_id,
        timeline=[_partner_event(actor, ClaimStage.INTIMATED.value,
                                 "Claim reported")])
    await c.insert()

    await notify_permission(
        _CLAIM_DESK, title=f"New claim from {actor.full_name}",
        body=f"{pol.policy_number or pol.code} — {payload.description[:100]}",
        category="claim", link=f"/claims/{c.id}")
    await log_action(
        AuditAction.POLICY_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="claim", entity_id=str(c.id), entity_code=c.code,
        summary=f"Claim {c.code} reported on {pol.code}")

    cat = (await _category_map()).get(c.category_key)
    return PortalClaimDetail(
        **_portal_claim(c, cat).model_dump(),
        incident_location=c.incident_location, timeline=_timeline(c.timeline),
        required_documents=_claim_slots(cat))


@router.post("/claims/{claim_id}/documents", response_model=DocumentOut)
async def attach_claim_document(
    claim_id: str,
    doc_key: str = Query(default=""),
    label: str = Query(default="Document"),
    file: UploadFile = File(...),
    actor: User = Depends(get_active_user),
) -> DocumentOut:
    await _require("can_raise_claims")
    c = await _own_claim(actor, claim_id)
    return await _upload_to("claim", str(c.id), file, actor, doc_key, label)


@router.post("/claims/{claim_id}/reply", response_model=Message)
async def reply_on_claim(claim_id: str, payload: ReplyIn,
                         actor: User = Depends(get_active_user)) -> Message:
    c = await _own_claim(actor, claim_id)
    c.timeline.append(_partner_event(actor, None, payload.message))
    c.updated_at = utcnow()
    await c.save()
    await notify_permission(
        _CLAIM_DESK, title=f"Reply on claim {c.code}",
        body=payload.message[:140], category="claim", link=f"/claims/{c.id}")
    return Message(detail="Sent.")


# --- Notices ------------------------------------------------------------------------------


@router.get("/notices", response_model=list[PortalNotice])
async def my_notices(actor: User = Depends(get_active_user)
                     ) -> list[PortalNotice]:
    """Broadcasts addressed to this partner.

    The audience was resolved and STORED when the broadcast was sent, so a
    notice does not vanish because the partner later moved to another
    relationship manager — see models/announcement.py.
    """
    rows = await Announcement.find(
        {"receipts.partner_id": str(actor.id), "withdrawn_at": None}
    ).sort("-created_at").limit(100).to_list()
    out = []
    for a in rows:
        receipt = next((r for r in a.receipts
                        if r.partner_id == str(actor.id)), None)
        out.append(PortalNotice(
            id=str(a.id), code=a.code, title=a.title, body=a.body,
            category=_enum(a.category), valid_until=a.valid_until,
            read_at=receipt.read_at if receipt else None,
            created_at=a.created_at))
    return out


@router.post("/notices/{notice_id}/read", response_model=Message)
async def mark_notice_read(notice_id: str,
                           actor: User = Depends(get_active_user)) -> Message:
    a = await Announcement.get(await parse_object_id(notice_id))
    receipt = None
    if a is not None:
        receipt = next((r for r in a.receipts
                        if r.partner_id == str(actor.id)), None)
    if a is None or receipt is None:
        # Not addressed to them: the same 404 as a notice that does not exist.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notice not found.")
    if receipt.read_at is None:
        receipt.read_at = utcnow()
        a.updated_at = utcnow()
        await a.save()
    return Message(detail="Marked as read.")
