"""Tests for the monthly channel-partner statement job: date logic, PDF render,
and the last-working-day guard (which short-circuits before any DB access)."""

import asyncio
from datetime import datetime, timezone

from app.services.partner_statements import (
    is_last_working_day,
    last_working_day,
    month_bounds,
    run_monthly_statements,
)
from app.services.statement_pdf import render_statement_pdf


def test_last_working_day_is_a_weekday():
    for y, m in [(2026, 7), (2026, 8), (2026, 2), (2027, 1), (2026, 5)]:
        d = last_working_day(y, m)
        assert datetime(y, m, d).weekday() < 5   # Mon–Fri


def test_is_last_working_day():
    y, m = 2026, 8
    d = last_working_day(y, m)
    assert is_last_working_day(datetime(y, m, d, tzinfo=timezone.utc))
    assert not is_last_working_day(datetime(y, m, 1, tzinfo=timezone.utc))


def test_month_bounds_non_leap_february():
    lo, hi = month_bounds(datetime(2026, 2, 15, tzinfo=timezone.utc))
    assert (lo.year, lo.month, lo.day) == (2026, 2, 1)
    assert (hi.month, hi.day) == (2, 28)   # 2026 is not a leap year
    assert hi.hour == 23 and hi.minute == 59


def test_run_skips_when_not_last_working_day():
    # The 1st of the month is never the last working day -> guard returns before
    # touching the DB, so this runs without a database.
    res = asyncio.run(
        run_monthly_statements(now=datetime(2026, 8, 1, tzinfo=timezone.utc)))
    assert res.get("skipped_reason") == "not the last working day"


def test_render_statement_pdf_with_data():
    data = {
        "label": "Neelam Insurance", "code": "CP-AA00001",
        "date_from": datetime(2026, 7, 1, tzinfo=timezone.utc),
        "date_to": datetime(2026, 7, 31, tzinfo=timezone.utc),
        "opening_balance": 50000, "total_premium": 354000,
        "total_reward": 42000, "net_balance": 92000,
        "total_in": 118000, "total_out": 20000,
        "policies": [{"date": datetime(2026, 7, 5, tzinfo=timezone.utc),
                      "code": "POL-AA00007", "customer": "Ramesh Kumar",
                      "category": "Motor", "premium": 118000,
                      "reward": 14000}],
        "transactions": [{"date": datetime(2026, 7, 9, tzinfo=timezone.utc),
                          "label": "Premium collected", "direction": "in",
                          "amount": 118000}],
    }
    pdf = render_statement_pdf(data)
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 500


def test_render_statement_pdf_empty():
    pdf = render_statement_pdf({"label": "X", "policies": [],
                                "transactions": []})
    assert pdf[:5] == b"%PDF-"
