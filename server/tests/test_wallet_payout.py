"""Pure-logic tests for agency-initiated reward payouts (no DB).

Payouts draw from a partner's AVAILABLE reward first, then PENDING (approved but
not yet received from the insurer), matching the owner's rule that a reward is
"due to pay" as soon as the policy is approved.
"""

from app.services.wallet import payout_split


def test_payout_within_available_only():
    # 500 available, 300 pending; pay 200 -> all from available.
    assert payout_split(500, 300, 200) == (200, 0)


def test_payout_exactly_available():
    assert payout_split(500, 300, 500) == (500, 0)


def test_payout_spills_into_pending():
    # Pay 700 with 500 available -> 500 available + 200 pending.
    assert payout_split(500, 300, 700) == (500, 200)


def test_payout_full_owed():
    assert payout_split(500, 300, 800) == (500, 300)


def test_payout_from_pending_when_no_available():
    assert payout_split(0, 300, 250) == (0, 250)


def test_payout_zero():
    assert payout_split(500, 300, 0) == (0, 0)


def test_excess_is_clamped_to_balances():
    # Caller validates amount <= owed; if not, split never exceeds balances.
    assert payout_split(500, 300, 1000) == (500, 300)


def test_negative_balances_treated_as_zero():
    assert payout_split(-100, -50, 100) == (0, 0)


# --- Overpay-as-advance (owner 2026-07: overpaying a partner is allowed) ------
def _advance_for(amount: int, available: int, pending: int) -> int:
    """Mirror of the router's split: whatever the wallet can't cover is booked
    as a PARTNER_ADVANCE the partner owes back."""
    from_reward = min(amount, max(0, available + pending))
    return amount - from_reward


def test_overpay_books_the_excess_as_advance():
    # Owe ₹100 reward, pay ₹200 -> ₹100 from the wallet, ₹100 advance.
    assert _advance_for(200_00, 100_00, 0) == 100_00


def test_exact_pay_books_no_advance():
    assert _advance_for(100_00, 100_00, 0) == 0


def test_pure_advance_when_wallet_empty():
    # Nothing owed at all -> the whole payment is an advance.
    assert _advance_for(500_00, 0, 0) == 500_00


# --- Reward-payout ledger mirror (Transactions-page visibility) --------------
def test_partner_payout_is_balance_neutral():
    """The reward-payout row exists only so the payout shows on the Transactions
    page; the reward position is held by the wallet, so this row must NEVER move
    the partner's premium party-ledger balance (else it double-counts)."""
    from app.core.enums import LedgerTxnType
    from app.services.finance import BALANCE_NEUTRAL_LEDGER_TYPES

    assert LedgerTxnType.PARTNER_PAYOUT in BALANCE_NEUTRAL_LEDGER_TYPES
