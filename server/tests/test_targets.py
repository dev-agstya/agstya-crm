"""Unit tests for the rebuilt target engine (no DB needed).

These cover the four defects the owner's screenshots exposed, so a regression
would fail here rather than silently drawing an empty chart again:

  A. a target of ANY metric must be visible to the roll-up (not house_profit only)
  B. actual and target must be expressed in the same unit
  C. a quarterly/yearly target must spread across its whole window
  D. a "July" target must cover all of July, not from-the-day-you-typed-it

...plus the new Top Employee scoring, which now blends profit contribution and
target achievement.
"""

from datetime import datetime, timezone

import pytest

from app.core.enums import TargetMetric, TargetPeriod
from app.services import targets as svc


def _dt(y, m, d, h=0):
    return datetime(y, m, d, h, tzinfo=timezone.utc)


class _FakeTarget:
    """Just enough of a Target document for the pure roll-up helpers."""

    def __init__(self, metrics, start, end, assignee_id="e1",
                 assignee_type="employee"):
        self.metrics = metrics
        self.period_start = start
        self.period_end = end
        self.assignee_id = assignee_id
        self.assignee_type = assignee_type


# --- D: period normalisation -----------------------------------------------------


def test_month_target_covers_the_whole_calendar_month():
    """Screenshot 23 showed a July target starting 26 Jul. Any day in the month
    must now snap to the 1st, so the goal covers 1-31 July."""
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 26))
    ist_lo = svc.to_ist(lo)
    ist_hi = svc.to_ist(hi)
    assert (ist_lo.year, ist_lo.month, ist_lo.day) == (2026, 7, 1)
    assert (ist_hi.year, ist_hi.month, ist_hi.day) == (2026, 8, 1)
    assert ist_lo.hour == 0 and ist_lo.minute == 0


def test_month_boundaries_are_ist_not_utc():
    """1 Jul 00:00 IST is 30 Jun 18:30 UTC — bucketing must follow the Indian
    calendar, matching every other finance boundary in the app."""
    lo, _ = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 15))
    assert lo.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M") \
        == "2026-06-30 18:30"


def test_quarter_snaps_to_quarter_start():
    lo, hi = svc.normalise_period(TargetPeriod.QUARTER, _dt(2026, 8, 20))
    assert svc.to_ist(lo).month == 7          # Jul-Sep quarter
    assert svc.to_ist(hi).month == 10


def test_year_snaps_to_indian_financial_year():
    lo, hi = svc.normalise_period(TargetPeriod.YEAR, _dt(2026, 2, 10))
    assert (svc.to_ist(lo).year, svc.to_ist(lo).month) == (2025, 4)
    assert (svc.to_ist(hi).year, svc.to_ist(hi).month) == (2026, 4)


def test_period_label_reads_naturally():
    lo, _ = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 26))
    assert svc.period_label(TargetPeriod.MONTH, lo) == "Jul 2026"


# --- C: pro-rating over the real window ------------------------------------------


def test_quarterly_target_spreads_across_its_months():
    """The old code charged a quarter's whole value to its first month and read
    zero for the other two."""
    q_lo, q_hi = svc.normalise_period(TargetPeriod.QUARTER, _dt(2026, 7, 5))
    target = _FakeTarget({TargetMetric.HOUSE_PROFIT.value: 900_000}, q_lo, q_hi)

    monthly = []
    for month in (7, 8, 9):
        m_lo, m_hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, month, 2))
        monthly.append(svc.prorated_goals([target], m_lo, m_hi)
                       .get(TargetMetric.HOUSE_PROFIT.value, 0))

    assert all(v > 0 for v in monthly), "every month of the quarter gets a share"
    assert sum(monthly) == pytest.approx(900_000, abs=5)


def test_monthly_target_reads_in_full_for_its_own_month():
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    target = _FakeTarget({TargetMetric.POLICIES.value: 10}, lo, hi)
    goals = svc.prorated_goals([target], lo, hi)
    assert goals[TargetMetric.POLICIES.value] == 10


def test_target_outside_the_window_contributes_nothing():
    jul_lo, jul_hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    sep_lo, sep_hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 9, 1))
    target = _FakeTarget({TargetMetric.POLICIES.value: 10}, jul_lo, jul_hi)
    assert svc.prorated_goals([target], sep_lo, sep_hi) == {}


def test_week_bucket_gets_a_fair_slice_of_the_month():
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 1))
    target = _FakeTarget({TargetMetric.HOUSE_PROFIT.value: 310_000}, lo, hi)
    week = svc.prorated_goals([target], _dt(2026, 7, 8), _dt(2026, 7, 15))
    # Seven of July's 31 days -> roughly 7/31 of the goal.
    assert 60_000 < week[TargetMetric.HOUSE_PROFIT.value] < 80_000


# --- A + B: every metric is visible, in its own unit -----------------------------


def test_multi_metric_target_reports_every_goal_that_was_set():
    """The owner asked for one target carrying several numbers at once."""
    rows = svc.metric_rows(
        {TargetMetric.POLICIES.value: 15,
         TargetMetric.HOUSE_PROFIT.value: 250_000},
        {TargetMetric.POLICIES.value: 3,
         TargetMetric.HOUSE_PROFIT.value: 125_000,
         TargetMetric.PREMIUM.value: 999_999,
         TargetMetric.RENEWALS.value: 1},
    )
    assert [r["metric"] for r in rows] == ["policies", "house_profit"]
    assert rows[0]["attainment_pct"] == 20.0     # 3 of 15
    assert rows[1]["attainment_pct"] == 50.0     # half the profit goal
    # Money metrics are flagged so the UI formats paise as rupees.
    assert rows[0]["is_money"] is False
    assert rows[1]["is_money"] is True


def test_a_policies_target_is_not_invisible():
    """Screenshot 22 read 'Target: Rs 0.00' because only house_profit targets
    were queried. A policies-only target must produce a real goal."""
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 26))
    target = _FakeTarget({TargetMetric.POLICIES.value: 10}, lo, hi)
    goals = svc.prorated_goals([target], lo, hi)
    assert goals.get(TargetMetric.POLICIES.value) == 10
    assert TargetMetric.HOUSE_PROFIT.value not in goals


def test_metric_absent_from_target_is_not_a_zero_goal():
    """No goal for a metric is different from a goal of zero, and must not show
    up as a permanent 0% row."""
    rows = svc.metric_rows({TargetMetric.POLICIES.value: 5},
                           svc.blank_metrics())
    assert len(rows) == 1


def test_attainment_of_a_zero_goal_is_zero_not_a_crash():
    assert svc.attainment_pct(500, 0) == 0.0
    assert svc.attainment_pct(0, 0) == 0.0


def test_attainment_can_exceed_one_hundred():
    assert svc.attainment_pct(150, 100) == 150.0


# --- Headline attainment ---------------------------------------------------------


def test_overall_attainment_prefers_the_primary_metric():
    rows = svc.metric_rows(
        {TargetMetric.POLICIES.value: 10,
         TargetMetric.HOUSE_PROFIT.value: 100_000},
        {TargetMetric.POLICIES.value: 10, TargetMetric.HOUSE_PROFIT.value: 40_000},
    )
    # Policies are at 100%, profit at 40% — house profit is what the owner
    # judges on, so the headline is 40%.
    assert svc.overall_attainment(rows) == 40.0


def test_overall_attainment_averages_when_profit_is_not_a_goal():
    rows = svc.metric_rows(
        {TargetMetric.POLICIES.value: 10, TargetMetric.RENEWALS.value: 4},
        {TargetMetric.POLICIES.value: 5, TargetMetric.RENEWALS.value: 4},
    )
    assert svc.overall_attainment(rows) == 75.0     # (50 + 100) / 2


def test_overall_attainment_with_no_goals_is_zero():
    assert svc.overall_attainment([]) == 0.0


# --- Top Employee scoring --------------------------------------------------------


def test_score_blends_profit_and_attainment():
    # Top profit, no target: 0.6 of the profit half, nothing from the target half.
    assert svc.score_row(100_000, 100_000, 0.0, False) == pytest.approx(0.6)
    # Top profit AND capped attainment: the full 1.0.
    assert svc.score_row(100_000, 100_000, 150.0, True) == pytest.approx(1.0)


def test_attainment_is_capped_so_a_token_target_cannot_win():
    tiny = svc.score_row(1_000, 100_000, 900.0, True)     # 1% of the profit, 900%
    big = svc.score_row(100_000, 100_000, 100.0, True)    # all the profit, on plan
    assert big > tiny


def test_hitting_target_beats_missing_it_at_equal_profit():
    hit = svc.score_row(50_000, 100_000, 120.0, True)
    miss = svc.score_row(50_000, 100_000, 40.0, True)
    assert hit > miss


def test_employee_with_no_target_still_ranks_on_profit():
    rows = [
        {"key": "a", "profit": 100_000, "attainment_pct": 0.0,
         "has_target": False},
        {"key": "b", "profit": 10_000, "attainment_pct": 100.0,
         "has_target": True},
    ]
    svc.rank_performers(rows)
    by_key = {r["key"]: r for r in rows}
    assert by_key["a"]["score"] > 0
    assert by_key["a"]["rank"] == 1      # 0.6 vs 0.06 + 0.267


def test_rank_performers_is_ordered_and_numbered():
    rows = [
        {"key": "low", "profit": 10, "attainment_pct": 10.0, "has_target": True},
        {"key": "high", "profit": 100, "attainment_pct": 100.0,
         "has_target": True},
    ]
    ranked = svc.rank_performers(rows)
    assert [r["key"] for r in ranked] == ["high", "low"]
    assert [r["rank"] for r in ranked] == [1, 2]


def test_ranking_an_empty_team_does_not_divide_by_zero():
    assert svc.rank_performers([]) == []


# --- Overlap -----------------------------------------------------------------------


def test_overlapping_selects_only_intersecting_targets():
    jul = _FakeTarget({}, *svc.normalise_period(TargetPeriod.MONTH,
                                                _dt(2026, 7, 1)))
    aug = _FakeTarget({}, *svc.normalise_period(TargetPeriod.MONTH,
                                                _dt(2026, 8, 1)))
    lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, 7, 15))
    assert svc.overlapping([jul, aug], lo, hi) == [jul]
