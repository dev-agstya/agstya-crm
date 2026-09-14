"""Editable "Role" master data — permission bundles the Owner assigns to staff.

A Role is what makes access configurable without code changes. Each EMPLOYEE
account is assigned exactly one Role (its permissions can still be fine-tuned per
user via User.extra_permissions). Owner and Channel Partner accounts do NOT use Roles —
their permissions are fixed by account type.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from beanie import Document, Indexed
from pydantic import Field

from app.models.base import utcnow


class Role(Document):
    key: Indexed(str, unique=True)             # slug, e.g. "sales_executive"
    name: str                                  # human label, e.g. "Sales Executive"
    description: Optional[str] = None
    permissions: list[str] = Field(default_factory=list)
    # is_system roles are protected from deletion (none are seeded as system by
    # default, but the flag lets us lock critical roles later).
    is_system: bool = False
    active: bool = True

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "roles"
