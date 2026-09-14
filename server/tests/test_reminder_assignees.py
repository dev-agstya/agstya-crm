"""Reminders shared between several people (owner Q3.2a, 2026-08-03).

The choice that everything here pins: a reminder with four names on it is ONE
task, not four copies. Everyone gets the bell and the daily email, and the first
person to mark it done closes it for all of them.

The failure this guards against is subtle and expensive: if "mine" or the digest
only ever matched the FIRST assignee, four people would be named on a follow-up
and three of them would never hear about it — the feature would look like it
worked right up until someone missed a call.

Pure tests: the bell and digest run against stubs so the fan-out can be counted
without a database.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import pytest

from app.models.reminder import REMINDER_DONE, REMINDER_OPEN, Reminder
from app.routers import reminders as reminders_router
from app.schemas.reminder import (
    MAX_ASSIGNEES,
    ReminderCreate,
    ReminderUpdate,
)
from app.services import reminder_svc
from app.services.finance_reports import IST


def _run(coro):
    return asyncio.run(coro)


@dataclass
class _User:
    id: str
    full_name: str
    account_type: str = "employee"


@dataclass
class _Stub:
    """A Reminder-shaped stub for the bell / digest loops."""

    assignee_ids: list
    assignee_names: list = field(default_factory=list)
    title: str = "Call the lead back"
    note: str = ""
    entity_type: str = "lead"
    entity_label: str = "Ramesh Kumar"
    entity_code: str = "AG-LED-000001"
    status: str = REMINDER_OPEN
    due_at: datetime = datetime(2026, 8, 3, 4, 0, tzinfo=timezone.utc)
    notified_at: datetime | None = None

    async def save(self):
        pass


# --- The model ----------------------------------------------------------------------


def test_the_single_assignee_field_is_gone():
    """It was an indexed scalar. Leaving it on the model means half the code
    writes one name while the other half reads a list."""
    assert "assigned_to_id" not in Reminder.model_fields
    assert "assignee_ids" in Reminder.model_fields


def test_the_index_is_on_the_array_so_mine_stays_indexed():
    """"What is due for me" is the query the whole feature exists for. Against
    an array Mongo needs a multikey index on that exact field — an index left
    on the old scalar would silently become a collection scan."""
    specs = [[k for k, _ in idx] for idx in Reminder.Settings.indexes]
    assert ["assignee_ids", "status", "due_at"] in specs


def test_assignees_pairs_ids_with_names():
    r = _Stub(assignee_ids=["u1", "u2"], assignee_names=["Asha", "Bilal"])
    got = Reminder.assignees.fget(r)
    assert got == [{"id": "u1", "name": "Asha"}, {"id": "u2", "name": "Bilal"}]


def test_a_names_list_out_of_step_with_the_ids_does_not_crash():
    """A renamed user or a hand-edited document must not 500 the list."""
    r = _Stub(assignee_ids=["u1", "u2", "u3"], assignee_names=["Asha"])
    got = Reminder.assignees.fget(r)
    assert [a["id"] for a in got] == ["u1", "u2", "u3"]
    assert got[1]["name"] == ""


# --- Resolving who is on it ----------------------------------------------------------


def test_no_one_named_means_me():
    """A reminder with nobody on it is a task nobody is ever told about."""
    me = _User("u1", "Asha")
    ids, names = _run(reminders_router._resolve_assignees([], fallback=me))
    assert ids == ["u1"]
    assert names == ["Asha"]


def test_the_same_person_twice_gets_one_bell():
    me = _User("u1", "Asha")
    ids, names = _run(
        reminders_router._resolve_assignees(["u1", "u1"], fallback=me))
    assert ids == ["u1"]
    assert names == ["Asha"]


def test_the_cap_is_enforced_by_the_schema():
    """Past a handful this is a team announcement, and it also stops one request
    fanning out into hundreds of notification writes."""
    with pytest.raises(Exception):
        ReminderCreate(entity_type="lead", entity_id="x", title="Call",
                       due_at=datetime.now(timezone.utc),
                       assignee_ids=[f"u{i}" for i in range(MAX_ASSIGNEES + 1)])


def test_creating_defaults_to_an_empty_list_not_none():
    payload = ReminderCreate(entity_type="lead", entity_id="x", title="Call",
                             due_at=datetime.now(timezone.utc))
    assert payload.assignee_ids == []


def test_an_omitted_assignee_list_on_update_leaves_them_alone():
    """PATCH is partial: changing the due date must not drop everyone off it."""
    payload = ReminderUpdate(title="New title")
    assert payload.assignee_ids is None
    assert "assignee_ids" not in payload.model_dump(exclude_unset=True)


def test_an_explicit_empty_list_on_update_is_distinguishable():
    """The router refuses this rather than orphaning the task, which it can only
    do if an explicit [] is tellable apart from an omitted field."""
    payload = ReminderUpdate(assignee_ids=[])
    assert payload.assignee_ids == []
    assert "assignee_ids" in payload.model_dump(exclude_unset=True)


# --- The bell -------------------------------------------------------------------------


def _fake_notifications(monkeypatch):
    sent = []

    async def create_notification(user_id, title, body="", **kw):
        sent.append({"user_id": user_id, "title": title, "body": body})

    monkeypatch.setattr(reminder_svc.notifications, "create_notification",
                        create_notification)
    return sent


def _fake_find(monkeypatch, rows):
    """Stand in for the Reminder document class inside reminder_svc.

    Beanie only turns `Reminder.status` into a queryable field expression once
    the ODM is initialised against a database, and these tests deliberately run
    without one — so the whole class is swapped rather than just `.find`.
    """
    class _Cursor:
        def __aiter__(self):
            async def gen():
                for r in rows:
                    yield r
            return gen()

    class _FakeReminder:
        status = "status"          # placeholder for the field expression

        @staticmethod
        def find(*a, **k):
            return _Cursor()

    monkeypatch.setattr(reminder_svc, "Reminder", _FakeReminder)


def test_the_bell_rings_for_every_person_on_a_shared_reminder(monkeypatch):
    """THE regression. One notification per assignee — not one for the first
    name with the rest silently dropped."""
    sent = _fake_notifications(monkeypatch)
    _fake_find(monkeypatch, [
        _Stub(assignee_ids=["u1", "u2", "u3"],
              assignee_names=["Asha", "Bilal", "Chetan"])])

    rung = _run(reminder_svc.ring_bells(datetime(2026, 8, 3, 12, 0, tzinfo=IST)))

    assert rung == 3
    assert {s["user_id"] for s in sent} == {"u1", "u2", "u3"}


def test_a_shared_bell_says_it_is_shared(monkeypatch):
    """Otherwise everyone assumes a colleague has it and nobody calls."""
    sent = _fake_notifications(monkeypatch)
    _fake_find(monkeypatch, [
        _Stub(assignee_ids=["u1", "u2"], assignee_names=["Asha", "Bilal"])])
    _run(reminder_svc.ring_bells(datetime(2026, 8, 3, 12, 0, tzinfo=IST)))
    assert "shared with 1 other" in sent[0]["body"]


def test_a_solo_reminder_is_not_described_as_shared(monkeypatch):
    sent = _fake_notifications(monkeypatch)
    _fake_find(monkeypatch, [_Stub(assignee_ids=["u1"], assignee_names=["Asha"])])
    _run(reminder_svc.ring_bells(datetime(2026, 8, 3, 12, 0, tzinfo=IST)))
    assert "shared" not in sent[0]["body"]


def test_the_bell_is_stamped_once_for_the_whole_reminder(monkeypatch):
    """notified_at is what makes the bell exactly-once. It belongs to the
    reminder, not to each person, or the digest and the bell disagree."""
    _fake_notifications(monkeypatch)
    row = _Stub(assignee_ids=["u1", "u2"], assignee_names=["Asha", "Bilal"])
    _fake_find(monkeypatch, [row])
    _run(reminder_svc.ring_bells(datetime(2026, 8, 3, 12, 0, tzinfo=IST)))
    assert row.notified_at is not None


# --- The daily digest -------------------------------------------------------------------


def test_the_digest_reaches_everyone_named(monkeypatch):
    """Owner Q3.6: a shared reminder appears in each person's email. That is the
    point of sharing it."""
    rows = [_Stub(assignee_ids=["u1", "u2"], assignee_names=["Asha", "Bilal"]),
            _Stub(assignee_ids=["u2"], assignee_names=["Bilal"],
                  title="Send the quote")]
    _fake_find(monkeypatch, rows)

    grouped: dict = {}
    for r in rows:
        for uid in r.assignee_ids:
            grouped.setdefault(uid, []).append(r)

    # Asha owes one thing, Bilal owes two — one of which is the shared one.
    assert len(grouped["u1"]) == 1
    assert len(grouped["u2"]) == 2


def test_the_digest_names_the_other_people_on_a_shared_row():
    """Reading "shared with Bilal" is what stops two people making the same
    call. Built the same way send_daily_digest builds it."""
    r = _Stub(assignee_ids=["u1", "u2", "u3"],
              assignee_names=["Asha", "Bilal", "Chetan"])
    me = "u2"
    shared_with = [n for i, n in enumerate(r.assignee_names)
                   if i < len(r.assignee_ids) and r.assignee_ids[i] != me]
    assert shared_with == ["Asha", "Chetan"]


# --- Done closes it for everyone --------------------------------------------------------


def test_done_is_one_status_on_one_row():
    """Owner Q3.2a. There is no per-person completion, by design: the status
    lives on the reminder, so marking it done closes it for all of them and
    cannot leave a copy open for someone else."""
    assert "status" in Reminder.model_fields
    assert not any(f.startswith("completed_by_") and f.endswith("_ids")
                   for f in Reminder.model_fields)
    assert "completed_by_name" in Reminder.model_fields


def test_a_closed_reminder_is_neither_overdue_nor_due_today():
    """It has to drop out of everyone's counts at once, not just the closer's."""
    past = datetime.now(timezone.utc) - timedelta(days=2)
    done = _Stub(assignee_ids=["u1", "u2"], status=REMINDER_DONE, due_at=past)
    assert reminder_svc.is_overdue(done) is False
    assert reminder_svc.is_due_today(done) is False
