"""Tests for TDS maths (services.finance.tds_on_reward) and the guarantee that TDS
never touches house profit.

Owner's worked example: commissionable 1000, agency 30% = 300 reward, TDS 2% = 6,
net cash = 294. Partner 20% = 200. House profit = 300 - 200 = 100 (TDS excluded).
Amounts in paise.
"""

from app.core.enums import RewardBasis
from app.services.finance import house_profit, tds_on_reward


def test_tds_owner_example():
    # 300.00 rupees reward = 30000 paise, TDS 2% (stored 200) -> 600 paise = ₹6.
    assert tds_on_reward(30000, 200) == 600


def test_tds_zero_percent_or_zero_reward():
    assert tds_on_reward(30000, 0) == 0
    assert tds_on_reward(0, 200) == 0
    assert tds_on_reward(-5, 200) == 0


def test_tds_rounds_half_to_even_like_discount():
    # 12345 paise * 2% = 246.9 -> rounds to 247.
    assert tds_on_reward(12345, 200) == 247


def test_house_profit_excludes_tds():
    # Profit is agency - partner - discount; TDS is NOT a term here (owner Q7).
    # Agency 300, partner 200, no discount -> 100, regardless of any TDS withheld.
    assert house_profit(30000, 20000, 0) == 10000


def test_five_percent_tds():
    # 5% of ₹5000 (500000 paise) = 25000 paise (₹250), net ₹4750.
    tds = tds_on_reward(500000, 500)
    assert tds == 25000
    assert 500000 - tds == 475000
