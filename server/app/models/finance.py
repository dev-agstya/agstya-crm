"""Finance-engine documents: the per-policy P&L snapshot, the money ledger, and
per-party running balances.

Design (all money in paise):
  - PolicyFinance is a FROZEN snapshot of a policy's P&L, recomputed on
    edit/approval — stable history, like the Reward snapshot.
  - LedgerTxn records an actual money movement (premium paid to insurer, cash
    collected, reward received, partner payout, discount, adjustment), each tagged
    with the counterparty it concerns.
  - PartyAccount is the running position with one counterparty, DERIVED by summing
    that party's ledger txns. Sign convention:
        balance_paise > 0  -> the party OWES the agency   (receivable / asset)
        balance_paise < 0  -> the agency OWES the party    (payable / liability)

NOTE: the channel-partner REWARD payout keeps using the existing Wallet (unchanged
so nothing breaks); PartyAccount tracks PREMIUM-cash receivables/payables. The two
are complementary statements for a partner.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import (
    LedgerTxnType,
    PartyType,
    PayerType,
    SettlementStatus,
)
from app.models.base import utcnow


class PolicyFinance(Document):
    """Frozen P&L snapshot for one policy (recomputed on edit/approval)."""

    policy_id: Indexed(str, unique=True)
    broker_id: Optional[str] = None
    partner_id: Optional[str] = None
    customer_id: Optional[str] = None

    # Money snapshot.
    gross_premium: int = 0            # paise, incl. GST
    commissionable: int = 0           # paise, reward base
    agency_reward: int = 0            # paise earned from insurer
    partner_share: int = 0            # paise owed to the partner
    discount: int = 0                 # paise, house-borne discount to customer
    house_profit: int = 0             # agency_reward - partner_share - discount

    # Cash routing.
    payer: PayerType = PayerType.AGENCY
    settlement_status: SettlementStatus = SettlementStatus.PENDING
    premium_paid_to_insurer: int = 0  # paise recorded as paid to the insurer
    premium_collected: int = 0        # paise collected from customer/partner

    computed_at: datetime = Field(default_factory=utcnow)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "policy_finance"
        indexes = [
            [("policy_id", pymongo.ASCENDING)],
            [("partner_id", pymongo.ASCENDING)],
            [("settlement_status", pymongo.ASCENDING)],
        ]


class LedgerTxn(Document):
    """One money movement, tagged with the party it concerns."""

    txn_type: LedgerTxnType
    party_type: PartyType
    party_id: Indexed(str)
    policy_id: Optional[str] = None

    # Signed amount from the AGENCY's perspective on this party's balance:
    #   +ve increases what the party owes the agency (receivable),
    #   -ve increases what the agency owes the party (payable).
    amount_paise: int = 0

    note: Optional[str] = None
    reference: Optional[str] = None    # UTR / cheque / txn ref
    occurred_at: datetime = Field(default_factory=utcnow)

    # --- Expense-only fields (txn_type == EXPENSE, party_type == EXPENSE) ---
    expense_category: Optional[str] = None      # sub-category key (see enums)
    paid_to_employee_id: Optional[str] = None   # optional staff link (salary etc.)
    paid_to_name: Optional[str] = None          # free-text payee when no link

    # Optional proof attachment (payment screenshot / receipt PDF) — a
    # DocumentRecord id, available on ANY transaction, not just expenses.
    attachment_doc_id: Optional[str] = None

    # --- Which of OUR accounts the money moved through ---
    # `bank_delta_paise` is the exact signed amount that hit that account
    # (+in / −out), which is NOT always ±amount_paise: a reward receipt credits
    # the bank NET of the TDS the broker withheld. Storing it makes an account's
    # balance a plain sum and auditable row by row. Both are None on accrual-only
    # rows (premium due, reward cancelled, …) — those move no money at all.
    bank_account_id: Optional[str] = None
    bank_delta_paise: Optional[int] = None

    # --- Transfer pairing (txn_type == TRANSFER) ---
    # A transfer between our own accounts is two rows; each points at the other
    # so the pair can be cancelled/deleted together and never half-applied.
    transfer_group_id: Optional[str] = None

    # --- Idempotency ---
    # A client-supplied key, unique per posting. A double-clicked Save or an
    # axios retry sends the SAME key, so the second write is rejected by the
    # unique index and the original row is returned instead of a duplicate
    # payment. Sparse/partial: rows written before this existed have none.
    idempotency_key: Optional[str] = None

    # --- Cancellation pairing ---
    # A cancel posts an equal-and-opposite row OF THE SAME TYPE. These two
    # fields make that pairing explicit so the same row cannot be cancelled
    # twice (which used to post two opposite entries and move the party balance
    # by the full amount in the wrong direction), and so a reversal row is
    # itself not cancellable.
    reversal_of: Optional[str] = None    # set on the reversal -> original id
    reversed_by: Optional[str] = None    # set on the original -> reversal id

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "ledger_txns"
        indexes = [
            [("party_type", pymongo.ASCENDING), ("party_id", pymongo.ASCENDING)],
            [("policy_id", pymongo.ASCENDING)],
            [("created_at", pymongo.DESCENDING)],
            # Overview / aging / dashboard filter by txn_type; the ledger and
            # every cash aggregate filter/sort by occurred_at. Index both so the
            # finance hot paths don't scan the whole collection.
            [("txn_type", pymongo.ASCENDING)],
            [("occurred_at", pymongo.DESCENDING)],
            # Bank statement / balance repair reads by account, newest first.
            [("bank_account_id", pymongo.ASCENDING),
             ("occurred_at", pymongo.DESCENDING)],
            # Idempotency: the unique index IS the guard — two racing requests
            # carrying the same key cannot both insert, whatever the app does.
            # Partial (not sparse) so the millions of legacy rows with no key
            # are outside the index entirely. NOTE "$gt": "" is how Mongo spells
            # "non-empty string" in a partial filter — "$ne" compiles to $not,
            # which it rejects, and a rejected spec silently kills EVERY index
            # in this app (see db.py's skip_indexes fallback).
            pymongo.IndexModel(
                [("idempotency_key", pymongo.ASCENDING)], unique=True,
                name="ledger_idempotency_key",
                partialFilterExpression={
                    "idempotency_key": {"$exists": True, "$type": "string",
                                        "$gt": ""}}),
        ]


class TdsEntry(Document):
    """One TDS (tax-deducted-at-source) event: the tax a broker withheld when it
    settled our reward. Tracked SEPARATELY from house profit — it is really an
    advance tax we later reclaim, so it never reduces the agency's profit. Summed
    per broker and per financial year for the TDS report. All amounts in paise.
    """

    broker_id: Indexed(str)
    policy_id: Optional[str] = None
    ledger_txn_id: Optional[str] = None   # the REWARD_RECEIVED row this pairs with

    gross_reward_paise: int = 0           # reward the broker settled (pre-TDS)
    tds_percent: int = 0                  # broker's TDS %, percent*100 (2% -> 200)
    tds_paise: int = 0                    # tax withheld = gross x tds_percent

    note: Optional[str] = None
    reference: Optional[str] = None
    occurred_at: datetime = Field(default_factory=utcnow)

    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "tds_entries"
        indexes = [
            [("broker_id", pymongo.ASCENDING)],
            [("occurred_at", pymongo.DESCENDING)],
        ]


class PartyAccount(Document):
    """Running money position with one counterparty (derived from LedgerTxns)."""

    party_type: PartyType
    party_id: Indexed(str)
    # Net position: > 0 receivable (they owe us), < 0 payable (we owe them).
    balance_paise: int = 0
    # Split totals for statements.
    total_charged_paise: int = 0       # sum of positive (receivable) postings
    total_settled_paise: int = 0       # sum of negative (payment) postings
    last_txn_at: Optional[datetime] = None

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "party_accounts"
        indexes = [
            pymongo.IndexModel(
                [("party_type", pymongo.ASCENDING), ("party_id", pymongo.ASCENDING)],
                unique=True, name="uniq_party"),
        ]
