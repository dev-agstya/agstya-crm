"""Leave: what a request costs, and how the balance behaves.

The two rules with money-shaped consequences, even though no money is involved:

  * A LEAVE COSTS WORKING DAYS ONLY. Friday-to-Monday over a Sunday is three
    days, not four (owner E9). The register and the leave form share ONE
    definition of "is the office open" so they can never disagree about which
    Tuesday was deductible.
  * THE BALANCE CARRIES FORWARD inside the leave year and lapses at the end of
    it (owner E2/E3). 1.5 a month that resets every month is not a balance, and
    the owner asked for a balance counter.

The accrual's idempotency is asserted here as a PROPERTY of the code (it inserts
a row with a period key and treats a duplicate as a no-op) rather than through a
live unique index, which would be testing Mongo. `db.py` names the index in
CRITICAL_INDEXES so a boot without it is shouted about.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.core.enums import LeaveDayPart, LeaveLedgerEntry
from app.models.settings import HrSettings
from app.services import hr_calendar as cal
from app.services import hr_leave as svc


def hr(**kw) -> HrSettings:
    return HrSettings(**kw)


# =============================================================================
# What a request costs
# =============================================================================


@pytest.mark.asyncio
async def test_a_leave_over_a_sunday_costs_three_days_not_four(monkeypatch):
    """OWNER E9, and the most visible rule in the module. Friday 14 Aug to
    Monday 17 Aug 2026 spans a Sunday; nobody spends a leave day on a day the
    office was shut."""
    async def _no_holidays(a, b):
        return {}
    monkeypatch.setattr(cal, "holiday_map", _no_holidays)

    cost, keys = await svc.count_days("2026-08-14", "2026-08-17",
                                      LeaveDayPart.FULL.value, hr())
    assert cost == 3.0
    assert "2026-08-16" not in keys           # the Sunday
    assert keys == ["2026-08-14", "2026-08-15", "2026-08-17"]


@pytest.mark.asyncio
async def test_a_declared_holiday_inside_a_range_costs_nothing(monkeypatch):
    async def _holidays(a, b):
        return {"2026-08-15": "Independence Day"}
    monkeypatch.setattr(cal, "holiday_map", _holidays)

    cost, keys = await svc.count_days("2026-08-14", "2026-08-17",
                                      LeaveDayPart.FULL.value, hr())
    assert cost == 2.0                         # Friday and Monday only
    assert "2026-08-15" not in keys


@pytest.mark.asyncio
async def test_saturday_costs_a_leave_day(monkeypatch):
    """The agency works Monday to SATURDAY. A default Mon-Fri calendar would
    silently refund a day of leave every single week."""
    async def _no_holidays(a, b):
        return {}
    monkeypatch.setattr(cal, "holiday_map", _no_holidays)
    cost, _ = await svc.count_days("2026-08-22", "2026-08-22",
                                   LeaveDayPart.FULL.value, hr())
    assert date(2026, 8, 22).weekday() == 5
    assert cost == 1.0


@pytest.mark.asyncio
async def test_a_half_day_costs_half(monkeypatch):
    async def _no_holidays(a, b):
        return {}
    monkeypatch.setattr(cal, "holiday_map", _no_holidays)
    cost, _ = await svc.count_days("2026-08-13", "2026-08-13",
                                   LeaveDayPart.FIRST_HALF.value, hr())
    assert cost == 0.5


@pytest.mark.asyncio
async def test_a_range_entirely_inside_a_weekend_costs_nothing(monkeypatch):
    """The router turns this into a refusal with a sentence rather than booking
    a zero-day leave — a request that costs nothing is a request somebody has
    made a mistake on."""
    async def _no_holidays(a, b):
        return {}
    monkeypatch.setattr(cal, "holiday_map", _no_holidays)
    cost, keys = await svc.count_days("2026-08-16", "2026-08-16",
                                      LeaveDayPart.FULL.value, hr())
    assert cost == 0.0 and keys == []


# =============================================================================
# Paid vs unpaid at approval
# =============================================================================


def test_the_balance_covers_what_it_can_and_the_rest_is_unpaid():
    """Owner E17: going short is ALLOWED and never blocked. People genuinely
    need unpaid leave, and refusing it only means the day is recorded as an
    absence instead — which is worse for everybody."""
    paid, unpaid = svc.split_paid_unpaid(3.0, 0.5)
    assert (paid, unpaid) == (0.5, 2.5)


def test_a_leave_fully_covered_is_fully_paid():
    assert svc.split_paid_unpaid(2.0, 6.0) == (2.0, 0.0)


def test_a_negative_balance_covers_nothing_rather_than_going_further_negative():
    """An adjustment can push somebody below zero. The unpaid part must never
    exceed the leave itself — 2 days of leave cannot be 3 days unpaid."""
    paid, unpaid = svc.split_paid_unpaid(2.0, -1.5)
    assert paid == 0.0
    assert unpaid == 2.0


def test_an_exactly_covered_leave_leaves_nothing_unpaid():
    assert svc.split_paid_unpaid(1.5, 1.5) == (1.5, 0.0)


# =============================================================================
# Rounding — leave is counted in halves and nothing finer
# =============================================================================


def test_leave_snaps_to_halves():
    assert svc._round_half(1.24) == 1.0
    assert svc._round_half(1.26) == 1.5
    assert svc._round_half(1.75) == 2.0
    # A negative zero would render as "-0" on a statement row.
    assert str(svc._round_half(-0.1)) == "0.0"


# =============================================================================
# The leave year
# =============================================================================


def test_the_leave_year_starts_in_april_and_spans_the_new_year():
    """Owner E2/E3 — the Indian financial year. August 2026 and February 2027
    are the SAME leave year, which is the whole point of carrying forward."""
    assert cal.leave_year_of("2026-08-14") == 2026
    assert cal.leave_year_of("2027-02-14") == 2026
    assert cal.leave_year_of("2027-03-31") == 2026
    assert cal.leave_year_of("2027-04-01") == 2027


def test_the_leave_year_bounds_are_the_indian_fy():
    first, last = cal.leave_year_bounds(2026)
    assert first == date(2026, 4, 1)
    assert last == date(2027, 3, 31)


def test_the_leave_year_start_month_is_configurable():
    """Nothing in the agency uses a January leave year, but the setting exists
    and a hard-coded 4 in the arithmetic would make it a lie."""
    assert cal.leave_year_of("2026-02-14", start_month=1) == 2026
    first, last = cal.leave_year_bounds(2026, start_month=1)
    assert (first, last) == (date(2026, 1, 1), date(2026, 12, 31))


# =============================================================================
# Accrual and lapse — idempotency, pro-rata and the cap
# =============================================================================


class _FakePost:
    """Records what `post` was asked to write, and refuses a repeated period key
    the way the unique index does."""

    def __init__(self):
        self.rows: list[dict] = []
        self.seen: set = set()

    async def __call__(self, user_id, entry_type, days, *, leave_year,
                       period_key="", note="", ref_id=None, actor=None):
        if period_key:
            key = (user_id, entry_type, period_key)
            if key in self.seen:
                return None                    # DuplicateKeyError, swallowed
            self.seen.add(key)
        row = dict(user_id=user_id, entry_type=entry_type, days=days,
                   leave_year=leave_year, period_key=period_key, note=note)
        self.rows.append(row)
        return row


class _Profile:
    def __init__(self, doj=None, accrual=None):
        self.date_of_joining = doj
        self.monthly_leave_accrual = accrual
        self.shift_start = self.shift_end = None


class _User:
    def __init__(self, uid="u1", doj=None, accrual=None):
        self.id = uid
        self.full_name = "Test Employee"
        self.employee_profile = _Profile(doj, accrual)


@pytest.fixture()
def accrual_env(monkeypatch):
    posted = _FakePost()
    monkeypatch.setattr(svc, "post", posted)

    balances: dict = {}

    async def _balance(user_id, hr_settings, *, leave_year=None, now=None):
        return {"available": balances.get(user_id, 0.0)}
    monkeypatch.setattr(svc, "balance_for", _balance)

    import app.services.hr_attendance as att
    users: list = []

    async def _employees(*, include_inactive=False):
        return users
    monkeypatch.setattr(att, "hr_employees", _employees)
    return posted, balances, users


@pytest.mark.asyncio
async def test_everybody_gets_the_monthly_accrual(accrual_env):
    posted, _, users = accrual_env
    users.extend([_User("u1"), _User("u2")])
    out = await svc.accrue_month(hr(), month="2026-08")
    assert out["credited"] == 2
    assert [r["days"] for r in posted.rows] == [1.5, 1.5]
    assert all(r["period_key"] == "2026-08" for r in posted.rows)


@pytest.mark.asyncio
async def test_running_the_accrual_twice_credits_once(accrual_env):
    """THE ONE THAT MATTERS. The daily job runs from a cron AND at boot, so the
    same month is genuinely attempted more than once — on a deploy morning,
    twice within the hour. Without the period key everybody quietly earns 3
    days a month."""
    posted, _, users = accrual_env
    users.append(_User("u1"))
    first = await svc.accrue_month(hr(), month="2026-08")
    second = await svc.accrue_month(hr(), month="2026-08")
    assert first["credited"] == 1
    assert second["credited"] == 0
    assert len(posted.rows) == 1


@pytest.mark.asyncio
async def test_a_new_joiner_accrues_pro_rata(accrual_env):
    """Owner E5. Joined on the 17th of a 31-day month: 15 of 31 days employed,
    1.5 x 15/31 = 0.73, which snaps to 0.5."""
    posted, _, users = accrual_env
    users.append(_User("u1", doj=date(2026, 8, 17)))
    await svc.accrue_month(hr(), month="2026-08")
    assert posted.rows[0]["days"] == 0.5


@pytest.mark.asyncio
async def test_somebody_who_had_not_joined_accrues_nothing(accrual_env):
    posted, _, users = accrual_env
    users.append(_User("u1", doj=date(2026, 9, 1)))
    out = await svc.accrue_month(hr(), month="2026-08")
    assert out["credited"] == 0 and posted.rows == []


@pytest.mark.asyncio
async def test_a_personal_accrual_rate_beats_the_agency_default(accrual_env):
    """Owner E1 — the senior person on a different arrangement."""
    posted, _, users = accrual_env
    users.append(_User("u1", accrual=2.0))
    await svc.accrue_month(hr(), month="2026-08")
    assert posted.rows[0]["days"] == 2.0


@pytest.mark.asyncio
async def test_the_cap_trims_the_credit_rather_than_refusing_it(accrual_env):
    """Landing exactly on the cap beats refusing the whole credit: a month of
    service that silently earned nothing is a month somebody will argue about."""
    posted, balances, users = accrual_env
    users.append(_User("u1"))
    balances["u1"] = 17.0                      # cap is 18
    await svc.accrue_month(hr(), month="2026-08")
    assert posted.rows[0]["days"] == 1.0       # trimmed from 1.5


@pytest.mark.asyncio
async def test_nothing_is_credited_once_the_cap_is_reached(accrual_env):
    posted, balances, users = accrual_env
    users.append(_User("u1"))
    balances["u1"] = 18.0
    out = await svc.accrue_month(hr(), month="2026-08")
    assert out["credited"] == 0 and posted.rows == []


@pytest.mark.asyncio
async def test_a_leave_year_that_has_not_ended_never_lapses(accrual_env):
    """The guard that stops a live balance being wiped. Running the lapse for
    the CURRENT year would clear everything everybody is holding."""
    posted, balances, users = accrual_env
    users.append(_User("u1"))
    balances["u1"] = 6.0
    from datetime import datetime, timezone
    out = await svc.lapse_year(hr(), leave_year=2026,
                               now=datetime(2026, 8, 20, tzinfo=timezone.utc))
    assert out["lapsed"] == 0
    assert posted.rows == []
    assert "not ended" in out["skipped_reason"]


@pytest.mark.asyncio
async def test_an_ended_leave_year_lapses_exactly_the_remaining_balance(
        accrual_env):
    posted, balances, users = accrual_env
    users.append(_User("u1"))
    balances["u1"] = 4.5
    from datetime import datetime, timezone
    out = await svc.lapse_year(hr(), leave_year=2026,
                               now=datetime(2027, 4, 2, tzinfo=timezone.utc))
    assert out["lapsed"] == 1
    assert posted.rows[0]["days"] == -4.5
    assert posted.rows[0]["entry_type"] == LeaveLedgerEntry.LAPSE.value
    # Idempotent by the same period key as the accrual.
    assert posted.rows[0]["period_key"] == "2026-04"


@pytest.mark.asyncio
async def test_a_zero_balance_writes_no_lapse_row(accrual_env):
    """A ledger full of zero rows is a ledger people stop reading — the same
    reasoning that stops a zero-difference bank reconciliation writing one."""
    posted, balances, users = accrual_env
    users.append(_User("u1"))
    balances["u1"] = 0.0
    from datetime import datetime, timezone
    out = await svc.lapse_year(hr(), leave_year=2026,
                               now=datetime(2027, 4, 2, tzinfo=timezone.utc))
    assert out["lapsed"] == 0 and posted.rows == []
