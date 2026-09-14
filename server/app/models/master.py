"""Editable master data — nested policy types (categories) + required documents.

A policy "type" (line of business) is a PolicyCategory. Each type may carry an
OPTIONAL nested tree of sub-types (`children`), up to MAX_SUBCATEGORY_DEPTH levels
deep — e.g. Motor > Car / 2-wheeler > RTO zone > ... A specific policy is booked by
choosing a PATH down this tree (which may stop at any node). Nothing is seeded by
default: every type is added manually by a permission holder.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from beanie import Document, Indexed
from pydantic import BaseModel, Field, field_validator

from app.models.base import utcnow

# Max levels of nested sub-types allowed BELOW a top-level policy type.
MAX_SUBCATEGORY_DEPTH = 5

# Sentinel reward-base meaning "the commissionable premium" (net-of-GST default).
COMMISSIONABLE_BASE = "commissionable"

# The custom-field types an admin can configure on a policy type. `amount` values
# are stored in paise (INR) and can act as the reward base ("Comm On"); every
# other type stores its natural JSON value in the policy's `details` dict.
CUSTOM_FIELD_TYPES = (
    "text", "textarea", "number", "amount", "date", "select", "multi_select",
    "checkbox", "phone", "email", "url",
)


class RequiredDocSpec(BaseModel):
    """A document that should be collected for a policy of this type.

    e.g. Motor -> [RC, Previous Policy, ID Proof]; Health -> [ID Proof, Medical].
    """

    key: str                      # machine key, e.g. "rc_book"
    label: str                    # human label, e.g. "RC (Registration Cert.)"
    required: bool = True
    accepts: list[str] = Field(default_factory=lambda: ["pdf", "jpg", "png"])


class CustomFieldSpec(BaseModel):
    """One admin-configured field prompted when booking a policy of this type.

    Written into the policy's `details` dict under `key`. An `amount` field can be
    flagged `is_reward_base` so it appears in the per-policy "Commission calculated
    on" dropdown (the OD/TP-vs-Net choice from the sample ledger).
    """

    key: str                      # machine key, e.g. "od_amount"
    label: str                    # human label, e.g. "OD Amount"
    type: str = "text"            # one of CUSTOM_FIELD_TYPES
    required: bool = False
    options: list[str] = Field(default_factory=list)   # select / multi_select
    hint: Optional[str] = None
    # Optional numeric bounds for number/amount (in the field's natural unit —
    # rupees for `amount`). None = unbounded.
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    # Only meaningful for `amount`: eligible to be used as the reward base.
    is_reward_base: bool = False

    @field_validator("type")
    @classmethod
    def _known_type(cls, v: str) -> str:
        return v if v in CUSTOM_FIELD_TYPES else "text"


class CategoryNode(BaseModel):
    """One node in a policy type's nested sub-type tree. A node may itself carry
    children, up to MAX_SUBCATEGORY_DEPTH levels deep (e.g. Motor > Car > RTO)."""

    key: str                      # machine key, unique among its siblings
    label: str                    # human label
    active: bool = True
    children: list["CategoryNode"] = Field(default_factory=list)


CategoryNode.model_rebuild()


class PolicyCategory(Document):
    """A policy type (line of business) — editable in-app, with an optional nested
    sub-type tree. No defaults are seeded; every type is added manually."""

    key: Indexed(str, unique=True)   # "motor"
    label: str                       # "Motor"
    description: Optional[str] = None
    # Optional nested sub-types (replaces the old flat `subcategories`).
    children: list[CategoryNode] = Field(default_factory=list)
    # Extra structured fields prompted when creating a policy of this type.
    custom_fields: list[CustomFieldSpec] = Field(default_factory=list)
    required_documents: list[RequiredDocSpec] = Field(default_factory=list)
    # Documents to collect when a CLAIM is raised on this type
    # (motor: FIR, photos, estimate; health: discharge summary,
    # bills). Same spec shape, configured on the same page — owner
    # C3 wanted one mechanism, not two.
    claim_documents: list[RequiredDocSpec] = Field(default_factory=list)
    # Default reward base for policies of this type: COMMISSIONABLE_BASE, or the
    # key of an `amount` custom field flagged `is_reward_base`. Overridable per
    # policy on the booking form.
    reward_base_field: str = COMMISSIONABLE_BASE
    active: bool = True
    sort_order: int = 100

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    @field_validator("custom_fields", mode="before")
    @classmethod
    def _coerce_legacy_fields(cls, v: Any) -> Any:
        """Tolerate the old `list[str]` shape: turn a bare name into a text spec."""
        if isinstance(v, list):
            return [
                {"key": item, "label": item, "type": "text"}
                if isinstance(item, str) else item
                for item in v
            ]
        return v

    class Settings:
        name = "policy_categories"
