"""In-app notifications: one row per recipient. Shown in the floating
notification widget; unread ones drive the red-dot indicator."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.config import settings
from app.models.base import utcnow

_NOTIF_TTL_SECONDS = settings.notification_retention_days * 24 * 3600


class Notification(Document):
    user_id: Indexed(str)                  # recipient user id
    title: str
    body: Optional[str] = None             # optional longer message
    category: Optional[str] = None         # "policy" | "withdrawal" | ...
    link: Optional[str] = None             # optional in-app route to open
    is_read: bool = False

    created_at: datetime = Field(default_factory=utcnow)
    read_at: Optional[datetime] = None

    class Settings:
        name = "notifications"
        indexes = [
            [("user_id", pymongo.ASCENDING), ("is_read", pymongo.ASCENDING)],
            [("created_at", pymongo.DESCENDING)],
            # TTL: notifications self-delete after the retention window (Q-D3).
            pymongo.IndexModel(
                [("created_at", pymongo.ASCENDING)],
                expireAfterSeconds=_NOTIF_TTL_SECONDS, name="notif_ttl"),
        ]
