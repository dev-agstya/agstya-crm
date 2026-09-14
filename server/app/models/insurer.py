"""Insurer master data — the insurance COMPANIES (manufacturers).

An insurer is a real insurance company that issues the policy (e.g. "HDFC Life",
"ICICI Lombard", "SBI General", "Tata AIG"). It is purely a reference list with no
money role: the agency does not deal with insurers directly — it places business
through Brokers (see app.models.broker), which own the rate card + TDS. On a policy
the insurer is only a tag recording which company underwrote it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import EmailStr, Field

from app.models.base import utcnow


class Insurer(Document):
    code: Indexed(str, unique=True)         # AG-INS-000007
    name: Indexed(str, unique=True)         # "HDFC Life"
    short_name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    website: Optional[str] = None

    active: bool = True
    notes: Optional[str] = None

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "insurers"
        indexes = [
            # Short name is unique too (owner 2026-07-26), but it is OPTIONAL —
            # a plain unique index would allow only ONE insurer without one,
            # because Mongo treats every missing field as the same null. The
            # partial filter limits the constraint to documents that actually
            # carry a string, so any number may leave it blank.
            pymongo.IndexModel(
                [("short_name", pymongo.ASCENDING)],
                name="uniq_short_name",
                unique=True,
                partialFilterExpression={"short_name": {"$type": "string"}},
            ),
        ]
