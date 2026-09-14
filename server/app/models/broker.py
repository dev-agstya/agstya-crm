"""Broker — a brokerage/aggregator the agency places business THROUGH.

A broker (e.g. "PolicyBazaar", "Cars24", "PolicyBoss") is who the agency actually
holds an account with and earns commission from. It is NOT nested under an insurer:
the same broker can offer policies for many insurer companies. Each broker owns:

  * its reward RATE CARD (see RateRule), set per policy type / insurer / sub-type;
  * a TDS % the broker withholds when it settles our reward (see services.finance);
  * our login / account reference on that broker's portal.

Money flows through the broker — both the premium we owe and the reward we earn are
tracked against the broker as the finance counterparty (PartyType.BROKER). The
insurer company is only a tag on the policy.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from beanie import Document, Indexed
from pydantic import Field

from app.models.base import utcnow


class Broker(Document):
    code: Indexed(str, unique=True)          # system id, e.g. BRK-AA00001
    # Human short code shown on policies (e.g. "PB"). Unique across brokers.
    short_code: Indexed(str, unique=True)
    name: Indexed(str, unique=True)          # "PolicyBazaar"

    # TDS the broker withholds on our reward when it pays us, percent*100
    # (2% -> 200). Deducted at reward-receipt and tracked separately (TdsEntry).
    tds_percent: int = 0

    # Our account / login reference on this broker's portal (never a password).
    account_login: Optional[str] = None
    reg_mobile: Optional[str] = None         # registered mobile number (10 digits)

    active: bool = True
    notes: Optional[str] = None

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "brokers"
