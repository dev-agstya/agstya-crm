"""Every user-picked date bound is an INDIAN day, in every router.

The bug this pins (2026-08-07): the IST reading was introduced in
`routers/reports.py` on 2026-08-04 and applied to that file only. The other five
routers kept a private `_parse_dt` that attached UTC, so the SAME custom range
answered differently depending on which screen you were on — the Business Report
counted an Indian day, the Transactions page counted a day starting at 05:30 IST
and running 05:30 into the next one.

CLAUDE.md calls two finance surfaces disagreeing "the worst bug this app can
have". Six private copies of a date rule is how it happened: there was nowhere
for the fix to land once. There is now, and these tests fail if a router grows
its own copy again.
"""

from datetime import datetime, timedelta, timezone

from app.routers import audit as audit_router
from app.routers import banks as banks_router
from app.routers import finance as finance_router
from app.routers import policies as policies_router
from app.routers import reports as reports_router
from app.services.finance_reports import (
    IST,
    ist_range,
    parse_ist_bound,
    parse_ist_end_of_day,
    resolve_period,
)

UTC = timezone.utc


# --- The reader itself ---------------------------------------------------------

def test_bare_date_is_indian_midnight_not_utc_midnight():
    """The whole bug in one assertion.

    "2026-08-01" from a date picker means midnight in Delhi. Read as UTC it
    becomes 05:30 IST and drops the first five and a half hours of the range.
    """
    got = parse_ist_bound("2026-08-01")
    assert got == datetime(2026, 8, 1, tzinfo=IST)
    # ...which is 18:30 on 31 July in UTC, NOT 00:00 on 1 August.
    assert got.astimezone(UTC) == datetime(2026, 7, 31, 18, 30, tzinfo=UTC)


def test_an_explicit_offset_is_respected():
    """A client that sent a real instant is not second-guessed."""
    assert parse_ist_bound("2026-08-01T00:00:00Z") == \
        datetime(2026, 8, 1, tzinfo=UTC)


def test_unparseable_is_no_filter_never_a_crash():
    assert parse_ist_bound("") is None
    assert parse_ist_bound(None) is None
    assert parse_ist_bound("last tuesday") is None
    assert parse_ist_end_of_day("31/07/2026") is None


def test_end_of_day_covers_the_whole_last_day():
    """A range ending "31 Jul" that stops at midnight drops the 31st."""
    hi = parse_ist_end_of_day("2026-07-31")
    assert hi is not None
    assert (hi.hour, hi.minute, hi.second) == (23, 59, 59)
    assert hi.utcoffset() == timedelta(hours=5, minutes=30)


def test_end_of_day_leaves_an_explicit_time_alone():
    """Only exact midnight is promoted — "31 Jul 14:00" means 14:00."""
    hi = parse_ist_end_of_day("2026-07-31T14:00:00")
    assert (hi.hour, hi.minute) == (14, 0)


def test_ist_range_is_empty_when_nothing_is_picked():
    assert ist_range(None, None) == {}
    assert set(ist_range("2026-08-01", None)) == {"$gte"}
    assert set(ist_range(None, "2026-08-07")) == {"$lte"}


# --- Every router reads a bound the same way -----------------------------------

def test_all_routers_share_one_reader():
    """The point of the fix: one function, not six copies of a rule.

    An identity check rather than a behavioural one, deliberately — a router
    that reintroduces its own `_parse_dt` fails here even if that copy happens
    to be correct on the day it is written. Copies are the bug.
    """
    for module in (banks_router, finance_router, policies_router,
                   audit_router):
        assert module._parse_dt is parse_ist_bound, (
            f"{module.__name__} has its own date reader again — use "
            f"services.finance_reports.parse_ist_bound")
    assert reports_router._parse_ist is parse_ist_bound
    for module in (banks_router, finance_router):
        assert module._end_of_day is parse_ist_end_of_day


def test_the_same_picked_range_means_the_same_thing_everywhere():
    """The user-visible promise: pick 1–7 Aug and every screen agrees."""
    lo = parse_ist_bound("2026-08-01")
    hi = parse_ist_end_of_day("2026-08-07")

    # The ledger filter (finance / banks) and the report window resolve to the
    # identical pair of instants.
    assert finance_router._date_range("2026-08-01", "2026-08-07") == {
        "$gte": lo, "$lte": hi}
    assert banks_router._parse_dt("2026-08-01") == lo
    assert banks_router._end_of_day("2026-08-07") == hi

    # And so does the Policies list, which routes through resolve_period.
    created = policies_router._created_range(
        "custom", "2026-08-01", "2026-08-07")
    assert created == {"$gte": lo, "$lte": hi}


def test_a_late_night_entry_lands_in_the_indian_day_it_belongs_to():
    """02:00 IST on 1 August is business done on 1 August.

    Stored UTC that is 2026-07-31T20:30Z. The old UTC bound ($gte 1 Aug 00:00Z)
    excluded it from a range starting 1 August and filed it under July.
    """
    entry = datetime(2026, 8, 1, 2, 0, tzinfo=IST).astimezone(UTC)
    rng = ist_range("2026-08-01", "2026-08-31")
    assert rng["$gte"] <= entry <= rng["$lte"]

    # The mirror case: 02:00 IST on 1 September must NOT be in August.
    september = datetime(2026, 9, 1, 2, 0, tzinfo=IST).astimezone(UTC)
    assert september > rng["$lte"]


def test_custom_range_agrees_with_the_preset_covering_the_same_month():
    """Switching "This month" -> the same dates as a custom range must not
    move the boundary. Presets were always IST; custom was UTC, so it did."""
    now = datetime(2026, 8, 20, 12, 0, tzinfo=IST)
    preset_lo, _preset_hi, _ = resolve_period("current_month", now)
    custom_lo, _custom_hi, _ = resolve_period(
        "custom", now, parse_ist_bound("2026-08-01"),
        parse_ist_end_of_day("2026-08-31"))
    assert preset_lo == custom_lo


def test_audit_range_includes_the_last_day():
    """The audit filter never promoted date_to to end-of-day, so a range
    ending "31 Jul" returned nothing that happened ON the 31st."""
    rng = ist_range("2026-07-01", "2026-07-31")
    late_on_the_31st = datetime(2026, 7, 31, 22, 0, tzinfo=IST)
    assert late_on_the_31st <= rng["$lte"]
