"""Comprehensive analytics for the Finance > Reports page.

One pass over the small per-agency dataset (policies + frozen PolicyFinance P&L,
joined with customers / leads / rewards / targets) produces every section the
dashboard renders: KPIs, trends, category/insurer splits, mix breakdowns,
renewals & retention, leaderboards, target attainment, reward health, the lead
funnel, and policy-status distribution.

Windowed (volume) metrics respect the selected date range via PolicyFinance
booking date; the time-series trends always span the last 12 months for context.
The optional insurer / category / partner / employee filters narrow which
policies are counted everywhere.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from app.core.enums import (
    LeadStage, LedgerTxnType, PayerType, PolicyStatus, RewardStatus,
    TargetMetric, WalletTxnType, is_inhouse,
)
from app.models.finance import LedgerTxn, PolicyFinance
from app.models.insurer import Insurer
from app.models.lead import Lead
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.reward import Reward
from app.models.target import Target
from app.models.user import User
from app.models.wallet import WalletTxn
from app.services import finance_profit as fp
from app.services import finance_reports as fr
from app.services import targets as tsvc

# Cash multiplier per ledger type (mirrors finance_dashboard): amount * mult
# = signed cash flow, positive in / negative out. Types absent = not cash.
_CASH = {
    LedgerTxnType.REWARD_RECEIVED: -1,        # stored negative -> cash in
    LedgerTxnType.PREMIUM_COLLECTED: -1,      # stored negative -> cash in
    LedgerTxnType.PREMIUM_PAID_BY_AGENCY: 1,  # stored negative -> cash out
    LedgerTxnType.PARTNER_ADVANCE: -1,        # stored positive -> cash out
    LedgerTxnType.REFUND: -1,                 # stored positive -> cash out
    LedgerTxnType.EXPENSE: 1,                 # stored negative -> cash out
}


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _in_window(dt: datetime, lo: datetime, hi: datetime) -> bool:
    dt = _aware(dt)
    return lo <= dt <= hi


def _pct(num: int, den: int) -> Optional[float]:
    return round(num / den * 100, 1) if den else None


def _metric() -> dict:
    return {"policies": 0, "premium": 0, "agency_reward": 0, "reward": 0,
            "profit": 0}


def _bump(agg: dict, pf: PolicyFinance) -> None:
    agg["policies"] += 1
    agg["premium"] += pf.gross_premium
    agg["agency_reward"] += pf.agency_reward
    agg["reward"] += pf.partner_share
    agg["profit"] += pf.house_profit


async def compute_insights(
    period: str, now: datetime,
    date_from: Optional[datetime], date_to: Optional[datetime],
    *, insurer_id: Optional[str] = None, category_key: Optional[str] = None,
    partner_id: Optional[str] = None, employee_id: Optional[str] = None,
) -> dict:
    lo, hi, label = fr.resolve_period(period, now, date_from, date_to)

    policies = {str(p.id): p async for p in Policy.find_all()}
    finances = await PolicyFinance.find_all().to_list()
    users = {str(u.id): u async for u in User.find_all()}
    insurers = {str(i.id): i.name async for i in Insurer.find_all()}
    cat_labels = {c.key: c.label async for c in PolicyCategory.find_all()}

    def passes(pol: Policy) -> bool:
        if insurer_id and pol.insurer_id != insurer_id:
            return False
        if category_key and pol.category_key != category_key:
            return False
        if partner_id and pol.partner_id != partner_id:
            return False
        if employee_id and pol.owner_user_id != employee_id:
            return False
        return True

    # --- Single windowed pass over booked P&L ---
    totals = _metric()
    by_cat: dict[str, dict] = {}
    by_ins: dict[str, dict] = {}
    payer_mix: dict[str, dict] = {}
    buyer_mix = {"direct": {"count": 0, "premium": 0},
                 "channel_partner": {"count": 0, "premium": 0}}
    partner_agg: dict[str, dict] = {}
    employee_agg: dict[str, dict] = {}
    cust_policy_count: dict[str, int] = {}

    keys12 = fr.last_n_month_keys(now, 12)
    trend = {k: {"premium": 0, "profit": 0, "policies": 0} for k in keys12}
    renew_trend = {k: {"new_business": 0, "renewals": 0} for k in keys12}
    cust_trend = {k: {"new": 0, "returning": 0} for k in keys12}

    # Each customer's first-ever policy month (for new-vs-returning).
    first_seen: dict[str, str] = {}
    for pf in finances:
        pol = policies.get(pf.policy_id)
        if pol is None:
            continue
        mk = fr.month_key(_aware(pf.created_at))
        cid = pol.customer_id
        if cid not in first_seen or mk < first_seen[cid]:
            first_seen[cid] = mk

    for pf in finances:
        pol = policies.get(pf.policy_id)
        if pol is None or not passes(pol):
            continue
        mk = fr.month_key(_aware(pf.created_at))
        # 12-month trends (context; not gated by the date window).
        if mk in trend:
            trend[mk]["premium"] += pf.gross_premium
            trend[mk]["profit"] += pf.house_profit
            trend[mk]["policies"] += 1
            if pol.renewed_from_policy_id:
                renew_trend[mk]["renewals"] += 1
            else:
                renew_trend[mk]["new_business"] += 1
            if first_seen.get(pol.customer_id) == mk:
                cust_trend[mk]["new"] += 1
            else:
                cust_trend[mk]["returning"] += 1
        # Windowed aggregations.
        if not _in_window(pf.created_at, lo, hi):
            continue
        _bump(totals, pf)
        by_cat.setdefault(pol.category_key, _metric())
        _bump(by_cat[pol.category_key], pf)
        by_ins.setdefault(pol.insurer_id, _metric())
        _bump(by_ins[pol.insurer_id], pf)
        pk = pol.payer.value if hasattr(pol.payer, "value") else pol.payer
        payer_mix.setdefault(pk, {"count": 0, "premium": 0})
        payer_mix[pk]["count"] += 1
        payer_mix[pk]["premium"] += pf.gross_premium
        bk = "channel_partner" if pol.partner_id else "direct"
        buyer_mix[bk]["count"] += 1
        buyer_mix[bk]["premium"] += pf.gross_premium
        if pol.partner_id:
            partner_agg.setdefault(pol.partner_id, _metric())
            _bump(partner_agg[pol.partner_id], pf)
        owner = users.get(pol.owner_user_id)
        if owner is not None and is_inhouse(owner.account_type):
            employee_agg.setdefault(pol.owner_user_id, _metric())
            _bump(employee_agg[pol.owner_user_id], pf)
        cust_policy_count[pol.customer_id] = \
            cust_policy_count.get(pol.customer_id, 0) + 1

    # --- Point-in-time policy sets (current status), honouring filters ---
    active_policies = 0
    status_dist: dict[str, int] = {}
    due = {"30": 0, "60": 0, "90": 0}
    horizon = {"30": now + timedelta(days=30), "60": now + timedelta(days=60),
               "90": now + timedelta(days=90)}
    renewed_win = lapsed_win = 0
    for pol in policies.values():
        if not passes(pol):
            continue
        st = pol.status.value if hasattr(pol.status, "value") else pol.status
        status_dist[st] = status_dist.get(st, 0) + 1
        if st == PolicyStatus.ACTIVE.value:
            active_policies += 1
        if st in (PolicyStatus.ACTIVE.value, PolicyStatus.RENEWAL_DUE.value) \
                and pol.expiry_date:
            exp = _aware(pol.expiry_date)
            for band in ("30", "60", "90"):
                if now <= exp <= horizon[band]:
                    due[band] += 1
        # Renewal rate within the window (by last update).
        if _in_window(pol.updated_at, lo, hi):
            if st == PolicyStatus.RENEWED.value:
                renewed_win += 1
            elif st in (PolicyStatus.LAPSED.value, PolicyStatus.EXPIRED.value):
                lapsed_win += 1

    # --- Retention over the filtered window ---
    distinct_customers = len(cust_policy_count)
    repeat_customers = sum(1 for n in cust_policy_count.values() if n > 1)
    total_win_policies = sum(cust_policy_count.values())

    # --- Reward health (agency reward by outcome, windowed by reward date) ---
    health = {s.value: 0 for s in (
        RewardStatus.RECEIVED, RewardStatus.PENDING, RewardStatus.REJECTED,
        RewardStatus.NOT_ELIGIBLE, RewardStatus.ZERO_PCT,
        RewardStatus.REFUNDED)}
    earned_total = 0
    async for r in Reward.find_all():
        pol = policies.get(r.policy_id)
        if pol is None or not passes(pol):
            continue
        if not _in_window(r.created_at, lo, hi):
            continue
        earned_total += r.agency_amount
        st = r.status.value if hasattr(r.status, "value") else r.status
        if st in health:
            health[st] += r.agency_amount
        elif st == RewardStatus.CANCELLED.value:
            health[RewardStatus.REJECTED.value] += r.agency_amount

    # --- Cash-based figures (owner 2026-07-16 Reports rebuild) ---
    # Net profit for the SELECTED window. Cash rows carry no insurer/partner/
    # employee tags, so only the date filter applies to this figure.
    net_profit = await fp.net_profit(lo, hi)

    # Monthly cash net profit for the fixed 12-month trend graph.
    net_by_month = {k: 0 for k in keys12}
    async for t in LedgerTxn.find():
        mult = _CASH.get(t.txn_type)
        if mult is None:
            continue
        mk = fr.month_key(_aware(t.occurred_at))
        if mk in net_by_month:
            net_by_month[mk] += mult * t.amount_paise
    async for w in WalletTxn.find(
            WalletTxn.type == WalletTxnType.WITHDRAWAL_DEBIT):
        if w.amount_paise < 0:
            mk = fr.month_key(_aware(w.created_at))
            if mk in net_by_month:
                net_by_month[mk] -= -w.amount_paise

    # Pending to collect / pay: point-in-time position (same netting as the
    # Finance Overview) — ignores every filter on purpose.
    from app.services.finance_dashboard import _pending_now
    pending = await _pending_now()

    # --- Targets: employees + partners, met or not (house profit) ---
    emp_targets = await _target_rows(
        "employee", employee_agg, users, lo, hi)
    partner_targets = await _target_rows(
        "channel_partner", partner_agg, users, lo, hi)

    # --- Lead funnel (windowed by lead creation) ---
    funnel = {s.value: 0 for s in LeadStage}
    async for ld in Lead.find_all():
        if _in_window(ld.created_at, lo, hi):
            key = ld.stage.value if hasattr(ld.stage, "value") else ld.stage
            funnel[key] = funnel.get(key, 0) + 1
    lead_total = sum(funnel.values())
    conversion = _pct(funnel.get(LeadStage.CONVERTED.value, 0), lead_total)

    # --- Assemble ---
    def named(agg: dict, label_fn, top: Optional[int] = None,
              sort_key: str = "premium") -> list[dict]:
        rows = [{"key": k, "label": label_fn(k), **m,
                 "avg_reward_pct": _pct(m["agency_reward"], m["premium"])}
                for k, m in agg.items()]
        rows.sort(key=lambda r: r[sort_key], reverse=True)
        return rows[:top] if top else rows

    def user_name(k: str) -> str:
        u = users.get(k)
        return u.full_name if u else k

    return {
        "period": period, "period_label": label, "date_from": lo, "date_to": hi,
        "kpis": {
            "total_premium": totals["premium"],
            "policies": totals["policies"],
            "active_policies": active_policies,
            "new_business_premium": totals["premium"],
            "house_profit": totals["profit"],
            "reward_earned": totals["agency_reward"],
            "reward": totals["reward"],
            "avg_premium": (totals["premium"] // totals["policies"]
                            if totals["policies"] else 0),
            "avg_reward_pct": _pct(totals["agency_reward"], totals["premium"]),
            "renewal_rate": _pct(renewed_win, renewed_win + lapsed_win),
            "repeat_rate": _pct(repeat_customers, distinct_customers),
            "net_profit": net_profit,
            "pending_to_collect": pending["to_collect"],
            "pending_to_pay": pending["to_pay"],
        },
        "trend": [{"month": k, "premium": trend[k]["premium"],
                   "profit": trend[k]["profit"],
                   "policies": trend[k]["policies"],
                   "net_profit": net_by_month[k],
                   "target": 0} for k in keys12],
        "by_category": named(by_cat, lambda k: cat_labels.get(k, k)),
        "by_insurer": named(by_ins, lambda k: insurers.get(k, k)),
        "payer_mix": [{"key": k, "label": _payer_label(k), "count": v["count"],
                       "premium": v["premium"]} for k, v in payer_mix.items()],
        "buyer_mix": [{"key": k, "label": ("Via partner" if k == "channel_partner"
                                           else "Direct"),
                       "count": v["count"], "premium": v["premium"]}
                      for k, v in buyer_mix.items()],
        "renewal_trend": [{"month": k, **renew_trend[k]} for k in keys12],
        "renewals_due": {"d30": due["30"], "d60": due["60"], "d90": due["90"]},
        "customer_trend": [{"month": k, **cust_trend[k]} for k in keys12],
        "retention": {
            "total_customers": distinct_customers,
            "repeat_customers": repeat_customers,
            "repeat_rate": _pct(repeat_customers, distinct_customers),
            "avg_policies": (round(total_win_policies / distinct_customers, 2)
                             if distinct_customers else 0),
        },
        # Leaderboards rank by PROFIT CONTRIBUTION (owner 2026-07-16), not
        # premium booked.
        "top_partners": named(partner_agg, user_name, top=8,
                              sort_key="profit"),
        "top_employees": named(employee_agg, user_name, top=8,
                               sort_key="profit"),
        "employee_targets": emp_targets,
        "partner_targets": partner_targets,
        "reward_health": {**health,
                          "realization_pct": _pct(
                              health[RewardStatus.RECEIVED.value],
                              earned_total)},
        "lead_funnel": [{"key": s.value, "label": s.value.title(),
                         "count": funnel.get(s.value, 0), "premium": 0}
                        for s in LeadStage],
        "lead_conversion_pct": conversion,
        "status_dist": [{"key": k, "label": k.replace("_", " ").title(),
                         "count": v, "premium": 0}
                        for k, v in status_dist.items()],
    }


def _payer_label(key: str) -> str:
    return {PayerType.AGENCY.value: "Agency paid",
            PayerType.CHANNEL_PARTNER.value: "Partner paid",
            PayerType.CUSTOMER.value: "Customer paid"}.get(key, key)


async def _target_rows(assignee_type: str, agg: dict[str, dict],
                       users: dict, lo: datetime, hi: datetime) -> list[dict]:
    """Actual house profit vs the assigned house-profit goal for the window.

    A target carries several metrics at once, so the house-profit component is
    pulled out of the map. The goal is taken in FULL for any target overlapping
    the window (services/targets.full_goals) rather than sliced by elapsed
    time: a monthly goal is a whole-month commitment, and slicing it made the
    figure drift upwards through the month and disagree with the Targets page.
    """
    target_by: dict[str, int] = {}
    for tg in tsvc.overlapping(await Target.find_all().to_list(), lo, hi):
        if tg.assignee_type != assignee_type:
            continue
        goal = tsvc.full_goals([tg], lo, hi).get(
            TargetMetric.HOUSE_PROFIT.value, 0)
        if goal:
            target_by[tg.assignee_id] = target_by.get(tg.assignee_id, 0) + goal

    rows = []
    for k in set(agg) | set(target_by):
        u = users.get(k)
        actual = agg.get(k, {}).get("profit", 0)
        target = target_by.get(k, 0)
        rows.append({
            "key": k, "label": u.full_name if u else k,
            "actual": actual, "target": target,
            "has_target": k in target_by,
            "met": bool(k in target_by and target > 0 and actual >= target),
        })
    rows.sort(key=lambda r: r["actual"], reverse=True)
    return rows
