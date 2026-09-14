"""Customer (policyholder) model — CRM record only, no login."""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, EmailStr, Field

from app.core.enums import RecordOrigin
from app.models.base import utcnow


class Nominee(BaseModel):
    """For life/health policies."""

    name: Optional[str] = None
    relationship: Optional[str] = None
    dob: Optional[date] = None
    share_percent: Optional[float] = None


class KYC(BaseModel):
    """Identity fields. Aadhaar stored masked (last 4) — never full number."""

    pan: Optional[str] = None
    aadhaar_last4: Optional[str] = None
    gstin: Optional[str] = None          # business customers
    dob: Optional[date] = None


class Customer(Document):
    code: Indexed(str, unique=True)      # AG-CX-26-000123

    name: Indexed(str)
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    # Mobile is compulsory and unique per agency (10 digits, +91 assumed). It is
    # the natural key we dedupe customers on.
    mobile: Indexed(str)
    alt_mobile: Optional[str] = None

    # No postal address is collected: the agency works off mobile + email
    # (owner 2026-07-26). Older documents may still carry an `address` sub-doc;
    # it is simply ignored on load.
    kyc: Optional[KYC] = None
    nominees: list[Nominee] = Field(default_factory=list)

    # Renewal reminder opt-in (per customer). Only send reminders if True.
    renewal_reminders_enabled: bool = True

    notes: Optional[str] = None
    tags: list[str] = Field(default_factory=list)

    # Archived instead of deleted while policies exist (owner Q9): hidden from
    # lists/search but still resolvable for finance history. Re-adding a
    # customer with the same mobile un-archives this record.
    is_archived: bool = False
    archived_at: Optional[datetime] = None

    # --- Origin / ownership / scoping ---
    # INHOUSE = created by owner/employee (shared across in-house users).
    # CHANNEL_PARTNER  = created by a partner (private to that partner; in-house can view).
    origin: RecordOrigin = RecordOrigin.INHOUSE
    owner_user_id: str                    # who "owns"/created this customer
    partner_id: Optional[str] = None

    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "customers"
        indexes = [
            [("origin", pymongo.ASCENDING)],
            [("owner_user_id", pymongo.ASCENDING)],
            [("partner_id", pymongo.ASCENDING)],
            [("mobile", pymongo.ASCENDING)],
            # Default list sort is -created_at (see policies).
            [("created_at", pymongo.DESCENDING)],
        ]
