"""Dashboard stats and reports (renewals, expiry, partner performance, funnel)
with CSV export."""

from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_any_permission,
    require_permission,
)
from app.core.enums import (
    AccountType,
    AuditAction,
    LeadStage,
    PolicyStatus,
    RewardStatus,
)
from app.core.permissions import (
    can,
    can_any,
    EXPORT_DATA,
    MANAGE_TRANSACTIONS,
    VIEW_AGENCY_PROFIT,
    FINANCE_VIEW_ANY,
    VIEW_POLICIES,
    VIEW_REPORTS,
)
from app.models.base import utcnow
from app.services import business_report as report_svc
from app.services import business_report_pdf
from app.services import finance_reports as fr
from app.services import policy_scope
from app.services.finance_reports import IST, PERIODS, month_floor, to_ist
from app.models.customer import Customer
from app.models.insurer import Insurer
from app.models.lead import Lead
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.reward import Reward
from app.models.user import User
from app.models.wallet import Wallet
from app.schemas.report import (
    AnalyticsGroup,
    AnalyticsMetrics,
    AnalyticsResult,
    PartnerPerformanceRow,
    DashboardStats,
    LeadFunnelRow,
    RenewalRow,
    RenewalSummary,
)
from app.services.audit import log_action
from app.services.money import paise_to_rupees

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/reports", tags=["reports"],
                   dependencies=[Depends(get_inhouse_user)])


async def _scope(actor: User) -> dict:
    """CUSTOMERS AND LEADS are unscoped, and deliberately stay so.

    Every in-house user shares the whole customer and lead book; access to them
    is decided by permission flags alone. That is unchanged and is not what the
    2026-08-24 policy scope was about.
    """
    return {}


async def _policy_scope(actor: User) -> dict:
    """POLICIES are scoped (owner 2026-08-24). This is the same clause the
    Policies page applies, in the same shape.

    A REPORT IS A READ OF THE SAME COLLECTION. Scoping the list and leaving the
    dashboard alone would tell an employee "1,240 active policies" over a page
    that shows them thirty — which is both a leak and a number they cannot
    reconcile with anything else on their screen.

    Returns `{}` for anybody exempt, so `_and` leaves their query untouched.
    """
    return await policy_scope.visible_filter(actor) or {}


async def _reward_scope(actor: User) -> dict:
    """The same scope, for the REWARD collection.

    `Reward` carries `owner_user_id` and `partner_id` — the same two fields the
    policy scope's first two clauses match on — so the analytics aggregates can
    be narrowed exactly as the policy counts are. Without this, an employee with
    `view_reports` reads the whole agency's premium and commission by partner
    off a page whose Policies list shows them thirty rows.

    IT DROPS THE JIT CLAUSE, and that is correct rather than an omission: a
    live grant names a POLICY id, which is not a reward id and would match
    nothing. It also should not widen a total — being lent sight of one policy
    for an afternoon is not being lent a share of the month's figures.
    """
    if policy_scope.sees_everything(actor):
        return {}
    me = str(actor.id)
    clauses: list[dict] = [{"owner_user_id": me}]
    partners = await policy_scope.partner_ids_for(me)
    if partners:
        clauses.append({"partner_id": {"$in": partners}})
    return {"$or": clauses}


def _and(scope: dict, extra: dict) -> dict:
    return {"$and": [scope, extra]} if scope else extra


@router.get("/dashboard", response_model=DashboardStats)
async def dashboard(actor: User = Depends(get_active_user)) -> DashboardStats:
    scope = await _scope(actor)
    pscope = await _policy_scope(actor)
    rscope = await _reward_scope(actor)
    now = utcnow()
    # Month-to-date uses the IST month boundary (owner Q-P1).
    month_start = month_floor(now)
    in_30 = now + timedelta(days=30)

    # Every tile is gated on the flag that governs the page it links to. This
    # endpoint carried no permission dependency at all, so a permissionless
    # account received the whole book's size and the agency's commission
    # position. Anything the caller may not see is simply not computed.
    can_policies = can(actor, VIEW_POLICIES)
    can_finance = (can(actor, MANAGE_TRANSACTIONS)
                   or can_any(actor, *FINANCE_VIEW_ANY))
    can_profit = can(actor, VIEW_AGENCY_PROFIT)

    customers = active_policies = leads_open = renewals_due = None
    nb_premium = None
    if can_policies:
        customers = await Customer.find(scope).count()
        active_policies = await Policy.find(
            _and(pscope, {"status": PolicyStatus.ACTIVE.value})).count()
        leads_open = await Lead.find(
            _and(scope, {"stage": {"$nin": [LeadStage.CONVERTED.value,
                                            LeadStage.LOST.value]}})).count()
        renewals_due = await Policy.find(_and(pscope, {
            "status": {"$in": [PolicyStatus.ACTIVE.value,
                               PolicyStatus.RENEWAL_DUE.value]},
            "expiry_date": {"$gte": now, "$lte": in_30},
        })).count()

        # New business premium this month.
        nb_pipeline = [
            {"$match": _and(pscope, {"created_at": {"$gte": month_start}})},
            {"$group": {"_id": None, "sum": {"$sum": "$premium_amount"}}},
        ]
        nb = await Policy.aggregate(nb_pipeline).to_list()
        nb_premium = nb[0]["sum"] if nb else 0

    # Reward totals (agency side) — the agency's own revenue, so view_finance.
    reward_pending = reward_received = None
    if can_finance:
        reward_pending = await _sum_reward(
            rscope, {"status": RewardStatus.PENDING.value}, "agency_amount")
        reward_received = await _sum_reward(
            rscope, {"status": RewardStatus.RECEIVED.value}, "agency_amount")

    profit_mtd = None
    if can_profit:
        profit_mtd = await _sum_reward(
            rscope, {"created_at": {"$gte": month_start}}, "house_amount")

    # --- New dashboard metrics ---------------------------------------------------

    # CALENDAR MONTHS, not rolling 30-day windows (owner 2026-08-07).
    #
    # "Policies done · last 30 days" and "Net profit · last 30 days" answered a
    # question nobody asks. Everyone in this business thinks in months — targets
    # are monthly, brokers settle monthly, the owner asks "how did we do this
    # month" — and a rolling window silently includes a slice of the previous
    # month, so the dashboard never agreed with the Targets page or the monthly
    # report for the same period.
    #
    # Boundaries are IST, like every other reporting boundary in this app.
    # `month_start` is already the IST month floor (declared above); this only
    # needs the month before it, for the growth comparison.
    prev_month_start = month_floor(month_start - timedelta(seconds=1))

    policies_total = None
    policies_mtd = None
    growth_policies_pct = None
    if can_policies:
        # "Policies Done" is a personal scoreboard for an employee and a company
        # one for the owner (owner, 2026-07-26): an executive opening their home
        # page wants to know what THEY sold this month, not what the agency did.
        # The Policies page itself still shows the whole shared book.
        mine = {} if actor.is_owner else {"owner_user_id": str(actor.id)}
        policies_total = await Policy.find(_and(pscope, mine)).count()
        policies_mtd = await Policy.find(
            _and(pscope, {**mine, "created_at": {"$gte": month_start}})).count()
        prev = await Policy.find(_and(pscope, {
            **mine,
            "created_at": {"$gte": prev_month_start, "$lt": month_start}})).count()
        growth_policies_pct = _growth_pct(policies_mtd, prev)

    net_profit_mtd = None
    unrealised_profit = None
    growth_earning_pct = None
    if can_profit:
        # Realised (received) profit: reward received − partner payouts −
        # refunds − expenses. Only money actually in hand counts as profit.
        from app.services import finance_profit as fp
        net_profit_mtd = await fp.net_profit(month_start, now)
        prev_profit = await fp.net_profit(prev_month_start, month_start)
        growth_earning_pct = _growth_pct(net_profit_mtd, prev_profit)
        # Reward still pending to collect from brokers (not yet profit).
        unrealised_profit = await fp.unrealised_reward()

    pending_to_collect = None
    pending_to_pay = None
    if can_finance:
        try:
            from app.services.finance_dashboard import _pending_now
            pend = await _pending_now()
            pending_to_collect = pend.get("to_collect", 0)
            pending_to_pay = pend.get("to_pay", 0)
        except Exception:  # noqa: BLE001 — never fail the dashboard on finance
            pending_to_collect = pending_to_pay = None

    partner_earnings = None
    wallet_available = None
    wallet_pending = None
    if actor.account_type == AccountType.CHANNEL_PARTNER:
        partner_earnings = await _sum_reward(
            {"partner_id": str(actor.id)}, {}, "partner_amount")
        wallet = await Wallet.find_one(Wallet.partner_id == str(actor.id))
        wallet_available = wallet.available_paise if wallet else 0
        wallet_pending = wallet.pending_paise if wallet else 0
    elif can_finance:
        # Total owed to channel partners is a finance figure. The old condition
        # (`can_profit or account_type in (OWNER, EMPLOYEE)`) was always true for
        # an employee, so the `can_profit` half never gated anything.
        partner_earnings = await _sum_reward(scope, {}, "partner_amount")

    return DashboardStats(
        customers=customers,
        active_policies=active_policies,
        leads_open=leads_open,
        renewals_due_30d=renewals_due,
        new_business_premium_mtd=nb_premium,
        reward_pending=reward_pending,
        reward_received=reward_received,
        agency_profit_mtd=profit_mtd,
        partner_earnings=partner_earnings,
        wallet_available=wallet_available,
        wallet_pending=wallet_pending,
        policies_total=policies_total,
        policies_mtd=policies_mtd,
        net_profit_mtd=net_profit_mtd,
        unrealised_profit=unrealised_profit,
        pending_to_collect=pending_to_collect,
        pending_to_pay=pending_to_pay,
        growth_policies_pct=growth_policies_pct,
        growth_earning_pct=growth_earning_pct,
    )


def _growth_pct(current: int, previous: int) -> float | None:
    """Percentage growth of current vs previous. None when there's no baseline."""
    if previous <= 0:
        return None if current == 0 else 100.0
    return round((current - previous) / previous * 100, 1)


async def _sum_reward(scope: dict, extra: dict, field: str) -> int:
    match = _and(scope, extra) if extra else scope
    pipeline = [
        {"$match": match} if match else {"$match": {}},
        {"$group": {"_id": None, "sum": {"$sum": f"${field}"}}},
    ]
    res = await Reward.aggregate(pipeline).to_list()
    return int(res[0]["sum"]) if res else 0


@router.get("/renewals", response_model=list[RenewalRow],
            dependencies=[Depends(require_permission(VIEW_REPORTS))])
async def renewals(
    actor: User = Depends(get_active_user),
    days: int = Query(default=30, ge=1, le=365),
) -> list[RenewalRow]:
    return await _renewal_rows(actor, days)


async def _renewal_rows(actor: User, days: int) -> list[RenewalRow]:
    pscope = await _policy_scope(actor)
    now = utcnow()
    until = now + timedelta(days=days)
    policies = await Policy.find(_and(pscope, {
        "status": {"$in": [PolicyStatus.ACTIVE.value,
                           PolicyStatus.RENEWAL_DUE.value]},
        "expiry_date": {"$gte": now, "$lte": until},
    })).sort("+expiry_date").to_list()

    rows: list[RenewalRow] = []
    for p in policies:
        cust = await Customer.get(p.customer_id)
        days_left = None
        if p.expiry_date:
            exp = p.expiry_date
            if exp.tzinfo is None:
                from datetime import timezone
                exp = exp.replace(tzinfo=timezone.utc)
            days_left = (exp - now).days
        rows.append(RenewalRow(
            policy_id=str(p.id), policy_code=p.code, customer_id=p.customer_id,
            customer_name=cust.name if cust else "-",
            category_key=p.category_key,
            expiry_date=p.expiry_date.isoformat() if p.expiry_date else None,
            days_left=days_left, premium_amount=p.premium_amount,
        ))
    return rows


@router.get("/renewal-summary", response_model=RenewalSummary,
            dependencies=[Depends(require_permission(VIEW_REPORTS))])
async def renewal_summary(
    actor: User = Depends(get_active_user),
    window_days: int = Query(default=90, ge=7, le=365),
) -> RenewalSummary:
    pscope = await _policy_scope(actor)
    now = utcnow()
    in_30 = now + timedelta(days=30)
    since = now - timedelta(days=window_days)

    due = await Policy.find(_and(pscope, {
        "status": {"$in": [PolicyStatus.ACTIVE.value,
                           PolicyStatus.RENEWAL_DUE.value]},
        "expiry_date": {"$gte": now, "$lte": in_30},
    })).to_list()
    due_premium = sum(p.premium_amount for p in due)

    renewed = await Policy.find(_and(pscope, {
        "status": PolicyStatus.RENEWED.value,
        "updated_at": {"$gte": since},
    })).count()
    lapsed = await Policy.find(_and(pscope, {
        "status": {"$in": [PolicyStatus.LAPSED.value,
                           PolicyStatus.EXPIRED.value]},
        "updated_at": {"$gte": since},
    })).count()
    denom = renewed + lapsed
    rate = round(renewed / denom, 4) if denom else None

    return RenewalSummary(
        due_30d=len(due), due_30d_premium=due_premium,
        renewed_window=renewed, lapsed_window=lapsed,
        renewal_rate=rate, window_days=window_days,
    )


_GROUP_FIELDS = {
    "category": "$category_key",
    "insurer": "$insurer_id",
    "partner": "$partner_id",
    "subcategory": "$subcategory_key",
    # Group by IST month so buckets match the rest of the app (owner Q-P1).
    "month": {"$dateToString": {"format": "%Y-%m", "date": "$created_at",
                                "timezone": "Asia/Kolkata"}},
}


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


async def _analytics(actor: User, *, group_by: str, date_from: str | None,
                     date_to: str | None, insurer_id: str | None,
                     category_key: str | None, partner_id: str | None
                     ) -> AnalyticsResult:
    rscope = await _reward_scope(actor)
    filters: dict = {}
    created: dict = {}
    if (df := _parse_dt(date_from)):
        created["$gte"] = df
    if (dt := _parse_dt(date_to)):
        created["$lte"] = dt
    if created:
        filters["created_at"] = created
    if insurer_id:
        filters["insurer_id"] = insurer_id
    if category_key:
        filters["category_key"] = category_key
    if partner_id:
        filters["partner_id"] = partner_id

    match = _and(rscope, filters) if filters else (rscope or {})
    group_field = _GROUP_FIELDS.get(group_by, _GROUP_FIELDS["category"])
    pipeline = [
        {"$match": match} if match else {"$match": {}},
        {"$group": {
            "_id": group_field,
            "policies": {"$sum": 1},
            "premium": {"$sum": "$premium_amount"},
            "commissionable": {"$sum": "$commissionable_premium"},
            "agency_reward": {"$sum": "$agency_amount"},
            "partner_payout": {"$sum": "$partner_amount"},
            "house": {"$sum": "$house_amount"},
        }},
        {"$sort": {"premium": -1}},
    ]
    raw = await Reward.aggregate(pipeline).to_list()

    # House profit is the agency's own margin: zeroed server-side (not merely
    # hidden by the UI) for anyone without view_agency_profit, exactly as the
    # finance endpoints do it. Reports used to hand it to every view_reports
    # holder, which quietly defeated that permission.
    can_profit = can(actor, VIEW_AGENCY_PROFIT)
    gate = (lambda v: v) if can_profit else (lambda _v: 0)

    labels = await _labels_for(group_by, [r["_id"] for r in raw])
    groups: list[AnalyticsGroup] = []
    totals = dict(policies=0, premium=0, commissionable=0, agency_reward=0,
                  partner_payout=0, house=0)
    for r in raw:
        key = r["_id"]
        for f in totals:
            value = int(r.get(f, 0) or 0)
            totals[f] += gate(value) if f == "house" else value
        groups.append(AnalyticsGroup(
            key=str(key) if key is not None else "—",
            label=labels.get(key, str(key) if key is not None else "In-house"),
            policies=r["policies"], premium=int(r["premium"] or 0),
            commissionable=int(r["commissionable"] or 0),
            agency_reward=int(r["agency_reward"] or 0),
            partner_payout=int(r["partner_payout"] or 0),
            house=gate(int(r["house"] or 0)),
        ))
    return AnalyticsResult(group_by=group_by, totals=AnalyticsMetrics(**totals),
                           groups=groups)


async def _labels_for(group_by: str, keys: list) -> dict:
    ids = [k for k in keys if k]
    if group_by == "insurer":
        return {str(i.id): i.name for i in
                await Insurer.find({"_id": {"$in": ids}}).to_list()} \
            if ids else {}
    if group_by == "partner":
        out = {}
        for pid in ids:
            u = await User.get(pid)
            out[pid] = u.full_name if u else str(pid)
        return out
    if group_by in ("category", "subcategory"):
        cats = await PolicyCategory.find_all().to_list()
        return {c.key: c.label for c in cats}
    return {}


@router.get("/analytics", response_model=AnalyticsResult,
            dependencies=[Depends(require_permission(VIEW_REPORTS))])
async def analytics(
    actor: User = Depends(get_active_user),
    group_by: str = Query(default="category"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    insurer_id: str | None = Query(default=None),
    category_key: str | None = Query(default=None),
    partner_id: str | None = Query(default=None),
) -> AnalyticsResult:
    return await _analytics(
        actor, group_by=group_by, date_from=date_from, date_to=date_to,
        insurer_id=insurer_id, category_key=category_key, partner_id=partner_id)


@router.get("/analytics/export",
            dependencies=[Depends(require_permission(EXPORT_DATA))])
async def export_analytics(
    actor: User = Depends(get_active_user),
    group_by: str = Query(default="category"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    insurer_id: str | None = Query(default=None),
    category_key: str | None = Query(default=None),
    partner_id: str | None = Query(default=None),
) -> StreamingResponse:
    result = await _analytics(
        actor, group_by=group_by, date_from=date_from, date_to=date_to,
        insurer_id=insurer_id, category_key=category_key, partner_id=partner_id)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([group_by.title(), "Policies", "Premium (INR)",
                     "Commissionable (INR)", "Agency reward (INR)",
                     "Partner payout (INR)", "House (INR)"])
    for g in result.groups:
        writer.writerow([g.label, g.policies, paise_to_rupees(g.premium),
                         paise_to_rupees(g.commissionable),
                         paise_to_rupees(g.agency_reward),
                         paise_to_rupees(g.partner_payout),
                         paise_to_rupees(g.house)])
    buf.seek(0)
    await log_action(
        AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        summary=f"Exported analytics ({group_by})",
    )
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=analytics_{group_by}.csv"})


@router.get("/partner-performance", response_model=list[PartnerPerformanceRow],
            dependencies=[Depends(require_permission(VIEW_REPORTS))])
async def partner_performance(actor: User = Depends(get_active_user)
                             ) -> list[PartnerPerformanceRow]:
    pscope = await _policy_scope(actor)
    pipeline = [
        {"$match": _and(pscope, {"partner_id": {"$ne": None}})},
        {"$group": {
            "_id": "$partner_id",
            "policies": {"$sum": 1},
            "total_premium": {"$sum": "$premium_amount"},
        }},
        {"$sort": {"total_premium": -1}},
    ]
    grouped = await Policy.aggregate(pipeline).to_list()
    rows: list[PartnerPerformanceRow] = []
    for g in grouped:
        partner_id = g["_id"]
        partner = await User.get(partner_id) if partner_id else None
        earnings = await _sum_reward(
            {"partner_id": partner_id}, {}, "partner_amount")
        rows.append(PartnerPerformanceRow(
            partner_id=str(partner_id),
            partner_name=partner.full_name if partner else "-",
            policies=g["policies"], total_premium=g["total_premium"],
            partner_earnings=earnings,
        ))
    return rows


@router.get("/lead-funnel", response_model=list[LeadFunnelRow],
            dependencies=[Depends(require_permission(VIEW_REPORTS))])
async def lead_funnel(actor: User = Depends(get_active_user)) -> list[LeadFunnelRow]:
    scope = await _scope(actor)
    rows: list[LeadFunnelRow] = []
    for stage in LeadStage:
        count = await Lead.find(_and(scope, {"stage": stage.value})).count()
        rows.append(LeadFunnelRow(stage=stage.value, count=count))
    return rows


# --- Business report ---------------------------------------------------------------
# One download with everything for a period: the Excel workbook is the data
# (seventeen sheets), the PDF is what gets printed and handed over. See
# services/business_report.


@router.get("/business-report",
            dependencies=[Depends(require_any_permission(*FINANCE_VIEW_ANY)),
                          Depends(require_permission(EXPORT_DATA))])
async def business_report(
    background: BackgroundTasks,
    actor: User = Depends(get_active_user),
    period: str = Query(default="current_month"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    fmt: str = Query(default="excel", pattern="^(excel|xlsx|pdf)$"),
):
    """Download a whole period in one file (owner 2026-08-04).

    The period comes from the SAME presets as every other date filter in the
    app — `current_month`, `last_month`, `last_3_months`, `this_year` (the
    Indian FY), `custom`, and the rest — so the file covers exactly what the
    charts above the button were showing for that choice.

    Gated on view_finance + export_data. Profit is blanked server-side for
    anyone without view_agency_profit, so the report cannot be used as a way
    around that permission.
    """
    lo, hi, label = _report_window(period, date_from, date_to)
    try:
        data = await report_svc.collect(
            lo, hi, can_view_profit=can(actor, VIEW_AGENCY_PROFIT))
    except report_svc.ReportTooLarge as e:
        # A refusal the user can act on, rather than a request that dies
        # half-way through building a file this instance cannot hold.
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, str(e))

    background.add_task(
        log_action, AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        summary=f"Downloaded the {label} business report ({fmt})",
        meta={"policies": len(data["policies"]),
              "transactions": len(data["txns"])})

    stem = report_svc.filename_stem(lo, hi)
    if fmt == "pdf":
        # Both renderers are CPU-bound and synchronous; run them off the event
        # loop so one big report can't stall every other request on this single
        # instance.
        content = await run_in_threadpool(
            business_report_pdf.build_pdf, data, label)
        media = "application/pdf"
        filename = f"{stem}.pdf"
    else:
        content = await run_in_threadpool(
            report_svc.build_workbook, data, label)
        media = ("application/vnd.openxmlformats-officedocument"
                 ".spreadsheetml.sheet")
        filename = f"{stem}.xlsx"
    return StreamingResponse(
        iter([content]), media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# This router got the IST reading first (2026-08-04) and was the only one that
# had it, which is how the Business Report and the Transactions page came to
# disagree about the same picked range. The rule now lives in
# services/finance_reports and every router shares it; the alias is kept so the
# call sites below read unchanged.
_parse_ist = fr.parse_ist_bound


def _report_window(period: str, date_from: str | None, date_to: str | None):
    """Resolve the report's window, in IST like every other reporting boundary."""
    if period not in PERIODS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown period '{period}'. Pick one of: "
            f"{', '.join(sorted(PERIODS))}.")
    lo = fr.parse_ist_bound(date_from)
    # A date with no time means the WHOLE of that day — a range ending "31 Jul"
    # that stopped at midnight would silently drop the last day's business.
    hi = fr.parse_ist_end_of_day(date_to)
    if lo is not None and hi is not None and hi < lo:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "The end of the range is before its start.")
    return report_svc.report_window(period, utcnow(),
                                    date_from=lo, date_to=hi)


@router.get("/renewals/export",
            dependencies=[Depends(require_permission(EXPORT_DATA))])
async def export_renewals(
    actor: User = Depends(get_active_user),
    days: int = Query(default=30, ge=1, le=365),
) -> StreamingResponse:
    rows = await _renewal_rows(actor, days)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Policy Code", "Customer", "Category", "Expiry",
                     "Days Left", "Premium (INR)"])
    for r in rows:
        writer.writerow([r.policy_code, r.customer_name, r.category_key,
                         r.expiry_date or "", r.days_left if r.days_left
                         is not None else "", paise_to_rupees(r.premium_amount)])
    buf.seek(0)
    await log_action(
        AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        summary=f"Exported renewals report ({days}d)",
    )
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition":
                 f"attachment; filename=renewals_{days}d.csv"},
    )
