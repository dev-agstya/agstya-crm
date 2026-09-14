"""Custom role (permission bundle) schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class RoleCreate(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    description: Optional[str] = None
    permissions: list[str] = Field(default_factory=list)


class RoleUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=60)
    description: Optional[str] = None
    permissions: Optional[list[str]] = None
    active: Optional[bool] = None


class RoleOut(BaseModel):
    id: str
    key: str
    name: str
    description: Optional[str] = None
    permissions: list[str]
    is_system: bool
    active: bool
    member_count: int = 0
    created_at: datetime

    @classmethod
    def from_model(cls, r, member_count: int = 0) -> "RoleOut":
        return cls(
            id=str(r.id),
            key=r.key,
            name=r.name,
            description=r.description,
            permissions=r.permissions,
            is_system=r.is_system,
            active=r.active,
            member_count=member_count,
            created_at=r.created_at,
        )
