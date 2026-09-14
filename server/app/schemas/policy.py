"""Policy schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field

from app.core.enums import (
    BuyerType,
    PayerType,
    PolicyStatus,
    RewardBasis,
)
from app.models.policy import RewardTerms


class PolicyCreate(BaseModel):
    # The insurer's real policy number — required and globally unique.
    policy_number: str = Field(min_length=1)
    category_key: str
    # Chosen path down the type's nested sub-tree (may be empty).
    subcategory_path: list[str] = Field(default_factory=list)
    insurer_id: str
    broker_id: Optional[str] = None   # the Broker this was placed through
    customer_id: str
    status: PolicyStatus = PolicyStatus.DRAFT
    premium_amount: int = Field(default=0, ge=0)          # paise, gross
    # If 0/omitted the server derives it from premium net of GST.
    commissionable_premium: int = Field(default=0, ge=0)  # paise, reward base
    gst_percent: int = Field(default=1800, ge=0)          # percent*100
    sum_insured: int = Field(default=0, ge=0)             # paise
    issue_date: Optional[datetime] = None
    start_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    # If omitted, reward terms are derived from the insurer slab / partner default.
    reward: Optional[RewardTerms] = None
    details: dict[str, Any] = Field(default_factory=dict)
    # Which value the reward % applies to: "commissionable" or an amount field key.
    reward_base_field: str = "commissionable"
    # In-house users can book on behalf of a partner (credits the partner's wallet).
    partner_id: Optional[str] = None
    # In-house users may book for another owner.
    owner_user_id: Optional[str] = None
    # --- Finance inputs ---
    payer: PayerType = PayerType.AGENCY
    discount_basis: RewardBasis = RewardBasis.PERCENT
    discount_value: int = Field(default=0, ge=0)
    notes: Optional[str] = None


class PolicyUpdate(BaseModel):
    policy_number: Optional[str] = None
    subcategory_path: Optional[list[str]] = None
    broker_id: Optional[str] = None
    premium_amount: Optional[int] = Field(default=None, ge=0)
    commissionable_premium: Optional[int] = Field(default=None, ge=0)
    gst_percent: Optional[int] = Field(default=None, ge=0)
    sum_insured: Optional[int] = Field(default=None, ge=0)
    issue_date: Optional[datetime] = None
    start_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    reward: Optional[RewardTerms] = None
    details: Optional[dict[str, Any]] = None
    reward_base_field: Optional[str] = None
    partner_id: Optional[str] = None
    payer: Optional[PayerType] = None
    discount_basis: Optional[RewardBasis] = None
    discount_value: Optional[int] = Field(default=None, ge=0)
    notes: Optional[str] = None


class PolicyStatusUpdate(BaseModel):
    status: PolicyStatus
    reason: Optional[str] = None




class PolicyRenew(BaseModel):
    """Create a renewal policy carried over from an existing one."""

    premium_amount: int = Field(ge=0)
    commissionable_premium: int = Field(default=0, ge=0)
    start_date: datetime
    expiry_date: datetime
    policy_number: Optional[str] = None
    reward: Optional[RewardTerms] = None
    # Type-specific custom fields for the new term. None = carry the old policy's
    # values unchanged; a dict re-collects them (validated against the type).
    details: Optional[dict] = None
    reward_base_field: Optional[str] = None
    # Carry the expiring policy's SUPPORTING documents onto the new term — the
    # RC book, the KYC, last year's previous-policy copy. Never the policy PDF:
    # that one is specific to the term it covers, and copying it forward would
    # put the wrong document in the customer's hands.
    #
    # Opt-in rather than automatic: a renewal is often the moment a document
    # legitimately CHANGES (a re-KYC, a new RC after a transfer), and silently
    # bringing a stale copy across would look like it had been checked.
    copy_documents: bool = False


class PolicyOut(BaseModel):
    id: str
    code: str
    policy_number: Optional[str] = None
    category_key: str
    subcategory_path: list[str] = Field(default_factory=list)
    subcategory_key: Optional[str] = None
    insurer_id: str
    insurer_name: Optional[str] = None
    broker_id: Optional[str] = None
    broker_name: Optional[str] = None
    broker_code: Optional[str] = None       # broker's short code, shown on policy
    customer_id: str
    customer_name: Optional[str] = None
    status: str
    quote_request_id: Optional[str] = None
    premium_amount: int
    commissionable_premium: int
    gst_percent: int
    sum_insured: int
    issue_date: Optional[datetime] = None
    start_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    reward: RewardTerms
    details: dict[str, Any]
    reward_base_field: str = "commissionable"
    owner_user_id: str
    partner_id: Optional[str] = None
    partner_name: Optional[str] = None
    buyer_type: BuyerType = BuyerType.DIRECT
    payer: PayerType = PayerType.AGENCY
    discount_basis: RewardBasis = RewardBasis.PERCENT
    discount_value: int = 0
    notes: Optional[str] = None
    # Per-policy reward outcome (from the Reward ledger). Drives partner payout.
    reward_status: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, p, *, customer_name: Optional[str] = None,
                   insurer_name: Optional[str] = None,
                   broker_name: Optional[str] = None,
                   broker_code: Optional[str] = None,
                   partner_name: Optional[str] = None,
                   reward_status: Optional[str] = None,
                   hide_agency: bool = False) -> "PolicyOut":
        data = p.model_dump()
        data["id"] = str(p.id)
        data["reward_status"] = reward_status
        data["status"] = p.status.value if hasattr(p.status, "value") else p.status
        data["customer_name"] = customer_name
        data["insurer_name"] = insurer_name
        data["broker_name"] = broker_name
        data["broker_code"] = broker_code
        data["partner_name"] = partner_name
        if hide_agency:
            # Channel partners never see the agency's insurer rate (the house
            # spread is derivable from it), only their own share.
            data["reward"] = {**data["reward"],
                              "agency_basis": RewardBasis.PERCENT,
                              "agency_value": 0}
        return cls(**data)
