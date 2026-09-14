"""Pure-logic tests for the channel-partner balance/statement helpers.

Covers the two subtle rules introduced with the finance overview/balance-sheet
changes: reconstructing reward-owed from the wallet ledger without double
counting the pending->available move, and the partner net-balance sign
convention (positive = we pay him, negative = he pays us)."""

from app.core.enums import WalletTxnType
from app.services.finance_balance import (
    partner_net_balance, wallet_txn_reward_delta,
)


def test_pending_credit_counts_as_reward():
    assert wallet_txn_reward_delta(
        WalletTxnType.REWARD_CREDIT, "Reward pending (policy approved)", 10000
    ) == 10000


def test_available_move_does_not_double_count():
    # The pending->available transition re-emits a +amount credit that is a move,
    # not new reward — it must contribute zero.
    assert wallet_txn_reward_delta(
        WalletTxnType.REWARD_CREDIT, "Reward available (payout received)", 10000
    ) == 0


def test_payout_and_reversal_reduce_reward():
    assert wallet_txn_reward_delta(
        WalletTxnType.WITHDRAWAL_DEBIT, "Reward paid to partner", -4000) == -4000
    assert wallet_txn_reward_delta(
        WalletTxnType.REWARD_REVERSAL, "Reward reversed", -10000) == -10000


def test_reward_owed_reconstruction_end_to_end():
    # Earn 100, move to available (no new reward), pay out 40 -> owe 60.
    rows = [
        (WalletTxnType.REWARD_CREDIT, "Reward pending (policy approved)", 10000),
        (WalletTxnType.REWARD_CREDIT, "Reward available (payout received)", 10000),
        (WalletTxnType.WITHDRAWAL_DEBIT, "Reward paid to partner", -4000),
    ]
    owed = sum(wallet_txn_reward_delta(t, n, a) for t, n, a in rows)
    assert owed == 6000


def test_net_balance_partner_owes_us_is_negative():
    # He owes ₹5,000 premium (balance +5000_00), no reward owed.
    assert partner_net_balance(reward_owed=0, premium_balance=500000) == -500000


def test_net_balance_we_owe_partner_is_positive():
    # We owe ₹400 reward, he owes us nothing.
    assert partner_net_balance(reward_owed=40000, premium_balance=0) == 40000


def test_net_balance_nets_both_sides():
    # We owe 40000 reward, he owes 15000 premium -> net +25000 (we pay him).
    assert partner_net_balance(reward_owed=40000, premium_balance=15000) == 25000
