"""Policies have to EXPIRE, and until 2026-08-19 nothing ever expired one.

THE BUG. `PolicyStatus.EXPIRED` was read in four places and WRITTEN in none.
There was no sweep, no scheduled job and no read-time rule, so a policy booked
in January for twelve months was still `ACTIVE` the following December — and in
every December after that. The status drives the badge on the policy page, the
customer's record, the partner portal, "active policies" on the Reports KPI
tile, and `_LIVE_STATUSES` in routers/managers (what counts as renewable). Every
one of them was reporting dead cover as live business, and the error only grows.

These pin the two rules and, just as importantly, the four states the sweep must
NEVER touch: a policy a HUMAN put somewhere means something happened, and a
clock has no business overruling a person.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.core.enums import PolicyStatus
from app.services import policy_lifecycle as lifecycle
from app.services.finance_reports import IST


class _FakeCollection:
    """Records the queries `sweep` issues instead of running them.

    The value of the sweep is entirely in WHICH ROWS it selects, so that is what
    is asserted. A mongomock round trip would test pymongo, not this rule.
    """

    def __init__(self):
        self.calls: list[tuple[dict, dict]] = []

    async def update_many(self, query, update):
        self.calls.append((query, update))

        class _Result:
            modified_count = 0
        return _Result()


@pytest.fixture()
def swept(monkeypatch):
    fake = _FakeCollection()
    monkeypatch.setattr(lifecycle.Policy, "get_motor_collection",
                        classmethod(lambda cls: fake))
    return fake


# --- The two transitions ---------------------------------------------------------


@pytest.mark.asyncio
async def test_cover_that_has_ended_becomes_expired(swept):
    await lifecycle.sweep(datetime(2026, 8, 19, tzinfo=timezone.utc))
    query, update = swept.calls[0]
    assert update["$set"]["status"] == PolicyStatus.EXPIRED.value
    # From BOTH live states: a policy left on renewal_due and never renewed has
    # still expired.
    assert set(query["status"]["$in"]) == {
        PolicyStatus.ACTIVE.value, PolicyStatus.RENEWAL_DUE.value}
    assert "$lt" in query["expiry_date"]


@pytest.mark.asyncio
async def test_cover_ending_soon_becomes_renewal_due(swept):
    await lifecycle.sweep(datetime(2026, 8, 19, tzinfo=timezone.utc))
    query, update = swept.calls[1]
    assert update["$set"]["status"] == PolicyStatus.RENEWAL_DUE.value
    # ONLY from active. Walking a policy backwards out of EXPIRED would undo
    # the first update on the same run.
    assert query["status"] == PolicyStatus.ACTIVE.value
    assert "$gte" in query["expiry_date"] and "$lte" in query["expiry_date"]


@pytest.mark.asyncio
async def test_expiring_runs_BEFORE_renewal_due(swept):
    """Order matters: a policy ignored long enough can go ACTIVE ->
    RENEWAL_DUE -> EXPIRED, and doing it the other way round would leave it
    marked renewal-due on cover that ended months ago."""
    await lifecycle.sweep(datetime(2026, 8, 19, tzinfo=timezone.utc))
    statuses = [c[1]["$set"]["status"] for c in swept.calls]
    assert statuses == [PolicyStatus.EXPIRED.value,
                        PolicyStatus.RENEWAL_DUE.value]


@pytest.mark.asyncio
async def test_a_policy_with_no_expiry_date_is_never_touched(swept):
    """A missing expiry is unknown, not expired. Sweeping it would mark cover
    dead on the strength of a blank field."""
    await lifecycle.sweep(datetime(2026, 8, 19, tzinfo=timezone.utc))
    for query, _ in swept.calls:
        assert query["expiry_date"]["$ne"] is None


# --- What it must NOT touch -------------------------------------------------------


@pytest.mark.asyncio
async def test_states_a_human_chose_are_left_alone(swept):
    """RENEWED, CANCELLED, LAPSED and DRAFT all mean somebody decided something.

    RENEWED is the one worth spelling out: a renewed policy's cover really has
    ended, but relabelling it EXPIRED would lose the fact that the customer
    STAYED — which is exactly what the renewal-rate figure counts.
    """
    await lifecycle.sweep(datetime(2026, 8, 19, tzinfo=timezone.utc))
    protected = {PolicyStatus.RENEWED.value, PolicyStatus.CANCELLED.value,
                 PolicyStatus.LAPSED.value, PolicyStatus.DRAFT.value}
    for query, _ in swept.calls:
        selected = query["status"]
        chosen = set(selected["$in"]) if isinstance(selected, dict) \
            else {selected}
        assert not (chosen & protected)


# --- The boundary -----------------------------------------------------------------


def test_the_day_ends_at_2359_IST_not_at_midnight_utc():
    """Cover bought "until 31 March" is good for the whole of the 31st.
    Comparing raw instants expires it at 05:30 IST on the 31st, taking half a
    working day of live cover off every policy in the book."""
    end = lifecycle._end_of_ist_day(datetime(2026, 3, 31, 6, 0,
                                             tzinfo=timezone.utc))
    local = end.astimezone(IST)
    assert (local.hour, local.minute) == (23, 59)
    assert local.date().isoformat() == "2026-03-31"


def test_the_renewal_window_is_thirty_days():
    """Not the Renewals PAGE's 90. That is how far a work queue looks ahead; a
    policy with three months left on it is simply active."""
    assert lifecycle.RENEWAL_DUE_WITHIN_DAYS == 30


@pytest.mark.asyncio
async def test_the_horizon_is_the_window_ahead_of_today(swept):
    now = datetime(2026, 8, 19, tzinfo=timezone.utc)
    await lifecycle.sweep(now)
    due_query = swept.calls[1][0]
    lo = due_query["expiry_date"]["$gte"]
    hi = due_query["expiry_date"]["$lte"]
    assert timedelta(days=29) <= (hi - lo) <= timedelta(days=31)


# --- It runs, and it runs more than once ------------------------------------------


@pytest.mark.asyncio
async def test_running_it_twice_changes_nothing_the_second_time(swept):
    """Idempotent by construction: it asks for rows in the WRONG state and puts
    them in the right one, so a second pass selects nothing. That is what lets
    it sit on both the daily cron and the boot path without coordination."""
    await lifecycle.sweep(datetime(2026, 8, 19, tzinfo=timezone.utc))
    first = list(swept.calls)
    swept.calls.clear()
    await lifecycle.sweep(datetime(2026, 8, 19, tzinfo=timezone.utc))
    assert [q for q, _ in swept.calls] == [q for q, _ in first]


def test_the_daily_job_and_the_boot_path_both_call_it():
    """A sweep nothing invokes is the bug it was written to fix, one layer up."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    cron = (root / "send_reminders.py").read_text(encoding="utf-8")
    boot = (root / "app" / "main.py").read_text(encoding="utf-8")
    assert "policy_lifecycle.sweep()" in cron
    assert "policy_lifecycle.sweep()" in boot
    # Never fatal in either place: a CRM that will not start, or a day with no
    # renewal emails, is worse than a status that lags by one run.
    assert "[lifecycle] FAILED" in cron
