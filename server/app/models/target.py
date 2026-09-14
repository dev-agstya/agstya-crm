"""Target — the performance goals set for one person over one period.

MULTI-METRIC (2026-07-26 rewrite, owner-directed)
-------------------------------------------------
A target used to be one row per metric, so giving an employee "15 policies AND
Rs 2,500 house profit for June" meant creating two separate targets with two
separate start dates. The owner asked for both numbers to be handed out in one
go, so a Target now carries a `metrics` map:

    {"policies": 15, "house_profit": 250000}

Only the metrics the owner actually filled in are present — an absent key means
"no goal for that metric", which is different from a goal of zero.

One document per (assignee, period_start, period). The window is normalised to
whole IST calendar months on write (services/targets.normalise_period), so a
"July target" always means 1-31 July and never 26-31 July because of the day the
form happened to be opened.

Attainment is DERIVED at read time from the live policy book (see
services/targets.compute_actuals) — a target is only ever the goal definition,
never a stored score, so a cancelled or deleted policy drops out of the numbers
automatically.

Money metrics store paise; count metrics store a plain integer.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import TargetPeriod
from app.models.base import utcnow


class Target(Document):
    # Who the target is for: an "employee" or a "channel_partner" (AccountType
    # value). Partners get targets too — staff use them to judge how a partner
    # is performing; partners never sign in to see them.
    assignee_type: str
    assignee_id: Indexed(str)

    period: TargetPeriod = TargetPeriod.MONTH
    period_start: datetime          # window start (UTC, inclusive)
    period_end: datetime            # window end   (UTC, exclusive)

    # {TargetMetric value: goal}. Paise for money metrics, count otherwise.
    metrics: dict[str, int] = Field(default_factory=dict)

    # Progress milestones (50 / 90 / 100) the assignee has already been
    # congratulated on. Stored so a milestone is announced exactly once per
    # target — attainment is recomputed on every read, so without this a
    # hovering-at-51% employee would be told "halfway there" on every policy.
    # Editing the goals clears it, because the numbers they were measured
    # against changed.
    notified_pcts: list[int] = Field(default_factory=list)

    note: Optional[str] = None

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "targets"
        indexes = [
            [("assignee_id", pymongo.ASCENDING),
             ("period_start", pymongo.DESCENDING)],
            [("period_start", pymongo.DESCENDING)],
        ]
