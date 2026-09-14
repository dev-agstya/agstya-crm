"""Schemas for relationship managers and their partner rosters.

Replaces schemas/team.py (owner 2026-08-05). A "manager" here is not a new
account type or a new record — it is an EMPLOYEE seen through the partners who
sit under them (`User.relationship_manager_id`).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.target import TargetMetricRow


class ManagerRow(BaseModel):
    """One manager's contribution inside the selected window.

    House profit is zeroed server-side for anyone without `view_agency_profit`,
    exactly like every other surface that carries it.

    The partner/own split is the point of the row: a manager's number is the
    business their partners brought PLUS anything they sold directly (owner T7),
    and hiding the split behind one total is how "why is Rahul's number so high"
    becomes a conversation instead of a glance.
    """

    manager_id: str
    manager_name: str
    manager_code: Optional[str] = None
    active_account: bool = True

    # Roster size. `active_partners` = partners who wrote at least one policy in
    # the window; the gap between the two is the manager's dead weight, and it
    # is the most useful number on the page.
    partners: int = 0
    active_partners: int = 0

    # Totals (partner-sourced + own).
    policies: int = 0
    premium: int = 0
    reward_earned: int = 0       # agency reward
    partner_share: int = 0       # paid out to partners
    profit: int = 0              # house, gated
    renewals: int = 0

    # The split, so the row explains itself.
    partner_policies: int = 0
    partner_premium: int = 0
    own_policies: int = 0
    own_premium: int = 0


class ManagerRollup(BaseModel):
    can_view_profit: bool = True
    # False for an employee looking at their own row — the page then shows the
    # roster and hides the league table (owner T4.3b).
    can_view_all: bool = True
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    period_label: str = ""
    rows: list[ManagerRow] = []
    # Policies whose manager could not be resolved at booking (a partner with no
    # manager, a deleted account). Its own row so the numbers still add up to
    # the company total rather than quietly dropping business on the floor.
    unassigned: Optional[ManagerRow] = None


class PartnerRosterRow(BaseModel):
    """One channel partner on a manager's roster."""

    partner_id: str
    partner_name: str
    partner_code: Optional[str] = None
    mobile: Optional[str] = None
    active_account: bool = True

    policies: int = 0
    premium: int = 0
    # What the PARTNER earns. Operational, shown to all staff — unlike the
    # agency reward and house profit, which are income figures.
    their_reward: int = 0

    # Current position, NOT windowed: `finance_balance.partner_net_balance`,
    # the same function the Balance Sheet and the partner's own statement use.
    # Positive = the agency owes them; negative = they owe the agency.
    net_balance: int = 0

    # Live cover expiring inside the renewal horizon — the money the agency
    # loses by not chasing (owner T6.2).
    renewals_due: int = 0

    last_policy_at: Optional[datetime] = None
    days_quiet: Optional[int] = None      # None = never wrote a policy
    is_quiet: bool = False

    # The number this partner was given for the period, and how far along they
    # are (owner 2026-08-06). A roster without targets on it is a list of names
    # and money — it cannot answer "is this partner doing what I asked".
    # House profit is stripped from `target_metrics` for anyone who may not see
    # it, exactly like every other target surface.
    has_target: bool = False
    target_id: Optional[str] = None
    attainment_pct: float = 0.0
    target_metrics: list[TargetMetricRow] = Field(default_factory=list)


class TargetAllocationRow(BaseModel):
    """One metric: what the manager was asked for, and what they have handed on.

    `allocated` is the sum of the ACTIVE partners' goals for the same metric.
    It can legitimately exceed `target_value` — a manager who wants headroom
    over-allocates on purpose — so this is a fact, not a validation.
    """

    metric: str
    label: str
    is_money: bool
    target_value: int = 0
    allocated: int = 0
    partners_with_goal: int = 0


class ManagerRoster(BaseModel):
    manager_id: str
    manager_name: str
    manager_code: Optional[str] = None
    can_view_profit: bool = True
    # Whether the caller may add a partner / book on their behalf.
    can_manage: bool = False
    # Whether the caller may SET the targets on this roster. Separate from
    # `can_manage` on purpose: a relationship manager splits their own goal
    # across their partners without holding manage_team (owner F1).
    can_manage_targets: bool = False
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    period_label: str = ""

    # Roster-wide totals for the summary strip.
    partners: int = 0
    active_partners: int = 0
    quiet_partners: int = 0
    policies: int = 0
    premium: int = 0
    their_reward_total: int = 0
    renewals_due: int = 0

    # The MANAGER's own target for the same window — the number the per-partner
    # ones were carved out of. Shown above the roster so the split reads as a
    # split rather than as ten unrelated goals.
    manager_has_target: bool = False
    manager_attainment_pct: float = 0.0
    manager_metrics: list[TargetMetricRow] = Field(default_factory=list)
    partners_with_target: int = 0

    # HOW MUCH OF THE MANAGER'S GOAL IS ACTUALLY HANDED OUT (2026-08-19).
    #
    # The whole point of a team target is dividing your number across your
    # roster — "you have 100 policies, your ten partners get ten each". Both
    # figures were already on this screen and the GAP between them was not, so
    # the one arithmetic that matters had to be done by eye across ten rows.
    #
    # One entry per metric the MANAGER carries a goal for, with the sum of what
    # their ACTIVE partners were given for the same metric. A deactivated
    # partner is excluded for the same reason `partners_with_target` excludes
    # them (owner J3): they cannot write the business a goal asks for.
    allocation: list[TargetAllocationRow] = Field(default_factory=list)

    rows: list[PartnerRosterRow] = []


class TeamPolicyRow(BaseModel):
    """One policy written by somebody on this manager's roster.

    The Team view could show what a partner was GIVEN and what they TOTALLED,
    and not one line of the actual business behind it — so "why is this number
    what it is" meant leaving the page for /policies and filtering it by hand,
    partner by partner.

    Carries no agency reward and no house profit: `their_reward` is what the
    PARTNER earns, which is operational and already on the roster row above it.
    """

    policy_id: str
    code: str
    policy_number: Optional[str] = None
    partner_id: Optional[str] = None
    partner_name: Optional[str] = None
    customer_name: Optional[str] = None
    category_label: Optional[str] = None
    insurer_name: Optional[str] = None
    premium: int = 0
    their_reward: int = 0
    status: str = ""
    is_renewal: bool = False
    booked_at: Optional[datetime] = None
    expiry_date: Optional[datetime] = None


class TeamPolicies(BaseModel):
    manager_id: str
    manager_name: str
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    period_label: str = ""
    total: int = 0
    premium: int = 0
    their_reward_total: int = 0
    rows: list[TeamPolicyRow] = Field(default_factory=list)
    # Set when the window holds more policies than one screen should carry. The
    # page says so rather than silently showing a truncated list that does not
    # add up to the totals above it.
    truncated: bool = False
