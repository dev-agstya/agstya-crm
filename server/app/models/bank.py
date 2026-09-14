"""The agency's OWN money accounts — bank, cash in hand, UPI float, credit card.

Every real cash movement is tagged with the account it moved through
(``LedgerTxn.bank_account_id``) plus the exact signed amount that hit it
(``LedgerTxn.bank_delta_paise``), so an account's live balance is:

    opening_balance_paise  +  Σ bank_delta_paise of its rows

Why store the delta instead of re-deriving it from the transaction type on every
read: the two are NOT the same number. A broker settling a Rs 10,000 reward with
2% TDS credits Rs 9,800 to the bank while the ledger correctly records Rs 10,000
plus a separate TdsEntry — see services/bank.cash_delta. Storing what actually
hit the account makes the balance auditable row by row, keeps transfers and
manual adjustments honest, and makes the repair function a plain sum.

`balance_paise` is a DERIVED running total kept in step by an atomic $inc on
every posting (services/bank), with recompute_balance() to heal it from the
ledger — the same append-only-truth + healable-cache pattern PartyAccount uses.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import CASH_ASSET_ACCOUNT_TYPES, BankAccountType
from app.models.base import utcnow


class BankAccount(Document):
    # --- Identity ---
    name: Indexed(str, unique=True)          # "HDFC Current", "Cash in hand"
    account_type: BankAccountType = BankAccountType.BANK
    bank_name: Optional[str] = None

    # Account number is stored ENCRYPTED at rest (app.core.crypto, dormant until
    # DATA_ENCRYPTION_KEY is set). `last4` is kept in clear because that is what
    # every screen shows; the full value is only ever unmasked for a caller
    # holding view_sensitive_pii.
    account_number: Optional[str] = None     # encrypted
    account_last4: Optional[str] = None
    ifsc: Optional[str] = None
    upi_id: Optional[str] = None

    # --- Opening position ---
    # What the account held on `opening_as_of`. Transactions dated before that
    # are still linkable but are NOT re-counted — the opening balance already
    # includes them, which is the whole point of stating an "as of" date.
    opening_balance_paise: int = 0
    opening_as_of: datetime = Field(default_factory=utcnow)

    # --- Derived running position (healable; see services/bank) ---
    balance_paise: int = 0                   # opening + Σ bank_delta_paise
    total_in_paise: int = 0
    total_out_paise: int = 0
    last_txn_at: Optional[datetime] = None

    # When somebody last checked this against the real account, and by how much
    # it was out. Reconciliation existed and worked from 2026-08-07 — but
    # nothing ever SAID an account was overdue a check, so the only way to find
    # out that our figure had drifted from the bank's was to go and compare them
    # by hand, which is the job the feature was supposed to prompt. A control
    # nobody is reminded to use is a control that does not get used.
    #
    # Nullable for ever: an account that has never been reconciled is a real and
    # normal state, and it is exactly the state worth surfacing.
    last_reconciled_at: Optional[datetime] = None
    last_reconciled_diff_paise: Optional[int] = None

    # --- State ---
    is_default: bool = False                 # preselected on the money forms
    active: bool = True
    note: Optional[str] = None

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "bank_accounts"
        indexes = [
            [("active", pymongo.ASCENDING)],
            [("is_default", pymongo.DESCENDING)],
        ]

    @property
    def is_cash_asset(self) -> bool:
        """True for money you HOLD. A credit card is money you OWE, so it is
        reported separately and never added into "cash + bank in hand"."""
        return self.account_type in CASH_ASSET_ACCOUNT_TYPES
