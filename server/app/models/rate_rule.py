"""RateRule — the reward rate card under a Broker.

Rewards differ per broker, per insurer company, and per policy-type node. A RateRule
is one row of that card: scoped to one Broker + one policy type, OPTIONALLY narrowed
to a specific insurer company and/or a PATH down that type's nested sub-tree (RTO
zone, vehicle class, ...). It fixes both what the agency earns and what a channel
partner is paid for that scenario.

Matching (see services/rates.py): among a broker's rules for the policy's type, keep
those whose insurer matches (a rule with no insurer_id applies to ANY insurer) and
whose `subcategory_path` is a prefix of the policy's chosen path. The MOST SPECIFIC
survivor wins — an insurer-specific rule beats an insurer-agnostic one, then the
deepest path wins. There is NO other fallback: if nothing matches, the reward stays
whatever was entered on the policy.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import RewardBasis
from app.models.base import utcnow


class RateRule(Document):
    # Which Broker this rate belongs to.
    broker_id: Indexed(str)
    # Optional insurer company this rate is pinned to. None = applies to ANY
    # insurer; a set value beats an insurer-agnostic rule when a policy is booked.
    insurer_id: Optional[str] = None

    category_key: Indexed(str)                 # matches PolicyCategory.key
    # Path of sub-type keys this rate applies to (empty = the whole type). The rate
    # applies to this node and all of its descendants; the deepest matching path
    # wins when a policy is booked.
    subcategory_path: list[str] = Field(default_factory=list)

    # What the AGENCY earns for this scenario. percent stored as percent*100; flat
    # in paise.
    agency_basis: RewardBasis = RewardBasis.PERCENT
    agency_value: int = 0
    # What a CHANNEL PARTNER is paid for this scenario (used only when a partner is
    # attributed to the policy). Set here on the rate card, applied to the
    # commissionable premium (NOT to the agency reward). Never affected by TDS.
    partner_basis: RewardBasis = RewardBasis.PERCENT
    partner_value: int = 0

    label: Optional[str] = None                # friendly name for the rate card
    active: bool = True
    # Optional validity window (UTC). None = open-ended on that side.
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    notes: Optional[str] = None

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "rate_rules"
        indexes = [
            [("broker_id", pymongo.ASCENDING)],
            [("category_key", pymongo.ASCENDING)],
            [
                ("broker_id", pymongo.ASCENDING),
                ("category_key", pymongo.ASCENDING),
            ],
        ]
