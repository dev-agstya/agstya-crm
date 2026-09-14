"""How a policy's reward reads in a report column.

Three small formatters that answer the three questions anyone asks of a policy
row: what rate did we get, what was that rate applied to, and are we actually
getting paid.

They live here rather than in `routers/policies` because the Policies export and
the business report both print them, and the pair had already drifted once — the
month pack's Policies sheet carried no rate, no base and no partner name while
the Policies export one screen away carried all three. Two copies of "what does
40% mean on this policy" is how one file says 40% and the other says 25%.
"""

from __future__ import annotations

from typing import Optional

from app.core.enums import REWARD_REVERSAL_STATES, RewardBasis
from app.models.master import COMMISSIONABLE_BASE, PolicyCategory

# The stored reward statuses that mean "no reward is coming".
REVERSAL_STATE_VALUES = {
    (s.value if hasattr(s, "value") else s) for s in REWARD_REVERSAL_STATES}


def reward_pct(basis, value: int, base_paise: int) -> str:
    """A reward rate as a percentage — ALWAYS a percentage (owner 2026-07-18).

    Percent rates are stored as percent*100. A FLAT rupee reward is expressed as
    its effective % of the base it was earned on, so a column of rates can be
    compared down the page instead of mixing "40%" with "Rs 1,200".
    """
    basis_v = basis.value if hasattr(basis, "value") else basis
    if basis_v == RewardBasis.PERCENT.value:
        return f"{value / 100:g}%"
    if base_paise > 0:
        return f"{value / base_paise * 100:.2f}%"
    return "0%"


def reward_base_label(reward_base_field: Optional[str],
                      cat: Optional[PolicyCategory]) -> str:
    """WHAT the reward percentage was applied to.

    Either the default — the premium net of GST — or the policy type's own
    amount field (OD, TP, ...). This is the column that answers "was it the
    default amount or some custom amount", and without it a 25% and a 40% row
    are not comparable because they may be percentages of different things.
    """
    if not reward_base_field or reward_base_field == COMMISSIONABLE_BASE:
        return "Commissionable (Net Premium)"
    if cat is not None:
        for f in cat.custom_fields:
            if f.key == reward_base_field:
                return f.label
    return reward_base_field


def eligibility(status: Optional[str]) -> str:
    """Eligible / Not Eligible, from a policy's reward outcome."""
    if status is None:
        return "—"
    return "Not Eligible" if status in REVERSAL_STATE_VALUES else "Eligible"


def outcome_label(status: Optional[str]) -> str:
    """The reward's actual state, spelled out — Pending / Received / Paid out /
    Cancelled — rather than the raw enum value an accountant has to decode."""
    if not status:
        return "—"
    return str(status).replace("_", " ").title()
