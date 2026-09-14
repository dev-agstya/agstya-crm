"""Schemas for RateRule (the reward rate card under a Broker)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.core.enums import RewardBasis


class RateRuleCreate(BaseModel):
    broker_id: str
    insurer_id: Optional[str] = None   # None = applies to any insurer company
    category_key: str
    subcategory_path: list[str] = Field(default_factory=list)
    agency_basis: RewardBasis = RewardBasis.PERCENT
    agency_value: int = Field(default=0, ge=0)
    partner_basis: RewardBasis = RewardBasis.PERCENT
    partner_value: int = Field(default=0, ge=0)
    label: Optional[str] = None
    active: bool = True
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    notes: Optional[str] = None


class RateRuleUpdate(BaseModel):
    insurer_id: Optional[str] = None
    subcategory_path: Optional[list[str]] = None
    agency_basis: Optional[RewardBasis] = None
    agency_value: Optional[int] = Field(default=None, ge=0)
    partner_basis: Optional[RewardBasis] = None
    partner_value: Optional[int] = Field(default=None, ge=0)
    label: Optional[str] = None
    active: Optional[bool] = None
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    notes: Optional[str] = None


class RateRuleOut(BaseModel):
    id: str
    broker_id: str
    insurer_id: Optional[str] = None
    category_key: str
    subcategory_path: list[str] = Field(default_factory=list)
    agency_basis: RewardBasis = RewardBasis.PERCENT
    agency_value: int = 0
    partner_basis: RewardBasis = RewardBasis.PERCENT
    partner_value: int = 0
    label: Optional[str] = None
    active: bool = True
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, r) -> "RateRuleOut":
        data = r.model_dump()
        data["id"] = str(r.id)
        return cls(**data)


class RatePreview(BaseModel):
    """The reward terms the engine would apply to a given scenario."""

    source: str        # "rate_rule" | "none"
    rule_id: Optional[str] = None
    label: Optional[str] = None
    agency_basis: RewardBasis = RewardBasis.PERCENT
    agency_value: int = 0
    partner_basis: RewardBasis = RewardBasis.PERCENT
    partner_value: int = 0
