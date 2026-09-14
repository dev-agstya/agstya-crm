"""Announcements — the agency broadcasting to its channel partners.

A rate change, a promotional offer, a festival notice. The owner writes it once,
picks who it goes to, and it lands in every matching partner's Notices list,
their notification bell and (per broadcast) their email and WhatsApp.

Two decisions worth knowing before changing anything here:

  * The audience is RESOLVED AT SEND TIME and the resulting recipient ids are
    STORED. It is not re-evaluated on read. A broadcast that said "everyone
    under Rahul" in August must still show the same fourteen people in November
    after two of them moved to Sunita — otherwise the read receipts stop meaning
    anything and a partner can lose a notice they were sent.
  * There is no scheduling (owner D4). Send-now only; the 08:00 digest cron is
    the only scheduled job in the app and adding a second is its own piece of
    work.

An announcement cannot be unsent. It can be withdrawn from the Notices list,
which stops it being read again but does not un-email anybody — the copy on the
composer says so.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.core.enums import AnnouncementAudience, AnnouncementCategory
from app.models.base import utcnow


class AnnouncementReceipt(BaseModel):
    """One recipient, and whether they have opened it."""

    partner_id: str
    partner_name: Optional[str] = None
    read_at: Optional[datetime] = None


class Announcement(Document):
    code: Indexed(str, unique=True)            # ANN-...

    title: str
    # Plain text with line breaks. Deliberately NOT HTML: this is composed in a
    # textarea by a non-technical user and rendered into an email, and accepting
    # markup from a form that ends up in someone's inbox is a hole.
    body: str
    category: AnnouncementCategory = AnnouncementCategory.NOTICE
    # Optional "this offer runs until" — shown on the notice, not enforced.
    valid_until: Optional[datetime] = None

    # --- Audience (owner D1: no performance-based segments) ---
    audience: AnnouncementAudience = AnnouncementAudience.ALL
    # Set when audience is MANAGER (everyone under this employee) or SELECTED.
    manager_id: Optional[str] = None
    manager_name: Optional[str] = None
    selected_partner_ids: list[str] = Field(default_factory=list)
    # Set when audience is NEW_PARTNERS.
    joined_within_days: Optional[int] = None

    # Frozen recipient list — see the note at the top of this module.
    receipts: list[AnnouncementReceipt] = Field(default_factory=list)

    # --- Delivery (owner D2: in-app always, email and WhatsApp per broadcast) ---
    send_email: bool = True
    send_whatsapp: bool = False

    withdrawn_at: Optional[datetime] = None

    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    @property
    def recipient_count(self) -> int:
        return len(self.receipts)

    @property
    def read_count(self) -> int:
        return sum(1 for r in self.receipts if r.read_at is not None)

    class Settings:
        name = "announcements"
        indexes = [
            [("created_at", pymongo.DESCENDING)],
            # "what should this partner see" — an equality match against an
            # array element, which is a multikey index hit.
            [("receipts.partner_id", pymongo.ASCENDING)],
        ]
