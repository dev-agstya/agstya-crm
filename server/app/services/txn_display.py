"""Simple, human-friendly labels for ledger transactions.

The raw LedgerTxnType values ("premium_collected", "partner_advance", …) are
internal jargon. Staff want plain, direction-aware phrasing on the Transactions
page and in the Excel export, e.g. money arriving from a partner reads
"Received from Channel Partner", money going out to them "Paid to Channel
Partner". One txn type can involve different parties, so the label needs both
the type and the party.

Kept in sync with the frontend `txnLabel()` in web/src/pages/TransactionsPage.tsx.
"""

from __future__ import annotations

from app.core.enums import LedgerTxnType, PartyType


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


_PARTY_WORD = {
    PartyType.CUSTOMER.value: "Customer",
    PartyType.CHANNEL_PARTNER.value: "Channel Partner",
    PartyType.BROKER.value: "Broker",
    PartyType.EXPENSE.value: "House",
}


def ledger_label(txn_type, party_type) -> str:
    """Plain label for one ledger row, from its type + counterparty."""
    t = _v(txn_type)
    p = _v(party_type)
    party = _PARTY_WORD.get(p, "Party")

    if t == LedgerTxnType.PREMIUM_DUE.value:
        return "Premium Due"
    if t in (LedgerTxnType.PREMIUM_TO_INSURER.value,
             LedgerTxnType.PREMIUM_PAID_BY_AGENCY.value):
        return "Policy Premium Paid"
    if t == LedgerTxnType.PREMIUM_COLLECTED.value:
        return f"Received from {party}"
    if t == LedgerTxnType.REWARD_RECEIVED.value:
        return "Broker Reward Received"
    if t == LedgerTxnType.REWARD_CANCELLED.value:
        return "Broker Reward Cancelled"
    if t == LedgerTxnType.TDS_DEDUCTED.value:
        return "TDS Deducted"
    if t in (LedgerTxnType.PARTNER_PAYOUT.value,
             LedgerTxnType.PARTNER_ADVANCE.value):
        return "Paid to Channel Partner"
    if t == LedgerTxnType.REFUND.value:
        return f"Paid to {party}"
    if t == LedgerTxnType.DISCOUNT.value:
        return "Discount"
    if t == LedgerTxnType.ADJUSTMENT.value:
        return "Adjustment"
    if t == LedgerTxnType.EXPENSE.value:
        return "Expense"
    return t.replace("_", " ").title()


def _is_partner_payout_part(txn) -> bool:
    return (_v(txn.party_type) == PartyType.CHANNEL_PARTNER.value
            and _v(txn.txn_type) in (LedgerTxnType.PARTNER_PAYOUT.value,
                                     LedgerTxnType.PARTNER_ADVANCE.value))


def merge_partner_payouts(items):
    """Collapse the two ledger rows a single partner payout creates (a wallet
    ``partner_payout`` + an over-balance ``partner_advance``) into ONE logical
    "Paid to Channel Partner" entry, so the Transactions list/export shows one
    simple line instead of two.

    Input is a list of LedgerTxn ordered newest-first (as the queries return
    them); the pair is created in one request so its two rows sit adjacent.
    Yields ``(representative_txn, cash_out_paise)`` where ``cash_out_paise`` is
    the NEGATIVE total cash paid (so outflow tone/sign is preserved). Rows that
    aren't part of such a pair pass through with their own signed amount.
    """
    out: list[tuple] = []
    i = 0
    n = len(items)
    while i < n:
        a = items[i]
        b = items[i + 1] if i + 1 < n else None
        if (b is not None and _is_partner_payout_part(a)
                and _is_partner_payout_part(b)
                and a.party_id == b.party_id
                and _v(a.txn_type) != _v(b.txn_type)):
            total = abs(a.amount_paise) + abs(b.amount_paise)
            out.append((a, -total))
            i += 2
            continue
        out.append((a, a.amount_paise))
        i += 1
    return out

