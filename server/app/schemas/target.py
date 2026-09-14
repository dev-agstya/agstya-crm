"""Schemas for Targets + attainment.

A target carries several metrics at once ({"policies": 15,
"house_profit": 250000}), so the wire format is a map rather than a single
metric/value pair — see models/target.py for why.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.core.enums import TargetMetric, TargetPeriod

_VALID_METRICS = {m.value for m in TargetMetric}


def _only_month(v: Optional[TargetPeriod]) -> Optional[TargetPeriod]:
    """Targets are monthly, full stop (owner 2026-07-26).

    Quarterly and yearly windows were removed from the UI; rejecting them here
    too means an old client (or a curious API caller) cannot create a target the
    screens can no longer display or edit. The enum keeps its other members so
    any legacy row still loads.
    """
    if v is not None and v != TargetPeriod.MONTH:
        raise ValueError("Targets are monthly only.")
    return v


def _clean_metrics(value: dict[str, int]) -> dict[str, int]:
    """Drop unknown keys and non-positive goals.

    A zero or negative goal is not a goal — it is the owner clearing the field —
    so it is removed rather than stored as "0 policies", which would otherwise
    read as a permanent 0% attainment row.
    """
    return {k: int(v) for k, v in (value or {}).items()
            if k in _VALID_METRICS and int(v) > 0}


class TargetMetricRow(BaseModel):
    """One metric inside a target, with its live attainment."""
    metric: TargetMetric
    label: str
    is_money: bool
    target_value: int
    actual_value: int = 0
    attainment_pct: float = 0.0


class TargetCreate(BaseModel):
    assignee_type: str                 # "employee" | "channel_partner"
    assignee_id: str
    period: TargetPeriod = TargetPeriod.MONTH
    # Any date inside the intended period — the server snaps it to the IST
    # period boundary, so the UI can send the 1st or "today" interchangeably.
    period_start: datetime
    metrics: dict[str, int] = Field(default_factory=dict)
    note: Optional[str] = None

    @field_validator("period")
    @classmethod
    def _period(cls, v):
        return _only_month(v)

    @field_validator("metrics")
    @classmethod
    def _validate_metrics(cls, v: dict[str, int]) -> dict[str, int]:
        cleaned = _clean_metrics(v)
        if not cleaned:
            raise ValueError("Set at least one target value.")
        return cleaned


class TargetUpdate(BaseModel):
    period: Optional[TargetPeriod] = None
    period_start: Optional[datetime] = None
    metrics: Optional[dict[str, int]] = None
    note: Optional[str] = None

    @field_validator("period")
    @classmethod
    def _period(cls, v):
        return _only_month(v)

    @field_validator("metrics")
    @classmethod
    def _validate_metrics(cls, v):
        if v is None:
            return v
        cleaned = _clean_metrics(v)
        if not cleaned:
            raise ValueError("Set at least one target value.")
        return cleaned


class BulkTargetRow(BaseModel):
    """One person's goals in the bulk assign screen. Empty metrics = remove."""
    assignee_id: str
    assignee_type: str = "employee"
    metrics: dict[str, int] = Field(default_factory=dict)

    @field_validator("metrics")
    @classmethod
    def _clean(cls, v: dict[str, int]) -> dict[str, int]:
        return _clean_metrics(v)


class BulkTargetAssign(BaseModel):
    """Assign a whole month's targets for the team in one save."""
    period: TargetPeriod = TargetPeriod.MONTH
    period_start: datetime
    rows: list[BulkTargetRow]

    @field_validator("period")
    @classmethod
    def _period(cls, v):
        return _only_month(v)


class TargetOut(BaseModel):
    id: str
    assignee_type: str
    assignee_id: str
    assignee_name: Optional[str] = None
    period: TargetPeriod
    period_start: datetime
    period_end: datetime
    period_label: str
    metrics: list[TargetMetricRow] = Field(default_factory=list)
    # Headline number: the primary metric's attainment when it is one of the
    # goals, else the average of the goals that were set.
    attainment_pct: float = 0.0
    note: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, t, *, actuals: Optional[dict[str, int]] = None,
                   assignee_name: Optional[str] = None,
                   allow_profit: bool = True) -> "TargetOut":
        """`allow_profit=False` drops the house-profit goal before it is
        serialised, and the headline % is then computed from what remains."""
        from app.services import targets as svc

        rows = svc.metric_rows(t.metrics or {}, actuals or {},
                               allow_profit=allow_profit)
        return cls(
            id=str(t.id),
            assignee_type=t.assignee_type,
            assignee_id=t.assignee_id,
            assignee_name=assignee_name,
            period=t.period,
            period_start=t.period_start,
            period_end=t.period_end,
            period_label=svc.period_label(t.period, t.period_start),
            metrics=[TargetMetricRow(**r) for r in rows],
            attainment_pct=svc.overall_attainment(rows),
            note=t.note,
            created_at=t.created_at,
        )


class PerformanceRow(BaseModel):
    """One person on the performance leaderboard."""
    assignee_id: str
    assignee_type: str = "employee"
    name: str
    code: Optional[str] = None
    policies: int = 0
    renewals: int = 0
    premium: int = 0
    profit: int = 0
    has_target: bool = False
    target_id: Optional[str] = None
    attainment_pct: float = 0.0
    metrics: list[TargetMetricRow] = Field(default_factory=list)
    score: float = 0.0
    rank: int = 0


class PerformanceReport(BaseModel):
    """The Targets page report + the dashboard's employee performance block."""
    period: TargetPeriod
    period_start: datetime
    period_end: datetime
    period_label: str
    rows: list[PerformanceRow] = Field(default_factory=list)
    totals: dict[str, int] = Field(default_factory=dict)
    with_target: int = 0
    on_track: int = 0          # rows at or above 100% of their goal


class TargetProgress(BaseModel):
    """The dashboard's target tile.

    `scope` says whose numbers these are: "self" for an employee looking at
    their own month, "team" for the owner looking at everyone's combined. The
    metric rows are already filtered for the viewer, so the tile renders
    whatever it is handed without deciding anything itself.
    """
    scope: str = "self"                  # "self" | "team"
    window: str = "current"              # current | prev1 | prev2 | last3
    label: str = ""
    period_start: datetime
    period_end: datetime
    has_target: bool = False
    metrics: list[TargetMetricRow] = Field(default_factory=list)
    attainment_pct: float = 0.0
    # Team scope only: how many people carry a target in this window, out of
    # how many active employees.
    people_with_target: int = 0
    people: int = 0


class TrendPoint(BaseModel):
    """One month of a person's actual-vs-target history."""
    key: str
    label: str
    actual: int = 0
    target: int = 0
    attainment_pct: float = 0.0


class AssigneeAnalytics(BaseModel):
    """Deep-dive for one employee or channel partner (the Analytics popup)."""
    assignee_id: str
    assignee_type: str
    name: str
    code: Optional[str] = None
    metric: TargetMetric
    period_label: str
    policies: int = 0
    renewals: int = 0
    premium: int = 0
    profit: int = 0
    partner_payout: int = 0
    attainment_pct: float = 0.0
    has_target: bool = False
    metrics: list[TargetMetricRow] = Field(default_factory=list)
    trend: list[TrendPoint] = Field(default_factory=list)
    top_categories: list[dict] = Field(default_factory=list)
