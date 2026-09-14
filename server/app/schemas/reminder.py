"""Schemas for follow-up reminders."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

# A reminder is a shared task, not a broadcast. Past a handful of names it is a
# team announcement and belongs in email, and the cap also stops one request
# fanning out into hundreds of notification writes.
MAX_ASSIGNEES = 20


class ReminderAssignee(BaseModel):
    id: str
    name: str = ""


class ReminderCreate(BaseModel):
    entity_type: str = "lead"
    entity_id: str
    title: str = Field(min_length=2, max_length=120)
    note: Optional[str] = Field(default=None, max_length=1000)
    due_at: datetime
    # Owner A2.3 / Q3.2: a reminder may be set for other people, and for
    # several at once. Empty means "me" — the router fills in the caller.
    assignee_ids: list[str] = Field(default_factory=list,
                                    max_length=MAX_ASSIGNEES)


class ReminderUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=2, max_length=120)
    note: Optional[str] = Field(default=None, max_length=1000)
    due_at: Optional[datetime] = None
    # Sending this REPLACES the whole list, so removing someone is the same
    # call as adding someone. An omitted field leaves the assignees alone; an
    # explicit empty list is rejected rather than silently orphaning the task.
    assignee_ids: Optional[list[str]] = Field(default=None,
                                              max_length=MAX_ASSIGNEES)
    status: Optional[str] = None


class ReminderOut(BaseModel):
    id: str
    entity_type: str
    entity_id: str
    entity_label: Optional[str] = None
    entity_code: Optional[str] = None
    title: str
    note: Optional[str] = None
    due_at: datetime
    assignees: list[ReminderAssignee] = Field(default_factory=list)
    assignee_ids: list[str] = Field(default_factory=list)
    status: str
    # Derived, so every screen agrees on what "overdue" means (IST day boundary)
    # instead of each one re-implementing the comparison in the browser.
    is_overdue: bool = False
    is_due_today: bool = False
    completed_at: Optional[datetime] = None
    completed_by: Optional[str] = None
    completed_by_name: Optional[str] = None
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, r) -> "ReminderOut":
        from app.services import reminder_svc

        data = r.model_dump()
        data["id"] = str(r.id)
        data["assignees"] = r.assignees
        data["is_overdue"] = reminder_svc.is_overdue(r)
        data["is_due_today"] = reminder_svc.is_due_today(r)
        return cls(**data)


class ReminderCounts(BaseModel):
    """What the Leads page badge and the dashboard tile need."""

    open: int = 0
    due_today: int = 0
    overdue: int = 0
