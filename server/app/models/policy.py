"""Policy model — the core CRM record tying customer, insurer and reward."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.core.enums import (
    BuyerType,
    PayerType,
    PolicyStatus,
    RewardBasis,
)
from app.models.base import utcnow


class RewardTerms(BaseModel):
    """Reward configuration captured on the policy.

    Two INDEPENDENT rates applied to the commissionable premium (premium net of
    GST):
      agency_* : what the agency receives from the insurer.
      partner_* : what the agency pays the partner (only if a partner is attributed).
    House profit = agency amount - partner amount.
    Values: percent stored as percent*100; flat stored as paise.
    """

    agency_basis: RewardBasis = RewardBasis.PERCENT
    agency_value: int = 0
    partner_basis: RewardBasis = RewardBasis.PERCENT
    partner_value: int = 0


class Policy(Document):
    code: Indexed(str, unique=True)          # POL-... (internal)
    policy_number: Optional[str] = None       # insurer's real policy number

    category_key: Indexed(str)                # matches PolicyCategory.key
    # Chosen path down the type's nested sub-tree (e.g. ["4_wheeler", "zone_a"]).
    # Drives which rate rule applies. May be empty (the top-level type itself).
    subcategory_path: list[str] = Field(default_factory=list)
    # Deepest chosen sub-type key — derived from subcategory_path; kept for display,
    # analytics group-by and the reward ledger.
    subcategory_key: Optional[str] = None
    # The insurer COMPANY (manufacturer) — a tag on the policy, no money role.
    insurer_id: Indexed(str)
    # The Broker this policy was placed through. Drives the reward rate card + TDS
    # and is the finance counterparty for premium + reward.
    broker_id: Optional[str] = None
    customer_id: Indexed(str)

    status: PolicyStatus = PolicyStatus.DRAFT

    # --- Provenance ---
    # Approval was deleted 2026-08-05. It existed only because channel
    # partners could submit policies; they cannot any more (they raise a quote
    # request instead), so every policy is written by staff and is a policy the
    # moment it is saved. A `pending` state nothing can produce is a state that
    # only ever confuses a filter.
    #
    # The enquiry this policy came from, when it came from one.
    quote_request_id: Optional[str] = None

    # --- Money (all INR, stored in paise) ---
    premium_amount: int = 0                   # paise, gross (incl. GST)
    commissionable_premium: int = 0           # paise, net of GST — reward base
    gst_percent: int = 1800                   # GST used, percent*100 (18% -> 1800)
    sum_insured: int = 0                      # paise

    # --- Dates (UTC) ---
    issue_date: Optional[datetime] = None
    start_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None    # drives renewal/expiry reports
    renewed_from_policy_id: Optional[str] = None
    reminders_sent: list[int] = Field(default_factory=list)

    # --- Reward ---
    reward: RewardTerms = Field(default_factory=RewardTerms)

    # --- Finance inputs (drive the finance engine; see services/finance) ---
    # Who the policy was sold to. Derived from partner_id but stored for reports.
    buyer_type: BuyerType = BuyerType.DIRECT
    # Who fronts the premium cash to the insurer.
    payer: PayerType = PayerType.AGENCY
    # Optional discount to the customer — ALWAYS borne by the house (agency).
    # percent stored as percent*100 (of gross premium); flat stored in paise.
    discount_basis: RewardBasis = RewardBasis.PERCENT
    discount_value: int = 0

    # --- Category-specific structured data (vehicle_no, sum_assured, ...) ---
    details: dict[str, Any] = Field(default_factory=dict)
    # Which value the reward % is applied to: "commissionable" (net-of-GST premium,
    # the default) or the key of an `amount` custom field in `details` (e.g. an
    # "OD Amount" — the ledger's "Comm On OD" case).
    reward_base_field: str = "commissionable"

    # --- Ownership / scoping ---
    owner_user_id: str                        # employee/partner who booked it
    partner_id: Optional[str] = None  # partner credited, if any
    # The RELATIONSHIP MANAGER this policy is credited to, AT THE TIME OF
    # BOOKING, frozen (owner 2026-08-05, replaces the old team stamp).
    #
    #   partner-sourced -> the channel partner's relationship manager
    #   in-house sale   -> the employee who booked it
    #
    # Frozen for the same reason the team stamp was: reassigning a partner to
    # another manager must not rewrite the history of what their old manager
    # brought in, or the person who did the work loses the credit in every
    # report. Attribution only — it never restricts visibility. Which SIDE of a
    # manager's number a policy falls on (their partners' business vs their own)
    # is derived from `partner_id` at roll-up time, so it needs no field.
    manager_id: Optional[str] = None
    manager_name: Optional[str] = None

    notes: Optional[str] = None

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "policies"
        indexes = [
            [("status", pymongo.ASCENDING)],
            [("quote_request_id", pymongo.ASCENDING)],
            [("expiry_date", pymongo.ASCENDING)],
            [("owner_user_id", pymongo.ASCENDING)],
            [("partner_id", pymongo.ASCENDING)],
            [("customer_id", pymongo.ASCENDING)],
            # Relationship-manager roll-ups (People -> Relationship Managers).
            [("manager_id", pymongo.ASCENDING)],
            # Default list sort is -created_at; index it so large lists don't hit
            # M0's 32MB in-memory sort limit.
            [("created_at", pymongo.DESCENDING)],
            # Policy numbers are globally unique. The router checks first, but a
            # check-then-insert is not a guarantee: two concurrent creates both
            # see "free" and both write. The DB is the only place that can
            # actually enforce it. Partial + case-insensitive so blank numbers
            # (allowed) don't collide with each other and "AB/1" == "ab/1".
            pymongo.IndexModel(
                [("policy_number", pymongo.ASCENDING)],
                name="policy_number_unique",
                unique=True,
                # NOTE: a partial filter may only use $exists/$eq/$gt/$gte/
                # $lt/$lte/$type/$and/$or/$in. "$ne": "" looks natural but
                # compiles to $not, which Mongo rejects outright — the index
                # then fails to build on EVERY startup, and db.py's fallback
                # quietly re-inits with skip_indexes=True, so no index on any
                # model gets created. For strings, "$gt": "" means exactly
                # "non-empty" and is allowed.
                partialFilterExpression={
                    "policy_number": {"$exists": True, "$type": "string",
                                      "$gt": ""}},
                collation=pymongo.collation.Collation(
                    locale="en", strength=2),
            ),
        ]
