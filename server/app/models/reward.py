"""Reward ledger — one record per policy's reward event (formerly "commission").

Amounts are computed and frozen at creation from the policy's commissionable
premium and terms, so later premium edits don't silently change historical
payouts. All money in paise.

  agency_amount = commissionable_premium x insurer_rate  (agency earns from insurer)
  partner_amount = commissionable_premium x partner_rate    (partner's share; only
                  when a partner is attributed to the policy, else 0)
  house_amount  = agency_amount - partner_amount            (agency profit; hidden
                  from partners)
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import RewardStatus
from app.models.base import utcnow


class Reward(Document):
    policy_id: Indexed(str)
    insurer_id: str
    customer_id: str

    # Snapshot for reporting without joins.
    category_key: Optional[str] = None
    subcategory_key: Optional[str] = None
    premium_amount: int = 0                    # paise, gross snapshot
    commissionable_premium: int = 0            # paise, base used for the maths

    agency_amount: int = 0                     # paise earned from insurer
    partner_amount: int = 0                     # paise owed to the partner
    house_amount: int = 0                      # paise agency profit (agency-partner)

    status: RewardStatus = RewardStatus.PENDING
    received_at: Optional[datetime] = None     # when insurer paid the agency
    paid_out_at: Optional[datetime] = None     # when partner share settled
    reference: Optional[str] = None            # payout UTR / note

    # Wallet integration: has the partner share been credited to the partner's
    # wallet, and is it available (vs pending) to withdraw?
    wallet_credited: bool = False
    wallet_available: bool = False

    # --- Scoping ---
    owner_user_id: str                         # booking employee/partner
    partner_id: Optional[str] = None

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "rewards"
        indexes = [
            [("policy_id", pymongo.ASCENDING)],
            [("status", pymongo.ASCENDING)],
            [("partner_id", pymongo.ASCENDING)],
            [("owner_user_id", pymongo.ASCENDING)],
        ]
