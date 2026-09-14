"""Follow-up reminders — "call this lead back on Thursday".

Deliberately a COLLECTION of its own rather than a list embedded on the lead,
the way comments are. Comments are only ever read with their lead; reminders are
read the other way round — "what is due today across every lead" — and that has
to be one indexed query on due_at, not a scan of the whole leads collection.

Built generic (entity_type + entity_id) and switched on for leads first (owner
A2.1): customers and policies are then a UI change, not a migration. It is also
the shape the reserved "Follow-ups & Tasks" page needs, so that page costs
nothing extra later.

Times are stored UTC like everything else; the UI enters and displays IST, and
the daily digest asks "what is due by end of today IST" (services/reminders).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.models.base import utcnow

# What a reminder can hang off. Leads today; the other two are wired in the
# model so enabling them later needs no migration.
# What a reminder can hang off. Built generic on purpose (see the module
# docstring); "channel_partner" was added on 2026-08-19 for the roster's quiet
# flag — a partner flagged "quiet for 61 days" showed an amber row and led
# NOWHERE, so there was no way to record that you had rung them and the same
# partner was flagged again tomorrow with no memory of yesterday.
REMINDER_ENTITIES = ("lead", "customer", "policy", "channel_partner")

# Open = still owed to someone. Everything else is history.
REMINDER_OPEN = "open"
REMINDER_DONE = "done"
REMINDER_CANCELLED = "cancelled"
REMINDER_STATUSES = (REMINDER_OPEN, REMINDER_DONE, REMINDER_CANCELLED)


class Reminder(Document):
    entity_type: str = "lead"
    entity_id: Indexed(str)
    entity_label: Optional[str] = None       # denormalised name for the digest
    entity_code: Optional[str] = None        # AG-LED-000045

    title: str
    note: Optional[str] = None
    due_at: datetime

    # Who owes the follow-up. Defaults to the creator; an owner can set one for
    # someone else (owner A2.3), or for SEVERAL people at once (owner Q3.2).
    #
    # Shared, not copied: one reminder with several names on it, everybody gets
    # the bell and the digest, and the first person to mark it done closes it
    # for everyone. The alternative — a copy per person — was rejected because
    # one real-world task should be one row.
    #
    # Names are denormalised alongside the ids so the list and the digest can
    # say who is on a reminder without loading every user.
    assignee_ids: list[str] = Field(default_factory=list)
    assignee_names: list[str] = Field(default_factory=list)

    status: str = REMINDER_OPEN
    completed_at: Optional[datetime] = None
    # Who closed it. Worth storing now that a reminder is shared: "done" on a
    # task with four names on it is a different fact from "done" on your own.
    completed_by: Optional[str] = None
    completed_by_name: Optional[str] = None

    # Set once the bell has fired, so a reminder is announced exactly once even
    # though the digest keeps listing it until it is done (owner A2.6).
    notified_at: Optional[datetime] = None

    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "reminders"
        indexes = [
            # "What is due for me" — the query the whole feature exists for.
            # Multikey now that a reminder can name several people: Mongo
            # indexes each element, so {"assignee_ids": me} still uses it.
            [("assignee_ids", pymongo.ASCENDING),
             ("status", pymongo.ASCENDING), ("due_at", pymongo.ASCENDING)],
            # The nightly digest sweeps by due date across everyone.
            [("status", pymongo.ASCENDING), ("due_at", pymongo.ASCENDING)],
            # Reminders shown on one lead's timeline.
            [("entity_type", pymongo.ASCENDING), ("entity_id", pymongo.ASCENDING)],
        ]

    @property
    def is_open(self) -> bool:
        return self.status == REMINDER_OPEN

    @property
    def assignees(self) -> list[dict]:
        """[{id, name}] pairs, tolerant of a names list that has fallen out of
        step with the ids (a renamed user, a hand-edited document)."""
        return [
            {"id": uid,
             "name": self.assignee_names[i]
             if i < len(self.assignee_names) else ""}
            for i, uid in enumerate(self.assignee_ids)
        ]

    def is_assigned_to(self, user_id: str) -> bool:
        return user_id in self.assignee_ids
