"""House-profit visibility, milestone alerts and the dashboard windows.

The owner's rule (2026-07-26), in their words: an employee who learns they
cleared Rs 20,000 against a Rs 10,000 goal "will ask for a salary appraisal or
will leave instantly" — so the house-profit metric belongs to the owner and to
whoever assigns the targets, and to nobody else. These tests are the guard rail
on that: if a future change lets a plain employee see the agency's margin, one
of them fails.
"""

from datetime import datetime, timezone

import pytest

from app.core.enums import AccountType, TargetMetric, TargetPeriod
from app.core.permissions import (
    MANAGE_TARGETS, VIEW_AGENCY_PROFIT, VIEW_FINANCE_OVERVIEW, VIEW_TARGETS,
)
from app.services import target_alerts as alerts
from app.services import targets as svc


def _dt(y, m, d, h=0):
    return datetime(y, m, d, h, tzinfo=timezone.utc)


class _Actor:
    """Just enough of a User for the visibility helpers."""

    def __init__(self, account_type=AccountType.EMPLOYEE, permissions=None):
        self.account_type = account_type
        self.permissions = list(permissions or [])

    @property
    def is_owner(self):
        return self.account_type == AccountType.OWNER


OWNER = _Actor(AccountType.OWNER, [MANAGE_TARGETS, VIEW_AGENCY_PROFIT])
ASSIGNER = _Actor(permissions=[VIEW_TARGETS, MANAGE_TARGETS])
PLAIN = _Actor(permissions=[VIEW_TARGETS])
# The exact account the owner complained about: trusted with the finance desk,
# still not entitled to see a house-profit TARGET.
FINANCE = _Actor(permissions=[VIEW_FINANCE_OVERVIEW, VIEW_AGENCY_PROFIT, VIEW_TARGETS])

FULL_TARGET = {
    TargetMetric.POLICIES.value: 10,
    TargetMetric.HOUSE_PROFIT.value: 1_000_000,      # Rs 10,000
    TargetMetric.RENEWALS.value: 3,
}
ACTUALS = {
    TargetMetric.POLICIES.value: 5,
    TargetMetric.PREMIUM.value: 250_000,
    TargetMetric.HOUSE_PROFIT.value: 2_000_000,      # doubled the goal
    TargetMetric.RENEWALS.value: 0,
}


# --- Who may see it --------------------------------------------------------------


def test_owner_sees_house_profit():
    assert svc.can_see_profit_targets(OWNER) is True


def test_target_assigner_sees_house_profit():
    """Whoever sets the numbers must see them, or the assign screen is a lie."""
    assert svc.can_see_profit_targets(ASSIGNER) is True


def test_plain_employee_never_sees_house_profit():
    assert svc.can_see_profit_targets(PLAIN) is False


def test_finance_permission_alone_does_not_unlock_target_profit():
    """view_agency_profit governs the finance screens; target visibility is a
    separate decision the owner tied to who assigns targets."""
    assert svc.can_see_profit_targets(FINANCE) is False


def test_no_actor_sees_nothing():
    assert svc.can_see_profit_targets(None) is False


# --- What comes back --------------------------------------------------------------


def test_metric_rows_drop_house_profit_for_an_employee():
    rows = svc.metric_rows(FULL_TARGET, ACTUALS, allow_profit=False)
    metrics = [r["metric"] for r in rows]
    assert TargetMetric.HOUSE_PROFIT.value not in metrics
    assert metrics == ["policies", "renewals"]


def test_metric_rows_keep_house_profit_for_the_owner():
    rows = svc.metric_rows(FULL_TARGET, ACTUALS, allow_profit=True)
    assert TargetMetric.HOUSE_PROFIT.value in [r["metric"] for r in rows]


def test_no_profit_figure_survives_anywhere_in_an_employee_payload():
    """Not just the goal — the actual and the percentage must be gone too, so
    the number cannot be reconstructed from the response."""
    rows = svc.metric_rows(FULL_TARGET, ACTUALS, allow_profit=False)
    blob = repr(rows)
    assert "house_profit" not in blob
    assert str(FULL_TARGET[TargetMetric.HOUSE_PROFIT.value]) not in blob
    assert str(ACTUALS[TargetMetric.HOUSE_PROFIT.value]) not in blob


def test_employee_headline_is_recomputed_from_visible_metrics_only():
    """Screenshot 29: the tile read 106% because house profit dominated it.
    With profit hidden the honest number is the average of what is left —
    5/10 policies and 0/3 renewals -> 25%."""
    rows = svc.metric_rows(FULL_TARGET, ACTUALS, allow_profit=False)
    assert svc.overall_attainment(rows) == 25.0


def test_owner_headline_still_leads_on_profit():
    rows = svc.metric_rows(FULL_TARGET, ACTUALS, allow_profit=True)
    assert svc.overall_attainment(rows) == 200.0


def test_a_profit_only_target_is_invisible_to_the_employee():
    """The owner's "get me 10k this month" case: the employee is told nothing
    at all rather than being shown a mystery bar."""
    rows = svc.metric_rows(
        {TargetMetric.HOUSE_PROFIT.value: 1_000_000}, ACTUALS,
        allow_profit=False)
    assert rows == []
    assert svc.overall_attainment(rows) == 0.0


def test_visible_actuals_strip_profit_too():
    assert TargetMetric.HOUSE_PROFIT.value not in svc.visible_actuals(
        ACTUALS, False)
    assert TargetMetric.HOUSE_PROFIT.value in svc.visible_actuals(ACTUALS, True)


# --- Milestones -------------------------------------------------------------------


def test_milestones_fire_once_each():
    assert svc.due_milestone(52.0, []) == 50
    assert svc.due_milestone(52.0, [50]) is None


def test_only_the_highest_new_milestone_is_announced():
    """One big policy taking someone from 20% to 100% earns one message, not
    three in a row."""
    assert svc.due_milestone(100.0, []) == 100


def test_crossed_milestones_records_the_ones_skipped_over():
    assert svc.crossed_milestones(100.0) == [50, 90, 100]
    assert svc.crossed_milestones(91.0) == [50, 90]
    assert svc.crossed_milestones(49.9) == []


def test_a_skipped_milestone_never_fires_later():
    already = svc.crossed_milestones(100.0)
    assert svc.due_milestone(100.0, already) is None
    assert svc.due_milestone(103.0, already) is None


def test_below_fifty_percent_says_nothing():
    assert svc.due_milestone(0.0, []) is None
    assert svc.due_milestone(49.9, []) is None


def test_milestone_percentage_ignores_house_profit():
    """A target smashed on profit but missed on policies must NOT trigger a
    congratulation — that would tell the employee the profit goal exists."""
    pct, _rows = alerts.visible_attainment(FULL_TARGET, ACTUALS)
    assert pct == 25.0
    assert svc.due_milestone(pct, []) is None


def test_goal_lines_never_mention_the_agency_margin():
    lines = alerts.goal_lines(FULL_TARGET)
    labels = [g["label"] for g in lines]
    assert "House profit" not in labels
    assert labels == ["Policies", "Renewals"]


def test_goal_lines_read_as_money_or_counts():
    lines = alerts.goal_lines({TargetMetric.PREMIUM.value: 10_000_000,
                               TargetMetric.POLICIES.value: 15})
    by_label = {g["label"]: g["value"] for g in lines}
    assert by_label["Premium"] == "₹1,00,000"     # Indian grouping
    assert by_label["Policies"] == "15"


def test_every_milestone_has_copy():
    for m in svc.MILESTONES:
        copy = alerts.MILESTONE_COPY[m]
        assert copy["title"] and copy["headline"] and copy["message"]
        assert "{period}" in copy["subject"]


# --- Dashboard windows -------------------------------------------------------------


def test_current_window_is_this_ist_month():
    lo, hi, label = svc.progress_window("current", _dt(2026, 7, 26))
    assert (svc.to_ist(lo).year, svc.to_ist(lo).month,
            svc.to_ist(lo).day) == (2026, 7, 1)
    assert (svc.to_ist(hi).year, svc.to_ist(hi).month) == (2026, 8)
    assert label == "July 2026"


def test_previous_windows_step_back_whole_months():
    _, _, prev1 = svc.progress_window("prev1", _dt(2026, 7, 26))
    _, _, prev2 = svc.progress_window("prev2", _dt(2026, 7, 26))
    assert prev1 == "June 2026"
    assert prev2 == "May 2026"


def test_last3_spans_three_whole_months():
    lo, hi, label = svc.progress_window("last3", _dt(2026, 7, 26))
    assert (svc.to_ist(lo).year, svc.to_ist(lo).month) == (2026, 5)
    assert (svc.to_ist(hi).year, svc.to_ist(hi).month) == (2026, 8)
    assert label == "May – Jul 2026"


def test_window_rollover_crosses_the_year():
    _, _, label = svc.progress_window("prev2", _dt(2026, 1, 15))
    assert label == "November 2025"


def test_unknown_window_falls_back_to_this_month():
    """A stale bookmark must never 500 someone's home page."""
    _, _, label = svc.progress_window("nonsense", _dt(2026, 7, 26))
    assert label == "July 2026"


def test_last3_goals_add_up_the_three_monthly_targets():
    """The combined view sums whole monthly targets, not a pro-rated slice."""
    targets = []
    for month in (5, 6, 7):
        lo, hi = svc.normalise_period(TargetPeriod.MONTH, _dt(2026, month, 1))
        t = type("T", (), {"metrics": {TargetMetric.POLICIES.value: 10},
                           "period_start": lo, "period_end": hi})()
        targets.append(t)
    lo, hi, _ = svc.progress_window("last3", _dt(2026, 7, 20))
    goals = svc.prorated_goals(targets, lo, hi)
    assert goals[TargetMetric.POLICIES.value] == 30


def test_team_totals_add_every_employee_up():
    combined = svc.sum_metrics([
        {TargetMetric.POLICIES.value: 3, TargetMetric.HOUSE_PROFIT.value: 500},
        {TargetMetric.POLICIES.value: 4},
        {},
    ])
    assert combined[TargetMetric.POLICIES.value] == 7
    assert combined[TargetMetric.HOUSE_PROFIT.value] == 500


def test_sum_metrics_of_nothing_is_empty():
    assert svc.sum_metrics([]) == {}


# --- Monthly only ------------------------------------------------------------------


def test_targets_reject_quarterly_and_yearly():
    from pydantic import ValidationError

    from app.schemas.target import TargetCreate

    for period in ("quarter", "year"):
        with pytest.raises(ValidationError):
            TargetCreate(assignee_type="employee", assignee_id="e1",
                         period=period, period_start=_dt(2026, 7, 1),
                         metrics={TargetMetric.POLICIES.value: 5})


def test_a_monthly_target_still_saves():
    from app.schemas.target import TargetCreate

    payload = TargetCreate(assignee_type="employee", assignee_id="e1",
                           period="month", period_start=_dt(2026, 7, 26),
                           metrics={TargetMetric.POLICIES.value: 5})
    assert payload.period == TargetPeriod.MONTH


def test_bulk_assign_is_monthly_only_too():
    from pydantic import ValidationError

    from app.schemas.target import BulkTargetAssign

    with pytest.raises(ValidationError):
        BulkTargetAssign(period="quarter", period_start=_dt(2026, 7, 1),
                         rows=[])
