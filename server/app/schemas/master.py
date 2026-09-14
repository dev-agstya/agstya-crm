"""Policy-type (category) master schemas."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from app.models.master import (
    COMMISSIONABLE_BASE,
    CategoryNode,
    CustomFieldSpec,
    RequiredDocSpec,
)


class PolicyCategoryCreate(BaseModel):
    key: str = Field(min_length=2, max_length=40, pattern="^[a-z0-9_]+$")
    label: str
    description: Optional[str] = None
    children: list[CategoryNode] = Field(default_factory=list)
    custom_fields: list[CustomFieldSpec] = Field(default_factory=list)
    required_documents: list[RequiredDocSpec] = Field(default_factory=list)
    # Documents asked for when a CLAIM is raised on this type. Same spec shape
    # as the booking documents above and configured on the same page (owner C3
    # wanted one mechanism, not two).
    claim_documents: list[RequiredDocSpec] = Field(default_factory=list)
    reward_base_field: str = COMMISSIONABLE_BASE
    sort_order: int = 100


class PolicyCategoryUpdate(BaseModel):
    label: Optional[str] = None
    description: Optional[str] = None
    children: Optional[list[CategoryNode]] = None
    custom_fields: Optional[list[CustomFieldSpec]] = None
    required_documents: Optional[list[RequiredDocSpec]] = None
    claim_documents: Optional[list[RequiredDocSpec]] = None
    reward_base_field: Optional[str] = None
    active: Optional[bool] = None
    sort_order: Optional[int] = None


class PolicyCategoryOut(BaseModel):
    id: str
    key: str
    label: str
    description: Optional[str] = None
    children: list[CategoryNode] = Field(default_factory=list)
    custom_fields: list[CustomFieldSpec]
    required_documents: list[RequiredDocSpec]
    claim_documents: list[RequiredDocSpec] = Field(default_factory=list)
    reward_base_field: str = COMMISSIONABLE_BASE
    active: bool
    sort_order: int
    # True when a policy or rate-card rule names this type. Policies are
    # referenced by KEY, so a deleted type leaves them pointing at nothing —
    # the delete is refused and deactivating is the answer.
    in_use: bool = True

    @classmethod
    def from_model(cls, c, *, in_use: bool = True) -> "PolicyCategoryOut":
        return cls(
            id=str(c.id),
            in_use=in_use,
            key=c.key,
            label=c.label,
            description=c.description,
            children=getattr(c, "children", []),
            custom_fields=c.custom_fields,
            required_documents=c.required_documents,
            claim_documents=getattr(c, "claim_documents", []),
            reward_base_field=getattr(c, "reward_base_field", COMMISSIONABLE_BASE),
            active=c.active,
            sort_order=c.sort_order,
        )
