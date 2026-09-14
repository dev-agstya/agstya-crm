"""Channel Partner virtual wallet: balance, ledger transactions, and withdrawal requests.

Money flow:
  - When a partner's policy is approved, their reward is credited to the wallet as
    PENDING. When the agency marks the reward RECEIVED (insurer paid), it moves to
    AVAILABLE (see services.wallet).
  - A partner requests a withdrawal (<= available). The team approves/rejects and
    marks it paid (manual bank transfer, UTR recorded). Balances update on each
    transition and every change writes a WalletTxn ledger row.

All amounts are integer paise.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import WalletTxnType, WithdrawalStatus
from app.models.base import utcnow
from app.models.user import BankDetails


class Wallet(Document):
    partner_id: Indexed(str, unique=True)
    available_paise: int = 0      # withdrawable now
    pending_paise: int = 0        # earned but not yet received from insurer
    # Lifetime totals for reporting.
    lifetime_earned_paise: int = 0
    lifetime_withdrawn_paise: int = 0

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "wallets"


class WalletTxn(Document):
    partner_id: Indexed(str)
    type: WalletTxnType
    # Signed amount in paise: positive credits available, negative debits it.
    # (Pending->available moves are recorded as informational rows with
    # affects_available flags handled by the service.)
    amount_paise: int = 0
    balance_after_paise: int = 0   # available balance snapshot after this txn
    note: Optional[str] = None
    ref_type: Optional[str] = None  # "reward" | "withdrawal" | "settlement" | "manual"
    ref_id: Optional[str] = None
    # Settlement debits record which buckets the amount was drawn from, so a
    # settlement REVERSAL can restore available/pending exactly.
    from_available_paise: Optional[int] = None
    from_pending_paise: Optional[int] = None
    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "wallet_txns"
        indexes = [
            [("partner_id", pymongo.ASCENDING)],
            [("created_at", pymongo.DESCENDING)],
        ]


class WithdrawalRequest(Document):
    code: Indexed(str, unique=True)            # WDL-...
    partner_id: Indexed(str)
    amount_paise: int
    status: WithdrawalStatus = WithdrawalStatus.REQUESTED

    # Snapshot of the payout destination at request time.
    bank_snapshot: Optional[BankDetails] = None
    note: Optional[str] = None                 # partner's note

    # Processing.
    processed_by: Optional[str] = None
    processed_at: Optional[datetime] = None
    reference: Optional[str] = None            # UTR / transfer reference
    reject_reason: Optional[str] = None

    requested_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "withdrawal_requests"
        indexes = [
            [("partner_id", pymongo.ASCENDING)],
            [("status", pymongo.ASCENDING)],
            [("requested_at", pymongo.DESCENDING)],
        ]
