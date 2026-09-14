"""Report / dashboard response schemas."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class DashboardStats(BaseModel):
    # Book-of-business counts: None for a viewer without view_policies. They
    # used to be unconditional, which handed a permissionless account the size
    # of the whole book.
    customers: Optional[int] = None
    active_policies: Optional[int] = None
    leads_open: Optional[int] = None
    renewals_due_30d: Optional[int] = None
    # Money (paise). Sensitive figures are None for users without permission.
    new_business_premium_mtd: Optional[int] = None
    # Agency commission position — view_finance, not merely "signed in".
    reward_pending: Optional[int] = None
    reward_received: Optional[int] = None
    agency_profit_mtd: Optional[int] = None   # house profit; gated
    partner_earnings: Optional[int] = None     # for partners / team
    # Channel Partner-only wallet snapshot.
    wallet_available: Optional[int] = None
    wallet_pending: Optional[int] = None

    # --- New dashboard metrics (all gated; None when not permitted) ---
    policies_total: Optional[int] = None            # lifetime policy count
    # Calendar month-to-date, IST (owner 2026-08-07). These were rolling
    # 30-day windows, which never agreed with the Targets page or the monthly
    # report for what everyone calls "this month".
    policies_mtd: Optional[int] = None              # policies booked, this month
    net_profit_mtd: Optional[int] = None            # realised profit, this month
    unrealised_profit: Optional[int] = None         # commission still to collect
    pending_to_collect: Optional[int] = None        # netted, agency-wide
    pending_to_pay: Optional[int] = None
    growth_policies_pct: Optional[float] = None     # this month vs last month
    growth_earning_pct: Optional[float] = None


class RenewalRow(BaseModel):
    policy_id: str
    policy_code: str
    customer_id: str
    customer_name: str
    category_key: str
    expiry_date: Optional[str] = None
    days_left: Optional[int] = None
    premium_amount: int


class RenewalSummary(BaseModel):
    """Renewal analytics over a lookback window + upcoming due count."""

    due_30d: int                       # policies expiring in the next 30 days
    due_30d_premium: int               # their total premium (paise)
    renewed_window: int                # policies renewed in the lookback window
    lapsed_window: int                 # lapsed/expired in the lookback window
    renewal_rate: Optional[float] = None   # renewed / (renewed + lapsed), 0..1
    window_days: int


class PartnerPerformanceRow(BaseModel):
    partner_id: str
    partner_name: str
    policies: int
    total_premium: int
    partner_earnings: int


class LeadFunnelRow(BaseModel):
    stage: str
    count: int


class AnalyticsMetrics(BaseModel):
    policies: int = 0
    premium: int = 0            # paise, gross
    commissionable: int = 0     # paise
    agency_reward: int = 0      # paise earned from insurers
    partner_payout: int = 0     # paise owed to partners
    house: int = 0              # paise, agency - partner (the spread)


class AnalyticsGroup(AnalyticsMetrics):
    key: str
    label: str


class AnalyticsResult(BaseModel):
    group_by: str
    totals: AnalyticsMetrics
    groups: list[AnalyticsGroup]
