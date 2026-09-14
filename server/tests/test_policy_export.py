"""Policies-export helper formatting (owner 2026-07-18): reward %, reward-base
label, and reward-eligibility text."""

from types import SimpleNamespace

from app.core.enums import RewardBasis, RewardStatus
from app.models.master import COMMISSIONABLE_BASE
from app.routers.policies import (
    _eligibility,
    _reward_base_label,
    _reward_pct,
)


def test_percent_reward_shows_percent():
    # Stored as percent*100 -> 1250 == 12.5%.
    assert _reward_pct(RewardBasis.PERCENT, 1250, 1_000_00) == "12.5%"
    assert _reward_pct(RewardBasis.PERCENT, 1000, 0) == "10%"


def test_flat_reward_shown_as_effective_percent():
    # Flat ₹500 (50000 paise) on a ₹1,000 (100000 paise) base -> 50%.
    assert _reward_pct(RewardBasis.FLAT, 50000, 100000) == "50.00%"
    # No base to divide by -> 0%.
    assert _reward_pct(RewardBasis.FLAT, 50000, 0) == "0%"


def test_reward_base_label():
    cat = SimpleNamespace(custom_fields=[
        SimpleNamespace(key="od_amount", label="OD Amount")])
    assert _reward_base_label(COMMISSIONABLE_BASE, cat) \
        == "Commissionable (Net Premium)"
    assert _reward_base_label("od_amount", cat) == "OD Amount"
    # Unknown key falls back to the raw key.
    assert _reward_base_label("mystery", cat) == "mystery"
    assert _reward_base_label("", None) == "Commissionable (Net Premium)"


def test_eligibility():
    assert _eligibility(RewardStatus.RECEIVED.value) == "Eligible"
    assert _eligibility(RewardStatus.PENDING.value) == "Eligible"
    for s in (RewardStatus.NOT_ELIGIBLE, RewardStatus.REJECTED,
              RewardStatus.ZERO_PCT, RewardStatus.REFUNDED,
              RewardStatus.CANCELLED):
        assert _eligibility(s.value) == "Not Eligible"
    assert _eligibility(None) == "—"
