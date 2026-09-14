"""Claims — an incident on a policy, tracked from intimation to settlement.

The stage list below is the general Indian general-insurance claim path, which
is the same shape for motor, health and property even though the paperwork
differs (owner C2: start general, improve later):

  intimation -> registration (insurer gives a claim number) -> documents ->
  survey/assessment -> approval -> settlement

Two facts from IRDAI's turnaround rules shape the model rather than just the
copy, and they are why `surveyor_*` and the ageing clock are first-class:
  * a licensed surveyor must be appointed within 72 hours where the loss is
    material (motor above Rs 50,000; Rs 1,00,000 for non-motor), and
  * the insurer must offer a settlement within 30 days of the survey report.
Those windows are the agency's problem to chase on the customer's behalf, so
the record carries the dates that let a queue sort by "who is waiting".

MONEY: a claim does not touch the ledger (owner C4). The settled amount is
recorded as information — the money moves between the insurer and the customer,
and the agency is not a party to it. Nothing here books a finance row.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.core.enums import ClaimSettlementMode, ClaimStage
from app.models.base import utcnow


class ClaimEvent(BaseModel):
    """One entry in the claim's timeline. Partner-visible — internal notes live
    on `Claim.internal_notes` and are never serialised to the portal."""

    at: datetime = Field(default_factory=utcnow)
    stage: Optional[str] = None
    by_id: Optional[str] = None
    by_name: Optional[str] = None
    by_side: str = "agency"                    # "agency" | "partner"
    message: Optional[str] = None


class Claim(Document):
    code: Indexed(str, unique=True)            # CLM-...

    # --- What it is against ---
    policy_id: Indexed(str)
    policy_number: Optional[str] = None        # denormalised for lists
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    category_key: Optional[str] = None         # drives the document checklist

    # --- Who raised it ---
    # A partner may raise one on their OWN policies; staff on any (owner C1).
    raised_by_id: Optional[str] = None
    raised_by_name: Optional[str] = None
    raised_by_side: str = "agency"
    # The partner credited on the policy, frozen here so the portal query is a
    # single indexed lookup instead of a join through the policy.
    partner_id: Optional[str] = None

    # --- The incident ---
    incident_at: Optional[datetime] = None
    incident_location: Optional[str] = None
    description: Optional[str] = None
    estimated_loss: int = 0                    # paise, the claimant's estimate

    # --- Insurer side ---
    insurer_claim_no: Optional[str] = None
    settlement_mode: Optional[ClaimSettlementMode] = None
    surveyor_name: Optional[str] = None
    surveyor_contact: Optional[str] = None
    surveyor_appointed_at: Optional[datetime] = None
    filed_at: Optional[datetime] = None         # lodged with the insurer
    approved_amount: int = 0                    # paise
    settled_amount: int = 0                     # paise, information only
    settled_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None

    # --- Where it has got to ---
    stage: ClaimStage = ClaimStage.INTIMATED
    timeline: list[ClaimEvent] = Field(default_factory=list)

    assigned_to_id: Optional[str] = None
    assigned_to_name: Optional[str] = None
    internal_notes: Optional[str] = None        # never leaves the staff side

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "claims"
        indexes = [
            [("partner_id", pymongo.ASCENDING),
             ("created_at", pymongo.DESCENDING)],
            [("policy_id", pymongo.ASCENDING)],
            [("stage", pymongo.ASCENDING)],
            [("created_at", pymongo.DESCENDING)],
        ]
