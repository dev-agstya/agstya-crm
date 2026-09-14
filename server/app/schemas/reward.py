"""Reward schemas (formerly commission)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.core.enums import RewardStatus


class RewardStatusUpdate(BaseModel):
    status: RewardStatus
    reference: Optional[str] = None


class RewardOut(BaseModel):
    id: str
    policy_id: str
    policy_code: Optional[str] = None    # resolved for display
    insurer_id: str
    customer_id: str
    customer_name: Optional[str] = None  # resolved for display
    category_key: Optional[str] = None
    subcategory_key: Optional[str] = None
    premium_amount: int
    commissionable_premium: int
    # agency_amount is hidden from channel partners (their own share is theirs
    # to see; the agency's insurer rate is not).
    agency_amount: Optional[int] = None
    partner_amount: int
    # house_amount is included only for users allowed to see agency profit; the
    # router strips it otherwise.
    house_amount: Optional[int] = None
    status: str
    received_at: Optional[datetime] = None
    paid_out_at: Optional[datetime] = None
    reference: Optional[str] = None
    owner_user_id: str
    partner_id: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, r, include_house: bool = False,
                   include_agency: bool = True,
                   policy_code: Optional[str] = None,
                   customer_name: Optional[str] = None) -> "RewardOut":
        return cls(
            id=str(r.id),
            policy_id=r.policy_id,
            policy_code=policy_code,
            insurer_id=r.insurer_id,
            customer_id=r.customer_id,
            customer_name=customer_name,
            category_key=r.category_key,
            subcategory_key=r.subcategory_key,
            premium_amount=r.premium_amount,
            commissionable_premium=r.commissionable_premium,
            agency_amount=r.agency_amount if include_agency else None,
            partner_amount=r.partner_amount,
            house_amount=r.house_amount if include_house else None,
            status=r.status.value if hasattr(r.status, "value") else r.status,
            received_at=r.received_at,
            paid_out_at=r.paid_out_at,
            reference=r.reference,
            owner_user_id=r.owner_user_id,
            partner_id=r.partner_id,
            created_at=r.created_at,
        )
