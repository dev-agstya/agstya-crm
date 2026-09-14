"""Finance engine API: per-policy P&L, the money ledger, party statements, and
recording payments.

Reads require view_finance (the ledger reads require view_transactions);
recording or correcting a payment requires manage_transactions. Channel partners
never reach these — they hold no permissions at all and cannot sign in.

House/net profit is gated separately on view_agency_profit and zeroed
server-side for anyone without it (see the _gate_* helpers), so someone can run
the whole money desk without ever seeing the agency's own margin.
"""

from __future__ import annotations

import asyncio

from beanie import PydanticObjectId
from fastapi import (
    APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile,
    status,
)
from fastapi.responses import StreamingResponse

from datetime import datetime, timezone
from typing import Optional

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_any_permission,
    require_permission,
)
from app.core.enums import (
    EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, AccountType, AuditAction,
    DocumentStatus, LedgerTxnType, PartyType, WalletTxnType,
)
from app.core.permissions import (
    can,
    EXPORT_DATA,
    FINANCE_VIEW_ANY,
    MANAGE_TRANSACTIONS,
    VIEW_AGENCY_PROFIT,
    VIEW_BALANCE_SHEET,
    VIEW_FINANCE_OVERVIEW,
    VIEW_REPORTS,
    VIEW_TDS,
    VIEW_TRANSACTIONS,
)
from app.models.bank import BankAccount
from app.models.base import utcnow
from app.models.broker import Broker
from app.models.customer import Customer
from app.models.finance import LedgerTxn, PartyAccount, PolicyFinance, TdsEntry
from app.models.policy import Policy
from app.models.reward import Reward
from app.models.target import Target
from app.models.user import User
from app.models.wallet import Wallet, WalletTxn
from app.routers._helpers import parse_object_id, read_upload, search_regex
from app.schemas.common import Message, Page
from app.schemas.finance import (
    AgingBlock,
    BalanceSheetDetail,
    BalanceSheetItem,
    DashboardEarnings,
    DashboardPending,
    EarningsBlock,
    EmployeeTarget,
    ExpenseCreate,
    ExpenseUpdate,
    EntityMonthPoint,
    EntityPending,
    EntityProfile,
    InsightsResult,
    FinanceDashboard,
    FinanceOverview,
    LedgerTxnDetail,
    LedgerTxnOut,
    LedgerTxnUpdate,
    MonthPoint,
    PartnerDuesOut,
    PartnerStatement,
    PartyAccountOut,
    PaymentCreate,
    PendingBlock,
    PolicyFinanceOut,
    ReportResult,
    ReportRow,
    ReportTotals,
    SeriesPoint,
    StatementPolicyRow,
    StatementTxnRow,
    TdsReport,
    TopPerformer,
)
from app.services import bank as bank_svc
from app.services import finance as finance_svc
from app.services import finance_agg
from app.services import finance_balance
from app.services import finance_dashboard
from app.services import finance_insights
from app.services import finance_reports as fr
from app.services import finance_tds
from app.services import idempotency
from app.services import targets as tsvc
from app.services.audit import diff_dict_async, log_action
from app.services.exporters import export_response
from app.services.txn_display import ledger_label, merge_partner_payouts
from app.core.enums import TargetMetric, TargetPeriod

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/finance", tags=["finance"],
                   dependencies=[Depends(get_inhouse_user)])


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


def _can_profit(actor: User) -> bool:
    """Agency house/net profit is a distinct, more sensitive right than
    view_finance (owner Q-A2): seeing transactions/ledgers/balances does NOT
    grant seeing the agency's profit/spread."""
    return can(actor, VIEW_AGENCY_PROFIT)


# --- Profit gating (Q-A2) ----------------------------------------------------
# When the viewer lacks view_agency_profit, every house/net-profit figure is
# zeroed server-side BEFORE it leaves the API, so the number never reaches the
# client regardless of the UI. Cash movements, receivables and commission
# (revenue) stay visible — only the agency spread/profit is withheld.

def _gate_overview(o: FinanceOverview, cvp: bool) -> FinanceOverview:
    o.can_view_profit = cvp
    if not cvp:
        o.earnings = EarningsBlock()
        for m in o.monthly:
            m.earnings = 0
            m.target = None
        o.fy_earnings = 0
    return o


def _gate_dashboard(d: FinanceDashboard, cvp: bool) -> FinanceDashboard:
    d.can_view_profit = cvp
    if not cvp:
        d.net_profit_30d = 0
        d.earnings.total_earnings = 0
        for s in d.series:
            s.net_profit = 0
            s.target = 0
            # `actual` is the booked figure for the target metric. When that
            # metric IS house profit it is a profit number, so it has to be
            # zeroed too — otherwise the target graph would leak the very
            # figure the net-profit series above just hid.
            if d.target_metric == TargetMetric.HOUSE_PROFIT.value:
                s.actual = 0
        d.top_employees = []
        d.top_partners = []
        d.top_brokers = []
        d.top_categories = []
        d.employee_targets = []
    return d


def _gate_reports(r: ReportResult, cvp: bool) -> ReportResult:
    r.can_view_profit = cvp
    if not cvp:
        r.totals.profit = 0
        for row in r.rows:
            row.profit = 0
            row.growth_pct = None
    return r


def _gate_insights(res: InsightsResult, cvp: bool) -> InsightsResult:
    res.can_view_profit = cvp
    if not cvp:
        res.kpis.house_profit = 0
        res.kpis.net_profit = 0
        for m in res.trend:
            m.profit = 0
            m.net_profit = 0
        for coll in (res.by_category, res.by_insurer,
                     res.top_partners, res.top_employees):
            for it in coll:
                it.profit = 0
        for tr in list(res.employee_targets) + list(res.partner_targets):
            tr.actual = 0
            tr.target = 0
            tr.met = False
    return res


def _gate_balance_item(item: BalanceSheetItem, cvp: bool) -> BalanceSheetItem:
    if not cvp:
        item.earnings = 0
        item.profit = 0
    return item


def _gate_balance_detail(d: BalanceSheetDetail, cvp: bool) -> BalanceSheetDetail:
    if not cvp:
        d.house_profit = 0
        d.total_earnings = 0
        for p in d.profiles:
            p.house_profit = 0
    return d


def _gate_entity(e: EntityProfile, cvp: bool) -> EntityProfile:
    if not cvp:
        e.metrics.profit = 0
        for m in e.monthly:
            m.profit = 0
    return e


# Plain party-kind label for the export's "Party" column.
_PARTY_TYPE_LABEL = {
    PartyType.CHANNEL_PARTNER.value: "Channel Partner",
    PartyType.CUSTOMER.value: "Customer",
    PartyType.BROKER.value: "Broker",
    PartyType.EXPENSE.value: "House",
}

# Ledger rows the payments manager must never touch by hand:
#   - PREMIUM_DUE / PREMIUM_PAID_BY_AGENCY / REWARD_CANCELLED are auto-managed
#     from the policy (re-synced on every re-book); editing/cancelling/deleting
#     them corrupts party balances (the balance-neutral ones would gain a
#     balance-moving reversal) — fix the policy instead.
PROTECTED_LEDGER_TYPES = {
    LedgerTxnType.PREMIUM_DUE,
    LedgerTxnType.PREMIUM_PAID_BY_AGENCY,
    LedgerTxnType.REWARD_CANCELLED,
    # Reward payouts are driven by the wallet (Payments -> pay a partner). Editing
    # this mirror row by hand would desync it from the wallet withdrawal — reverse
    # the payout from the partner's wallet instead.
    LedgerTxnType.PARTNER_PAYOUT,
    # A transfer is a PAIR of rows across two accounts. Touching one leg on its
    # own leaves the money half-moved — reverse it with another transfer.
    LedgerTxnType.TRANSFER,
}
_PROTECTED_MSG = {
    LedgerTxnType.PREMIUM_DUE:
        "Premium-due rows are managed automatically from the policy. "
        "Edit the policy (premium / discount / paid-by) instead.",
    LedgerTxnType.PREMIUM_PAID_BY_AGENCY:
        "This row is auto-logged from the policy and is balance-neutral. "
        "Edit the policy instead.",
    LedgerTxnType.REWARD_CANCELLED:
        "This row is auto-logged from the reward outcome. "
        "Change the policy's reward status instead.",
    LedgerTxnType.PARTNER_PAYOUT:
        "This row mirrors a reward payout made from the partner's wallet. "
        "Reverse the payout from the partner's wallet instead.",
    LedgerTxnType.TRANSFER:
        "This is one leg of a transfer between your own accounts. Editing it "
        "alone would leave the two accounts disagreeing — record a transfer "
        "back the other way instead.",
}

# Transaction types staff may post through the generic payments endpoint.
# Everything else is either auto-managed (see above), has its own endpoint
# (expenses, partner payouts/advances via the wallet), or is derived
# (TDS entries pair automatically with reward receipts).
MANUAL_PAYMENT_TYPES = {
    LedgerTxnType.PREMIUM_COLLECTED,
    LedgerTxnType.PREMIUM_TO_INSURER,
    LedgerTxnType.REWARD_RECEIVED,
    LedgerTxnType.REFUND,
    # DISCOUNT deliberately excluded (owner Q7): discounts live on the policy
    # and flow through its premium-due — a manual row would double-count.
    LedgerTxnType.ADJUSTMENT,
}


async def _require_bank_account(account_id: Optional[str],
                                txn_type: LedgerTxnType) -> Optional[str]:
    """Resolve (and insist on) the account a cash movement went through.

    Mandatory once ANY account exists (owner A4.3): an optional field makes
    every balance untrustworthy within a week. Before the owner has set up their
    first account nothing is required, so the app keeps working exactly as it
    did — and legacy rows written before this existed simply carry no account
    (owner A4.2: history is test data, start clean from here).

    Accrual-only rows (premium due, discounts, …) never take an account.
    """
    if not bank_svc.is_cash_moving(txn_type):
        return None
    if account_id:
        account = await bank_svc.get_account(account_id)
        if account is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                "That account no longer exists.")
        if not account.active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                f"'{account.name}' is deactivated. Choose "
                                f"another account.")
        return str(account.id)
    if await BankAccount.find(BankAccount.active == True).count():  # noqa: E712
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Choose which account this money moved through.")
    return None


async def _party_exists(party_type: PartyType, party_id: str) -> bool:
    """Does this counterparty actually exist?

    Guards the re-file path on `edit_ledger_txn`: an id that resolves to
    nothing would move the money onto a balance nobody can ever open, which is
    strictly worse than the wrong-party row it was correcting.
    """
    model = {PartyType.CUSTOMER: Customer,
             PartyType.BROKER: Broker,
             PartyType.CHANNEL_PARTNER: User}.get(party_type)
    if model is None:
        return False
    try:
        found = await model.get(PydanticObjectId(party_id))
    except Exception:  # noqa: BLE001 — a malformed id is simply "no party"
        return False
    if found is None:
        return False
    if model is User:
        return found.account_type == AccountType.CHANNEL_PARTNER
    return True


def _guard_protected(txn: LedgerTxn) -> None:
    if txn.txn_type in PROTECTED_LEDGER_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            _PROTECTED_MSG[txn.txn_type])


def _guard_reversal(txn: LedgerTxn) -> None:
    """Refuse to cancel a row that is already settled by a cancellation.

    Cancelling posts an equal-and-opposite row. Do it twice and the party
    balance moves by the full amount in the WRONG direction, because the second
    reversal has nothing left to reverse. A double-clicked Cancel button was
    enough to trigger it.
    """
    if txn.reversed_by:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This transaction has already been cancelled.")
    if txn.reversal_of:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This row is itself a cancellation and can't be cancelled. Record a "
            "fresh transaction instead.")


# Sign of a ledger posting from the agency's receivable perspective
# (+ve = party owes us, -ve = we owe / party paid us).
def _signed_amount(payload: PaymentCreate) -> int:
    amt = payload.amount_paise
    if payload.txn_type in (LedgerTxnType.PREMIUM_TO_INSURER,
                            LedgerTxnType.REFUND):
        # Agency fronted premium / paid the party back -> clears what we owe
        # them (their balance moves toward a receivable).
        return amt
    if payload.txn_type in (LedgerTxnType.PREMIUM_COLLECTED,
                            LedgerTxnType.PARTNER_PAYOUT,
                            LedgerTxnType.REWARD_RECEIVED,
                            LedgerTxnType.DISCOUNT):
        return -amt           # money received/paid out reduces the receivable
    # ADJUSTMENT: caller chooses the direction.
    return amt if payload.increases_receivable else -amt


# A party is stored as (type, id); resolve display names in bulk so the UI can
# show "Ramesh Kumar" instead of an opaque id fragment.
async def _party_names(
        keys: set[tuple[str, str]]) -> dict[tuple[str, str], str]:
    def _oids(party_type: PartyType) -> list[PydanticObjectId]:
        out: list[PydanticObjectId] = []
        for ptype, pid in keys:
            if ptype == party_type.value:
                try:
                    out.append(PydanticObjectId(pid))
                except Exception:  # noqa: BLE001 — skip malformed ids
                    continue
        return out

    names: dict[tuple[str, str], str] = {}
    partner_ids = _oids(PartyType.CHANNEL_PARTNER)
    if partner_ids:
        for u in await User.find({"_id": {"$in": partner_ids}}).to_list():
            names[(PartyType.CHANNEL_PARTNER.value, str(u.id))] = u.full_name
    customer_ids = _oids(PartyType.CUSTOMER)
    if customer_ids:
        for c in await Customer.find({"_id": {"$in": customer_ids}}).to_list():
            names[(PartyType.CUSTOMER.value, str(c.id))] = c.name
    broker_ids = _oids(PartyType.BROKER)
    if broker_ids:
        for b in await Broker.find({"_id": {"$in": broker_ids}}).to_list():
            names[(PartyType.BROKER.value, str(b.id))] = (
                f"{b.name} · {b.short_code}" if b.short_code else b.name)
    # House expenses: resolve an employee-linked payee's name; the "house"
    # sentinel stays unnamed (the UI shows the expense category instead).
    expense_ids = _oids(PartyType.EXPENSE)
    if expense_ids:
        for u in await User.find({"_id": {"$in": expense_ids}}).to_list():
            names[(PartyType.EXPENSE.value, str(u.id))] = u.full_name
    return names


async def _bank_names(ids: set[str]) -> dict[str, str]:
    """Resolve account ids to display names in one query, so the transactions
    list can show "HDFC Current" against each row."""
    oids = []
    for value in ids:
        try:
            oids.append(PydanticObjectId(value))
        except Exception:  # noqa: BLE001 — skip malformed ids
            continue
    if not oids:
        return {}
    return {str(a.id): a.name
            for a in await BankAccount.find({"_id": {"$in": oids}}).to_list()}


def _party_key(item) -> tuple[str, str]:
    ptype = item.party_type.value if hasattr(item.party_type, "value") \
        else item.party_type
    return (ptype, item.party_id)


# A date somebody picked out of a filter is an INDIAN day, not a UTC one — the
# shared readers live in services/finance_reports so all six routers agree.
# These were private UTC-attaching copies, which is why the Transactions page and
# the Business Report answered the same custom range differently.
_parse_dt = fr.parse_ist_bound
_end_of_day = fr.parse_ist_end_of_day
_date_range = fr.ist_range


def _aware(dt: datetime) -> datetime:
    """A datetime from a REQUEST BODY (an occurred_at the client computed).

    UTC, unlike the query-string bounds above — see the note in routers/banks.
    """
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# --- Finance overview (dashboard) --------------------------------------------
@router.get("/overview", response_model=FinanceOverview,
            dependencies=[Depends(require_permission(VIEW_FINANCE_OVERVIEW))])
async def finance_overview(
    basis: str = Query(default="cash", pattern="^(cash|accrual)$"),
    actor: User = Depends(get_active_user),
) -> FinanceOverview:
    now = utcnow()
    keys = fr.last_n_month_keys(now, 12)
    this_key = fr.month_key(now)
    last3_keys = set(keys[-3:])
    earn_by_month: dict[str, int] = {k: 0 for k in keys}

    # --- Cash: every real money movement, signed (owner's 1.2 rule) ---
    # in:  premium collected + reward received
    # out: premium fronted by the agency + advances + refunds + expenses
    reward_total = premium_collected_total = premium_fronted_total = 0
    refunds_total = expenses_total = advances_total = 0

    def _bump_month(when, amt: int) -> None:
        if basis != "cash":
            return
        mk = fr.month_key(_aware(when))
        if mk in earn_by_month:
            earn_by_month[mk] += amt

    async for t in LedgerTxn.find():
        if t.txn_type == LedgerTxnType.REWARD_RECEIVED:
            amt = -t.amount_paise        # stored negative; received is positive
            reward_total += amt
            _bump_month(t.occurred_at, amt)
        elif t.txn_type == LedgerTxnType.PREMIUM_COLLECTED:
            amt = -t.amount_paise        # stored negative
            premium_collected_total += amt
            _bump_month(t.occurred_at, amt)
        elif t.txn_type == LedgerTxnType.PREMIUM_PAID_BY_AGENCY:
            amt = -t.amount_paise        # stored negative -> fronted positive
            premium_fronted_total += amt
            _bump_month(t.occurred_at, -amt)
        elif t.txn_type == LedgerTxnType.PARTNER_ADVANCE:
            amt = t.amount_paise         # stored positive (cash out)
            advances_total += amt
            _bump_month(t.occurred_at, -amt)
        elif t.txn_type == LedgerTxnType.REFUND:
            amt = t.amount_paise         # stored positive
            refunds_total += amt
            _bump_month(t.occurred_at, -amt)
        elif t.txn_type == LedgerTxnType.EXPENSE:
            amt = -t.amount_paise        # stored negative
            expenses_total += amt
            _bump_month(t.occurred_at, -amt)

    rewards_paid_total = advances_total
    async for w in WalletTxn.find(
            WalletTxn.type == WalletTxnType.WITHDRAWAL_DEBIT):
        if w.amount_paise >= 0:
            continue                     # skip informational 0 rows
        paid = -w.amount_paise
        rewards_paid_total += paid
        _bump_month(w.created_at, -paid)

    # --- Accrual: house profit from booked policies (PolicyFinance) ---
    expected_reward = 0
    async for pf in PolicyFinance.find_all():
        expected_reward += pf.agency_reward
        if basis == "accrual":
            mk = fr.month_key(_aware(pf.created_at))
            if mk in earn_by_month:
                earn_by_month[mk] += pf.house_profit

    total = sum(earn_by_month.values()) if basis == "accrual" \
        else (premium_collected_total + reward_total
              - premium_fronted_total - rewards_paid_total
              - refunds_total - expenses_total)
    this_month = earn_by_month.get(this_key, 0)
    last_key = keys[-2] if len(keys) >= 2 else this_key
    last_month = earn_by_month.get(last_key, 0)
    last_3 = sum(v for k, v in earn_by_month.items() if k in last3_keys)

    # --- Targets (agency-wide monthly house-profit goals) ---
    # Every target counts, whatever period it was set for: each contributes the
    # slice of its own window that falls in the month, so a quarterly goal
    # shows a third of itself per month instead of everything in its first.
    all_targets = await Target.find_all().to_list()
    target_by_month: dict[str, int] = {}
    for k in keys:
        m_lo, m_hi = tsvc.normalise_period(
            TargetPeriod.MONTH, datetime.strptime(k, "%Y-%m").replace(
                tzinfo=timezone.utc))
        goal = tsvc.prorated_goals(all_targets, m_lo, m_hi).get(
            TargetMetric.HOUSE_PROFIT.value, 0)
        if goal:
            target_by_month[k] = goal
    monthly = [MonthPoint(month=k, earnings=earn_by_month[k],
                          target=target_by_month.get(k)) for k in keys]

    # --- Pending balances (point in time) ---
    pending = await _pending_block(expected_reward, reward_total)
    aging = await _aging_block(now)

    fy_start = datetime(fr.fy_start_year(now), 4, 1, tzinfo=fr.IST)
    fy_earnings = sum(
        v for k, v in earn_by_month.items() if k >= fr.month_key(fy_start))

    # TDS withheld by brokers (all-time + this financial year).
    tds_total = tds_fy = 0
    async for e in TdsEntry.find_all():
        tds_total += e.tds_paise
        if _aware(e.occurred_at) >= fy_start:
            tds_fy += e.tds_paise

    return _gate_overview(FinanceOverview(
        basis=basis,
        earnings=EarningsBlock(
            total=total, this_month=this_month, last_month=last_month,
            last_3_months=last_3, growth_pct=fr.growth_pct(this_month, last_month)),
        monthly=monthly, pending=pending, aging=aging,
        fy_label=fr.fy_label(now), fy_earnings=fy_earnings,
        reward_received_total=reward_total,
        rewards_paid_total=rewards_paid_total,
        premium_collected_total=premium_collected_total,
        premium_fronted_total=premium_fronted_total,
        refunds_total=refunds_total, expenses_total=expenses_total,
        tds_deducted_total=tds_total, tds_deducted_fy=tds_fy),
        _can_profit(actor))


# --- Redesigned dashboard (date-filtered) ------------------------------------
@router.get("/dashboard", response_model=FinanceDashboard,
            dependencies=[Depends(require_permission(VIEW_FINANCE_OVERVIEW))])
async def finance_dashboard_view(
    period: str = Query(default="current_month"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    target_metric: TargetMetric = Query(default=TargetMetric.HOUSE_PROFIT),
    target_employee_id: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> FinanceDashboard:
    """The Finance Overview.

    `target_metric` picks which goal the Performance-vs-Target graph plots;
    actual and target always come back in that metric's own units so the two
    bars are comparable. `target_employee_id` narrows that graph to one
    person — omit it for the company total."""
    if period not in fr.PERIODS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown period '{period}'.")
    res = await finance_dashboard.compute_dashboard(
        period, utcnow(), _parse_dt(date_from),
        _end_of_day(date_to), target_metric, target_employee_id)
    return _gate_dashboard(FinanceDashboard(
        period=res["period"], period_label=res["period_label"],
        date_from=res["date_from"], date_to=res["date_to"],
        net_profit_30d=res["net_profit_30d"],
        earnings=DashboardEarnings(**res["earnings"]),
        granularity=res["granularity"],
        series=[SeriesPoint(**m) for m in res["series"]],
        target_metric=res["target_metric"],
        target_metric_label=res["target_metric_label"],
        target_is_money=res["target_is_money"],
        has_targets=res["has_targets"],
        target_employee_id=res["target_employee_id"],
        top_employees=[TopPerformer(**r) for r in res["top_employees"]],
        top_partners=[TopPerformer(**r) for r in res["top_partners"]],
        top_brokers=[TopPerformer(**r) for r in res["top_brokers"]],
        top_categories=[TopPerformer(**r) for r in res["top_categories"]],
        employee_targets=[EmployeeTarget(**r)
                          for r in res["employee_targets"]],
        pending=DashboardPending(**res["pending"])),
        _can_profit(actor))


# --- Reports insights (date + entity filtered) -------------------------------
@router.get("/insights", response_model=InsightsResult,
            dependencies=[Depends(require_permission(VIEW_FINANCE_OVERVIEW))])
async def finance_insights_view(
    period: str = Query(default="this_year"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    insurer_id: str | None = Query(default=None),
    category_key: str | None = Query(default=None),
    partner_id: str | None = Query(default=None),
    employee_id: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> InsightsResult:
    if period not in fr.PERIODS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown period '{period}'.")
    res = await finance_insights.compute_insights(
        period, utcnow(), _parse_dt(date_from), _end_of_day(date_to),
        insurer_id=insurer_id or None, category_key=category_key or None,
        partner_id=partner_id or None, employee_id=employee_id or None)
    return _gate_insights(InsightsResult(**res), _can_profit(actor))


# --- Balance sheets ----------------------------------------------------------
@router.get("/balance-sheet/{section}", response_model=Page[BalanceSheetItem],
            dependencies=[Depends(require_permission(VIEW_BALANCE_SHEET))])
async def balance_sheet_list(
    section: str,
    period: str = Query(default="this_year"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    sort: str = Query(default="premium"),
    order: str = Query(default="desc", pattern="^(asc|desc)$"),
    q: str | None = Query(default=None, description="Search name / code"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    actor: User = Depends(get_active_user),
) -> Page[BalanceSheetItem]:
    """The left-hand broker/partner/customer roster on the Balance Sheet page.

    Paginated server-side (owner 2026-09-12) — search and sort still run over
    the WHOLE section (they have to: sorting "who owes the most" requires
    comparing every row, and paging the underlying computation isn't possible
    without a larger finance-read-path rework, see `list_section`'s own
    docstring), only the RESPONSE is sliced to one page.
    """
    if section not in finance_balance.SECTIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown section '{section}'.")
    lo, hi, _label = fr.resolve_period(
        period, utcnow(), _parse_dt(date_from), _end_of_day(date_to))
    rows, total = await finance_balance.list_section_page(
        section, lo, hi, sort, q=q, order=order, page=page,
        page_size=page_size)
    cvp = _can_profit(actor)
    return Page[BalanceSheetItem](
        items=[_gate_balance_item(BalanceSheetItem(**r), cvp) for r in rows],
        total=total, page=page, page_size=page_size)


@router.get("/balance-sheet/{section}/{entity_id}",
            response_model=BalanceSheetDetail,
            dependencies=[Depends(require_permission(VIEW_BALANCE_SHEET))])
async def balance_sheet_detail(
    section: str, entity_id: str,
    period: str = Query(default="this_year"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> BalanceSheetDetail:
    if section not in finance_balance.SECTIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown section '{section}'.")
    lo, hi, _label = fr.resolve_period(
        period, utcnow(), _parse_dt(date_from), _end_of_day(date_to))
    res = await finance_balance.detail_section(section, entity_id, lo, hi)
    return _gate_balance_detail(BalanceSheetDetail(**res), _can_profit(actor))


@router.get("/balance-sheet/{section}/{entity_id}/statement.pdf",
            dependencies=[Depends(require_permission(VIEW_BALANCE_SHEET))])
async def statement_pdf_download(
    section: str, entity_id: str,
    period: str = Query(default="this_year"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> StreamingResponse:
    """Server-rendered themed PDF statement for a broker / partner / customer."""
    if section not in finance_balance.SECTIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown section '{section}'.")
    from app.services import statement_pdf
    lo, hi, label = fr.resolve_period(
        period, utcnow(), _parse_dt(date_from), _end_of_day(date_to))
    # Statement No. dropped from the document (owner 2026-07-24) — the audit log
    # still records every generation.
    res = await finance_balance.build_statement(
        section, entity_id, lo, hi, period_label=label)
    pdf = statement_pdf.render_statement_pdf(res)
    filename = res["filename"]
    await log_action(
        AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="statement", entity_id=entity_id,
        summary=f"Generated {section} statement for "
                f"{res.get('label', entity_id)}")
    return StreamingResponse(
        iter([pdf]), media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.post("/balance-sheet/{section}/{entity_id}/statement/whatsapp",
             dependencies=[Depends(require_permission(VIEW_BALANCE_SHEET))])
async def statement_send_whatsapp(
    section: str, entity_id: str,
    period: str = Query(default="this_year"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> dict:
    """Generate the statement PDF, stash it in S3 and WhatsApp it to the party.

    Only customers and channel partners (broker statements are internal). No-ops
    with a clear reason until WhatsApp + a statement template are configured."""
    if section not in ("partner", "customer"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Statements can only be sent to customers or partners.")
    from starlette.concurrency import run_in_threadpool
    from app.config import settings as app_settings
    from app.services import s3, statement_pdf, messaging

    lo, hi, label = fr.resolve_period(
        period, utcnow(), _parse_dt(date_from), _end_of_day(date_to))
    res = await finance_balance.build_statement(
        section, entity_id, lo, hi, period_label=label)
    mobile = res.get("mobile")
    if not mobile:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This party has no mobile number on file.")
    pdf = statement_pdf.render_statement_pdf(res)
    filename = res["filename"]
    key = s3.build_key("statement", entity_id, filename)
    await run_in_threadpool(
        s3.get_s3_client().put_object,
        Bucket=app_settings.aws_bucket_name, Key=key, Body=pdf,
        ContentType="application/pdf")
    doc_url = s3.presigned_download(key, filename, expires_in=7 * 24 * 3600)
    result = await messaging.send_statement_document(
        mobile=mobile, name=res.get("label", ""), doc_url=doc_url,
        filename=filename, period_label=label, kind=section,
        related_id=entity_id)
    await log_action(
        AuditAction.PAYMENT_RECORDED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="statement", entity_id=entity_id,
        summary=f"Sent {section} statement on WhatsApp to "
                f"{res.get('label', entity_id)}")
    return result


async def _pending_block(expected_reward: int,
                         reward_received: int) -> PendingBlock:
    cust = part = 0
    async for a in PartyAccount.find(
            PartyAccount.party_type == PartyType.CUSTOMER):
        if a.balance_paise > 0:
            cust += a.balance_paise
    async for a in PartyAccount.find(
            PartyAccount.party_type == PartyType.CHANNEL_PARTNER):
        if a.balance_paise > 0:
            part += a.balance_paise

    reward_owed = 0
    async for w in Wallet.find_all():
        reward_owed += w.available_paise + w.pending_paise

    return PendingBlock(
        collection_customers=cust, collection_partners=part,
        reward_brokers=max(0, expected_reward - reward_received),
        rewards_partners=reward_owed)


async def _aging_block(now: datetime) -> AgingBlock:
    """Age premium receivables by their PREMIUM_DUE posting date."""
    b = {"0_30": 0, "30_60": 0, "60_plus": 0}
    async for t in LedgerTxn.find(
            LedgerTxn.txn_type == LedgerTxnType.PREMIUM_DUE):
        if t.amount_paise <= 0:
            continue
        days = (now - _aware(t.occurred_at)).days
        b[fr.aging_bucket(days)] += t.amount_paise
    return AgingBlock(bucket_0_30=b["0_30"], bucket_30_60=b["30_60"],
                      bucket_60_plus=b["60_plus"])


@router.get("/tds", response_model=TdsReport,
            dependencies=[Depends(require_permission(VIEW_TDS))])
async def tds_report(
    period: str = Query(default="this_year"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    _: User = Depends(get_active_user),
) -> TdsReport:
    """TDS brokers withheld on our reward, for the window (default: this FY)."""
    lo, hi, label = fr.resolve_period(
        period, utcnow(), _parse_dt(date_from), _end_of_day(date_to))
    res = await finance_tds.compute_tds_report(lo, hi, fy_label=label)
    return TdsReport(**res)


@router.get("/policy/{policy_id}", response_model=PolicyFinanceOut,
            dependencies=[Depends(require_any_permission(*FINANCE_VIEW_ANY))])
async def get_policy_finance(policy_id: str,
                             actor: User = Depends(get_active_user)
                             ) -> PolicyFinanceOut:
    pf = await PolicyFinance.find_one(PolicyFinance.policy_id == policy_id)
    if pf is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "No finance booked for this policy yet.")
    out = PolicyFinanceOut.from_model(pf)
    if not _can_profit(actor):
        out.house_profit = 0
    return out


@router.get("/parties", response_model=list[PartyAccountOut],
            dependencies=[Depends(require_any_permission(*FINANCE_VIEW_ANY))])
async def list_parties(
    party_type: PartyType | None = Query(default=None),
    outstanding_only: bool = Query(default=False),
    _: User = Depends(get_active_user),
) -> list[PartyAccountOut]:
    query: dict = {}
    if party_type:
        query["party_type"] = party_type.value
    if outstanding_only:
        query["balance_paise"] = {"$ne": 0}
    items = await PartyAccount.find(query).sort("-updated_at").to_list()
    names = await _party_names({_party_key(a) for a in items})
    return [PartyAccountOut.from_model(a, party_name=names.get(_party_key(a)))
            for a in items]


@router.get("/partner-dues", response_model=list[PartnerDuesOut],
            dependencies=[Depends(require_any_permission(*FINANCE_VIEW_ANY))])
async def partner_dues(
    outstanding_only: bool = Query(default=False),
    _: User = Depends(get_active_user),
) -> list[PartnerDuesOut]:
    """Per-partner reward owed (wallet) + premium balance (party ledger) for the
    Payments page."""
    partners = await User.find(
        {"account_type": AccountType.CHANNEL_PARTNER.value,
         "is_deleted": {"$ne": True}}).to_list()
    if not partners:
        return []
    ids = [str(p.id) for p in partners]
    wallets = {w.partner_id: w for w in await Wallet.find(
        {"partner_id": {"$in": ids}}).to_list()}
    accounts = {a.party_id: a for a in await PartyAccount.find(
        {"party_type": PartyType.CHANNEL_PARTNER.value,
         "party_id": {"$in": ids}}).to_list()}

    rows: list[PartnerDuesOut] = []
    for p in partners:
        pid = str(p.id)
        w = wallets.get(pid)
        a = accounts.get(pid)
        row = PartnerDuesOut(
            partner_id=pid, partner_name=p.full_name, partner_code=p.code,
            reward_available_paise=w.available_paise if w else 0,
            reward_pending_paise=w.pending_paise if w else 0,
            premium_balance_paise=a.balance_paise if a else 0,
        )
        if outstanding_only and not (row.reward_available_paise
                                     or row.reward_pending_paise
                                     or row.premium_balance_paise):
            continue
        rows.append(row)
    # Most reward owed first.
    rows.sort(key=lambda d: d.reward_available_paise + d.reward_pending_paise,
              reverse=True)
    return rows


@router.get("/reports", response_model=ReportResult,
            dependencies=[Depends(require_permission(VIEW_REPORTS))])
async def finance_reports(
    dimension: str = Query(default="insurer"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> ReportResult:
    if dimension not in finance_agg.DIMENSIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown dimension '{dimension}'.")
    res = await finance_agg.compute_report(
        dimension, _parse_dt(date_from), _parse_dt(date_to))
    return _gate_reports(ReportResult(
        dimension=res["dimension"], totals=ReportTotals(**res["totals"]),
        rows=[ReportRow(**r) for r in res["rows"]]), _can_profit(actor))


@router.get("/entity/{entity_type}/{entity_id}", response_model=EntityProfile,
            dependencies=[Depends(require_any_permission(*FINANCE_VIEW_ANY))])
async def finance_entity(entity_type: str, entity_id: str,
                         actor: User = Depends(get_active_user)) -> EntityProfile:
    if entity_type not in finance_agg._ENTITY_FIELD:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown entity type '{entity_type}'.")
    res = await finance_agg.compute_entity_profile(
        entity_type, entity_id, utcnow())
    return _gate_entity(EntityProfile(
        entity_type=entity_type, entity_id=entity_id, label=res["label"],
        party_type=res["party_type"], metrics=ReportTotals(**res["metrics"]),
        monthly=[EntityMonthPoint(**m) for m in res["monthly"]],
        pending=EntityPending(**res["pending"]),
        policy_status=res["policy_status"]), _can_profit(actor))


@router.get("/ledger", response_model=Page[LedgerTxnOut],
            dependencies=[Depends(require_permission(VIEW_TRANSACTIONS))])
async def list_ledger(
    party_type: PartyType | None = Query(default=None),
    party_id: str | None = Query(default=None),
    policy_id: str | None = Query(default=None),
    txn_type: LedgerTxnType | None = Query(default=None),
    # Comma-separated txn types to HIDE (e.g. "premium_due" — the Transactions
    # page hides the balance-position rows; they still drive every balance).
    exclude_types: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    # Which of OUR accounts the money moved through. "none" is the interesting
    # value: rows carrying NO account are the ones a balance can never explain,
    # and there was no way to list them — a legacy row, or one recorded before
    # accounts existed, was invisible until an account disagreed with the bank
    # and nobody could say why.
    bank_account_id: str | None = Query(default=None),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    _: User = Depends(get_active_user),
) -> Page[LedgerTxnOut]:
    query: dict = {}
    if party_type:
        query["party_type"] = party_type.value
    if party_id:
        query["party_id"] = party_id
    if policy_id:
        query["policy_id"] = policy_id
    if bank_account_id == "none":
        # Both shapes: a row written before the field existed has no key at all,
        # and one recorded without an account has it set to null. Matching only
        # one of the two would quietly under-report exactly the rows this filter
        # exists to find.
        query["$and"] = [{"$or": [{"bank_account_id": None},
                                  {"bank_account_id": {"$exists": False}}]}]
    elif bank_account_id:
        query["bank_account_id"] = bank_account_id
    if txn_type:
        query["txn_type"] = txn_type.value
    elif exclude_types:
        excl = [s.strip() for s in exclude_types.split(",") if s.strip()]
        if excl:
            query["txn_type"] = {"$nin": excl}
    created = _date_range(date_from, date_to)
    if created:
        query["occurred_at"] = created   # the (editable) transaction date
    if q and q.strip():
        rx = search_regex(q)
        query["$or"] = [{"reference": rx}, {"note": rx}]
    total = await LedgerTxn.find(query).count()
    items = (await LedgerTxn.find(query).sort("-created_at")
             .skip((page - 1) * page_size).limit(page_size).to_list())
    names = await _party_names({_party_key(t) for t in items})
    accounts = await _bank_names({t.bank_account_id for t in items
                                  if t.bank_account_id})
    return Page[LedgerTxnOut](
        items=[LedgerTxnOut.from_model(
            t, party_name=names.get(_party_key(t)),
            bank_account_name=accounts.get(t.bank_account_id))
            for t in items],
        total=total, page=page, page_size=page_size)


@router.get("/ledger/export",
            dependencies=[Depends(require_permission(VIEW_TRANSACTIONS)),
                          Depends(require_permission(EXPORT_DATA))])
async def export_ledger(
    background: BackgroundTasks,
    actor: User = Depends(get_active_user),
    party_type: PartyType | None = Query(default=None),
    party_id: str | None = Query(default=None),
    txn_type: LedgerTxnType | None = Query(default=None),
    exclude_types: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    # Same values as the list endpoint, and it MUST accept them: an export that
    # ignores a filter the screen is showing hands somebody a spreadsheet that
    # disagrees with the page they downloaded it from.
    bank_account_id: str | None = Query(default=None),
    q: str | None = Query(default=None),
    fmt: str = Query(default="excel", pattern="^(excel|xlsx|csv)$"),
):
    query: dict = {}
    if party_type:
        query["party_type"] = party_type.value
    if party_id:
        query["party_id"] = party_id
    if bank_account_id == "none":
        query["$and"] = [{"$or": [{"bank_account_id": None},
                                  {"bank_account_id": {"$exists": False}}]}]
    elif bank_account_id:
        query["bank_account_id"] = bank_account_id
    if txn_type:
        query["txn_type"] = txn_type.value
    elif exclude_types:
        excl = [s.strip() for s in exclude_types.split(",") if s.strip()]
        if excl:
            query["txn_type"] = {"$nin": excl}
    created = _date_range(date_from, date_to)
    if created:
        query["occurred_at"] = created   # the (editable) transaction date
    if q and q.strip():
        rx = search_regex(q)
        query["$or"] = [{"reference": rx}, {"note": rx}]
    items = await LedgerTxn.find(query).sort("-created_at").limit(20000).to_list()
    names = await _party_names({_party_key(t) for t in items})

    def _party_label(t: LedgerTxn) -> str:
        if _v(t.party_type) == PartyType.EXPENSE.value:
            return (t.paid_to_name or EXPENSE_CATEGORY_LABELS.get(
                t.expense_category or "", "House"))
        return names.get(_party_key(t), "")

    # Collapse the payout+advance pair of a single partner payout into one line
    # (owner 2026-07-18), same as the Transactions page.
    headers = ["Date", "Type", "Party", "Party name", "Amount (Rs)",
               "Reference", "Note", "Policy"]
    rows = ([t.occurred_at.strftime("%Y-%m-%d"),
             ledger_label(t.txn_type, t.party_type),
             _PARTY_TYPE_LABEL.get(_v(t.party_type), _v(t.party_type)),
             _party_label(t), f"{amount / 100:.2f}",
             t.reference or "", t.note or "", t.policy_id or ""]
            for t, amount in merge_partner_payouts(items))
    background.add_task(
        log_action, AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="ledger_txn",
        summary=f"Exported {len(items)} ledger rows ({fmt})")
    return export_response(fmt, "transactions", headers, rows,
                           sheet_title="Transactions")


@router.get("/ledger/{txn_id}", response_model=LedgerTxnDetail,
            dependencies=[Depends(require_permission(VIEW_TRANSACTIONS))])
async def get_ledger_txn(txn_id: str,
                         _: User = Depends(get_active_user)) -> LedgerTxnDetail:
    """One transaction with its linked policy + resolved names, for the
    View-details popup (works for auto rows like premium-paid-by-agency too)."""
    txn = await LedgerTxn.get(await parse_object_id(txn_id))
    if txn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    names = await _party_names({_party_key(txn)})

    async def _get(model, raw_id):
        """Fetch by id, tolerating a missing or malformed (legacy) value."""
        if not raw_id:
            return None
        try:
            return await model.get(PydanticObjectId(raw_id))
        except Exception:  # noqa: BLE001 — malformed legacy id
            return None

    policy_code = policy_number = None
    customer_name = partner_name = broker_name = None

    # The policy has to be resolved before its own references are known, but
    # everything after that is independent — gather them instead of paying five
    # sequential round-trips every time the details popup opens.
    pol, creator = await asyncio.gather(
        _get(Policy, txn.policy_id), _get(User, txn.created_by))
    created_by_name = creator.full_name if creator else None

    if pol is not None:
        policy_code = pol.code
        policy_number = pol.policy_number
        cust, partner, broker = await asyncio.gather(
            _get(Customer, pol.customer_id),
            _get(User, pol.partner_id),
            _get(Broker, pol.broker_id))
        customer_name = cust.name if cust else None
        partner_name = partner.full_name if partner else None
        broker_name = broker.name if broker else None

    base = LedgerTxnOut.from_model(txn, party_name=names.get(_party_key(txn)))
    return LedgerTxnDetail(
        **base.model_dump(),
        policy_code=policy_code, policy_number=policy_number,
        customer_name=customer_name, partner_name=partner_name,
        broker_name=broker_name, created_by_name=created_by_name)


@router.post("/payments", response_model=LedgerTxnOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def record_payment(payload: PaymentCreate,
                         actor: User = Depends(get_active_user)) -> LedgerTxnOut:
    return await _post_payment(payload, actor)


async def _post_payment(payload: PaymentCreate, actor: User) -> LedgerTxnOut:
    """Book ONE money movement, with every rule that goes with it.

    Extracted from the endpoint on 2026-08-19 so the bank-statement import
    (routers/statement_import) books its rows through EXACTLY this path rather
    than through a second copy of it. That matters more here than almost
    anywhere: this function is where the TDS split on a reward receipt happens,
    where the bank delta is derived from the transaction TYPE rather than from
    the stored sign, and where the idempotency key is honoured. A bulk importer
    that re-implemented any one of those would drift from the single-payment
    form within a release, and the two would disagree about the same money.
    """
    if payload.txn_type not in MANUAL_PAYMENT_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"'{payload.txn_type.value}' can't be recorded manually. Auto rows "
            f"come from the policy; expenses and partner payouts "
            f"have their own actions.")
    if payload.policy_id:
        # Validate the referenced policy exists (id must be well-formed).
        pol = await Policy.get(await parse_object_id(payload.policy_id))
        if pol is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")

    # A retry or a double-clicked Save carries the same key: return the row that
    # was already written instead of taking the money twice.
    key = idempotency.clean(payload.idempotency_key)
    if key and (already := await idempotency.existing(key)) is not None:
        return LedgerTxnOut.from_model(already)

    account_id = await _require_bank_account(payload.bank_account_id,
                                             payload.txn_type)

    # TDS is withheld by the broker BEFORE the money reaches us, so the bank is
    # credited net while the ledger records the gross (which is what clears the
    # broker's receivable). Resolve the rate first so the bank delta is right.
    tds_percent = 0
    if (payload.txn_type == LedgerTxnType.REWARD_RECEIVED
            and payload.party_type == PartyType.BROKER):
        broker = await Broker.get(await parse_object_id(payload.party_id))
        tds_percent = broker.tds_percent if broker else 0
    tds_paise = finance_svc.tds_on_reward(payload.amount_paise, tds_percent)

    delta = bank_svc.cash_delta(
        payload.txn_type, payload.amount_paise, tds_paise=tds_paise,
        manual_delta=(payload.bank_direction or 0) * payload.amount_paise)

    txn, created = await finance_svc.record_ledger_txn_ex(
        txn_type=payload.txn_type, party_type=payload.party_type,
        party_id=payload.party_id, amount_paise=_signed_amount(payload),
        policy_id=payload.policy_id, note=payload.note,
        reference=payload.reference,
        occurred_at=_aware(payload.occurred_at) if payload.occurred_at else None,
        created_by=str(actor.id), bank_account_id=account_id,
        bank_delta_paise=delta, idempotency_key=key)
    if not created:
        # Lost the race to an identical request; its side effects already ran.
        return LedgerTxnOut.from_model(txn)

    # Record the TDS separately so the broker's receivable still clears at the
    # gross amount recorded above, while the tax withheld is tracked for the TDS
    # report (owner Q6/Q7) and never reduces house profit.
    if tds_paise > 0:
        await finance_svc.record_reward_tds(
            broker_id=payload.party_id, tds_percent=tds_percent,
            gross_reward_paise=payload.amount_paise,
            policy_id=payload.policy_id, ledger_txn_id=str(txn.id),
            reference=payload.reference,
            note=payload.note or "TDS on reward", created_by=str(actor.id))

    # Keep a policy's settlement status fresh when its premium cash moves.
    if payload.policy_id and payload.txn_type in (
            LedgerTxnType.PREMIUM_COLLECTED, LedgerTxnType.PREMIUM_TO_INSURER):
        await _refresh_policy_settlement(payload.policy_id)

    await log_action(
        AuditAction.PAYMENT_RECORDED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="ledger_txn", entity_id=str(txn.id),
        summary=f"Recorded {payload.txn_type.value} "
                f"(₹{payload.amount_paise / 100:,.2f}) "
                f"for {payload.party_type.value}",
        meta={"policy_id": payload.policy_id},
    )
    return LedgerTxnOut.from_model(txn)


EXPENSE_HOUSE_PARTY = "house"   # party_id sentinel for house expenses


@router.post("/expenses", response_model=LedgerTxnOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def record_expense(payload: ExpenseCreate,
                         actor: User = Depends(get_active_user)) -> LedgerTxnOut:
    """Log a house expense (salary, rent, office, …). Stored as an EXPENSE ledger
    row with no counterparty position; subtracted from realised net profit."""
    return await _post_expense(payload, actor)


async def _post_expense(payload: ExpenseCreate, actor: User) -> LedgerTxnOut:
    """The body of `record_expense`. Shared with the statement import for the
    same reason `_post_payment` is — see its docstring."""
    if payload.category not in EXPENSE_CATEGORIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Unknown expense category.")
    if payload.paid_to_employee_id:
        emp = await User.get(await parse_object_id(payload.paid_to_employee_id))
        if emp is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown employee.")

    key = idempotency.clean(payload.idempotency_key)
    if key and (already := await idempotency.existing(key)) is not None:
        return LedgerTxnOut.from_model(already)
    account_id = await _require_bank_account(payload.bank_account_id,
                                             LedgerTxnType.EXPENSE)
    delta = bank_svc.cash_delta(LedgerTxnType.EXPENSE, payload.amount_paise)

    txn = LedgerTxn(
        txn_type=LedgerTxnType.EXPENSE, party_type=PartyType.EXPENSE,
        party_id=payload.paid_to_employee_id or EXPENSE_HOUSE_PARTY,
        amount_paise=-abs(payload.amount_paise),        # outflow
        note=payload.note, reference=payload.reference,
        # _aware, like every other date this router stores. A client sending
        # "2026-07-01" parses to a NAIVE datetime; mixing those with the
        # tz-aware values everywhere else breaks the IST month bucketing and
        # raises "can't compare offset-naive and offset-aware datetimes".
        occurred_at=(_aware(payload.occurred_at) if payload.occurred_at
                     else utcnow()),
        expense_category=payload.category,
        paid_to_employee_id=payload.paid_to_employee_id,
        paid_to_name=payload.paid_to_name,
        attachment_doc_id=payload.attachment_doc_id,
        bank_account_id=account_id,
        bank_delta_paise=delta if account_id else None,
        idempotency_key=key,
        created_by=str(actor.id))
    txn, created = await idempotency.insert_once(txn)
    if not created:
        return LedgerTxnOut.from_model(txn)
    if account_id:
        await bank_svc.apply_delta(account_id, delta, txn.occurred_at)
    await log_action(
        AuditAction.PAYMENT_RECORDED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="ledger_txn", entity_id=str(txn.id),
        summary=f"Recorded expense {payload.category} "
                f"(Rs {payload.amount_paise / 100:,.2f})")
    return LedgerTxnOut.from_model(txn)


@router.patch("/expenses/{txn_id}", response_model=LedgerTxnOut,
              dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def edit_expense(txn_id: str, payload: ExpenseUpdate,
                       actor: User = Depends(get_active_user)) -> LedgerTxnOut:
    txn = await LedgerTxn.get(await parse_object_id(txn_id))
    if txn is None or txn.txn_type != LedgerTxnType.EXPENSE:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Expense not found.")
    if payload.category and payload.category not in EXPENSE_CATEGORIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Unknown expense category.")
    before = {
        "amount_paise": txn.amount_paise, "category": txn.expense_category,
        "note": txn.note, "reference": txn.reference,
        "occurred_at": txn.occurred_at, "paid_to_name": txn.paid_to_name,
        "paid_to_employee_id": txn.paid_to_employee_id,
    }
    if payload.amount_paise is not None:
        txn.amount_paise = -abs(payload.amount_paise)
    for field in ("category", "note", "occurred_at", "paid_to_employee_id",
                  "paid_to_name", "reference"):
        val = getattr(payload, field)
        if val is not None:
            if field == "occurred_at":
                val = _aware(val)        # same tz rule as record_expense
            setattr(txn, "expense_category" if field == "category" else field, val)
    if payload.paid_to_employee_id is not None:
        txn.party_id = payload.paid_to_employee_id or EXPENSE_HOUSE_PARTY
    await txn.save()

    # The amount and/or the account may have moved, so the bank balance has to
    # follow. repost() backs the OLD delta off the OLD account before applying
    # the new one — editing an expense from 5k to 3k must move the balance by
    # 2k, not by 3k.
    new_account = (payload.bank_account_id
                   if payload.bank_account_id is not None
                   else txn.bank_account_id)
    if new_account or txn.bank_account_id:
        await bank_svc.repost(
            txn, account_id=new_account,
            delta=bank_svc.cash_delta(LedgerTxnType.EXPENSE, txn.amount_paise))

    # Every other money mutation is audited; this one changed the amount, payee
    # and date of a cash outflow and left no trail at all.
    changes = await diff_dict_async(before, {
        "amount_paise": txn.amount_paise, "category": txn.expense_category,
        "note": txn.note, "reference": txn.reference,
        "occurred_at": txn.occurred_at, "paid_to_name": txn.paid_to_name,
        "paid_to_employee_id": txn.paid_to_employee_id,
    })
    await log_action(
        AuditAction.LEDGER_ADJUSTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="ledger_txn", entity_id=str(txn.id),
        summary=f"Edited expense {txn.expense_category} "
                f"(Rs {abs(txn.amount_paise) / 100:,.2f})",
        meta={"changes": changes})
    return LedgerTxnOut.from_model(txn)


@router.post("/ledger/{txn_id}/attachment", response_model=LedgerTxnOut,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def upload_txn_attachment(txn_id: str,
                                background: BackgroundTasks,
                                file: UploadFile = File(...),
                                actor: User = Depends(get_active_user)
                                ) -> LedgerTxnOut:
    """Attach a proof (payment screenshot / receipt PDF) to any transaction.

    REPLACES rather than accumulates: a row holds exactly one
    `attachment_doc_id`, so a second upload used to orphan the first — its
    DocumentRecord and its S3 object stayed for ever, unreferenced and
    unreachable, and the bucket grew a copy of every badly-photographed receipt
    anybody re-took. The previous file is now removed with the same
    best-effort-S3 / definite-record pattern as deleting a policy.
    """
    from starlette.concurrency import run_in_threadpool
    from app.config import settings as app_settings
    from app.models.document import DocumentRecord
    from app.services import s3

    txn = await LedgerTxn.get(await parse_object_id(txn_id))
    if txn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    data = await read_upload(file, 20 * 1024 * 1024, label="Attachment")
    key = s3.build_key("ledger_txn", txn_id, file.filename or "attachment")
    await run_in_threadpool(
        s3.get_s3_client().put_object,
        Bucket=app_settings.aws_bucket_name, Key=key, Body=data,
        ContentType=file.content_type or "application/octet-stream")
    doc = DocumentRecord(
        entity_type="ledger_txn", entity_id=txn_id, doc_key="attachment",
        label="Transaction attachment", s3_key=key,
        filename=file.filename or "attachment", content_type=file.content_type,
        size_bytes=len(data), status=DocumentStatus.UPLOADED,
        uploaded_by=str(actor.id))
    await doc.insert()
    # Point at the new file BEFORE removing the old one: if this crashes in
    # between, the row keeps a file that exists, which is the safe direction to
    # fail in. The reverse leaves a transaction pointing at nothing.
    previous_id, txn.attachment_doc_id = txn.attachment_doc_id, str(doc.id)
    await txn.save()
    if previous_id and previous_id != str(doc.id):
        try:
            previous = await DocumentRecord.get(
                await parse_object_id(previous_id))
        except HTTPException:      # a malformed legacy id — nothing to clean up
            previous = None
        if previous is not None:
            background.add_task(s3.delete_object, previous.s3_key)
            await previous.delete()
    return LedgerTxnOut.from_model(txn)


@router.patch("/ledger/{txn_id}", response_model=LedgerTxnOut,
              dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def edit_ledger_txn(txn_id: str, payload: LedgerTxnUpdate,
                          actor: User = Depends(get_active_user)
                          ) -> LedgerTxnOut:
    """Edit a ledger row. Amount is a positive magnitude — the original sign
    (receivable vs payable) is preserved. The party balance is recomputed."""
    txn = await LedgerTxn.get(await parse_object_id(txn_id))
    if txn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    _guard_protected(txn)

    # Who the row was about BEFORE the edit. If the party moves, that party's
    # balance has to be rebuilt too — otherwise the money stays counted against
    # someone it no longer concerns, which is a worse state than the mistake
    # being corrected.
    old_party = (txn.party_type, txn.party_id)
    old_account = txn.bank_account_id

    if payload.amount_paise is not None:
        sign = -1 if txn.amount_paise < 0 else 1
        txn.amount_paise = sign * payload.amount_paise
    if payload.note is not None:
        txn.note = payload.note
    if payload.reference is not None:
        txn.reference = payload.reference
    if payload.occurred_at is not None:
        txn.occurred_at = _aware(payload.occurred_at)

    # --- Re-filing the row against the right party (2026-08-19) --------------
    # Right money, wrong customer is one of the two mistakes people actually
    # make keying a payment, and it had no correction: the only route was to
    # delete the row and re-enter it, losing the audit trail and any attachment.
    if (payload.party_type is None) != (payload.party_id is None):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Moving a transaction needs both the party type and the party.")
    if payload.party_type is not None and payload.party_id:
        if payload.party_type == PartyType.EXPENSE:
            # An expense has no counterparty position; its own editor
            # (PATCH /expenses/{id}) owns the category and the payee.
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "A transaction can't be moved onto the house. Edit it as an "
                "expense instead.")
        if not await _party_exists(payload.party_type, payload.party_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "That party could not be found.")
        txn.party_type = payload.party_type
        txn.party_id = payload.party_id

    # --- Re-filing the row against the right ACCOUNT ------------------------
    # The other mistake: right money, wrong bank. Editing an EXPENSE could
    # already do this; nothing else could, so a ₹1,00,000 receipt keyed against
    # ICICI when it landed in HDFC left both accounts permanently wrong.
    # "" clears the account (a legacy row that never had one); None leaves it.
    if payload.bank_account_id is not None:
        account_id = payload.bank_account_id.strip() or None
        if account_id and await bank_svc.get_account(account_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "That bank account could not be found.")
        txn.bank_account_id = account_id

    await txn.save()

    # A changed amount changes what hit the bank. Recompute the delta from the
    # (possibly new) amount and repost it — for a reward receipt that means
    # re-deriving the TDS split too, since the bank only ever saw the net.
    #
    # `old_account` is what repost() has to back the money OFF, and the row now
    # carries the new one — so unpost() would credit the wrong account. Restore
    # the old id for the length of the call and let repost() move it.
    if txn.bank_account_id or old_account:
        tds = 0
        if txn.txn_type == LedgerTxnType.REWARD_RECEIVED:
            entry = await TdsEntry.find_one(
                TdsEntry.ledger_txn_id == str(txn.id))
            if entry is not None:
                tds = finance_svc.tds_on_reward(abs(txn.amount_paise),
                                                entry.tds_percent)
        # An adjustment's direction was chosen by whoever recorded it — keep it
        # and apply the new magnitude, rather than re-guessing from the type.
        direction = 1 if (txn.bank_delta_paise or 0) >= 0 else -1
        new_account, txn.bank_account_id = txn.bank_account_id, old_account
        await bank_svc.repost(
            txn, account_id=new_account,
            delta=bank_svc.cash_delta(
                txn.txn_type, txn.amount_paise, tds_paise=tds,
                manual_delta=direction * abs(txn.amount_paise)))

    await finance_svc.recompute_party_account(txn.party_type, txn.party_id)
    if old_party != (txn.party_type, txn.party_id):
        # The party it USED to be filed against, or the correction leaves the
        # money sitting on someone it no longer concerns.
        await finance_svc.recompute_party_account(*old_party)
    if txn.policy_id:
        await _refresh_policy_settlement(txn.policy_id)
    # Keep the paired TDS entry in sync when a reward receipt is edited.
    if txn.txn_type == LedgerTxnType.REWARD_RECEIVED:
        await _sync_tds_for_edit(txn)

    await log_action(
        AuditAction.LEDGER_ADJUSTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="ledger_txn", entity_id=str(txn.id),
        summary=f"Edited {txn.txn_type.value} "
                f"(₹{abs(txn.amount_paise) / 100:,.2f}) "
                f"for {txn.party_type.value}",
        meta={"policy_id": txn.policy_id})
    names = await _party_names({_party_key(txn)})
    return LedgerTxnOut.from_model(txn, party_name=names.get(_party_key(txn)))


@router.post("/ledger/{txn_id}/cancel", response_model=LedgerTxnOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def cancel_ledger_txn(txn_id: str,
                            actor: User = Depends(get_active_user)
                            ) -> LedgerTxnOut:
    """Reverse a ledger row by posting an equal-and-opposite entry OF THE SAME
    TYPE, keeping both for the audit trail. Same-type reversal matters: every
    cash aggregate (reward received, premium collected, refunds, expenses)
    sums rows by type, so an ADJUSTMENT reversal would fix the balance but leave
    those totals overstated. The party balance is recomputed."""
    txn = await LedgerTxn.get(await parse_object_id(txn_id))
    if txn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    _guard_protected(txn)
    _guard_reversal(txn)

    reversal = await finance_svc.record_ledger_txn(
        txn_type=txn.txn_type, party_type=txn.party_type,
        party_id=txn.party_id, amount_paise=-txn.amount_paise,
        policy_id=txn.policy_id,
        note=f"Reversal of {txn.txn_type.value}"
             + (f" ({txn.reference})" if txn.reference else ""),
        reference=str(txn.id), created_by=str(actor.id),
        reversal_of=str(txn.id),
        # The money goes back to the account it came from, by exactly what left
        # it — never re-derived from the type, so a reward receipt's reversal
        # takes back the NET amount the bank actually received.
        bank_account_id=txn.bank_account_id,
        bank_delta_paise=-(txn.bank_delta_paise or 0))
    # Pair the two rows so neither can be cancelled again.
    txn.reversed_by = str(reversal.id)
    await txn.save()
    if txn.policy_id:
        await _refresh_policy_settlement(txn.policy_id)
    # Cancelling a reward receipt also reverses the TDS it booked.
    if txn.txn_type == LedgerTxnType.REWARD_RECEIVED:
        await _reverse_tds_for_txn(txn, reversal_txn_id=str(reversal.id),
                                   actor_id=str(actor.id))
    # An expense reversal keeps the category so per-category totals net out.
    if txn.txn_type == LedgerTxnType.EXPENSE:
        reversal.expense_category = txn.expense_category
        reversal.paid_to_employee_id = txn.paid_to_employee_id
        reversal.paid_to_name = txn.paid_to_name
        await reversal.save()

    await log_action(
        AuditAction.LEDGER_ADJUSTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="ledger_txn", entity_id=str(txn.id),
        summary=f"Cancelled {txn.txn_type.value} "
                f"(₹{abs(txn.amount_paise) / 100:,.2f}) "
                f"for {txn.party_type.value}",
        meta={"reversal_id": str(reversal.id)})
    return LedgerTxnOut.from_model(reversal)


@router.delete("/ledger/{txn_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def delete_ledger_txn(txn_id: str,
                            actor: User = Depends(get_active_user)) -> Message:
    """Hard-delete a ledger row and recompute the party balance.

    Returning the confirmation matters: the annotation is FastAPI's response
    model, so a handler that falls off the end sends `None`, fails response
    validation and raises a 500 — AFTER the row is already gone. That is what
    made a successful delete look like a server error, and (because the client
    took the error branch) left the list showing a transaction that no longer
    existed until the page was reloaded.
    """
    txn = await LedgerTxn.get(await parse_object_id(txn_id))
    if txn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    _guard_protected(txn)
    party_type, party_id = txn.party_type, txn.party_id
    policy_id, txn_type, amount = txn.policy_id, txn.txn_type, txn.amount_paise
    # A deleted reward receipt takes its paired TDS entries with it.
    if txn.txn_type == LedgerTxnType.REWARD_RECEIVED:
        async for e in TdsEntry.find(TdsEntry.ledger_txn_id == str(txn.id)):
            await e.delete()
    # Take the money back off the bank account BEFORE the row goes, or the
    # balance keeps an effect whose evidence no longer exists.
    await bank_svc.unpost(txn)
    await txn.delete()
    await finance_svc.recompute_party_account(party_type, party_id)
    if policy_id:
        await _refresh_policy_settlement(policy_id)

    await log_action(
        AuditAction.LEDGER_ADJUSTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="ledger_txn", entity_id=txn_id,
        summary=f"Deleted {txn_type.value} (₹{abs(amount) / 100:,.2f}) "
                f"for {party_type.value}",
        meta={"policy_id": policy_id})
    return Message(detail="Transaction deleted.")


async def _refresh_policy_settlement(policy_id: str) -> None:
    pf = await PolicyFinance.find_one(PolicyFinance.policy_id == policy_id)
    if pf is None:
        return
    collected = await _sum_collected(policy_id)
    receivable = finance_svc.premium_receivable(
        pf.payer, pf.gross_premium, pf.discount)
    pf.premium_collected = collected
    pf.settlement_status = finance_svc.settlement_status(receivable, collected)
    pf.updated_at = utcnow()
    await pf.save()


async def _sum_collected(policy_id: str) -> int:
    """Premium cash cleared against a policy (stored negative; same-type
    reversals net out)."""
    txns = await LedgerTxn.find(
        {"policy_id": policy_id,
         "txn_type": LedgerTxnType.PREMIUM_COLLECTED.value}).to_list()
    return sum(-t.amount_paise for t in txns)


async def _sync_tds_for_edit(txn: LedgerTxn) -> None:
    """Re-derive the TDS entry paired with an edited reward receipt so the
    TDS report keeps matching the (new) gross amount."""
    gross = -txn.amount_paise if txn.amount_paise < 0 else txn.amount_paise
    entries = await TdsEntry.find(
        TdsEntry.ledger_txn_id == str(txn.id)).to_list()
    for e in entries:
        e.gross_reward_paise = gross
        e.tds_paise = finance_svc.tds_on_reward(gross, e.tds_percent)
        e.reference = txn.reference
        e.occurred_at = txn.occurred_at
        await e.save()


async def _reverse_tds_for_txn(txn: LedgerTxn, *, reversal_txn_id: str,
                               actor_id: str) -> None:
    """Post mirror (negative) TDS entries for a cancelled reward receipt so
    the TDS report nets to zero while keeping the audit trail."""
    entries = await TdsEntry.find(
        TdsEntry.ledger_txn_id == str(txn.id)).to_list()
    for e in entries:
        await TdsEntry(
            broker_id=e.broker_id, policy_id=e.policy_id,
            ledger_txn_id=reversal_txn_id,
            gross_reward_paise=-e.gross_reward_paise,
            tds_percent=e.tds_percent, tds_paise=-e.tds_paise,
            note=f"Reversal of TDS on cancelled reward ({e.reference})"
            if e.reference else "Reversal of TDS on cancelled reward",
            reference=str(e.id), created_by=actor_id,
        ).insert()
