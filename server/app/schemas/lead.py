"""Lead schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.core.enums import LeadStage, LeadType
from app.models.lead import Lead, LeadComment


def _validate_mobile(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    digits = "".join(ch for ch in str(v) if ch.isdigit())
    if len(digits) != 10:
        raise ValueError("Mobile number must be exactly 10 digits.")
    return digits


class LeadCreate(BaseModel):
    # Mandatory in the UI, defaulted here so an import row that leaves the
    # column blank lands on the overwhelmingly common case rather than failing
    # (owner Q1.3 / Q1.5). `source` is no longer collected (owner 2026-07-17).
    type: LeadType = LeadType.CUSTOMER
    name: str = Field(min_length=2, max_length=160)
    mobile: str = Field(min_length=10, max_length=10)   # compulsory, 10 digits
    email: Optional[str] = None
    address: Optional[str] = None
    interested_in: Optional[str] = Field(default=None, max_length=40)
    category_key: Optional[str] = None
    estimated_premium: Optional[int] = Field(default=None, ge=0)
    source: Optional[str] = None
    note: Optional[str] = None

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v):
        return _validate_mobile(v)


class LeadUpdate(BaseModel):
    type: Optional[LeadType] = None
    name: Optional[str] = Field(default=None, min_length=2, max_length=160)
    mobile: Optional[str] = Field(default=None, min_length=10, max_length=10)
    email: Optional[str] = None
    address: Optional[str] = None
    interested_in: Optional[str] = Field(default=None, max_length=40)
    category_key: Optional[str] = None
    estimated_premium: Optional[int] = Field(default=None, ge=0)
    source: Optional[str] = None
    note: Optional[str] = None

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v):
        return _validate_mobile(v)


class LeadStageUpdate(BaseModel):
    stage: LeadStage
    lost_reason: Optional[str] = None


class LeadCommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=2000)


class LeadReminderSummary(BaseModel):
    """The next open follow-up on a lead, for the Reminders column in the list.

    Only what the cell needs — the full reminder is on the lead's own page.
    `is_overdue` / `is_due_today` come from the server so the list, the bell and
    the digest can never disagree about what "today" means (IST day boundary).
    """

    id: str
    title: str
    due_at: datetime
    is_overdue: bool = False
    is_due_today: bool = False
    # How many open reminders this lead has in total, so the cell can say
    # "+2 more" rather than implying the soonest one is the only one.
    open_count: int = 1


class LeadTypeCount(BaseModel):
    """One tab at the top of the Leads page: its value and how many match."""

    type: str
    count: int


class LeadCounts(BaseModel):
    """Counts behind the type tabs. `total` is the All tab, and it is computed
    from the same filtered query so All never disagrees with the sum of the
    other three."""

    total: int = 0
    by_type: list[LeadTypeCount] = Field(default_factory=list)


class LeadOut(BaseModel):
    id: str
    code: str
    type: str
    name: str
    mobile_country_code: str
    mobile: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    interested_in: Optional[str] = None
    category_key: Optional[str] = None
    estimated_premium: Optional[int] = None
    source: Optional[str] = None
    note: Optional[str] = None
    stage: str
    # Body of the most recent comment (for the list "Comment" column). Respects
    # the same internal-comment hiding as `comments`.
    last_comment: Optional[str] = None
    lost_reason: Optional[str] = None
    converted_customer_id: Optional[str] = None
    converted_policy_id: Optional[str] = None
    comments: list[LeadComment]
    origin: str
    owner_user_id: str
    partner_id: Optional[str] = None
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    # True when the viewer may edit this lead (computed per request).
    can_edit: bool = False
    # The soonest open follow-up, for the list's Reminders column. None means
    # there are none — which the UI says out loud rather than leaving blank.
    next_reminder: Optional[LeadReminderSummary] = None
    created_at: datetime

    @classmethod
    def from_model(cls, lead: Lead, *, hide_internal: bool = False,
                   can_edit: bool = False,
                   next_reminder: Optional[LeadReminderSummary] = None
                   ) -> "LeadOut":
        comments = lead.comments
        if hide_internal:
            comments = [c for c in comments if not c.internal]
        data = lead.model_dump()
        data["id"] = str(lead.id)
        data["type"] = (lead.type.value if hasattr(lead.type, "value")
                        else lead.type)
        data["stage"] = (lead.stage.value if hasattr(lead.stage, "value")
                         else lead.stage)
        data["origin"] = (lead.origin.value if hasattr(lead.origin, "value")
                          else lead.origin)
        data["comments"] = comments
        data["can_edit"] = can_edit
        data["last_comment"] = comments[-1].body if comments else None
        data["next_reminder"] = next_reminder
        return cls(**data)


class LeadImportFailure(BaseModel):
    row: int
    reason: str


class LeadImportResult(BaseModel):
    total: int
    created: int
    failed: list[LeadImportFailure]
    detail: str
