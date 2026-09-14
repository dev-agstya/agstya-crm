"""Broadcasts to channel partners — offers, rate changes, notices.

The owner writes it once, picks who it goes to, and it lands in every matching
partner's Notices list, their notification bell, their email and (when
configured) WhatsApp.

TWO DESIGN DECISIONS WORTH KNOWING BEFORE CHANGING ANYTHING HERE:

  * The audience is RESOLVED AT SEND TIME and the recipient ids are STORED. It
    is never re-evaluated on read. A broadcast that said "everyone under Rahul"
    in August must still show the same fourteen people in November after two of
    them moved to Sunita — otherwise the read receipts stop meaning anything and
    a partner can lose a notice they were sent.

  * A broadcast cannot be unsent. `/preview` exists so the audience is a number
    on screen BEFORE the button is pressed, and withdrawing only hides it from
    the portal — it does not un-email anybody, and the copy says so.

Its own permission pair rather than riding on manage_team (owner D5): being able
to message every partner at once should be a deliberate grant, not a side effect
of being able to add an employee.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from beanie import PydanticObjectId
from fastapi import (
    APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status,
)
from pydantic import BaseModel, Field

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import (
    AccountStatus, AccountType, AnnouncementAudience, AnnouncementCategory,
    AuditAction,
)
from app.core.permissions import MANAGE_ANNOUNCEMENTS, VIEW_ANNOUNCEMENTS
from app.models.announcement import Announcement, AnnouncementReceipt
from app.models.base import utcnow
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message, Page
from app.services import settings_svc
from app.services import whatsapp as whatsapp_svc
from app.services.audit import log_action
from app.services.codes import next_code
from app.services.notifications import create_notification

# Staff-only at the router level, like every other staff surface.
router = APIRouter(prefix="/api/announcements", tags=["announcements"],
                   dependencies=[Depends(get_inhouse_user)])

# "New partners" means joined within this many days unless the composer says
# otherwise.
DEFAULT_NEW_PARTNER_DAYS = 30


class AnnouncementIn(BaseModel):
    title: str = Field(min_length=3, max_length=120)
    # Plain text with line breaks. Deliberately NOT HTML: this is composed in a
    # textarea by a non-technical user and ends up in somebody's inbox, and
    # accepting markup from that path is a hole.
    body: str = Field(min_length=1, max_length=4000)
    category: AnnouncementCategory = AnnouncementCategory.NOTICE
    valid_until: Optional[datetime] = None

    audience: AnnouncementAudience = AnnouncementAudience.ALL
    manager_id: Optional[str] = None
    selected_partner_ids: list[str] = Field(default_factory=list)
    joined_within_days: Optional[int] = Field(default=None, ge=1, le=3650)

    send_email: bool = True
    send_whatsapp: bool = False


class AudiencePreview(BaseModel):
    """What the composer shows BEFORE the send button — a broadcast cannot be
    unsent, so the count and a few names go on screen first."""

    count: int = 0
    names: list[str] = Field(default_factory=list)
    truncated: bool = False


class AnnouncementReceiptOut(BaseModel):
    partner_id: str
    partner_name: Optional[str] = None
    read_at: Optional[datetime] = None


class AnnouncementOut(BaseModel):
    id: str
    code: str
    title: str
    body: str
    category: str
    valid_until: Optional[datetime] = None
    audience: str
    manager_name: Optional[str] = None
    send_email: bool = True
    send_whatsapp: bool = False
    recipients: int = 0
    read_count: int = 0
    withdrawn_at: Optional[datetime] = None
    created_by_name: Optional[str] = None
    created_at: datetime


class AnnouncementDetail(AnnouncementOut):
    receipts: list[AnnouncementReceiptOut] = Field(default_factory=list)


def _enum(v) -> str:
    return v.value if hasattr(v, "value") else str(v)


def _out(a: Announcement) -> AnnouncementOut:
    return AnnouncementOut(
        id=str(a.id), code=a.code, title=a.title, body=a.body,
        category=_enum(a.category), valid_until=a.valid_until,
        audience=_enum(a.audience), manager_name=a.manager_name,
        send_email=a.send_email, send_whatsapp=a.send_whatsapp,
        recipients=a.recipient_count, read_count=a.read_count,
        withdrawn_at=a.withdrawn_at, created_by_name=a.created_by_name,
        created_at=a.created_at)


async def _resolve_audience(payload: AnnouncementIn) -> list[User]:
    """Who this goes to, right now.

    Only ACTIVE partners with portal access — sending a notice to somebody who
    cannot sign in is a read receipt that will never arrive and an email that
    invites a support call.
    """
    query: dict = {
        "account_type": AccountType.CHANNEL_PARTNER.value,
        "is_deleted": {"$ne": True},
        "status": AccountStatus.ACTIVE.value,
        "portal_access": True,
    }

    if payload.audience == AnnouncementAudience.MANAGER:
        if not payload.manager_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Choose a relationship manager.")
        query["relationship_manager_id"] = payload.manager_id
    elif payload.audience == AnnouncementAudience.SELECTED:
        ids = []
        for pid in payload.selected_partner_ids:
            try:
                ids.append(PydanticObjectId(pid))
            except Exception:  # noqa: BLE001
                continue
        if not ids:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Pick at least one channel partner.")
        query["_id"] = {"$in": ids}
    elif payload.audience == AnnouncementAudience.NEW_PARTNERS:
        days = payload.joined_within_days or DEFAULT_NEW_PARTNER_DAYS
        query["created_at"] = {"$gte": utcnow() - timedelta(days=days)}

    return await User.find(query).sort("+full_name").to_list()


async def _deliver(a: Announcement, recipients: list[User]) -> None:
    """In-app always; email and WhatsApp per broadcast (owner D2).

    Best-effort by design: a bounced email must not stop the notice reaching
    the other thirteen partners, and it must never fail the request that
    already saved the record.
    """
    from app.services import email as email_svc

    for user in recipients:
        await create_notification(
            str(user.id), a.title, body=a.body[:200],
            category="announcement", link=f"/portal/notices")

    if a.send_email:
        for user in recipients:
            try:
                await email_svc.send_announcement_email(
                    user.email, user.full_name, a.title, a.body,
                    _enum(a.category))
            except Exception:  # noqa: BLE001 — one bad address is not a failure
                continue

    if a.send_whatsapp:
        for user in recipients:
            if not user.mobile:
                continue
            try:
                await whatsapp_svc.send_announcement(user.mobile, a.title,
                                                     a.body)
            except Exception:  # noqa: BLE001
                continue


# --- Composing ----------------------------------------------------------------------


@router.post("/preview", response_model=AudiencePreview,
             dependencies=[Depends(require_permission(MANAGE_ANNOUNCEMENTS))])
async def preview_audience(payload: AnnouncementIn) -> AudiencePreview:
    """"This will go to 14 partners", before the button is pressed."""
    recipients = await _resolve_audience(payload)
    return AudiencePreview(
        count=len(recipients),
        names=[u.full_name for u in recipients[:10]],
        truncated=len(recipients) > 10)


@router.post("", response_model=AnnouncementDetail,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_ANNOUNCEMENTS))])
async def send_announcement(payload: AnnouncementIn,
                            background: BackgroundTasks, request: Request,
                            actor: User = Depends(get_active_user)
                            ) -> AnnouncementDetail:
    recipients = await _resolve_audience(payload)
    if not recipients:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Nobody matches that audience, so there is nothing to send.")

    manager_name = None
    if payload.manager_id:
        try:
            mgr = await User.get(PydanticObjectId(payload.manager_id))
        except Exception:  # noqa: BLE001
            mgr = None
        manager_name = mgr.full_name if mgr else None

    caps = (await settings_svc.get_settings()).partner_portal
    a = Announcement(
        code=await next_code("announcement"),
        title=payload.title.strip(), body=payload.body.strip(),
        category=payload.category, valid_until=payload.valid_until,
        audience=payload.audience, manager_id=payload.manager_id,
        manager_name=manager_name,
        selected_partner_ids=payload.selected_partner_ids,
        joined_within_days=payload.joined_within_days,
        # FROZEN recipient list — see the module docstring.
        receipts=[AnnouncementReceipt(partner_id=str(u.id),
                                      partner_name=u.full_name)
                  for u in recipients],
        send_email=payload.send_email,
        # Asking for WhatsApp while it is switched off would silently do
        # nothing, which is worse than the switch being honest.
        send_whatsapp=payload.send_whatsapp and whatsapp_svc.credentials_ready(),
        created_by=str(actor.id), created_by_name=actor.full_name)
    await a.insert()

    # Delivery runs after the response so composing feels instant even with
    # fifty recipients on a small instance.
    background.add_task(_deliver, a, recipients)
    await log_action(
        AuditAction.SETTINGS_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="announcement", entity_id=str(a.id), entity_code=a.code,
        request=request,
        summary=f"Sent notice {a.code} to {len(recipients)} channel partner(s)")
    _ = caps  # settings read kept for the WhatsApp/email switches above
    return AnnouncementDetail(
        **_out(a).model_dump(),
        receipts=[AnnouncementReceiptOut(**r.model_dump()) for r in a.receipts])


# --- Reading back ---------------------------------------------------------------------


@router.get("", response_model=Page[AnnouncementOut],
            dependencies=[Depends(require_permission(VIEW_ANNOUNCEMENTS))])
async def list_announcements(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[AnnouncementOut]:
    total = await Announcement.find_all().count()
    rows = (await Announcement.find_all().sort("-created_at")
            .skip((page - 1) * page_size).limit(page_size).to_list())
    return Page[AnnouncementOut](items=[_out(a) for a in rows],
                                 total=total, page=page, page_size=page_size)


@router.get("/{announcement_id}", response_model=AnnouncementDetail,
            dependencies=[Depends(require_permission(VIEW_ANNOUNCEMENTS))])
async def get_announcement(announcement_id: str) -> AnnouncementDetail:
    a = await Announcement.get(await parse_object_id(announcement_id))
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notice not found.")
    return AnnouncementDetail(
        **_out(a).model_dump(),
        receipts=[AnnouncementReceiptOut(**r.model_dump()) for r in a.receipts])


@router.post("/{announcement_id}/withdraw", response_model=Message,
             dependencies=[Depends(require_permission(MANAGE_ANNOUNCEMENTS))])
async def withdraw(announcement_id: str,
                   actor: User = Depends(get_active_user)) -> Message:
    """Hide it from the portal. It does NOT un-email anybody — that is not a
    thing that can be done, and the composer says so."""
    a = await Announcement.get(await parse_object_id(announcement_id))
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notice not found.")
    a.withdrawn_at = utcnow()
    a.updated_at = utcnow()
    await a.save()
    return Message(
        detail="Withdrawn from the portal. Emails already sent cannot be "
               "recalled.")
