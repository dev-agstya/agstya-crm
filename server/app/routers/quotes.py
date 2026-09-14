"""The staff side of channel-partner quote requests.

A partner raises an enquiry in the portal; this is where the agency works it —
picks it up, asks for what is missing, prices it, and hands off to the normal
policy form once the customer accepts.

TWO THINGS THIS DELIBERATELY DOES NOT DO:

  * It never books a policy. Accepting a quote tells staff to book one; the
    broker and the rate card are human decisions and they belong on the policy
    form (owner A3). `POST /{id}/booked` only LINKS the two records afterwards.
  * It never computes the partner's earning. The staff member types the figure
    they are quoting, from the same rate card the policy will be booked on. A
    number this endpoint invented and the reward engine later disagreed with
    would be worse than no number at all.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import (
    QUOTE_CLOSED, AccountType, AuditAction, QuoteStage,
)
from app.core.permissions import EXPORT_DATA, MANAGE_QUOTES, VIEW_QUOTES
from app.models.base import utcnow
from app.models.document import DocumentRecord
from app.models.insurer import Insurer
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.quote_request import (
    QuoteEvent, QuoteOption, QuoteRequest, option_expired,
)
from app.models.user import User
from app.routers._helpers import parse_object_id, search_regex
from app.schemas.common import Message, Page
from app.schemas.document import DocumentOut, DownloadUrlResponse
from app.services import s3, settings_svc
from app.services.exporters import export_response
from app.services.audit import log_action
from app.services.notifications import create_notification

# Staff-only. The guard is attached to the WHOLE router, not per endpoint, so a
# new route added here is closed to channel partners by default.
router = APIRouter(prefix="/api/quotes", tags=["quotes"],
                   dependencies=[Depends(get_inhouse_user)])

# Ageing flags on the queue (owner B4.2). A pile with no clock is a pile.
AMBER_AFTER_HOURS = 24
RED_AFTER_HOURS = 48


class QuoteOptionIn(BaseModel):
    """What the agency can place, and what the partner earns on it.

    `partner_earning` is typed by the staff member in RUPEES-as-paise. It is not
    derived here on purpose — see the module docstring.
    """

    insurer_id: Optional[str] = None
    premium_amount: int = Field(ge=0)
    sum_insured: int = Field(default=0, ge=0)
    cover_from: Optional[datetime] = None
    cover_to: Optional[datetime] = None
    inclusions: Optional[str] = Field(default=None, max_length=2000)
    partner_earning: int = Field(default=0, ge=0)
    valid_until: Optional[datetime] = None


class QuoteNoteIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    # True = "we need something from you", which moves it to INFO_NEEDED and
    # puts the ball back in the partner's court.
    request_info: bool = False


class QuoteAssignIn(BaseModel):
    assigned_to_id: Optional[str] = None


class QuoteCloseIn(BaseModel):
    stage: QuoteStage
    reason: Optional[str] = Field(default=None, max_length=500)


class QuoteInternalNoteIn(BaseModel):
    internal_notes: Optional[str] = Field(default=None, max_length=4000)


class StaffQuoteOption(BaseModel):
    id: str
    insurer_id: Optional[str] = None
    insurer_name: Optional[str] = None
    premium_amount: int = 0
    sum_insured: int = 0
    cover_from: Optional[datetime] = None
    cover_to: Optional[datetime] = None
    inclusions: Optional[str] = None
    partner_earning: int = 0
    valid_until: Optional[datetime] = None
    quoted_by_name: Optional[str] = None
    quoted_at: Optional[datetime] = None
    accepted_at: Optional[datetime] = None
    declined_at: Optional[datetime] = None
    decline_reason: Optional[str] = None


class StaffQuote(BaseModel):
    id: str
    code: str
    stage: str
    partner_id: str
    partner_name: Optional[str] = None
    manager_name: Optional[str] = None
    assigned_to_id: Optional[str] = None
    assigned_to_name: Optional[str] = None
    customer_name: str
    customer_mobile: str
    customer_email: Optional[str] = None
    category_key: str
    category_label: Optional[str] = None
    subcategory_label: Optional[str] = None
    is_renewal: bool = False
    note: Optional[str] = None
    options: list[StaffQuoteOption] = Field(default_factory=list)
    policy_id: Optional[str] = None
    closed_reason: Optional[str] = None
    # Hours since it was raised, and whether anybody has answered yet. Drives
    # the amber/red flag on the queue.
    age_hours: int = 0
    answered: bool = False
    # The quotation we sent has run out. A QUOTED request with an expired option
    # is NOT workable — the partner cannot accept it — but it sat in the open
    # queue looking exactly like a live one, so the pile grew a category of row
    # that nobody could act on and nobody could see. The partner has an "ask for
    # a fresh quotation" action now; this is the same fact on the staff side.
    expired: bool = False
    created_at: datetime
    updated_at: datetime


class StaffQuoteDetail(StaffQuote):
    subcategory_path: list[str] = Field(default_factory=list)
    details: dict = Field(default_factory=dict)
    field_labels: dict[str, str] = Field(default_factory=dict)
    timeline: list[dict] = Field(default_factory=list)
    documents: list[DocumentOut] = Field(default_factory=list)
    internal_notes: Optional[str] = None
    renewal_of_policy_id: Optional[str] = None


async def _cats() -> dict[str, PolicyCategory]:
    return {c.key: c async for c in PolicyCategory.find_all()}


def _sub_label(cat: Optional[PolicyCategory], path: list[str]) -> Optional[str]:
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


def _enum(v) -> str:
    return v.value if hasattr(v, "value") else str(v)


def _age_hours(q: QuoteRequest, now: datetime) -> int:
    created = q.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=now.tzinfo)
    return max(0, int((now - created).total_seconds() // 3600))


def _staff_option(o, insurers: dict[str, str]) -> StaffQuoteOption:
    return StaffQuoteOption(
        id=o.id, insurer_id=o.insurer_id,
        insurer_name=o.insurer_name or insurers.get(o.insurer_id or ""),
        premium_amount=o.premium_amount, sum_insured=o.sum_insured,
        cover_from=o.cover_from, cover_to=o.cover_to,
        inclusions=o.inclusions, partner_earning=o.partner_earning,
        valid_until=o.valid_until, quoted_by_name=o.quoted_by_name,
        quoted_at=o.quoted_at, accepted_at=o.accepted_at,
        declined_at=o.declined_at, decline_reason=o.decline_reason)


def _staff_quote(q: QuoteRequest, cat: Optional[PolicyCategory],
                 insurers: dict[str, str], now: datetime) -> StaffQuote:
    return StaffQuote(
        id=str(q.id), code=q.code, stage=_enum(q.stage),
        partner_id=q.partner_id, partner_name=q.partner_name,
        manager_name=q.manager_name,
        assigned_to_id=q.assigned_to_id, assigned_to_name=q.assigned_to_name,
        customer_name=q.customer_name, customer_mobile=q.customer_mobile,
        customer_email=q.customer_email,
        category_key=q.category_key,
        category_label=cat.label if cat else q.category_key,
        subcategory_label=_sub_label(cat, q.subcategory_path),
        is_renewal=q.is_renewal, note=q.note,
        options=[_staff_option(o, insurers) for o in q.options],
        policy_id=q.policy_id, closed_reason=q.closed_reason,
        age_hours=_age_hours(q, now),
        answered=q.first_response_at is not None,
        expired=(q.stage == QuoteStage.QUOTED
                 and any(option_expired(o, now) for o in q.options)),
        created_at=q.created_at, updated_at=q.updated_at)


async def _insurer_names() -> dict[str, str]:
    return {str(i.id): i.name async for i in Insurer.find_all()}


async def _load(quote_id: str) -> QuoteRequest:
    q = await QuoteRequest.get(await parse_object_id(quote_id))
    if q is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Request not found.")
    return q


async def _detail(q: QuoteRequest) -> StaffQuoteDetail:
    cat = (await _cats()).get(q.category_key)
    base = _staff_quote(q, cat, await _insurer_names(),
                        datetime.now(tz=utcnow().tzinfo))
    docs = [DocumentOut.from_model(d) async for d in DocumentRecord.find(
        {"entity_type": "quote_request", "entity_id": str(q.id)}
    ).sort("+created_at")]
    return StaffQuoteDetail(
        **base.model_dump(), subcategory_path=q.subcategory_path,
        details=q.details or {},
        field_labels={f.key: f.label for f in (cat.custom_fields if cat else [])},
        timeline=[{"at": e.at, "stage": e.stage, "by_name": e.by_name,
                   "by_side": e.by_side, "message": e.message}
                  for e in q.timeline],
        documents=docs, internal_notes=q.internal_notes,
        renewal_of_policy_id=q.renewal_of_policy_id)


def _touch(q: QuoteRequest, actor: User, stage: Optional[QuoteStage],
           message: str) -> None:
    """Move the request and record who moved it.

    Stamps `first_response_at` the first time anybody answers — that clock is
    what the ageing flags on the queue are measured against.
    """
    if stage is not None:
        q.stage = stage
    if q.first_response_at is None:
        q.first_response_at = utcnow()
    q.timeline.append(QuoteEvent(
        stage=stage.value if stage else None, by_id=str(actor.id),
        by_name=actor.full_name, by_side="agency", message=message))
    q.updated_at = utcnow()


async def _tell_partner(q: QuoteRequest, title: str, body: str) -> None:
    await create_notification(q.partner_id, title, body=body,
                              category="quote",
                              link=f"/portal/quotes/{q.id}")


def _list_query(actor: User, *, stage: str | None, mine: bool,
                open_only: bool, q: str | None) -> dict:
    """The queue's filter, in ONE place.

    Shared by the list and the export for the same reason `leads._list_query`
    is: a download that quietly applies different filters from the screen it was
    started from is worse than no download — you cannot see that it is wrong.
    """
    query: dict = {}
    if stage:
        query["stage"] = stage
    elif open_only:
        query["stage"] = {"$nin": [s.value for s in QUOTE_CLOSED]}
    if mine:
        query["assigned_to_id"] = str(actor.id)
    if q:
        query["$or"] = [{"code": search_regex(q)},
                        {"customer_name": search_regex(q)},
                        {"customer_mobile": search_regex(q)},
                        {"partner_name": search_regex(q)}]
    return query


# --- Queue ---------------------------------------------------------------------------


@router.get("", response_model=Page[StaffQuote],
            dependencies=[Depends(require_permission(VIEW_QUOTES))])
async def list_quotes(
    actor: User = Depends(get_active_user),
    stage: str | None = Query(default=None),
    mine: bool = Query(default=False),
    open_only: bool = Query(default=True),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[StaffQuote]:
    """The queue. Assigned AND a shared pool (owner B4.1): every request has a
    name on it so it is somebody's job, and everyone can see the lot so it is
    never stuck behind one person's leave."""
    query = _list_query(actor, stage=stage, mine=mine, open_only=open_only, q=q)

    total = await QuoteRequest.find(query).count()
    rows = (await QuoteRequest.find(query).sort("+created_at")
            .skip((page - 1) * page_size).limit(page_size).to_list())
    cats = await _cats()
    insurers = await _insurer_names()
    now = datetime.now(tz=utcnow().tzinfo)
    return Page[StaffQuote](
        items=[_staff_quote(r, cats.get(r.category_key), insurers, now)
               for r in rows],
        total=total, page=page, page_size=page_size)


# STATIC BEFORE DYNAMIC. Registered above /{quote_id}, or FastAPI matches
# "export" as a quote id and every download 404s. This router has no scar of its
# own here yet — policies.py does, and that is enough.
@router.get("/export",
            dependencies=[Depends(require_permission(VIEW_QUOTES)),
                          Depends(require_permission(EXPORT_DATA))])
async def export_quotes(
    actor: User = Depends(get_active_user),
    stage: str | None = Query(default=None),
    mine: bool = Query(default=False),
    open_only: bool = Query(default=True),
    q: str | None = Query(default=None),
    fmt: str = Query(default="excel", pattern="^(excel|xlsx|csv)$"),
):
    """Download the quote queue.

    Every other list in the app exports and this one did not, which made the one
    question the owner actually asks of it — "what did we quote last month and
    what came of it" — a manual count off the screen.

    MONEY IS A NUMBER, not a formatted string, exactly as the business report
    does it: a premium column you cannot total is not much of an export. The
    partner's earning is included because this is a STAFF export and staff price
    it; the agency's own reward is not here at all, because it is not on the
    quote — a quote has no broker and no rate card yet, which is the whole
    design (owner A3).
    """
    query = _list_query(actor, stage=stage, mine=mine, open_only=open_only, q=q)
    rows_raw = await QuoteRequest.find(query).sort("-created_at")         .limit(5000).to_list()
    cats = await _cats()
    insurers = await _insurer_names()
    now = datetime.now(tz=utcnow().tzinfo)

    headers = ["Code", "Raised", "Stage", "Channel Partner",
               "Relationship Manager", "Assigned To", "Customer", "Mobile",
               "Policy Type", "Sub-type", "Renewal", "Insurer Quoted",
               "Premium Quoted", "Partner Earning", "Quote Valid Until",
               "Expired", "Age (hours)", "Answered", "Policy", "Closed Reason"]

    rows = []
    for r in rows_raw:
        view = _staff_quote(r, cats.get(r.category_key), insurers, now)
        opt = next((o for o in r.options if o.accepted_at), None)             or (r.options[0] if r.options else None)
        rows.append([
            view.code,
            r.created_at.date().isoformat() if r.created_at else "",
            view.stage,
            view.partner_name or "",
            view.manager_name or "",
            view.assigned_to_name or "",
            view.customer_name,
            view.customer_mobile,
            view.category_label or "",
            view.subcategory_label or "",
            "Yes" if r.is_renewal else "No",
            (opt.insurer_name or insurers.get(opt.insurer_id or "") or "")
            if opt else "",
            (opt.premium_amount / 100) if opt else 0,
            (opt.partner_earning / 100) if opt else 0,
            opt.valid_until.date().isoformat()
            if opt and opt.valid_until else "",
            "Yes" if view.expired else "No",
            view.age_hours,
            "Yes" if view.answered else "No",
            r.policy_id or "",
            r.closed_reason or "",
        ])

    await log_action(
        AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="quote_request", entity_id="export",
        summary=f"Exported {len(rows)} quote requests")
    return export_response(fmt, "quote-requests", headers, rows,
                           sheet_title="Quote Requests")


@router.get("/{quote_id}", response_model=StaffQuoteDetail,
            dependencies=[Depends(require_permission(VIEW_QUOTES))])
async def get_quote(quote_id: str) -> StaffQuoteDetail:
    return await _detail(await _load(quote_id))


@router.get("/{quote_id}/documents/{document_id}",
            response_model=DownloadUrlResponse,
            dependencies=[Depends(require_permission(VIEW_QUOTES))])
async def download_quote_document(quote_id: str, document_id: str
                                  ) -> DownloadUrlResponse:
    from app.config import settings as app_settings

    q = await _load(quote_id)
    doc = await DocumentRecord.get(await parse_object_id(document_id))
    if doc is None or doc.entity_type != "quote_request" \
            or doc.entity_id != str(q.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    return DownloadUrlResponse(
        url=s3.presigned_download(doc.s3_key, doc.filename),
        expires_in=app_settings.s3_presign_expire_seconds)


# --- Working it -----------------------------------------------------------------------


@router.post("/{quote_id}/claim", response_model=StaffQuoteDetail,
             dependencies=[Depends(require_permission(MANAGE_QUOTES))])
async def pick_up(quote_id: str, actor: User = Depends(get_active_user)
                  ) -> StaffQuoteDetail:
    """Take it off the pile. The partner sees a name and a time — which is most
    of what "is anybody looking at this" means to them."""
    q = await _load(quote_id)
    if q.stage in QUOTE_CLOSED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This request is closed.")
    q.assigned_to_id, q.assigned_to_name = str(actor.id), actor.full_name
    _touch(q, actor, QuoteStage.IN_REVIEW,
           f"{actor.full_name} is looking at this")
    await q.save()
    await _tell_partner(q, f"We are on it — {q.code}",
                        f"{actor.full_name} has picked up your request.")
    return await _detail(q)


@router.post("/{quote_id}/assign", response_model=StaffQuoteDetail,
             dependencies=[Depends(require_permission(MANAGE_QUOTES))])
async def assign(quote_id: str, payload: QuoteAssignIn,
                 actor: User = Depends(get_active_user)) -> StaffQuoteDetail:
    q = await _load(quote_id)
    target = None
    if payload.assigned_to_id:
        try:
            target = await User.get(PydanticObjectId(payload.assigned_to_id))
        except Exception:  # noqa: BLE001
            target = None
        if target is None or target.account_type == AccountType.CHANNEL_PARTNER:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Assign this to a member of staff.")
    q.assigned_to_id = str(target.id) if target else None
    q.assigned_to_name = target.full_name if target else None
    _touch(q, actor, None,
           f"Assigned to {target.full_name}" if target else "Unassigned")
    await q.save()
    return await _detail(q)


@router.post("/{quote_id}/note", response_model=StaffQuoteDetail,
             dependencies=[Depends(require_permission(MANAGE_QUOTES))])
async def add_note(quote_id: str, payload: QuoteNoteIn,
                   actor: User = Depends(get_active_user)) -> StaffQuoteDetail:
    """Say something to the partner — usually "we need X".

    This is the partner-visible conversation. Staff-only thinking goes in
    `internal_notes`, which the portal schema has no field for.
    """
    q = await _load(quote_id)
    if q.stage in QUOTE_CLOSED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This request is closed.")
    stage = QuoteStage.INFO_NEEDED if payload.request_info else None
    _touch(q, actor, stage, payload.message)
    await q.save()
    await _tell_partner(
        q,
        "We need something from you" if payload.request_info
        else f"Update on {q.code}",
        payload.message[:140])
    return await _detail(q)


@router.patch("/{quote_id}/internal-notes", response_model=StaffQuoteDetail,
              dependencies=[Depends(require_permission(MANAGE_QUOTES))])
async def set_internal_notes(quote_id: str, payload: QuoteInternalNoteIn
                             ) -> StaffQuoteDetail:
    """Staff-only scratchpad. Never serialised to the portal."""
    q = await _load(quote_id)
    q.internal_notes = payload.internal_notes
    q.updated_at = utcnow()
    await q.save()
    return await _detail(q)


@router.post("/{quote_id}/quote", response_model=StaffQuoteDetail,
             dependencies=[Depends(require_permission(MANAGE_QUOTES))])
async def send_quote(quote_id: str, payload: QuoteOptionIn, request: Request,
                     actor: User = Depends(get_active_user)
                     ) -> StaffQuoteDetail:
    """Put a price on it.

    The partner sees the premium and THEIR earning in rupees — never a rate,
    never the agency's side (owner E1/B2). Validity defaults to the owner's
    configured window because premiums move and a quote with no expiry is a
    promise the agency did not make (owner B3).
    """
    q = await _load(quote_id)
    if q.stage in QUOTE_CLOSED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This request is closed.")

    insurer_name = None
    if payload.insurer_id:
        try:
            ins = await Insurer.get(PydanticObjectId(payload.insurer_id))
        except Exception:  # noqa: BLE001
            ins = None
        if ins is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown insurer.")
        insurer_name = ins.name

    caps = (await settings_svc.get_settings()).partner_portal
    valid_until = payload.valid_until or (
        utcnow() + timedelta(days=caps.quote_validity_days))

    option = QuoteOption(
        id=uuid.uuid4().hex[:8],
        insurer_id=payload.insurer_id, insurer_name=insurer_name,
        premium_amount=payload.premium_amount,
        sum_insured=payload.sum_insured,
        cover_from=payload.cover_from, cover_to=payload.cover_to,
        inclusions=payload.inclusions,
        partner_earning=payload.partner_earning,
        valid_until=valid_until,
        quoted_by=str(actor.id), quoted_by_name=actor.full_name)
    # Owner B1: one option in practice. A re-quote REPLACES rather than piling
    # up, so the partner is never looking at two prices for the same case.
    q.options = [option]
    _touch(q, actor, QuoteStage.QUOTED, "Quotation sent")
    await q.save()

    await _tell_partner(
        q, f"Your quotation is ready — {q.code}",
        f"{insurer_name or 'Quotation'} for {q.customer_name}.")
    await log_action(
        AuditAction.POLICY_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="quote_request", entity_id=str(q.id), entity_code=q.code,
        request=request, summary=f"Quoted {q.code}")
    return await _detail(q)


@router.post("/{quote_id}/close", response_model=StaffQuoteDetail,
             dependencies=[Depends(require_permission(MANAGE_QUOTES))])
async def close_quote(quote_id: str, payload: QuoteCloseIn,
                      actor: User = Depends(get_active_user)
                      ) -> StaffQuoteDetail:
    """Declined (we cannot place it) or lost (quoted, not taken)."""
    if payload.stage not in (QuoteStage.DECLINED, QuoteStage.LOST):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Close it as declined or lost.")
    q = await _load(quote_id)
    q.closed_reason = payload.reason
    _touch(q, actor, payload.stage,
           payload.reason or _enum(payload.stage).title())
    await q.save()
    await _tell_partner(q, f"{q.code} closed",
                        payload.reason or "This request has been closed.")
    return await _detail(q)


@router.post("/{quote_id}/booked", response_model=StaffQuoteDetail,
             dependencies=[Depends(require_permission(MANAGE_QUOTES))])
async def mark_booked(quote_id: str, policy_id: str = Query(...),
                      actor: User = Depends(get_active_user)
                      ) -> StaffQuoteDetail:
    """Link the policy that came out of this request.

    Called by the policy form after it saves. It does NOT create anything — the
    broker and the rate card are decided on that form by a human, which is the
    whole reason this endpoint only links (owner A3).
    """
    q = await _load(quote_id)
    pol = await Policy.get(await parse_object_id(policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    q.policy_id = str(pol.id)
    pol.quote_request_id = str(q.id)
    pol.updated_at = utcnow()
    await pol.save()
    _touch(q, actor, QuoteStage.ISSUED,
           f"Policy {pol.policy_number or pol.code} issued")
    await q.save()
    await _tell_partner(
        q, f"Policy issued — {pol.policy_number or pol.code}",
        f"Your case for {q.customer_name} is now on cover.")
    return await _detail(q)
