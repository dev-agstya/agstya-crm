"""Pure helpers for the finance dashboard/reports: month bucketing, growth,
aging. The async aggregation lives in routers/finance.py and calls these.

Business calendar is INDIAN STANDARD TIME (owner Q-P1). Data is stored in UTC,
but every reporting boundary — "today", month, financial year, month keys — is
computed in IST so a late-night transaction lands in the correct Indian day /
month. All datetimes returned here are IST-aware; Mongo compares them against the
UTC-stored instants correctly (comparison is by absolute instant, not wall clock).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

# Indian Standard Time (UTC+5:30). India has no DST, so a fixed offset is exact.
IST = timezone(timedelta(hours=5, minutes=30))


def to_ist(dt: datetime) -> datetime:
    """Coerce any datetime to IST-aware. Naive values are assumed UTC (that's how
    everything is stored)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST)


def now_ist() -> datetime:
    return datetime.now(IST)


# --- User-picked date bounds -----------------------------------------------------
#
# THE ONE PLACE a date somebody typed into a filter is turned into an instant.
#
# Six routers each had a private `_parse_dt` that attached UTC to a value with no
# offset. That is right for an API timestamp and WRONG for a calendar date: an
# Indian user picking "01-08-2026" means midnight in Delhi, not midnight in
# Greenwich, so the UTC reading started the range at 05:30 IST and silently
# dropped the first five and a half hours of it — and closed it 05:30 into the
# NEXT day at the other end.
#
# The fix had already been made once (routers/reports._parse_ist, 2026-08-04) and
# applied to exactly one of the six files, so the Business Report and the
# Transactions page gave different answers for the same picked range. Six copies
# of a rule is why: there was no single place for the fix to land. This is that
# place. Routers import these; nobody re-implements them.


def parse_ist_bound(value: Optional[str]) -> Optional[datetime]:
    """A user-picked date/datetime, read as INDIAN wall-clock time.

    A value carrying its own offset is respected as given (the client sent a
    real instant). A bare "2026-08-01" or "2026-08-01T09:30" is IST, because
    that is the calendar the person picking it is looking at.

    Returns None for blank or unparseable input — a filter that cannot be read
    is no filter, never a 500.
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=IST)


def parse_ist_end_of_day(value: Optional[str]) -> Optional[datetime]:
    """An upper bound, inclusive of the whole day when no time was given.

    A range ending "31 Jul" that stopped at 00:00:00 would drop everything
    booked on the 31st — the single most common off-by-one in a date filter.
    Only a value that is exactly midnight is promoted, so an explicit
    "31 Jul 14:00" is left alone.
    """
    dt = parse_ist_bound(value)
    if dt is None:
        return None
    if (dt.hour, dt.minute, dt.second, dt.microsecond) == (0, 0, 0, 0):
        dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
    return dt


def ist_range(date_from: Optional[str],
              date_to: Optional[str]) -> dict:
    """An inclusive Mongo range for a pair of user-picked dates.

    Empty dict when neither bound is given, so it can be splatted into a query
    unconditionally.
    """
    out: dict = {}
    if (lo := parse_ist_bound(date_from)) is not None:
        out["$gte"] = lo
    if (hi := parse_ist_end_of_day(date_to)) is not None:
        out["$lte"] = hi
    return out


def month_key(dt: datetime) -> str:
    d = to_ist(dt)
    return f"{d.year:04d}-{d.month:02d}"


def shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    """Add `delta` months to (year, month), returning the normalised pair."""
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def last_n_month_keys(now: datetime, n: int) -> list[str]:
    """The last n month keys ending with `now`'s (IST) month, oldest first."""
    now = to_ist(now)
    keys: list[str] = []
    for i in range(n - 1, -1, -1):
        y, m = shift_month(now.year, now.month, -i)
        keys.append(f"{y:04d}-{m:02d}")
    return keys


def growth_pct(this: int, last: int) -> Optional[float]:
    """Percent change this vs last; None when there's no prior base."""
    if last == 0:
        return None
    return round((this - last) / last * 100, 1)


def aging_bucket(days: int) -> str:
    """Bucket a receivable's age in days: 0-30 / 30-60 / 60+."""
    if days <= 30:
        return "0_30"
    if days <= 60:
        return "30_60"
    return "60_plus"


def fy_start_year(dt: datetime) -> int:
    """Indian financial year starts 1 April (IST). Returns the FY's start year."""
    d = to_ist(dt)
    return d.year if d.month >= 4 else d.year - 1


def fy_label(dt: datetime) -> str:
    start = fy_start_year(dt)
    return f"FY {start}-{str(start + 1)[-2:]}"


def _fy_label_for_start(start: int) -> str:
    return f"FY {start}-{str(start + 1)[-2:]}"


def month_floor(dt: datetime) -> datetime:
    """First instant of `dt`'s month, IST-aware."""
    d = to_ist(dt)
    return datetime(d.year, d.month, 1, tzinfo=IST)


# The date-filter presets offered on the finance dashboard / balance sheets.
# today / this_week support the daily/weekly partner-payout statement cadence.
# till_date = everything ever recorded (all-time).
PERIODS = {"today", "this_week", "current_month", "last_month", "last_3_months",
           "this_year", "last_year", "till_date", "custom"}


def resolve_period(
    period: str, now: datetime,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
) -> tuple[datetime, datetime, str]:
    """Turn a preset name (+ optional custom bounds) into a concrete
    (lo, hi, human-label) window. `hi` is inclusive.

    Years use the Indian financial year (1 Apr–31 Mar) to match the rest of
    the app. Unknown presets fall back to the current month. All boundaries are
    computed in IST (owner Q-P1); `now` is the true current instant (IST-aware).
    """
    now = to_ist(now)
    eps = timedelta(seconds=1)

    if period == "today":
        lo = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return lo, now, "Today"
    if period == "this_week":
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        lo = day_start - timedelta(days=now.weekday())   # Monday
        return lo, now, "This week"
    if period == "last_month":
        y, m = shift_month(now.year, now.month, -1)
        lo = datetime(y, m, 1, tzinfo=IST)
        hi = month_floor(now) - eps
        return lo, hi, "Last month"
    if period == "last_3_months":
        y, m = shift_month(now.year, now.month, -2)
        lo = datetime(y, m, 1, tzinfo=IST)
        return lo, now, "Last 3 months"
    if period == "this_year":
        sy = fy_start_year(now)
        lo = datetime(sy, 4, 1, tzinfo=IST)
        return lo, now, _fy_label_for_start(sy)
    if period == "last_year":
        sy = fy_start_year(now) - 1
        lo = datetime(sy, 4, 1, tzinfo=IST)
        hi = datetime(sy + 1, 4, 1, tzinfo=IST) - eps
        return lo, hi, _fy_label_for_start(sy)
    if period == "till_date":
        lo = datetime(1970, 1, 1, tzinfo=IST)
        return lo, now, "Till date"
    if period == "custom":
        # Explicit user-picked bounds are taken as given (already tz-aware from
        # the router); a naive value is read as IST wall-clock.
        lo = date_from if date_from is not None else month_floor(now)
        hi = date_to if date_to is not None else now
        lo = lo if lo.tzinfo else lo.replace(tzinfo=IST)
        hi = hi if hi.tzinfo else hi.replace(tzinfo=IST)
        return lo, hi, "Custom range"
    # current_month (default)
    return month_floor(now), now, "This month"
