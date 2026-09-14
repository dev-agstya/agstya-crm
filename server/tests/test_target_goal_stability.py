"""A monthly goal reads the same all month long.

The owner's report (2026-07-26): the Finance Overview said Rajan's July
house-profit target was Rs 20,752.90 while the Targets page said Rs 25,000 for
the same month and the same person — and the smaller number crept up every time
the page was opened. They suspected a deleted transaction.

It was neither. The overview sliced the monthly goal by how much of the month
had elapsed (25.73 of July's 31 days -> 83% of 25,000), so the "target" moved by
the minute. These tests pin the fix: a reporting window takes goals in FULL;
only graph buckets pro-rate.
"""

from datetime import datetime, timezone

from app.core.enums import TargetMetric, TargetPeriod
from app.services import targets as svc

JULY_GOAL = 2_500_000        # Rs 25,000 in paise


def _dt(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=timezone.utc)


class _FakeTarget:
    def __init__(self, metrics, start, end, assignee_id="e1",
                 assignee_type="employee"):
        self.metrics = metrics
        self.period_start = start
        self.period_end = end
        self.assignee_id = assignee_id
        self.assignee_type = assignee_type


def _july_target(metrics=None):
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    return _FakeTarget(metrics or {TargetMetric.HOUSE_PROFIT.value: JULY_GOAL},
                       lo, hi)


# --- The reported bug ---------------------------------------------------------------


def test_the_old_behaviour_really_did_shrink_the_goal():
    """Reproduces the reported figure, so the regression is unmistakable:
    pro-rating July's 25,000 to the 26th at 17:36 IST gives ~20,752."""
    target = _july_target()
    lo, _ = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    as_of = _dt(2026, 7, 26, 12, 6)          # 17:36 IST
    sliced = svc.prorated_goals([target], lo, as_of)[
        TargetMetric.HOUSE_PROFIT.value]
    assert 2_070_000 < sliced < 2_080_000     # ~Rs 20,7xx — the wrong number


def test_a_part_way_window_still_reports_the_whole_month_goal():
    """The fix: on the 26th, July's goal is still Rs 25,000."""
    target = _july_target()
    lo, _ = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    as_of = _dt(2026, 7, 26, 12, 6)
    goals = svc.full_goals([target], lo, as_of)
    assert goals[TargetMetric.HOUSE_PROFIT.value] == JULY_GOAL


def test_the_goal_does_not_drift_as_the_month_passes():
    """The heart of the complaint — "why does it keep changing". Read the same
    target at four points in the month and get one answer."""
    target = _july_target()
    lo, _ = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    readings = {
        svc.full_goals([target], lo, _dt(2026, 7, day, hour))[
            TargetMetric.HOUSE_PROFIT.value]
        for day, hour in ((2, 0), (14, 6), (26, 12), (31, 23))
    }
    assert readings == {JULY_GOAL}


def test_overview_and_targets_page_now_agree():
    """Same target, the two windows the two screens use, one number."""
    target = _july_target()
    month_lo, month_hi = svc.normalise_period(TargetPeriod.MONTH,
                                              _dt(2026, 7, 1))
    targets_page = svc.full_goals([target], month_lo, month_hi)
    overview = svc.full_goals([target], month_lo, _dt(2026, 7, 26, 12, 6))
    assert targets_page == overview == {
        TargetMetric.HOUSE_PROFIT.value: JULY_GOAL}


def test_deleting_a_transaction_cannot_move_a_goal():
    """The owner's actual question. A goal is a stored number; nothing in the
    ledger is an input to it, so no cash movement can change it."""
    target = _july_target()
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    before = svc.full_goals([target], lo, hi)
    # Whatever happens to the money, the goal is the goal.
    after = svc.full_goals([target], lo, hi)
    assert before == after == {TargetMetric.HOUSE_PROFIT.value: JULY_GOAL}


# --- Multiple months / metrics -------------------------------------------------------


def test_a_three_month_window_adds_three_whole_monthly_goals():
    targets = []
    for month in (5, 6, 7):
        lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, month, 1))
        targets.append(_FakeTarget(
            {TargetMetric.HOUSE_PROFIT.value: JULY_GOAL}, lo, hi))
    lo, hi, _label = svc.progress_window("last3", _dt(2026, 7, 20))
    goals = svc.full_goals(targets, lo, hi)
    assert goals[TargetMetric.HOUSE_PROFIT.value] == JULY_GOAL * 3


def test_every_metric_is_carried_in_full():
    target = _july_target({TargetMetric.HOUSE_PROFIT.value: JULY_GOAL,
                           TargetMetric.POLICIES.value: 10,
                           TargetMetric.RENEWALS.value: 3})
    lo, _ = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    goals = svc.full_goals([target], lo, _dt(2026, 7, 3))
    assert goals == {TargetMetric.HOUSE_PROFIT.value: JULY_GOAL,
                     TargetMetric.POLICIES.value: 10,
                     TargetMetric.RENEWALS.value: 3}


def test_a_target_outside_the_window_contributes_nothing():
    target = _july_target()
    sep_lo, sep_hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 9, 1))
    assert svc.full_goals([target], sep_lo, sep_hi) == {}


def test_no_targets_means_no_goals():
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    assert svc.full_goals([], lo, hi) == {}


# --- Graph buckets keep pro-rating ----------------------------------------------------


def test_a_week_bucket_still_gets_a_weeks_share():
    """Pro-rating is right for a series bucket: a single week must not be
    judged against a whole month's number."""
    target = _july_target()
    week = svc.prorated_goals([target], _dt(2026, 7, 8), _dt(2026, 7, 15))
    share = week[TargetMetric.HOUSE_PROFIT.value]
    assert 0 < share < JULY_GOAL
    assert abs(share - JULY_GOAL * 7 / 31) < 20_000


def test_full_month_bucket_and_prorate_agree():
    """Over a whole month the two helpers must give the same answer — that is
    why the monthly trend chart needed no change."""
    target = _july_target()
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    assert svc.prorated_goals([target], lo, hi) == svc.full_goals(
        [target], lo, hi)
