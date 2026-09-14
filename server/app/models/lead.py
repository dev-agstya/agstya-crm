"""Lead / sales-pipeline model with internal comments."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.core.enums import LeadStage, LeadType, RecordOrigin
from app.models.base import utcnow


class LeadComment(BaseModel):
    """A note on a lead.

    `internal` marks a note written by an in-house user on a *partner's* lead —
    such notes are hidden from the partner (they only see their own comments).
    """

    author_id: str
    author_name: str
    author_role: Optional[str] = None
    body: str
    internal: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class Lead(Document):
    code: Indexed(str, unique=True)           # AG-LED-000045

    # What kind of prospect this is: a person, a company, or someone who will
    # bring business in. Filtered on from the tabs at the top of the Leads page,
    # so it carries an index of its own.
    type: LeadType = LeadType.CUSTOMER
    name: str
    mobile_country_code: str = "+91"          # fixed ISD code for now
    mobile: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    category_key: Optional[str] = None        # legacy line-of-business key (kept
                                              # for back-compat; superseded by
                                              # the free-text interested_in)
    interested_in: Optional[str] = None       # short free text (owner 2026-07-17)
    estimated_premium: Optional[int] = None   # paise
    source: Optional[str] = None              # legacy — no longer collected
    note: Optional[str] = None                # free-text note (not a comment)

    stage: LeadStage = LeadStage.NEW
    lost_reason: Optional[str] = None

    # Set when converted to a customer/policy.
    converted_customer_id: Optional[str] = None
    converted_policy_id: Optional[str] = None

    comments: list[LeadComment] = Field(default_factory=list)

    # --- Origin / ownership / scoping ---
    origin: RecordOrigin = RecordOrigin.INHOUSE
    owner_user_id: str
    partner_id: Optional[str] = None
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None     # "Added by" (denormalised)

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "leads"
        indexes = [
            [("stage", pymongo.ASCENDING)],
            [("type", pymongo.ASCENDING)],
            # The tab counts are one grouped query per page load; the tabs then
            # filter on type + stage together.
            [("type", pymongo.ASCENDING), ("stage", pymongo.ASCENDING)],
            [("origin", pymongo.ASCENDING)],
            [("owner_user_id", pymongo.ASCENDING)],
            [("partner_id", pymongo.ASCENDING)],
            # Default list sort is -created_at (see policies).
            [("created_at", pymongo.DESCENDING)],
        ]
