"""Pure-logic tests for the payments-engine changes:
  - realised (cash) net profit = cash in (premium collected + reward received)
    − cash out (premium fronted + payouts + refunds + expenses)
  - reward eligibility zeroes a policy's P&L snapshot
  - the informational broker "reward cancelled" row amount
All money in paise.
"""

from app.core.enums import RewardStatus
from app.services.finance import (
    eligible_snapshot_amounts,
    reward_cancellation_amount,
)
from app.services.finance_profit import net_from_components


# --- Realised net profit -----------------------------------------------------
def test_net_profit_is_cash_in_minus_cash_out():
    # Reward received 20000, refund 5000 — no premium legs, payouts or expenses.
    assert net_from_components(0, 20000, 0, 0, 5000, 0) == 15000


def test_net_profit_subtracts_payouts_and_expenses():
    assert net_from_components(0, 100000, 0, 30000, 0, 25000) == 45000


def test_net_profit_can_go_negative_on_expenses():
    # A month with expenses but little received income runs a loss.
    assert net_from_components(0, 1000, 0, 0, 0, 9000) == -8000


def test_net_profit_drops_when_agency_fronts_premium():
    # Owner's 1.2 rule: fronting ₹11,800 shows as −11,800 until collected …
    assert net_from_components(0, 0, 11800_00, 0, 0, 0) == -11800_00
    # … recovers to 0 once the buyer pays it back …
    assert net_from_components(11800_00, 0, 11800_00, 0, 0, 0) == 0
    # … and goes positive when the broker settles the reward.
    assert net_from_components(11800_00, 1500_00, 11800_00, 0, 0, 0) == 1500_00


# --- Eligibility zeroes the snapshot -----------------------------------------
def test_eligible_reward_keeps_amounts():
    assert eligible_snapshot_amounts(
        RewardStatus.PENDING, 727_32, 551_00, 100) == (727_32, 551_00, 100)
    assert eligible_snapshot_amounts(
        RewardStatus.RECEIVED, 5000, 2000, 300) == (5000, 2000, 300)


def test_not_eligible_reward_zeroes_everything():
    for st in (RewardStatus.NOT_ELIGIBLE, RewardStatus.REJECTED,
               RewardStatus.CANCELLED, RewardStatus.REFUNDED,
               RewardStatus.ZERO_PCT):
        assert eligible_snapshot_amounts(st, 5000, 2000, 300) == (0, 0, 0)


# --- Broker "reward cancelled" informational row -----------------------------
def test_cancellation_row_only_when_not_eligible_with_broker():
    # Not eligible + a broker + a reward -> negative informational amount.
    assert reward_cancellation_amount(
        RewardStatus.NOT_ELIGIBLE, "brk1", 5000) == -5000


def test_no_cancellation_row_when_eligible():
    assert reward_cancellation_amount(RewardStatus.PENDING, "brk1", 5000) == 0


def test_no_cancellation_row_without_broker_or_amount():
    assert reward_cancellation_amount(RewardStatus.NOT_ELIGIBLE, None, 5000) == 0
    assert reward_cancellation_amount(RewardStatus.NOT_ELIGIBLE, "brk1", 0) == 0
