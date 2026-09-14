"""Profit gating (owner Q-A2): view_finance must NOT expose agency profit.

Verifies the server-side gate zeroes every house/net-profit figure before it
leaves the API when the viewer lacks view_agency_profit."""

from app.routers.finance import (
    _gate_overview,
    _gate_reports,
)
from app.schemas.finance import (
    AgingBlock,
    EarningsBlock,
    FinanceOverview,
    MonthPoint,
    PendingBlock,
    ReportResult,
    ReportRow,
    ReportTotals,
)


def _overview() -> FinanceOverview:
    return FinanceOverview(
        basis="cash",
        earnings=EarningsBlock(total=500, this_month=100, last_month=80,
                               last_3_months=250, growth_pct=25.0),
        monthly=[MonthPoint(month="2026-07", earnings=100, target=200)],
        pending=PendingBlock(collection_customers=300),
        aging=AgingBlock(bucket_0_30=300),
        fy_label="FY 2026-27", fy_earnings=500,
        reward_received_total=900, premium_collected_total=1180)


def test_overview_profit_hidden_when_not_permitted():
    o = _gate_overview(_overview(), cvp=False)
    assert o.can_view_profit is False
    # Profit / earnings zeroed...
    assert o.earnings.total == 0
    assert o.earnings.this_month == 0
    assert o.monthly[0].earnings == 0
    assert o.monthly[0].target is None
    assert o.fy_earnings == 0
    # ...but cash movements + receivables stay visible.
    assert o.reward_received_total == 900
    assert o.premium_collected_total == 1180
    assert o.pending.collection_customers == 300


def test_overview_profit_shown_when_permitted():
    o = _gate_overview(_overview(), cvp=True)
    assert o.can_view_profit is True
    assert o.earnings.total == 500
    assert o.fy_earnings == 500


def test_reports_profit_hidden_when_not_permitted():
    r = ReportResult(
        dimension="insurer",
        totals=ReportTotals(policies=2, premium=1000, profit=400),
        rows=[ReportRow(key="x", label="X", policies=2, premium=1000,
                        profit=400, growth_pct=12.5)])
    r = _gate_reports(r, cvp=False)
    assert r.can_view_profit is False
    assert r.totals.profit == 0
    assert r.rows[0].profit == 0
    assert r.rows[0].growth_pct is None
    # Non-profit metrics untouched.
    assert r.rows[0].premium == 1000
    assert r.totals.policies == 2
