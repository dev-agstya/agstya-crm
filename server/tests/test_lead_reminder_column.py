"""The Reminders column on the Leads list (owner Q2.4, 2026-08-03).

THE COST THIS GUARDS: a countdown per row is the kind of feature that quietly
becomes N+1. Fifteen leads on a page must cost ONE extra query, not fifteen —
the whole reason reminders live in their own collection rather than on the lead
is that this lookup has to stay a single indexed read.

The second thing pinned here is that the cell reports the SOONEST open reminder
and says how many others there are. Showing an arbitrary one would make the
column actively misleading: a lead due in an hour could display "in 3 weeks".
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import pytest

from app.models.reminder import REMINDER_DONE, REMINDER_OPEN
from app.services import reminder_svc


def _run(coro):
    return asyncio.run(coro)


NOW = datetime(2026, 8, 3, 10, 0, tzinfo=timezone.utc)


@dataclass
class _Stub:
    id: str
    entity_id: str
    due_at: datetime
    title: str = "Call back"
    status: str = REMINDER_OPEN
    entity_type: str = "lead"


@dataclass
class _Recorder:
    """Captures the queries reminder_svc issues, so "one query" is a fact the
    test can assert rather than a claim in a comment."""

    rows: list
    queries: list = field(default_factory=list)

    def find(self, *args, **kwargs):
        self.queries.append(args[0] if args else kwargs)
        rows = self.rows
        recorder = self

        class _Cursor:
            def sort(self, key):
                # Mirror Mongo: +due_at ascending. next_open_by_entity relies on
                # this ordering to make "first hit per entity" mean "soonest".
                recorder.sorted_by = key
                self._rows = sorted(rows, key=lambda r: r.due_at)
                return self

            def __aiter__(self):
                items = getattr(self, "_rows", rows)

                async def gen():
                    for r in items:
                        yield r
                return gen()

        return _Cursor()


@pytest.fixture
def recorder(monkeypatch):
    rec = _Recorder(rows=[])
    monkeypatch.setattr(reminder_svc, "Reminder", rec)
    return rec


# --- One query for a whole page ------------------------------------------------------


def test_a_page_of_leads_costs_one_query(recorder):
    recorder.rows = [
        _Stub("r1", "lead1", NOW + timedelta(days=1)),
        _Stub("r2", "lead2", NOW + timedelta(days=2)),
        _Stub("r3", "lead3", NOW + timedelta(days=3)),
    ]
    ids = [f"lead{i}" for i in range(1, 16)]   # a full 15-row page
    _run(reminder_svc.next_open_by_entity("lead", ids))
    assert len(recorder.queries) == 1


def test_the_query_scopes_to_the_ids_on_screen(recorder):
    """A find() without the $in would drag the whole reminders collection back
    to filter it in Python — fine with 3 leads, ruinous with 30,000."""
    _run(reminder_svc.next_open_by_entity("lead", ["lead1", "lead2"]))
    q = recorder.queries[0]
    assert q["entity_id"] == {"$in": ["lead1", "lead2"]}
    assert q["entity_type"] == "lead"
    assert q["status"] == REMINDER_OPEN


def test_no_leads_means_no_query_at_all(recorder):
    """An empty page must not issue a query matching everything."""
    assert _run(reminder_svc.next_open_by_entity("lead", [])) == {}
    assert recorder.queries == []


def test_it_asks_the_database_to_sort(recorder):
    """Sorting in Python would mean fetching every open reminder for the page's
    leads before knowing which one wins."""
    recorder.rows = [_Stub("r1", "lead1", NOW)]
    _run(reminder_svc.next_open_by_entity("lead", ["lead1"]))
    assert recorder.sorted_by == "+due_at"


# --- The soonest one wins, and the rest are counted -----------------------------------


def test_the_soonest_reminder_is_the_one_reported(recorder):
    recorder.rows = [
        _Stub("far", "lead1", NOW + timedelta(days=21)),
        _Stub("soon", "lead1", NOW + timedelta(hours=2)),
        _Stub("mid", "lead1", NOW + timedelta(days=3)),
    ]
    out = _run(reminder_svc.next_open_by_entity("lead", ["lead1"]))
    reminder, count = out["lead1"]
    assert reminder.id == "soon"
    assert count == 3


def test_a_lead_with_one_reminder_reports_a_count_of_one(recorder):
    recorder.rows = [_Stub("r1", "lead1", NOW + timedelta(days=1))]
    _, count = _run(reminder_svc.next_open_by_entity("lead", ["lead1"]))["lead1"]
    assert count == 1


def test_leads_without_reminders_are_simply_absent(recorder):
    """The caller renders "No reminders" from a missing key. A zero-valued entry
    would make an empty lead look like it had one."""
    recorder.rows = [_Stub("r1", "lead1", NOW)]
    out = _run(reminder_svc.next_open_by_entity("lead", ["lead1", "lead2"]))
    assert "lead1" in out
    assert "lead2" not in out


def test_several_leads_are_kept_apart(recorder):
    recorder.rows = [
        _Stub("a1", "lead1", NOW + timedelta(days=5)),
        _Stub("b1", "lead2", NOW + timedelta(days=1)),
        _Stub("a2", "lead1", NOW + timedelta(days=2)),
    ]
    out = _run(reminder_svc.next_open_by_entity("lead", ["lead1", "lead2"]))
    assert out["lead1"][0].id == "a2"       # soonest for lead1
    assert out["lead1"][1] == 2
    assert out["lead2"][0].id == "b1"
    assert out["lead2"][1] == 1


def test_only_open_reminders_are_asked_for(recorder):
    """A lead whose follow-ups are all done should read "No reminders", not
    show the last completed one."""
    _run(reminder_svc.next_open_by_entity("lead", ["lead1"]))
    assert recorder.queries[0]["status"] == REMINDER_OPEN
    assert recorder.queries[0]["status"] != REMINDER_DONE
