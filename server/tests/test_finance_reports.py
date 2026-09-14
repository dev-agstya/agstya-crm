"""Pure helpers for the finance dashboard/reports."""

from datetime import datetime, timezone

from app.services.finance_reports import (
    aging_bucket,
    fy_label,
    fy_start_year,
    growth_pct,
    last_n_month_keys,
    month_key,
    shift_month,
)


def test_month_key():
    assert month_key(datetime(2026, 7, 9)) == "2026-07"
    assert month_key(datetime(2026, 12, 1)) == "2026-12"


def test_shift_month_wraps_years():
    assert shift_month(2026, 1, -1) == (2025, 12)
    assert shift_month(2026, 12, 1) == (2027, 1)
    assert shift_month(2026, 7, -7) == (2025, 12)


def test_last_n_month_keys():
    keys = last_n_month_keys(datetime(2026, 2, 15), 3)
    assert keys == ["2025-12", "2026-01", "2026-02"]


def test_growth_pct():
    assert growth_pct(150, 100) == 50.0
    assert growth_pct(50, 100) == -50.0
    assert growth_pct(100, 0) is None


def test_aging_bucket():
    assert aging_bucket(0) == "0_30"
    assert aging_bucket(30) == "0_30"
    assert aging_bucket(31) == "30_60"
    assert aging_bucket(60) == "30_60"
    assert aging_bucket(61) == "60_plus"


def test_financial_year():
    # Indian FY starts 1 April.
    assert fy_start_year(datetime(2026, 3, 31, tzinfo=timezone.utc)) == 2025
    assert fy_start_year(datetime(2026, 4, 1, tzinfo=timezone.utc)) == 2026
    assert fy_label(datetime(2026, 7, 9, tzinfo=timezone.utc)) == "FY 2026-27"
