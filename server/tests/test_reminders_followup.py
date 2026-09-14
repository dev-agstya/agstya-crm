"""Follow-up reminder timing — the IST/UTC boundary, which is where this breaks.

Storage is UTC; "today" is the Indian calendar day. A reminder set for 9pm on
the 3rd IST is stored as 15:30 UTC on the 3rd, and must be due on the 3rd — not
the 4th. These are pure (no DB): they build Reminder-shaped stubs so the date
logic can be pinned without a database.
"""

from datetime import datetime, timedelta, timezone

from app.models.reminder import REMINDER_CANCELLED, REMINDER_DONE, REMINDER_OPEN
from app.services import reminder_svc
from app.services.finance_reports import IST


class _R:
    """A Reminder-shaped stub — the service only reads due_at and status."""

    def __init__(self, due_at, status=REMINDER_OPEN):
        self.due_at = due_at
        self.status = status


def _ist(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=IST)


def _utc(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


# --- The IST day boundary ----------------------------------------------------------


def test_the_day_ends_at_midnight_ist_not_midnight_utc():
    """Midnight UTC is 5:30am IST — using it would call half the working day
    'tomorrow'."""
    end = reminder_svc.end_of_day_ist(_ist(2026, 8, 2, 10, 0))
    assert (end.year, end.month, end.day) == (2026, 8, 2)
    assert end.utcoffset() == timedelta(hours=5, minutes=30)
    assert (end.hour, end.minute) == (23, 59)


def test_a_late_evening_reminder_is_due_the_same_indian_day():
    """9pm IST on the 3rd is 15:30 UTC on the 3rd. Bucketing in UTC would still
    put it on the 3rd here — but at 1am IST on the 4th (19:30 UTC on the 3rd)
    the two disagree, which is the case below."""
    now = _ist(2026, 8, 3, 10, 0)
    assert reminder_svc.is_due_today(_R(_ist(2026, 8, 3, 21, 0)), now) is True


def test_just_after_midnight_ist_belongs_to_the_new_day():
    due = _ist(2026, 8, 4, 0, 30)             # 19:00 UTC on the 3rd
    assert reminder_svc.is_due_today(_R(due), _ist(2026, 8, 3, 10, 0)) is False
    assert reminder_svc.is_due_today(_R(due), _ist(2026, 8, 4, 9, 0)) is True


def test_a_utc_stored_time_is_read_back_in_ist():
    """Stored UTC, judged in IST: 20:00 UTC on the 2nd is 1:30am IST on the 3rd."""
    due = _utc(2026, 8, 2, 20, 0)
    assert reminder_svc.is_due_today(_R(due), _ist(2026, 8, 2, 12, 0)) is False
    assert reminder_svc.is_due_today(_R(due), _ist(2026, 8, 3, 12, 0)) is True


# --- Due vs overdue -------------------------------------------------------------------


def test_due_later_today_is_not_overdue():
    """A 5pm reminder at 10am is due, not late. Conflating the two makes the
    whole list red by breakfast and people stop reading it."""
    now = _ist(2026, 8, 2, 10, 0)
    r = _R(_ist(2026, 8, 2, 17, 0))
    assert reminder_svc.is_due_today(r, now) is True
    assert reminder_svc.is_overdue(r, now) is False


def test_yesterday_is_overdue_and_still_counts_as_owed_today():
    now = _ist(2026, 8, 2, 10, 0)
    r = _R(_ist(2026, 8, 1, 17, 0))
    assert reminder_svc.is_overdue(r, now) is True
    # It is before the end of today, so the digest still lists it (owner A2.6).
    assert r.due_at <= reminder_svc.end_of_day_ist(now)


def test_tomorrow_is_neither_due_nor_overdue():
    now = _ist(2026, 8, 2, 10, 0)
    r = _R(_ist(2026, 8, 3, 9, 0))
    assert reminder_svc.is_due_today(r, now) is False
    assert reminder_svc.is_overdue(r, now) is False


# --- Closed reminders never chase anyone ------------------------------------------------


def test_a_completed_reminder_is_never_due_or_overdue():
    now = _ist(2026, 8, 2, 10, 0)
    for status in (REMINDER_DONE, REMINDER_CANCELLED):
        long_past = _R(_ist(2026, 1, 1), status=status)
        assert reminder_svc.is_overdue(long_past, now) is False
        assert reminder_svc.is_due_today(long_past, now) is False
