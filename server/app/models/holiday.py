"""Declared holidays — the yearly list an admin enters once.

A holiday is a PAID non-working day. It cannot make anybody absent, it is never
deducted, and a leave range that spans one does not spend a leave day on it.
That is the whole feature: entering the list is how the attendance month stops
reporting Republic Day as everybody failing to come to work.

NOTHING IS SEEDED. This app seeds nothing, deliberately, and a holiday list is
the clearest case for it — Diwali moves every year and half of any real Indian
list is regional. The Holidays page offers the three fixed NATIONAL holidays as
one-click suggestions when a year is empty (services/hr_calendar), which is a
suggestion the owner accepts, not a row that appeared by itself.

DECLARING ONE RETROACTIVELY WORKS, and that is a consequence of attendance days
being DERIVED rather than pre-stamped (see models/attendance): adding 15 August
in September fixes every affected month view at once, with no backfill.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.models.base import utcnow


class Holiday(Document):
    # "YYYY-MM-DD", IST — the same key AttendanceDay.day uses, so a holiday and
    # a day are comparable without parsing either.
    date: str
    # Denormalised off `date` because the page is a year at a time and "give me
    # 2026" must be one indexed lookup rather than a regex on a string.
    year: Indexed(int)
    name: str
    note: Optional[str] = None

    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "holidays"
        indexes = [
            # ONE holiday per date. Two rows for 26 January is not a richer
            # calendar, it is a list somebody will read twice and a day the
            # month view would have to pick between.
            pymongo.IndexModel(
                [("date", pymongo.ASCENDING)], unique=True,
                name="holiday_date_unique"),
            [("year", pymongo.ASCENDING), ("date", pymongo.ASCENDING)],
        ]
