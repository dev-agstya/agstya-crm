"""Pure-logic tests for the reward-outcome states and the Reports insights
aggregation helpers."""

from types import SimpleNamespace

from app.core.enums import REWARD_REVERSAL_STATES, PayerType, RewardStatus
from app.services import finance_insights as fi


def test_reversal_states_are_exactly_the_non_payable_outcomes():
    assert REWARD_REVERSAL_STATES == {
        RewardStatus.REJECTED, RewardStatus.NOT_ELIGIBLE,
        RewardStatus.ZERO_PCT, RewardStatus.REFUNDED, RewardStatus.CANCELLED,
    }
    # Payable / owed states must NOT reverse the wallet.
    assert RewardStatus.RECEIVED not in REWARD_REVERSAL_STATES
    assert RewardStatus.PENDING not in REWARD_REVERSAL_STATES


def test_pct_helper():
    assert fi._pct(50, 200) == 25.0
    assert fi._pct(1, 3) == 33.3
    assert fi._pct(5, 0) is None       # no base -> undefined, not a crash


def test_payer_label():
    assert fi._payer_label(PayerType.AGENCY.value) == "Agency paid"
    assert fi._payer_label(PayerType.CHANNEL_PARTNER.value) == "Partner paid"
    assert fi._payer_label(PayerType.CUSTOMER.value) == "Customer paid"


def test_bump_accumulates_snapshot_fields():
    agg = fi._metric()
    pf = SimpleNamespace(gross_premium=100000, agency_reward=12000,
                         partner_share=5000, house_profit=7000)
    fi._bump(agg, pf)
    fi._bump(agg, pf)
    assert agg == {"policies": 2, "premium": 200000, "agency_reward": 24000,
                   "reward": 10000, "profit": 14000}
