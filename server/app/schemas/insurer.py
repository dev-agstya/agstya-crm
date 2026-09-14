"""Insurer schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.common import validate_optional_mobile


def _clean_short_name(v):
    """Trim, and treat an empty box as "not set".

    Short name is unique, so "" must not become a value — otherwise the second
    insurer saved with the field left blank collides with the first.
    """
    if v is None:
        return None
    v = str(v).strip()
    return v or None


class InsurerCreate(BaseModel):
    name: str = Field(min_length=2, max_length=140)
    short_name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("short_name")
    @classmethod
    def _short(cls, v):
        return _clean_short_name(v)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v):
        return validate_optional_mobile(v)


class InsurerUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=140)
    short_name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    active: Optional[bool] = None
    notes: Optional[str] = None

    @field_validator("short_name")
    @classmethod
    def _short(cls, v):
        return _clean_short_name(v)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v):
        return validate_optional_mobile(v)


class InsurerOut(BaseModel):
    id: str
    code: str
    name: str
    short_name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    active: bool
    notes: Optional[str] = None
    created_at: datetime
    # True when a policy or rate card points at this insurer. Deleting one that
    # is in use would blank the insurer name on every historic policy, so the
    # UI hides the delete action and the API refuses it (services/references).
    in_use: bool = True

    @classmethod
    def from_model(cls, i, *, in_use: bool = True) -> "InsurerOut":
        data = i.model_dump()
        data["id"] = str(i.id)
        data["in_use"] = in_use
        return cls(**data)


class ShortNameAvailability(BaseModel):
    """Answer to the live "is this short name free?" check the form makes while
    you type — same contract as the broker short code, so the clash is shown in
    the field instead of as an error after Save."""

    short_name: str
    available: bool
