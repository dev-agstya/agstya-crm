"""Unit tests for reward math (no DB needed).

The formulas mirror the agency's real reward sheet: rates apply to the
commissionable premium (premium net of GST), the broker cut is only paid when a
broker is attributed, and house profit = agency - broker.
"""

from app.core.enums import RewardBasis
from app.services.money import (
    commissionable_from_premium,
    compute_reward,
    paise_to_rupees,
    percent_to_stored,
    rupees_to_paise,
)


def test_rupee_paise_roundtrip():
    assert rupees_to_paise(12000) == 1_200_000
    assert paise_to_rupees(1_200_000) == 12000.0
    assert percent_to_stored(12.5) == 1250


def test_commissionable_is_net_of_gst():
    # Gross premium ₹2600.72 -> net of 18% GST ≈ ₹2204 (matches the sheet).
    gross = rupees_to_paise(2600.72)
    net = commissionable_from_premium(gross)  # default 18%
    assert paise_to_rupees(net) == 2204.0


def test_reward_matches_sheet_row():
    # Sheet row 1: commissionable 2204, broker 25% -> 551, insurer 33% -> 727.32,
    # house = 727.32 - 551 = 176.32.
    commissionable = rupees_to_paise(2204)
    agency, broker, house = compute_reward(
        commissionable,
        RewardBasis.PERCENT, percent_to_stored(33),   # insurer/agency rate
        RewardBasis.PERCENT, percent_to_stored(25),   # broker rate
        has_partner=True,
    )
    assert paise_to_rupees(agency) == 727.32
    assert paise_to_rupees(broker) == 551.0
    assert paise_to_rupees(house) == 176.32


def test_no_broker_means_whole_agency_is_house():
    # In-house sale (no broker) -> broker cut is 0 even if a broker rate is set.
    commissionable = rupees_to_paise(2204)
    agency, broker, house = compute_reward(
        commissionable,
        RewardBasis.PERCENT, percent_to_stored(33),
        RewardBasis.PERCENT, percent_to_stored(25),
        has_partner=False,
    )
    assert paise_to_rupees(agency) == 727.32
    assert broker == 0
    assert house == agency


def test_flat_agency_reward():
    agency, broker, house = compute_reward(
        1_200_000, RewardBasis.FLAT, 500_000, RewardBasis.PERCENT, 0,
        has_partner=True,
    )
    assert agency == 500_000
    assert broker == 0
    assert house == 500_000


def test_broker_share_capped_to_agency():
    # Broker flat share larger than the agency reward must be capped.
    agency, broker, house = compute_reward(
        1_200_000, RewardBasis.PERCENT, percent_to_stored(10),  # 120000
        RewardBasis.FLAT, 999_999, has_partner=True,
    )
    assert agency == 120_000
    assert broker == 120_000       # capped
    assert house == 0


def test_zero_reward():
    agency, broker, house = compute_reward(
        1_000_000, RewardBasis.PERCENT, 0, RewardBasis.PERCENT, 0,
        has_partner=True)
    assert (agency, broker, house) == (0, 0, 0)
