"""In-app notifications API — every account reads/manages only its own rows."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import get_active_user
from app.models.base import utcnow
from app.models.notification import Notification
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message
from app.schemas.notification import NotificationOut, UnreadCount

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut])
async def list_notifications(
    unread_only: bool = Query(default=False),
    limit: int = Query(default=30, ge=1, le=100),
    actor: User = Depends(get_active_user),
) -> list[NotificationOut]:
    query: dict = {"user_id": str(actor.id)}
    if unread_only:
        query["is_read"] = False
    items = (await Notification.find(query).sort("-created_at")
             .limit(limit).to_list())
    return [NotificationOut.from_model(n) for n in items]


@router.get("/unread-count", response_model=UnreadCount)
async def unread_count(actor: User = Depends(get_active_user)) -> UnreadCount:
    count = await Notification.find(
        Notification.user_id == str(actor.id),
        Notification.is_read == False).count()  # noqa: E712
    return UnreadCount(count=count)


async def _own(notification_id: str, actor: User) -> Notification:
    n = await Notification.get(await parse_object_id(notification_id))
    if n is None or n.user_id != str(actor.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found.")
    return n


@router.post("/{notification_id}/read", response_model=NotificationOut)
async def mark_read(notification_id: str,
                    actor: User = Depends(get_active_user)) -> NotificationOut:
    n = await _own(notification_id, actor)
    if not n.is_read:
        n.is_read = True
        n.read_at = utcnow()
        await n.save()
    return NotificationOut.from_model(n)


@router.post("/read-all", response_model=Message)
async def mark_all_read(actor: User = Depends(get_active_user)) -> Message:
    await Notification.find(
        Notification.user_id == str(actor.id),
        Notification.is_read == False).update(  # noqa: E712
            {"$set": {"is_read": True, "read_at": utcnow()}})
    return Message(detail="All notifications marked as read.")


@router.delete("/{notification_id}", response_model=Message)
async def delete_notification(notification_id: str,
                              actor: User = Depends(get_active_user)) -> Message:
    n = await _own(notification_id, actor)
    await n.delete()
    return Message(detail="Notification deleted.")
