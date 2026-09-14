"""The staff side of claims.

A claim is an incident on a policy, tracked from intimation to settlement. It
can be raised by the channel partner in the portal (owner C1) or by staff here.

MONEY: a claim never touches the ledger (owner C4). The settled amount is
recorded as information — the money moves between the insurer and the customer,
and the agency is not a party to it. Nothing in this file books a finance row,
and that is deliberate rather than unfinished.

The stages follow the general Indian general-insurance path (see
models/claim.py). Two IRDAI turnaround windows are why the surveyor fields and
the ageing clock are first-class rather than notes: a surveyor must be appointed
within 72 hours on a material loss, and the insurer must offer settlement within
30 days of the survey report. Those clocks are the agency's to chase on the
customer's behalf.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.config import settings as app_settings
from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import (
    CLAIM_OPEN_STAGES, AccountType, AuditAction, ClaimSettlementMode,
    ClaimStage,
)
from app.core.permissions import MANAGE_CLAIMS, VIEW_CLAIMS
from app.models.base import utcnow
from app.models.claim import Claim, ClaimEvent
from app.models.customer import Customer
from app.models.document import DocumentRecord
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.user import User
from app.routers._helpers import parse_object_id, search_regex
from app.schemas.common import Page
from app.schemas.document import DocumentOut, DownloadUrlResponse
from app.services import s3
from app.services.audit import log_action
from app.services.codes import next_code
from app.services.notifications import create_notification

# Staff-only. The guard is on the WHOLE router, so a new route added here is
# closed to channel partners by default.
router = APIRouter(prefix="/api/claims", tags=["claims"],
                   dependencies=[Depends(get_inhouse_user)])


class ClaimCreateIn(BaseModel):
    """Staff raising a claim on any policy — the partner phoned it in."""

    policy_id: str
    incident_at: datetime
    incident_location: Optional[str] = Field(default=None, max_length=200)
    description: str = Field(min_length=5, max_length=2000)
    estimated_loss: int = Field(default=0, ge=0)


class ClaimUpdateIn(BaseModel):
    """Everything the agency knows that the partner does not yet.

    `internal_notes` never leaves this router — the portal's claim schema has
    no field for it.
    """

    insurer_claim_no: Optional[str] = Field(default=None, max_length=80)
    settlement_mode: Optional[ClaimSettlementMode] = None
    surveyor_name: Optional[str] = Field(default=None, max_length=120)
    surveyor_contact: Optional[str] = Field(default=None, max_length=60)
    surveyor_appointed_at: Optional[datetime] = None
    filed_at: Optional[datetime] = None
    approved_amount: Optional[int] = Field(default=None, ge=0)
    settled_amount: Optional[int] = Field(default=None, ge=0)
    settled_at: Optional[datetime] = None
    rejection_reason: Optional[str] = Field(default=None, max_length=500)
    assigned_to_id: Optional[str] = None
    internal_notes: Optional[str] = Field(default=None, max_length=4000)


class ClaimStageIn(BaseModel):
    stage: ClaimStage
    message: Optional[str] = Field(default=None, max_length=2000)


class ClaimNoteIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


class StaffClaim(BaseModel):
    id: str
    code: str
    stage: str
    policy_id: str
    policy_number: Optional[str] = None
    customer_name: Optional[str] = None
    category_key: Optional[str] = None
    category_label: Optional[str] = None
    partner_id: Optional[str] = None
    raised_by_name: Optional[str] = None
    raised_by_side: str = "agency"
    assigned_to_id: Optional[str] = None
    assigned_to_name: Optional[str] = None
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
    age_days: int = 0
    created_at: datetime
    updated_at: datetime


class StaffClaimDetail(StaffClaim):
    incident_location: Optional[str] = None
    surveyor_contact: Optional[str] = None
    surveyor_appointed_at: Optional[datetime] = None
    filed_at: Optional[datetime] = None
    internal_notes: Optional[str] = None
    timeline: list[dict] = Field(default_factory=list)
    documents: list[DocumentOut] = Field(default_factory=list)
    required_documents: list[dict] = Field(default_factory=list)


def _enum(v) -> str:
    return v.value if hasattr(v, "value") else str(v)


async def _cats() -> dict[str, PolicyCategory]:
    return {c.key: c async for c in PolicyCategory.find_all()}


def _age_days(c: Claim, now: datetime) -> int:
    created = c.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=now.tzinfo)
    return max(0, (now - created).days)


def _staff_claim(c: Claim, cat: Optional[PolicyCategory],
                 now: datetime) -> StaffClaim:
    return StaffClaim(
        id=str(c.id), code=c.code, stage=_enum(c.stage),
        policy_id=c.policy_id, policy_number=c.policy_number,
        customer_name=c.customer_name, category_key=c.category_key,
        category_label=cat.label if cat else c.category_key,
        partner_id=c.partner_id, raised_by_name=c.raised_by_name,
        raised_by_side=c.raised_by_side,
        assigned_to_id=c.assigned_to_id, assigned_to_name=c.assigned_to_name,
        incident_at=c.incident_at, description=c.description,
        estimated_loss=c.estimated_loss, insurer_claim_no=c.insurer_claim_no,
        settlement_mode=_enum(c.settlement_mode) if c.settlement_mode else None,
        surveyor_name=c.surveyor_name, approved_amount=c.approved_amount,
        settled_amount=c.settled_amount, settled_at=c.settled_at,
        rejection_reason=c.rejection_reason, age_days=_age_days(c, now),
        created_at=c.created_at, updated_at=c.updated_at)


async def _load(claim_id: str) -> Claim:
    c = await Claim.get(await parse_object_id(claim_id))
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Claim not found.")
    return c


async def _detail(c: Claim) -> StaffClaimDetail:
    cat = (await _cats()).get(c.category_key or "")
    base = _staff_claim(c, cat, datetime.now(tz=utcnow().tzinfo))
    docs = [DocumentOut.from_model(d) async for d in DocumentRecord.find(
        {"entity_type": "claim", "entity_id": str(c.id)}).sort("+created_at")]
    return StaffClaimDetail(
        **base.model_dump(), incident_location=c.incident_location,
        surveyor_contact=c.surveyor_contact,
        surveyor_appointed_at=c.surveyor_appointed_at, filed_at=c.filed_at,
        internal_notes=c.internal_notes,
        timeline=[{"at": e.at, "stage": e.stage, "by_name": e.by_name,
                   "by_side": e.by_side, "message": e.message}
                  for e in c.timeline],
        documents=docs,
        required_documents=[{"key": d.key, "label": d.label,
                             "required": d.required}
                            for d in (cat.claim_documents if cat else [])])


def _touch(c: Claim, actor: User, stage: Optional[ClaimStage],
           message: Optional[str]) -> None:
    if stage is not None:
        c.stage = stage
    if message or stage:
        c.timeline.append(ClaimEvent(
            stage=stage.value if stage else None, by_id=str(actor.id),
            by_name=actor.full_name, by_side="agency",
            message=message or f"Moved to {_enum(stage)}"))
    c.updated_at = utcnow()


async def _tell_partner(c: Claim, title: str, body: str) -> None:
    """Only the partner credited on the policy hears about it. Silent when the
    policy is an in-house sale — there is nobody external to tell."""
    if not c.partner_id:
        return
    await create_notification(c.partner_id, title, body=body,
                              category="claim",
                              link=f"/portal/claims/{c.id}")


# --- Queue ---------------------------------------------------------------------------


@router.get("", response_model=Page[StaffClaim],
            dependencies=[Depends(require_permission(VIEW_CLAIMS))])
async def list_claims(
    stage: str | None = Query(default=None),
    open_only: bool = Query(default=True),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[StaffClaim]:
    query: dict = {}
    if stage:
        query["stage"] = stage
    elif open_only:
        query["stage"] = {"$in": [s.value for s in CLAIM_OPEN_STAGES]}
    if q:
        query["$or"] = [{"code": search_regex(q)},
                        {"policy_number": search_regex(q)},
                        {"customer_name": search_regex(q)},
                        {"insurer_claim_no": search_regex(q)}]

    total = await Claim.find(query).count()
    rows = (await Claim.find(query).sort("+created_at")
            .skip((page - 1) * page_size).limit(page_size).to_list())
    cats = await _cats()
    now = datetime.now(tz=utcnow().tzinfo)
    return Page[StaffClaim](
        items=[_staff_claim(c, cats.get(c.category_key or ""), now)
               for c in rows],
        total=total, page=page, page_size=page_size)


@router.get("/{claim_id}", response_model=StaffClaimDetail,
            dependencies=[Depends(require_permission(VIEW_CLAIMS))])
async def get_claim(claim_id: str) -> StaffClaimDetail:
    return await _detail(await _load(claim_id))


@router.get("/{claim_id}/documents/{document_id}",
            response_model=DownloadUrlResponse,
            dependencies=[Depends(require_permission(VIEW_CLAIMS))])
async def download_claim_document(claim_id: str, document_id: str
                                  ) -> DownloadUrlResponse:
    c = await _load(claim_id)
    doc = await DocumentRecord.get(await parse_object_id(document_id))
    if doc is None or doc.entity_type != "claim" \
            or doc.entity_id != str(c.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    return DownloadUrlResponse(
        url=s3.presigned_download(doc.s3_key, doc.filename),
        expires_in=app_settings.s3_presign_expire_seconds)


# --- Working it -----------------------------------------------------------------------


@router.post("", response_model=StaffClaimDetail,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_CLAIMS))])
async def create_claim(payload: ClaimCreateIn, request: Request,
                       actor: User = Depends(get_active_user)
                       ) -> StaffClaimDetail:
    """Staff raising a claim on any policy — usually because the customer or
    partner phoned it in."""
    pol = await Policy.get(await parse_object_id(payload.policy_id))
    if pol is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
    cust = None
    if pol.customer_id:
        try:
            cust = await Customer.get(PydanticObjectId(pol.customer_id))
        except Exception:  # noqa: BLE001
            cust = None

    c = Claim(
        code=await next_code("claim"),
        policy_id=str(pol.id), policy_number=pol.policy_number,
        customer_id=pol.customer_id,
        customer_name=getattr(cust, "name", None),
        category_key=pol.category_key,
        raised_by_id=str(actor.id), raised_by_name=actor.full_name,
        raised_by_side="agency",
        # Frozen so the portal query is one indexed lookup rather than a join.
        partner_id=pol.partner_id,
        incident_at=payload.incident_at,
        incident_location=payload.incident_location,
        description=payload.description,
        estimated_loss=payload.estimated_loss,
        assigned_to_id=str(actor.id), assigned_to_name=actor.full_name,
        timeline=[ClaimEvent(stage=ClaimStage.INTIMATED.value,
                             by_id=str(actor.id), by_name=actor.full_name,
                             by_side="agency", message="Claim recorded")])
    await c.insert()
    await _tell_partner(c, f"Claim opened — {c.code}",
                        f"On policy {pol.policy_number or pol.code}.")
    await log_action(
        AuditAction.POLICY_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="claim", entity_id=str(c.id), entity_code=c.code,
        request=request, summary=f"Claim {c.code} opened on {pol.code}")
    return await _detail(c)


@router.patch("/{claim_id}", response_model=StaffClaimDetail,
              dependencies=[Depends(require_permission(MANAGE_CLAIMS))])
async def update_claim(claim_id: str, payload: ClaimUpdateIn,
                       actor: User = Depends(get_active_user)
                       ) -> StaffClaimDetail:
    """The insurer's side: claim number, surveyor, amounts.

    None of these move money. `settled_amount` is recorded because the partner
    and the customer will ask, not because the agency's books care (owner C4).
    """
    c = await _load(claim_id)
    data = payload.model_dump(exclude_unset=True)

    if "assigned_to_id" in data:
        target = None
        if data["assigned_to_id"]:
            try:
                target = await User.get(PydanticObjectId(data["assigned_to_id"]))
            except Exception:  # noqa: BLE001
                target = None
            if target is None \
                    or target.account_type == AccountType.CHANNEL_PARTNER:
                raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                    "Assign this to a member of staff.")
        c.assigned_to_id = str(target.id) if target else None
        c.assigned_to_name = target.full_name if target else None
        data.pop("assigned_to_id")

    for field, value in data.items():
        setattr(c, field, value)
    c.updated_at = utcnow()
    await c.save()
    return await _detail(c)


@router.post("/{claim_id}/stage", response_model=StaffClaimDetail,
             dependencies=[Depends(require_permission(MANAGE_CLAIMS))])
async def set_stage(claim_id: str, payload: ClaimStageIn, request: Request,
                    actor: User = Depends(get_active_user)
                    ) -> StaffClaimDetail:
    """Move the claim on, and tell the partner.

    Settling or rejecting stamps the moment it happened, so "when did this
    close" is answerable from the record rather than from memory.
    """
    c = await _load(claim_id)
    previous = _enum(c.stage)
    if payload.stage == ClaimStage.SETTLED and c.settled_at is None:
        c.settled_at = utcnow()
    _touch(c, actor, payload.stage, payload.message)
    await c.save()

    await _tell_partner(
        c, f"Claim {c.code}: {_enum(payload.stage).replace('_', ' ')}",
        payload.message or f"Moved from {previous}.")
    await log_action(
        AuditAction.POLICY_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="claim", entity_id=str(c.id), entity_code=c.code,
        request=request,
        summary=f"Claim {c.code}: {previous} -> {_enum(payload.stage)}")
    return await _detail(c)


@router.post("/{claim_id}/note", response_model=StaffClaimDetail,
             dependencies=[Depends(require_permission(MANAGE_CLAIMS))])
async def add_note(claim_id: str, payload: ClaimNoteIn,
                   actor: User = Depends(get_active_user)) -> StaffClaimDetail:
    """Say something to the partner. Staff-only thinking goes in
    `internal_notes`, which the portal never sees."""
    c = await _load(claim_id)
    _touch(c, actor, None, payload.message)
    await c.save()
    await _tell_partner(c, f"Update on claim {c.code}", payload.message[:140])
    return await _detail(c)
