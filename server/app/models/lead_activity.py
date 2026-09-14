"""Per-staff, per-day lead activity counters.

Feeds future Employee-performance reporting: how many leads a staff member
created / touched / converted each day. One document per (user, UTC day).
Partners are NOT tracked — staff (employees) only.
"""

from __future__ import annotations

from datetime import datetime

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.config import settings
from app.models.base import utcnow

_LEAD_ACT_TTL_SECONDS = settings.lead_activity_retention_days * 24 * 3600


class LeadActivityDaily(Document):
    user_id: Indexed(str)
    user_name: str
    day: str                       # 'YYYY-MM-DD' in UTC

    leads_created: int = 0
    leads_converted: int = 0
    leads_updated: int = 0         # DISTINCT leads touched that day

    # Ids touched today, so re-editing the same lead doesn't double-count.
    touched_lead_ids: list[str] = Field(default_factory=list)

    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "lead_activity_daily"
        indexes = [
            [("user_id", pymongo.ASCENDING), ("day", pymongo.ASCENDING)],
            [("day", pymongo.ASCENDING)],
            # TTL: owner Q-D3 — don't keep daily lead-activity long-term. Rows
            # self-delete after the retention window (default 90d).
            pymongo.IndexModel(
                [("updated_at", pymongo.ASCENDING)],
                expireAfterSeconds=_LEAD_ACT_TTL_SECONDS, name="lead_act_ttl"),
        ]
