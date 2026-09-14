"""Plain-language ledger labels + the single-row partner-payout merge
(owner 2026-07-18)."""

from types import SimpleNamespace

from app.core.enums import LedgerTxnType, PartyType
from app.services.txn_display import ledger_label, merge_partner_payouts


def _row(txn_type: str, party_type: str, party_id: str, amount: int):
    return SimpleNamespace(txn_type=txn_type, party_type=party_type,
                           party_id=party_id, amount_paise=amount)


def test_labels_are_party_and_direction_aware():
    assert ledger_label(LedgerTxnType.PREMIUM_COLLECTED,
                        PartyType.CUSTOMER) == "Received from Customer"
    assert ledger_label(LedgerTxnType.PREMIUM_COLLECTED,
                        PartyType.CHANNEL_PARTNER) \
        == "Received from Channel Partner"
    assert ledger_label(LedgerTxnType.REFUND,
                        PartyType.BROKER) == "Paid to Broker"
    assert ledger_label(LedgerTxnType.REFUND,
                        PartyType.CUSTOMER) == "Paid to Customer"


def test_premium_paid_labels_collapse():
    for t in (LedgerTxnType.PREMIUM_TO_INSURER,
              LedgerTxnType.PREMIUM_PAID_BY_AGENCY):
        assert ledger_label(t, PartyType.BROKER) == "Policy Premium Paid"


def test_broker_reward_and_partner_payout_labels():
    assert ledger_label(LedgerTxnType.REWARD_RECEIVED,
                        PartyType.BROKER) == "Broker Reward Received"
    assert ledger_label(LedgerTxnType.REWARD_CANCELLED,
                        PartyType.BROKER) == "Broker Reward Cancelled"
    for t in (LedgerTxnType.PARTNER_PAYOUT, LedgerTxnType.PARTNER_ADVANCE):
        assert ledger_label(t, PartyType.CHANNEL_PARTNER) \
            == "Paid to Channel Partner"


def test_labels_accept_raw_strings():
    assert ledger_label("premium_collected", "customer") \
        == "Received from Customer"


def test_merge_collapses_payout_plus_advance():
    # Rows arrive newest-first: advance (later) then payout (earlier).
    advance = _row("partner_advance", "channel_partner", "p1", 30000)
    payout = _row("partner_payout", "channel_partner", "p1", -900000)
    merged = merge_partner_payouts([advance, payout])
    assert len(merged) == 1
    row, amount = merged[0]
    # Full cash paid = |payout| + |advance|, negative (outflow).
    assert amount == -(900000 + 30000)
    assert ledger_label(row.txn_type, row.party_type) \
        == "Paid to Channel Partner"


def test_merge_leaves_lone_rows_untouched():
    # A pure advance (no wallet portion) stays a single row with its own sign.
    advance = _row("partner_advance", "channel_partner", "p1", 20000)
    other = _row("premium_collected", "customer", "c1", -500000)
    merged = merge_partner_payouts([advance, other])
    assert [a for _, a in merged] == [20000, -500000]


def test_merge_does_not_join_different_partners():
    a = _row("partner_advance", "channel_partner", "p1", 20000)
    b = _row("partner_payout", "channel_partner", "p2", -50000)
    merged = merge_partner_payouts([a, b])
    assert len(merged) == 2


def test_merge_does_not_join_two_advances():
    a = _row("partner_advance", "channel_partner", "p1", 20000)
    b = _row("partner_advance", "channel_partner", "p1", 30000)
    merged = merge_partner_payouts([a, b])
    assert len(merged) == 2
