"""A reminder can only be set for the FUTURE (owner 2026-08-04).

Why this is a server rule and not a form rule: `ring_bells` only ever looks
forward from the moment it runs, so a reminder saved for yesterday has no moment
left for its bell to ring in — it is born overdue and the first anybody hears of
it is the 08:00 digest calling it late. The browser check is a courtesy; this is
the guard.

The two things that are easy to get wrong and are pinned here:

  1. The GRACE. Rejecting to the exact second fails a reminder set for "in one
     minute" purely on the round trip, which reads as a broken form.
  2. EDITING something already overdue. The rule is about *scheduling*, not
     about locking the record — re-saving a past date unchanged (to fix a typo,
     or add a colleague) has to keep working, or an overdue follow-up becomes
     uneditable until someone reschedules it first.

Pure tests: the router helper and a Reminder-shaped stub, no database.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.core.enums import AccountType
from app.models.reminder import REMINDER_OPEN
from app.routers import reminders as reminders_router
from app.schemas.reminder import ReminderUpdate


def _run(coro):
    return asyncio.run(coro)


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class _User:
    id: str = "u1"
    full_name: str = "Asha"
    account_type: AccountType = AccountType.EMPLOYEE


@dataclass
class _Stub:
    """Enough of a Reminder for update_reminder to walk over."""

    due_at: datetime
    assignee_ids: list = field(default_factory=lambda: ["u1"])
    assignee_names: list = field(default_factory=lambda: ["Asha"])
    title: str = "Call the lead back"
    note: str = ""
    entity_code: str = "AG-LED-000001"
    status: str = REMINDER_OPEN
    notified_at: datetime | None = None
    completed_at: datetime | None = None
    completed_by: str | None = None
    completed_by_name: str | None = None
    updated_at: datetime | None = None
    saved: bool = False

    async def save(self):
        self.saved = True


# --- The rule itself ---------------------------------------------------------------


def test_a_past_due_date_is_refused():
    with pytest.raises(HTTPException) as e:
        reminders_router._ensure_future(_now() - timedelta(hours=2))
    assert e.value.status_code == 400
    # The message has to say what to do, not just that it failed.
    assert "future" in e.value.detail.lower()


def test_a_future_due_date_is_accepted_and_comes_back_aware():
    due = _now() + timedelta(days=1)
    assert reminders_router._ensure_future(due) == due


def test_a_naive_datetime_is_read_as_utc_not_rejected_outright():
    """The API takes ISO strings; a client that drops the offset must not have
    its perfectly good future date read as some other instant."""
    naive = (_now() + timedelta(days=1)).replace(tzinfo=None)
    got = reminders_router._ensure_future(naive)
    assert got.tzinfo is not None
    assert got.utcoffset() == timedelta(0)


def test_the_grace_covers_the_round_trip():
    """A form that sat open for a beat before Save must not fail on latency."""
    assert reminders_router.DUE_GRACE == timedelta(seconds=60)
    reminders_router._ensure_future(_now() - timedelta(seconds=30))


def test_the_grace_is_too_small_to_schedule_anything_in_the_past():
    with pytest.raises(HTTPException):
        reminders_router._ensure_future(_now() - timedelta(seconds=180))


# --- Creating ----------------------------------------------------------------------


def test_creating_runs_the_due_date_through_the_guard():
    """Reading the source rather than hitting the DB: what matters is that the
    create path cannot go back to the bare `_aware()` it used to call."""
    import inspect

    src = inspect.getsource(reminders_router.create_reminder)
    assert "_ensure_future(payload.due_at)" in src
    assert "_aware(payload.due_at)" not in src


# --- Editing -----------------------------------------------------------------------


def _patch_load(monkeypatch, stub):
    """Run update_reminder against a stub: no database, no audit write, and no
    Pydantic serialisation of a dataclass at the end of it."""
    async def _load(_id):
        return stub

    monkeypatch.setattr(reminders_router, "_load", _load)

    async def _log(*a, **k):
        return None

    monkeypatch.setattr(reminders_router, "log_action", _log)

    class _Out:
        @staticmethod
        def from_model(r):
            return r

    monkeypatch.setattr(reminders_router, "ReminderOut", _Out)


def test_moving_a_reminder_into_the_past_is_refused(monkeypatch):
    stub = _Stub(due_at=_now() + timedelta(days=1))
    _patch_load(monkeypatch, stub)
    with pytest.raises(HTTPException) as e:
        _run(reminders_router.update_reminder(
            "r1", ReminderUpdate(due_at=_now() - timedelta(days=1)), _User()))
    assert e.value.status_code == 400
    assert stub.saved is False


def test_resaving_an_overdue_reminder_unchanged_still_works(monkeypatch):
    """THE regression. Fixing a typo on something due yesterday sends the stored
    date straight back; refusing it would make an overdue follow-up read-only."""
    past = _now() - timedelta(days=3)
    stub = _Stub(due_at=past)
    _patch_load(monkeypatch, stub)
    _run(reminders_router.update_reminder(
        "r1", ReminderUpdate(title="Call back about the motor quote",
                             due_at=past), _User()))
    assert stub.saved is True
    assert stub.due_at == past
    assert stub.title == "Call back about the motor quote"


def test_an_unchanged_past_date_does_not_re_ring_the_bell(monkeypatch):
    """notified_at is cleared because a NEW date is a new promise. Re-saving the
    same date is not, so it must not make the bell go off a second time."""
    past = _now() - timedelta(days=3)
    stub = _Stub(due_at=past, notified_at=past)
    _patch_load(monkeypatch, stub)
    _run(reminders_router.update_reminder("r1", ReminderUpdate(due_at=past),
                                          _User()))
    assert stub.notified_at == past


def test_rescheduling_forward_clears_notified_at(monkeypatch):
    stub = _Stub(due_at=_now() - timedelta(days=1),
                 notified_at=_now() - timedelta(days=1))
    _patch_load(monkeypatch, stub)
    later = _now() + timedelta(days=2)
    _run(reminders_router.update_reminder("r1", ReminderUpdate(due_at=later),
                                          _User()))
    assert stub.due_at == later
    assert stub.notified_at is None


def test_snooze_is_untouched_by_the_rule():
    """Snooze only ever adds days to an existing date, so it cannot produce a
    past one — and it must not start going through the guard, because snoozing
    something three days overdue by one day is legitimate."""
    import inspect

    src = inspect.getsource(reminders_router.snooze_reminder)
    assert "_ensure_future" not in src
    assert "timedelta(days=days)" in src
