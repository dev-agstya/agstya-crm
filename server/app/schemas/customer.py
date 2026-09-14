"""Customer schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.models.customer import KYC, Nominee

# A 10-digit Indian mobile number (no country code). Reused across schemas.
MOBILE_FIELD = Field(min_length=10, max_length=10, pattern=r"^\d{10}$")


def _validate_mobile(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    digits = "".join(ch for ch in str(v) if ch.isdigit())
    if len(digits) != 10:
        raise ValueError("Mobile number must be exactly 10 digits.")
    return digits


class CustomerCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    mobile: str = MOBILE_FIELD   # compulsory, unique per agency
    alt_mobile: Optional[str] = None
    kyc: Optional[KYC] = None
    nominees: list[Nominee] = Field(default_factory=list)
    renewal_reminders_enabled: bool = True
    notes: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    partner_id: Optional[str] = None

    @field_validator("mobile", "alt_mobile")
    @classmethod
    def _mobile(cls, v):
        return _validate_mobile(v)


class CustomerUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=160)
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    mobile: Optional[str] = None
    alt_mobile: Optional[str] = None
    kyc: Optional[KYC] = None
    nominees: Optional[list[Nominee]] = None
    renewal_reminders_enabled: Optional[bool] = None
    notes: Optional[str] = None
    tags: Optional[list[str]] = None
    partner_id: Optional[str] = None

    @field_validator("mobile", "alt_mobile")
    @classmethod
    def _mobile(cls, v):
        return _validate_mobile(v)


class CustomerOut(BaseModel):
    id: str
    code: str
    name: str
    contact_person: Optional[str] = None
    email: Optional[str] = None
    mobile: Optional[str] = None
    alt_mobile: Optional[str] = None
    kyc: Optional[KYC] = None
    nominees: list[Nominee] = Field(default_factory=list)
    renewal_reminders_enabled: bool
    notes: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    origin: str = "inhouse"
    owner_user_id: str
    partner_id: Optional[str] = None
    created_by_name: Optional[str] = None
    can_edit: bool = False
    is_archived: bool = False
    # Policy counts for the list view (populated by the list endpoint; 0 elsewhere).
    total_policies: int = 0
    active_policies: int = 0
    # True when a policy or a ledger row names this customer. Such a record is
    # load-bearing for finance and can only be ARCHIVED. Documents and the lead
    # they converted from don't count — those are cleaned up on delete.
    in_use: bool = True
    created_at: datetime

    @classmethod
    def from_model(cls, c, *, can_edit: bool = False,
                   total_policies: int = 0,
                   active_policies: int = 0,
                   in_use: bool = True) -> "CustomerOut":
        data = c.model_dump()
        data["id"] = str(c.id)
        data["in_use"] = in_use
        # Legacy records may still carry a stored `type` / `address` — ignored.
        data.pop("type", None)
        data.pop("address", None)
        data["origin"] = (c.origin.value if hasattr(c.origin, "value")
                          else c.origin)
        data["can_edit"] = can_edit
        data["total_policies"] = total_policies
        data["active_policies"] = active_policies
        return cls(**data)


class CustomerImportFailure(BaseModel):
    row: int
    reason: str


class CustomerImportResult(BaseModel):
    total: int
    created: int
    failed: list[CustomerImportFailure]
    detail: str


class CustomerStats(BaseModel):
    """Aggregated contribution stats shown in the customer detail view."""
    total_policies: int = 0
    active_policies: int = 0
    total_premium: int = 0            # paise
    # Renewal rate % (renewed / (renewed + lapsed/expired)); None when no basis.
    renewal_rate: Optional[float] = None
    # Profit contribution — only populated for viewers with view_agency_profit.
    profit_contribution: Optional[int] = None
    can_view_profit: bool = False
    # How this customer's business was sourced: "Direct", a channel partner's
    # name, "Mixed (Direct + Partner)", or "—" when they hold no policies yet.
    source: str = "—"


class SendResultOut(BaseModel):
    detail: str
    channels: dict = Field(default_factory=dict)
