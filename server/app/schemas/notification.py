"""Schemas for in-app notifications."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class NotificationOut(BaseModel):
    id: str
    title: str
    body: Optional[str] = None
    category: Optional[str] = None
    link: Optional[str] = None
    is_read: bool = False
    created_at: datetime

    @classmethod
    def from_model(cls, n) -> "NotificationOut":
        data = n.model_dump()
        data["id"] = str(n.id)
        return cls(**data)


class UnreadCount(BaseModel):
    count: int = 0
