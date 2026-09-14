"""Schemas for the finance engine (snapshot, ledger, party accounts, payments)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.core.enums import LedgerTxnType, PartyType, PayerType, SettlementStatus


class PolicyFinanceOut(BaseModel):
    policy_id: str
    broker_id: Optional[str] = None
    partner_id: Optional[str] = None
    customer_id: Optional[str] = None
    gross_premium: int
    commissionable: int
    agency_reward: int
    partner_share: int
    discount: int
    house_profit: int
    payer: PayerType
    settlement_status: SettlementStatus
    premium_paid_to_insurer: int
    premium_collected: int
    computed_at: datetime

    @classmethod
    def from_model(cls, pf) -> "PolicyFinanceOut":
        return cls(**pf.model_dump())


class LedgerTxnOut(BaseModel):
    id: str
    txn_type: LedgerTxnType
    party_type: PartyType
    party_id: str
    party_name: Optional[str] = None   # resolved display name (not stored)
    policy_id: Optional[str] = None
    amount_paise: int
    note: Optional[str] = None
    reference: Optional[str] = None
    occurred_at: datetime
    # Expense-only + attachment metadata.
    expense_category: Optional[str] = None
    paid_to_employee_id: Optional[str] = None
    paid_to_name: Optional[str] = None
    attachment_doc_id: Optional[str] = None
    # Which account the money moved through, and the signed amount that hit it
    # (NOT always ±amount_paise — a reward receipt is net of TDS).
    bank_account_id: Optional[str] = None
    bank_account_name: Optional[str] = None   # resolved for display, not stored
    bank_delta_paise: Optional[int] = None
    created_at: datetime

    @classmethod
    def from_model(cls, t, *, party_name: Optional[str] = None,
                   bank_account_name: Optional[str] = None) -> "LedgerTxnOut":
        data = t.model_dump()
        data["id"] = str(t.id)
        data["party_name"] = party_name
        data["bank_account_name"] = bank_account_name
        return cls(**data)


class LedgerTxnDetail(LedgerTxnOut):
    """One transaction with everything the View-details popup needs: the linked
    policy (if any) and the resolved names around it."""

    policy_code: Optional[str] = None
    policy_number: Optional[str] = None
    customer_name: Optional[str] = None
    partner_name: Optional[str] = None
    broker_name: Optional[str] = None
    created_by_name: Optional[str] = None


class ExpenseCreate(BaseModel):
    """Log a house expense (salary, rent, …). Stored as an EXPENSE ledger row."""

    amount_paise: int = Field(gt=0)
    category: str                          # sub-category key (see EXPENSE_CATEGORIES)
    note: Optional[str] = None
    occurred_at: Optional[datetime] = None
    paid_to_employee_id: Optional[str] = None
    paid_to_name: Optional[str] = None
    reference: Optional[str] = None
    attachment_doc_id: Optional[str] = None
    bank_account_id: Optional[str] = None
    idempotency_key: Optional[str] = None


class ExpenseUpdate(BaseModel):
    amount_paise: Optional[int] = Field(default=None, gt=0)
    category: Optional[str] = None
    note: Optional[str] = None
    occurred_at: Optional[datetime] = None
    paid_to_employee_id: Optional[str] = None
    paid_to_name: Optional[str] = None
    reference: Optional[str] = None
    bank_account_id: Optional[str] = None


class PartyAccountOut(BaseModel):
    id: str
    party_type: PartyType
    party_id: str
    party_name: Optional[str] = None   # resolved display name (not stored)
    balance_paise: int          # >0 receivable (owes us), <0 payable (we owe)
    total_charged_paise: int
    total_settled_paise: int
    last_txn_at: Optional[datetime] = None

    @classmethod
    def from_model(cls, a, *, party_name: Optional[str] = None) -> "PartyAccountOut":
        data = a.model_dump()
        data["id"] = str(a.id)
        data["party_name"] = party_name
        return cls(**data)


class PartnerDuesOut(BaseModel):
    """Per-partner money position for the Payments page. Reward figures come from
    the wallet; the premium balance from the party ledger (owner Q3a: show both).
    """

    partner_id: str
    partner_name: Optional[str] = None
    partner_code: Optional[str] = None
    reward_available_paise: int = 0   # reward ready to pay out
    reward_pending_paise: int = 0     # reward due once the insurer pays
    # >0 the partner owes us premium, <0 we owe them.
    premium_balance_paise: int = 0


class EarningsBlock(BaseModel):
    total: int = 0
    this_month: int = 0
    last_month: int = 0
    last_3_months: int = 0
    growth_pct: Optional[float] = None   # (this - last) / last, percent


class MonthPoint(BaseModel):
    month: str                            # "YYYY-MM"
    earnings: int = 0
    target: Optional[int] = None


class PendingBlock(BaseModel):
    collection_customers: int = 0         # customers owe us premium
    collection_partners: int = 0          # partners owe us premium
    reward_brokers: int = 0               # expected - received (>=0)
    rewards_partners: int = 0             # reward owed to partners (wallet)


class AgingBlock(BaseModel):
    bucket_0_30: int = 0
    bucket_30_60: int = 0
    bucket_60_plus: int = 0


class FinanceOverview(BaseModel):
    # False when the viewer lacks view_agency_profit: all house/net-profit figures
    # (earnings, monthly earnings, fy_earnings) are zeroed server-side (Q-A2).
    can_view_profit: bool = True
    basis: str                            # "cash" | "accrual"
    earnings: EarningsBlock
    monthly: list[MonthPoint]
    pending: PendingBlock
    aging: AgingBlock                     # customer + partner premium receivables
    fy_label: str
    fy_earnings: int = 0
    reward_received_total: int = 0        # gross reward received (all-time)
    rewards_paid_total: int = 0           # cash reward paid (all-time)
    premium_collected_total: int = 0      # premium cash collected (all-time)
    premium_fronted_total: int = 0        # premium the agency fronted (all-time)
    refunds_total: int = 0                # refunds paid (all-time, house-borne)
    expenses_total: int = 0               # house expenses (all-time)
    tds_deducted_total: int = 0           # TDS withheld by brokers (all-time)
    tds_deducted_fy: int = 0              # TDS withheld this financial year


class ReportRow(BaseModel):
    key: str
    label: str
    policies: int = 0
    premium: int = 0
    reward_earned: int = 0            # accrual (agency reward)
    reward: int = 0                   # partner reward owed (accrual)
    discount: int = 0
    profit: int = 0                   # house profit incl. discount
    pending_collection: Optional[int] = None
    pending_payout: Optional[int] = None
    growth_pct: Optional[float] = None


class ReportTotals(BaseModel):
    policies: int = 0
    premium: int = 0
    reward_earned: int = 0
    reward: int = 0
    discount: int = 0
    profit: int = 0


class ReportResult(BaseModel):
    dimension: str
    can_view_profit: bool = True     # profit/growth zeroed server-side if False
    totals: ReportTotals
    rows: list[ReportRow]


class EntityMonthPoint(BaseModel):
    month: str
    profit: int = 0
    premium: int = 0


class EntityPending(BaseModel):
    collection: Optional[int] = None
    payout: Optional[int] = None
    reward_to_receive: Optional[int] = None


class EntityProfile(BaseModel):
    entity_type: str
    entity_id: str
    label: str
    party_type: Optional[str] = None
    metrics: ReportTotals
    monthly: list[EntityMonthPoint]
    pending: EntityPending
    policy_status: dict[str, int]


# --- Redesigned dashboard (date-filtered) -----------------------------------
class TopPerformer(BaseModel):
    key: str
    label: str
    policies: int = 0
    premium: int = 0
    profit: int = 0          # house profit contribution in the window (paise)
    agency_reward: int = 0   # agency reward earned (employee / broker)
    reward: int = 0          # partner share earned (channel partner)
    renewals: int = 0        # renewed policies in the window

    # Employees only: Top Employee ranks on profit AND target achievement, so
    # the card can show WHY someone is first. Left at defaults for the partner,
    # broker and category cards, which are still pure profit rankings.
    attainment_pct: float = 0.0
    has_target: bool = False
    score: float = 0.0
    rank: int = 0


class SeriesPoint(BaseModel):
    """One bucket of the overview graph. Bucket size follows the date filter:
    day (≤ a week), week (≤ a month) or month (longer)."""

    key: str                 # "YYYY-MM-DD" (day/week start) or "YYYY-MM"
    label: str               # short axis label ("Mon 14", "Wk 2 · 8 Jul", "Jul")
    policies: int = 0        # policies booked in the bucket
    net_profit: int = 0      # cash net profit in the bucket (paise)
    renewals: int = 0        # renewal policies booked in the bucket
    renewal_rate_pct: Optional[float] = None   # renewals / policies × 100

    # Performance vs Target. `actual` is the BOOKED figure for the selected
    # target metric, NOT the cash net_profit above — the two are different
    # bases and the old graph compared them against each other, which is why it
    # could show a rupee bar against a policy-count goal. `target` is the same
    # metric, pro-rated across the bucket.
    target: int = 0          # pro-rated goal for the bucket, in metric units
    actual: int = 0          # booked actual for the bucket, same units


class EmployeeTarget(BaseModel):
    """One person's actuals vs goal for the window, with their rank."""

    key: str
    label: str
    actual: int = 0          # booked figure for the target metric (paise/count)
    target: int = 0          # assigned goal for the window (same units)
    has_target: bool = False
    attainment_pct: float = 0.0
    profit: int = 0          # house profit contribution (paise)
    policies: int = 0
    score: float = 0.0       # combined profit + attainment score (0..1)
    rank: int = 0


class DashboardEarnings(BaseModel):
    total_earnings: int = 0        # realised net profit (cash in − cash out)
    reward_received: int = 0       # cash reward received from brokers
    rewards_paid: int = 0          # reward (incl. advances) paid to partners
    premium_collected: int = 0     # premium cash collected from buyers
    premium_fronted: int = 0       # premium the agency fronted to insurers
    refunds: int = 0               # refunds paid to customers/partners (house-borne)
    expenses: int = 0              # house expenses (salary, rent, …)
    total_policies: int = 0        # policies booked in the window


class PendingItem(BaseModel):
    party_type: str                # customer | partner | broker
    party_id: str
    label: str
    amount: int                    # NET amount on this side (owed_to_us − owed_to_them)
    owed_to_us: int = 0            # gross the party owes us (premium / commission)
    owed_to_them: int = 0          # gross we owe them (reward / discount refund)


class DashboardPending(BaseModel):
    """Point-in-time outstanding balances (NOT affected by the date filter),
    NETTED so each party appears on exactly one side, with its gross breakdown
    kept for the expandable view."""

    to_collect: int = 0            # net owed TO the agency across all parties
    to_pay: int = 0                # net owed BY the agency across all parties
    collect_items: list[PendingItem] = []
    pay_items: list[PendingItem] = []


class FinanceDashboard(BaseModel):
    can_view_profit: bool = True     # profit tiles/series/leaderboards gated (Q-A2)
    period: str
    period_label: str
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    # Fixed 30-day cash net profit for the hero tile (ignores the date filter).
    net_profit_30d: int = 0
    earnings: DashboardEarnings
    granularity: str = "month"           # day | week | month
    series: list[SeriesPoint] = []
    # Which metric the Performance-vs-Target graph is showing, and whether any
    # goal exists for the window at all — the UI needs the second one to tell
    # "nobody hit their target" apart from "nobody has been given one".
    target_metric: str = "house_profit"
    target_metric_label: str = "House profit"
    target_is_money: bool = True
    has_targets: bool = False
    # Set when the Performance-vs-Target graph is scoped to one employee.
    target_employee_id: Optional[str] = None
    top_employees: list[TopPerformer] = []
    top_partners: list[TopPerformer] = []
    top_brokers: list[TopPerformer] = []
    top_categories: list[TopPerformer] = []
    employee_targets: list[EmployeeTarget] = []
    pending: DashboardPending


# --- Balance sheets ----------------------------------------------------------
class BalanceSheetItem(BaseModel):
    """One row in a balance-sheet master list."""

    id: str
    label: str
    code: Optional[str] = None
    policies: int = 0
    premium: int = 0
    earnings: int = 0             # party's own earnings inside the window
    profit: int = 0               # house-profit contribution inside the window
    # Net position from the AGENCY's receivable view: >0 the party owes us,
    # <0 we owe them. The UI applies the owner's sign/colour convention.
    net_balance: int = 0
    outstanding: int = 0          # legacy alias of net_balance (kept for compat)
    wallet_balance: Optional[int] = None


class CategoryStat(BaseModel):
    key: str
    label: str
    policies: int = 0
    premium: int = 0


class ProfileStat(BaseModel):
    """A per-insurer-company breakdown of a broker's business (which insurers we
    placed through this broker, and the reward each generated)."""

    id: str
    label: str
    code: Optional[str] = None
    policies: int = 0
    premium: int = 0
    reward_earned: int = 0
    reward_received: int = 0
    reward_to_receive: int = 0
    house_profit: int = 0


class BalanceSheetDetail(BaseModel):
    section: str                  # broker | partner | customer
    id: str
    label: str
    code: Optional[str] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None

    total_policies: int = 0
    renewals: int = 0
    by_category: list[CategoryStat] = []

    active_policies: int = 0      # policies in the window still Active today
    premium: int = 0              # gross premium / business generated
    premium_collected: int = 0
    reward_earned: int = 0        # agency reward (broker) / partner share (partner)
    reward_received: int = 0      # gross reward received from broker
    reward_to_receive: int = 0
    tds_deducted: int = 0         # TDS withheld by this broker (broker section)
    tds_percent: Optional[int] = None   # broker's TDS rate (percent*100)
    # Broker only: what we actually pocketed = rewards received − TDS.
    total_earnings: int = 0
    house_profit: int = 0         # profit contribution
    discount: int = 0
    refund: int = 0
    avg_reward_pct: Optional[float] = None

    outstanding: int = 0          # net party balance (>0 receivable)
    receivable: int = 0
    payable: int = 0
    net_balance: int = 0
    wallet_balance: Optional[int] = None

    profiles: list[ProfileStat] = []   # broker only (profile-wise breakdown)


class StatementPolicyRow(BaseModel):
    date: Optional[datetime] = None
    code: str
    customer: str
    category: str
    premium: int = 0
    reward: int = 0               # the partner's share (what he is to get)


class StatementTxnRow(BaseModel):
    date: datetime
    label: str                    # human description of the movement
    direction: str                # "in" (he paid us) | "out" (we paid him)
    amount: int = 0               # positive magnitude (paise)


class PartnerStatement(BaseModel):
    """Everything the printable channel-partner statement needs, for the window
    selected on the Balance Sheet."""

    partner_id: str
    label: str
    code: Optional[str] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None

    opening_balance: int = 0      # net position just before the window (>0 we owe him)
    policies: list[StatementPolicyRow] = []
    total_premium: int = 0
    total_reward: int = 0
    transactions: list[StatementTxnRow] = []
    total_in: int = 0             # premium he paid us in the window
    total_out: int = 0            # reward/refund we paid him in the window
    net_balance: int = 0          # current net as of today (>0 we owe him)


# --- Finance Reports insights ------------------------------------------------
class InsightMetric(BaseModel):
    key: str
    label: str
    policies: int = 0
    premium: int = 0
    agency_reward: int = 0
    reward: int = 0
    profit: int = 0
    avg_reward_pct: Optional[float] = None


class InsightSlice(BaseModel):
    key: str
    label: str
    count: int = 0
    premium: int = 0


class InsightTrendPoint(BaseModel):
    month: str
    premium: int = 0
    profit: int = 0
    policies: int = 0       # policies booked that month
    net_profit: int = 0     # cash net profit that month
    target: int = 0


class RenewalTrendPoint(BaseModel):
    month: str
    new_business: int = 0
    renewals: int = 0


class CustomerTrendPoint(BaseModel):
    month: str
    new: int = 0
    returning: int = 0


class TargetRow(BaseModel):
    key: str
    label: str
    actual: int = 0
    target: int = 0
    has_target: bool = False
    met: bool = False


class InsightKpis(BaseModel):
    total_premium: int = 0
    policies: int = 0
    active_policies: int = 0
    new_business_premium: int = 0
    house_profit: int = 0
    reward_earned: int = 0
    reward: int = 0
    avg_premium: int = 0
    avg_reward_pct: Optional[float] = None
    renewal_rate: Optional[float] = None
    repeat_rate: Optional[float] = None
    # Cash figures (owner 2026-07-16): net profit obeys the date filter only;
    # the pending pair is a point-in-time position that ignores all filters.
    net_profit: int = 0
    pending_to_collect: int = 0
    pending_to_pay: int = 0


class RewardHealth(BaseModel):
    received: int = 0
    pending: int = 0
    rejected: int = 0
    not_eligible: int = 0
    zero_pct: int = 0
    refunded: int = 0
    realization_pct: Optional[float] = None


class RetentionBlock(BaseModel):
    total_customers: int = 0
    repeat_customers: int = 0
    repeat_rate: Optional[float] = None
    avg_policies: float = 0


class RenewalsDue(BaseModel):
    d30: int = 0
    d60: int = 0
    d90: int = 0


class InsightsResult(BaseModel):
    can_view_profit: bool = True     # all profit figures zeroed server-side if False
    period: str
    period_label: str
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    kpis: InsightKpis
    trend: list[InsightTrendPoint] = []
    by_category: list[InsightMetric] = []
    by_insurer: list[InsightMetric] = []
    payer_mix: list[InsightSlice] = []
    buyer_mix: list[InsightSlice] = []
    renewal_trend: list[RenewalTrendPoint] = []
    renewals_due: RenewalsDue
    customer_trend: list[CustomerTrendPoint] = []
    retention: RetentionBlock
    top_partners: list[InsightMetric] = []
    top_employees: list[InsightMetric] = []
    employee_targets: list[TargetRow] = []
    partner_targets: list[TargetRow] = []
    reward_health: RewardHealth
    lead_funnel: list[InsightSlice] = []
    lead_conversion_pct: Optional[float] = None
    status_dist: list[InsightSlice] = []


class LedgerTxnUpdate(BaseModel):
    """Edit a manual ledger row. `amount_paise` is a POSITIVE magnitude; the
    stored sign (receivable vs payable) is preserved from the original row.

    The two CORRECTION fields below were missing until 2026-08-19, and their
    absence had a real cost. An expense could always be moved to a different
    account (see ExpenseUpdate); a receipt could not, and no transaction of any
    kind could be moved to a different party. So the two mistakes people
    actually make when keying a payment — right money, wrong account; right
    money, wrong customer — had no correction at all, and the only route was
    delete-and-re-enter, which throws away the audit trail and the attachment.
    """

    amount_paise: Optional[int] = Field(default=None, gt=0)
    note: Optional[str] = None
    reference: Optional[str] = None
    occurred_at: Optional[datetime] = None
    # Which of OUR accounts the money moved through. Sending "" detaches it
    # (a legacy row that never had one), which is why this is not just Optional:
    # None means "leave it alone" and "" means "clear it".
    bank_account_id: Optional[str] = None
    # Who the row is about. BOTH are required together — a party_id is only
    # meaningful next to its type, and accepting one alone would let a customer
    # id be filed under PartyType.BROKER.
    party_type: Optional[PartyType] = None
    party_id: Optional[str] = None


class PaymentCreate(BaseModel):
    """Record one money movement. `amount_paise` is a POSITIVE magnitude; the
    server derives the sign from the txn type (see the router)."""

    txn_type: LedgerTxnType
    party_type: PartyType
    party_id: str
    amount_paise: int = Field(gt=0)
    policy_id: Optional[str] = None
    note: Optional[str] = None
    reference: Optional[str] = None
    # The real-world transaction date/time (owner Q10); defaults to now.
    occurred_at: Optional[datetime] = None
    # For ADJUSTMENT only: does this increase what the party owes us?
    increases_receivable: bool = False
    # Which of OUR accounts the money moved through. Required once any account
    # exists (owner A4.3) — an optional field makes every balance untrustworthy
    # within a week.
    bank_account_id: Optional[str] = None
    # ADJUSTMENT only: a correction is usually a book entry, so it moves no cash
    # unless the person recording it says it did, and in which direction.
    # +1 money came in, -1 money went out, 0/None nothing moved.
    bank_direction: int = 0
    # Stable per submission; a retry or double-click carries the same key and is
    # rejected by the unique index instead of posting twice.
    idempotency_key: Optional[str] = None


# --- TDS report --------------------------------------------------------------
class TdsBrokerRow(BaseModel):
    broker_id: str
    broker_name: Optional[str] = None
    broker_code: Optional[str] = None
    tds_percent: int = 0              # current TDS % on the broker (percent*100)
    entries: int = 0                  # number of TDS events in the window
    gross_reward: int = 0            # gross reward these events settled (paise)
    tds_deducted: int = 0            # tax withheld in the window (paise)


class TdsEntryRow(BaseModel):
    id: str
    date: datetime
    broker_id: str
    broker_name: Optional[str] = None
    policy_id: Optional[str] = None
    policy_code: Optional[str] = None
    gross_reward: int = 0
    tds_percent: int = 0
    tds_deducted: int = 0
    reference: Optional[str] = None
    note: Optional[str] = None


class TdsReport(BaseModel):
    """TDS withheld by brokers, for the selected window (default: this FY)."""

    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    fy_label: Optional[str] = None
    total_gross_reward: int = 0
    total_tds: int = 0
    by_broker: list[TdsBrokerRow] = []
    entries: list[TdsEntryRow] = []
