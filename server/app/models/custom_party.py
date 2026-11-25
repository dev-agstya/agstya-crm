"""Custom party model — for KhataBook style ad-hoc party ledger (friends, vendors, loans, etc.)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.models.base import utcnow


class CustomParty(Document):
    """An external or personal counterparty for KhataBook tracking."""

    name: Indexed(str)
    phone: Optional[str] = None
    category: str = "personal"  # "personal", "vendor", "loan", "landlord", "other"
    notes: Optional[str] = None
    is_archived: bool = False

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "custom_parties"
        indexes = [
            [("name", pymongo.ASCENDING)],
            [("category", pymongo.ASCENDING)],
            [("created_at", pymongo.DESCENDING)],
        ]
