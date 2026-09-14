"""Unit tests for the Finance Overview graph buckets (no DB needed).

Owner 2026-07-24: the graph must reflect the TOP date filter — the buckets span
the actual selected [lo, hi] window instead of a fixed "last 7 days / last 6
months" heuristic.
"""

from datetime import datetime, timezone

from app.services.finance_dashboard import series_buckets


def _dt(y, m, d):
    return datetime(y, m, d, tzinfo=timezone.utc)


def test_short_window_is_daily_and_spans_window():
    gran, buckets = series_buckets(_dt(2026, 7, 1), _dt(2026, 7, 7))
    assert gran == "day"
    assert len(buckets) == 7
    # First/last buckets sit at the window edges (not "last 7 days" ending today).
    assert buckets[0]["key"] == "2026-07-01"
    assert buckets[-1]["key"] == "2026-07-07"


def test_month_window_is_weekly():
    gran, buckets = series_buckets(_dt(2026, 7, 1), _dt(2026, 7, 31))
    assert gran == "week"
    assert len(buckets) >= 4


def test_year_window_is_monthly_and_spans_every_month():
    gran, buckets = series_buckets(_dt(2026, 4, 1), _dt(2027, 3, 31))
    assert gran == "month"
    keys = [b["key"] for b in buckets]
    assert keys[0] == "2026-04"
    assert keys[-1] == "2027-03"
    assert len(keys) == 12
