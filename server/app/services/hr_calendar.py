"""The working calendar: what an IST day IS before anybody punches on it.

ONE definition of "is the office open", read by attendance, by leave and by the
holiday page. Three copies of "Sunday plus the holiday list" is how the leave
form ends up charging somebody for a day the attendance register shows as shut.

EVERYTHING HERE IS IST, AND EVERYTHING HERE IS A DATE
-----------------------------------------------------
The rest of the app stores instants in UTC and buckets them in IST
(services/finance_reports). This module works one level up from that: its unit
is the CALENDAR DAY, keyed "YYYY-MM-DD" in Indian time, because that is what a
holiday, a leave and an attendance row actually are. `IST` and `to_ist` are
imported from finance_reports rather than redefined — a second timezone
constant is a second thing to get wrong.

`day_key(instant)` is the one bridge between the two worlds and every write in
this module goes through it. A punch-out at 19:30 IST is 14:00 UTC; asking the
UTC date would still say the right day, but a punch at 00:30 IST is 19:00 UTC
the PREVIOUS day, and that is the shift somebody works late enough to hit.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Iterable, Optional

from app.models.holiday import Holiday
from app.services.finance_reports import IST, to_ist

__all__ = [
    "IST", "day_key", "parse_day", "today_key", "now_ist", "month_key_of",
    "month_bounds", "days_in_month", "is_week_off", "holiday_map",
    "calendar_days", "working_days_between", "day_span",
    "combine_ist", "parse_hhmm", "shift_bounds", "NATIONAL_HOLIDAYS",
    "leave_year_of", "leave_year_bounds", "month_iter",
]


# --- Day keys ---------------------------------------------------------------------


def now_ist() -> datetime:
    return datetime.now(IST)


def day_key(moment: datetime | date) -> str:
    """The IST calendar day an instant belongs to, as "YYYY-MM-DD".

    Accepts a `date` unchanged (it is already a calendar day and has no
    timezone to convert) and converts a `datetime` through IST.
    """
    if isinstance(moment, datetime):
        return to_ist(moment).strftime("%Y-%m-%d")
    return moment.strftime("%Y-%m-%d")


def parse_day(key: str) -> date:
    """"YYYY-MM-DD" -> date. Raises ValueError on anything else, deliberately:
    a malformed day key is a bug in a caller, not user input to be tolerated."""
    return date.fromisoformat(key)


def today_key(now: Optional[datetime] = None) -> str:
    return day_key(now or now_ist())


def month_key_of(day: str | date) -> str:
    """"2026-08-14" -> "2026-08"."""
    return (day if isinstance(day, str) else day.isoformat())[:7]


def days_in_month(year: int, month: int) -> int:
    first = date(year, month, 1)
    nxt = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    return (nxt - first).days


def month_bounds(month: str) -> tuple[date, date]:
    """"2026-08" -> (1 Aug, 31 Aug), inclusive both ends."""
    year, mon = (int(x) for x in month.split("-"))
    return date(year, mon, 1), date(year, mon, days_in_month(year, mon))


def month_iter(month: str) -> list[date]:
    """Every calendar date in the month, in order."""
    first, last = month_bounds(month)
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]


def day_span(start: str | date, end: str | date) -> list[date]:
    """Every date from start to end INCLUSIVE. Empty when end precedes start."""
    a = parse_day(start) if isinstance(start, str) else start
    b = parse_day(end) if isinstance(end, str) else end
    if b < a:
        return []
    return [a + timedelta(days=i) for i in range((b - a).days + 1)]


def calendar_days(month: str) -> int:
    first, _ = month_bounds(month)
    return days_in_month(first.year, first.month)


# --- Non-working days -------------------------------------------------------------


def is_week_off(day: date, week_off_days: Iterable[int]) -> bool:
    """Python weekday(): Monday=0 ... Sunday=6.

    The agency works Monday to Saturday with Sunday off, so the default set is
    {6} — but it is a SET rather than `== 6` so alternate Saturdays are a
    settings change rather than a deploy (owner D1/D2).
    """
    return day.weekday() in set(week_off_days)


async def holiday_map(start: str | date, end: str | date) -> dict[str, str]:
    """{day key: holiday name} for a date range. ONE query, never one per day.

    A range query on the string date works because "YYYY-MM-DD" sorts
    lexicographically in the same order it sorts chronologically — which is the
    whole reason the key is zero-padded ISO rather than anything friendlier.
    """
    lo = start if isinstance(start, str) else start.isoformat()
    hi = end if isinstance(end, str) else end.isoformat()
    rows = await Holiday.find({"date": {"$gte": lo, "$lte": hi}}).to_list()
    return {h.date: h.name for h in rows}


def working_days_between(start: str | date, end: str | date, *,
                         week_off_days: Iterable[int],
                         holidays: dict[str, str]) -> list[date]:
    """The days the office is actually open in a range.

    This is what a leave request costs (owner E9): a Friday-to-Monday leave over
    a Sunday is THREE days, not four, and nobody spends a leave day on a day the
    office was shut. Same function decides which days an attendance month can
    call somebody absent, so the two can never disagree.
    """
    offs = set(week_off_days)
    return [d for d in day_span(start, end)
            if d.weekday() not in offs and d.isoformat() not in holidays]


# --- Shift times ------------------------------------------------------------------


def parse_hhmm(value: str, fallback: str = "10:00") -> tuple[int, int]:
    """"10:00" -> (10, 0). Falls back rather than raising: a shift time is a
    settings string a person typed, and a malformed one must not 500 every
    punch in the agency."""
    for candidate in (value, fallback):
        try:
            hh, mm = (candidate or "").split(":")
            h, m = int(hh), int(mm)
            if 0 <= h <= 23 and 0 <= m <= 59:
                return h, m
        except (ValueError, AttributeError):
            continue
    return 10, 0


def combine_ist(day: date, hhmm: str, fallback: str = "10:00") -> datetime:
    """An IST-aware instant for a wall-clock time on a calendar day."""
    h, m = parse_hhmm(hhmm, fallback)
    return datetime(day.year, day.month, day.day, h, m, tzinfo=IST)


def shift_bounds(day: date, start: str, end: str) -> tuple[datetime, datetime]:
    """(shift start, shift end) as IST instants on `day`.

    An end EARLIER than the start is read as an overnight shift and rolls into
    the next day, so a 22:00-06:00 arrangement does not produce a negative
    working window. Nothing in the agency works that way today; the alternative
    was a silently negative duration if anyone ever configured it.
    """
    a = combine_ist(day, start, "10:00")
    b = combine_ist(day, end, "19:00")
    if b <= a:
        b += timedelta(days=1)
    return a, b


# --- The leave year ---------------------------------------------------------------


def leave_year_of(day: str | date, start_month: int = 4) -> int:
    """Which leave year a date belongs to, as the year it STARTED in.

    With the Indian default (April), 14 Aug 2026 and 14 Feb 2027 are both leave
    year 2026 — which is the point: a balance carries across the calendar-year
    boundary and lapses at the end of March (owner E2/E3).
    """
    d = parse_day(day) if isinstance(day, str) else day
    return d.year if d.month >= start_month else d.year - 1


def leave_year_bounds(leave_year: int, start_month: int = 4) -> tuple[date, date]:
    """(first day, last day) of a leave year."""
    first = date(leave_year, start_month, 1)
    last = date(leave_year + 1, start_month, 1) - timedelta(days=1)
    return first, last


# --- Suggestions ------------------------------------------------------------------

# The three FIXED national holidays, offered as one-click suggestions on an
# empty year (owner D4). Deliberately not seeded and deliberately only these
# three: every other Indian holiday either moves with the lunar calendar or is
# regional, and a list that guesses wrong is worse than an empty one somebody
# fills in. (month, day, name.)
NATIONAL_HOLIDAYS: tuple[tuple[int, int, str], ...] = (
    (1, 26, "Republic Day"),
    (8, 15, "Independence Day"),
    (10, 2, "Gandhi Jayanti"),
)


def national_holidays_for(year: int) -> list[dict]:
    return [{"date": date(year, m, d).isoformat(), "name": name}
            for m, d, name in NATIONAL_HOLIDAYS]
