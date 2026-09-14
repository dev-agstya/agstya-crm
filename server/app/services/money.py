"""Money and reward math. All monetary values are integers in paise.

Reward model (corrected — verified against the agency's real reward sheet):

  commissionable_premium = premium net of GST   (the base for ALL reward maths)
  agency_amount = commissionable x insurer_rate  (what the agency receives)
  partner_amount = commissionable x partner_rate   (what the agency pays a partner,
                  and ONLY when a partner is attributed to the policy)
  house_amount  = agency_amount - partner_amount  (agency profit / the spread)
"""

from __future__ import annotations

from app.core.enums import RewardBasis

# Percentages are stored as percent * 100 (e.g. 12.5% -> 1250) to keep integers.
PERCENT_SCALE = 100

# Default GST on insurance premium in India, as percent*100 (18% -> 1800).
DEFAULT_GST_PERCENT = 1800


def rupees_to_paise(rupees: float) -> int:
    return round(rupees * 100)


def paise_to_rupees(paise: int) -> float:
    return round(paise / 100, 2)


def percent_to_stored(percent: float) -> int:
    return round(percent * PERCENT_SCALE)


def commissionable_from_premium(premium_paise: int,
                                gst_percent: int = DEFAULT_GST_PERCENT) -> int:
    """Net-of-GST premium = gross / (1 + gst). gst_percent is percent*100.

    This is the default auto-fill for the commissionable premium; the user may
    override it per policy (e.g. motor OD/package cases where only part of the
    premium is commissionable).
    """
    if premium_paise <= 0:
        return 0
    divisor = 1 + (gst_percent / (PERCENT_SCALE * 100))
    return round(premium_paise / divisor)


def _apply(basis: RewardBasis, value: int, base_paise: int) -> int:
    """Compute an amount in paise from a basis+value against a base amount."""
    if basis == RewardBasis.PERCENT:
        # value is percent*100; amount = base * percent / 100
        return round(base_paise * value / (PERCENT_SCALE * 100))
    return int(value)  # flat: value already in paise


def compute_reward(
    commissionable_paise: int,
    agency_basis: RewardBasis,
    agency_value: int,
    partner_basis: RewardBasis,
    partner_value: int,
    has_partner: bool,
) -> tuple[int, int, int]:
    """Return (agency_amount, partner_amount, house_amount) in paise.

    Both the agency (insurer) rate and the partner rate apply to the
    commissionable premium INDEPENDENTLY. The partner amount is only paid when a
    partner is attributed to the policy (has_partner); for a pure in-house sale the
    whole agency amount is house profit.
    """
    agency_amount = _apply(agency_basis, agency_value, commissionable_paise)

    partner_amount = 0
    if has_partner and partner_value:
        partner_amount = _apply(partner_basis, partner_value, commissionable_paise)

    # A partner can't be paid more than the agency earned on the policy.
    partner_amount = max(0, min(partner_amount, agency_amount))
    house_amount = agency_amount - partner_amount
    return agency_amount, partner_amount, house_amount
