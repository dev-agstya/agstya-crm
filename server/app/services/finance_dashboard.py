"""Aggregation for the redesigned Finance Overview dashboard.

Everything money-related is derived from the ledger + the frozen PolicyFinance
snapshots (never a stored duplicate):

  - The hero tile carries the FIXED last-30-days cash net profit (it ignores
    the date filter); "policies done" follows the selected window.
  - The graph series buckets by the window length: daily over the last 7 days
    (window ≤ a week), week-wise (window ≤ a month), else the last 6 months.
    Each bucket carries policies booked, cash net profit, the company-wide
    house-profit target (pro-rated by days for sub-month buckets) and the
    renewal rate.
  - Top performers rank employees / partners / brokers (insurers) / categories
    by house-profit contribution inside the window; the top five of each are
    returned with rich per-type metrics for the expandable cards. Their profit
    is ACCRUAL (booked, not yet necessarily received).
  - Pending-to-collect / pending-to-pay are point-in-time balances (NOT filtered
    by the window) and are broken down per party for the expandable views.
"""

from __future__ import annotations

import asyncio
from calendar import monthrange
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.core.enums import (
    LedgerTxnType, PartyType, TargetMetric, TargetPeriod, WalletTxnType,
    is_inhouse,
)
from app.models.broker import Broker
from app.models.customer import Customer
from app.models.finance import LedgerTxn, PartyAccount, PolicyFinance
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.target import Target
from app.models.user import User
from app.models.wallet import Wallet, WalletTxn
from app.services import finance_reports as fr
from app.services import targets as tsvc


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _in_window(dt: datetime, lo: datetime, hi: datetime) -> bool:
    dt = _aware(dt)
    return lo <= dt <= hi


def net_pending(owed_to_us: int, owed_to_them: int) -> int:
    """Signed point-in-time position for a party: positive = they owe the agency
    (collect), negative = the agency owes them (pay)."""
    return owed_to_us - owed_to_them


def partner_pending_gross(premium_balance: int,
                          reward_owed: int) -> tuple[int, int]:
    """A partner's (owed_to_us, owed_to_them) gross components. Premium they owe
    us lives on the party ledger (can go negative = we owe them, e.g. a discount
    refund); reward we owe them lives in the wallet. Both fold into the correct
    side so the net is a single honest figure."""
    reward = max(reward_owed, 0)
    return max(premium_balance, 0), reward + max(-premium_balance, 0)


_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _metric_value(metric: TargetMetric, pol, pf) -> int:
    """One policy's contribution to a target metric, in that metric's units."""
    if metric == TargetMetric.POLICIES:
        return 1
    if metric == TargetMetric.PREMIUM:
        return pf.gross_premium
    if metric == TargetMetric.RENEWALS:
        return 1 if pol.renewed_from_policy_id else 0
    return pf.house_profit


def _day_floor(dt: datetime) -> datetime:
    """Start of `dt`'s day in IST (owner Q-P1) — graph day/week buckets follow the
    Indian calendar, not UTC."""
    return fr.to_ist(dt).replace(hour=0, minute=0, second=0, microsecond=0)


def series_buckets(lo: datetime, hi: datetime) -> tuple[str, list[dict]]:
    """Bucket layout for the overview graph — it now spans the ACTUAL selected
    window [lo, hi] (owner 2026-07-24), so the graph always reflects the top date
    filter rather than a fixed "last 7 days / last 6 months" heuristic:
      ≤ 10 days  -> daily buckets across the window
      ≤ 92 days  -> week-wise buckets across the window
      otherwise  -> one bucket per calendar month spanned by the window.
    Returns (granularity, [{key, label, lo, hi}, ...]) with inclusive bounds.
    """
    days = max(1, (hi - lo).days + 1)
    if days <= 10:
        buckets = []
        d0 = _day_floor(lo)
        while d0 <= hi:
            d1 = min(hi, d0 + timedelta(days=1) - timedelta(seconds=1))
            buckets.append({
                "key": d0.strftime("%Y-%m-%d"),
                "label": f"{d0.day} {_MONTH_NAMES[d0.month - 1]}",
                "lo": max(d0, lo), "hi": d1,
            })
            d0 = d0 + timedelta(days=1)
        return "day", buckets
    if days <= 92:
        buckets = []
        d0 = _day_floor(lo)
        week = 1
        while d0 <= hi:
            d1 = min(hi, d0 + timedelta(days=7) - timedelta(seconds=1))
            buckets.append({
                "key": d0.strftime("%Y-%m-%d"),
                "label": f"Wk {week} · {d0.day} {_MONTH_NAMES[d0.month - 1]}",
                "lo": max(d0, lo), "hi": d1,
            })
            d0 = d0 + timedelta(days=7)
            week += 1
        return "week", buckets
    # Monthly buckets spanning every calendar month between lo and hi inclusive.
    buckets = []
    cur = _day_floor(lo).replace(day=1)
    end = _day_floor(hi)
    while cur <= end:
        y, m = cur.year, cur.month
        m_lo = datetime(y, m, 1, tzinfo=fr.IST)
        m_hi = datetime(y, m, monthrange(y, m)[1], 23, 59, 59, tzinfo=fr.IST)
        buckets.append({
            "key": f"{y:04d}-{m:02d}",
            "label": f"{_MONTH_NAMES[m - 1]}" if y == end.year
                     else f"{_MONTH_NAMES[m - 1]} '{str(y)[2:]}",
            "lo": max(m_lo, lo), "hi": min(m_hi, hi),
        })
        cur = (cur.replace(day=28) + timedelta(days=7)).replace(day=1)
    return "month", buckets


async def _compute_series(lo: datetime, hi: datetime, metric: TargetMetric,
                          employee_id: Optional[str] = None,
                          ) -> tuple[str, list[dict], bool]:
    """Overview graph series for [lo, hi].

    Each bucket carries policies booked, cash net profit, renewal rate, and the
    Performance-vs-Target pair for `metric`.

    That last pair is the fix for the bug in the owner's screenshot. It used to
    plot CASH net profit against a house-profit goal, and it only ever looked
    for `metric == house_profit AND period == month` targets — so a policies
    target rendered as "Target Rs 0.00" next to a rupee bar. Now both numbers
    are the SAME metric in the SAME units: `actual` is the booked figure for the
    chosen metric and `target` is that metric's goal pro-rated across the
    bucket, with every target period (month / quarter / year) contributing its
    real share.

    `employee_id` narrows the target pair to ONE person — their booked figure
    against their own goal. The rest of the series (policies, cash net profit,
    renewal rate) always stays company-wide, because those tiles are not about
    an individual.

    Cash rule for net_profit: money in (premium collected + reward received)
    minus money out (premium fronted, advances, refunds, payouts, expenses).
    Pure read — safe to run concurrently with the other dashboard passes.
    """
    granularity, buckets = series_buckets(lo, hi)
    series_lo = min(b["lo"] for b in buckets)
    series_hi = max(b["hi"] for b in buckets)

    def bucket_of(dt: datetime) -> Optional[dict]:
        dt = _aware(dt)
        if dt < series_lo or dt > series_hi:
            return None
        for b in buckets:
            if b["lo"] <= dt <= b["hi"]:
                return b
        return None

    profit_by: dict[str, int] = {b["key"]: 0 for b in buckets}
    _CASH = {
        LedgerTxnType.REWARD_RECEIVED: -1,        # stored negative -> cash in
        LedgerTxnType.PREMIUM_COLLECTED: -1,      # stored negative -> cash in
        LedgerTxnType.PREMIUM_PAID_BY_AGENCY: 1,  # stored negative -> cash out
        LedgerTxnType.PARTNER_ADVANCE: -1,        # stored positive -> cash out
        LedgerTxnType.REFUND: -1,                 # stored positive -> cash out
        LedgerTxnType.EXPENSE: 1,                 # stored negative -> cash out
    }
    async for t in LedgerTxn.find():
        mult = _CASH.get(t.txn_type)
        if mult is None:
            continue
        b = bucket_of(t.occurred_at)
        if b is not None:
            profit_by[b["key"]] += mult * t.amount_paise
    async for w in WalletTxn.find(
            WalletTxn.type == WalletTxnType.WITHDRAWAL_DEBIT):
        if w.amount_paise < 0:
            b = bucket_of(w.created_at)
            if b is not None:
                profit_by[b["key"]] -= -w.amount_paise

    # Policies + renewals booked per bucket (from the frozen snapshots).
    policies_all = {str(p.id): p async for p in Policy.find_all()}
    pol_by: dict[str, int] = {b["key"]: 0 for b in buckets}
    renew_by: dict[str, int] = {b["key"]: 0 for b in buckets}
    async for pf in PolicyFinance.find_all():
        b = bucket_of(pf.created_at)
        if b is None:
            continue
        pol_by[b["key"]] += 1
        pol = policies_all.get(pf.policy_id)
        if pol is not None and pol.renewed_from_policy_id:
            renew_by[b["key"]] += 1

    # --- Performance vs Target, in one consistent unit ---------------------
    # Booked actuals for the chosen metric, per bucket, from the same snapshots
    # the rest of finance uses.
    actual_by: dict[str, int] = {b["key"]: 0 for b in buckets}
    async for pf in PolicyFinance.find_all():
        b = bucket_of(pf.created_at)
        if b is None:
            continue
        pol = policies_all.get(pf.policy_id)
        if pol is None or not tsvc.counts_for_targets(pol):
            continue
        if employee_id and pol.owner_user_id != employee_id:
            continue
        actual_by[b["key"]] += _metric_value(metric, pol, pf)

    # EVERY target counts, whatever its metric or period — each contributes the
    # slice of its own window that overlaps the bucket.
    all_targets = await Target.find_all().to_list()
    if employee_id:
        all_targets = [t for t in all_targets
                       if t.assignee_id == employee_id]
    has_targets = any((t.metrics or {}).get(metric.value)
                      for t in tsvc.overlapping(all_targets, lo, hi))

    series = []
    for b in buckets:
        k = b["key"]
        pols, renews = pol_by[k], renew_by[k]
        goals = tsvc.prorated_goals(all_targets, b["lo"], b["hi"])
        series.append({
            "key": k, "label": b["label"],
            "policies": pols,
            "net_profit": profit_by[k],
            "actual": actual_by[k],
            "target": goals.get(metric.value, 0),
            "renewals": renews,
            "renewal_rate_pct": (round(renews / pols * 100, 1)
                                 if pols else None),
        })
    return granularity, series, has_targets


async def compute_dashboard(
    period: str, now: datetime,
    date_from: Optional[datetime], date_to: Optional[datetime],
    target_metric: TargetMetric = TargetMetric.HOUSE_PROFIT,
    target_employee_id: Optional[str] = None,
) -> dict:
    lo, hi, label = fr.resolve_period(period, now, date_from, date_to)

    # These five passes are independent and read-only, so run them concurrently
    # — one parallel batch instead of ~5 sequential trips to Atlas. This is what
    # removes the 2-3s. Each pass builds its own data (no shared mutable state),
    # so it stays correct with many people using the app simultaneously.
    #   - realized_profit : cash earnings inside the window
    #   - net_profit (30d): hero tile, fixed last 30 days (ignores the filter)
    #   - _compute_series : the graph buckets
    #   - _top_performers : employee/partner/broker/category leaders
    #   - _pending_now    : point-in-time pending-to-collect / pending-to-pay
    from app.services import finance_profit as fp
    prof, net_profit_30d, (granularity, series, has_targets), top, pending = \
        await asyncio.gather(
            fp.realized_profit(lo, hi),
            fp.net_profit(now - timedelta(days=30), now),
            _compute_series(lo, hi, target_metric, target_employee_id),
            _top_performers(lo, hi),
            _pending_now(),
        )
    total_policies = top.pop("_total_policies")

    # Per-employee actual vs target needs each employee's metrics from `top`,
    # so it runs after the batch above. It also RE-RANKS the Top Employees card
    # on the combined profit + attainment score the owner asked for, which is
    # why the two are computed together rather than in separate passes.
    employee_targets, top["top_employees"] = await _employee_performance(
        lo, hi, target_metric, top.pop("_emp_metrics"), top["top_employees"])

    return {
        "period": period, "period_label": label,
        "date_from": lo, "date_to": hi,
        "net_profit_30d": net_profit_30d,
        "earnings": {
            "total_earnings": prof["net_profit"],
            "reward_received": prof["reward_received"],
            "rewards_paid": prof["partner_payouts"],
            "premium_collected": prof["premium_collected"],
            "premium_fronted": prof["premium_fronted"],
            "refunds": prof["refunds"],
            "expenses": prof["expenses"],
            "total_policies": total_policies,
        },
        "granularity": granularity,
        "series": series,
        "target_metric": target_metric.value,
        "target_metric_label": tsvc.METRIC_LABELS[target_metric.value],
        "target_is_money": target_metric.value in tsvc.MONEY_METRICS,
        "has_targets": has_targets,
        "target_employee_id": target_employee_id,
        **top,
        "employee_targets": employee_targets,
        "pending": pending,
    }


def _empty_bucket() -> dict:
    return {"policies": 0, "premium": 0, "profit": 0,
            "agency_reward": 0, "reward": 0, "renewals": 0}


def _bump(bucket: dict, key: Optional[str], pol, pf) -> None:
    if not key:
        return
    agg = bucket.setdefault(key, _empty_bucket())
    agg["policies"] += 1
    agg["premium"] += pf.gross_premium
    agg["profit"] += pf.house_profit
    agg["agency_reward"] += pf.agency_reward
    agg["reward"] += pf.partner_share
    if pol.renewed_from_policy_id:
        agg["renewals"] += 1


async def _top_performers(lo: datetime, hi: datetime) -> dict:
    policies = {str(p.id): p async for p in Policy.find_all()}
    users = {str(u.id): u async for u in User.find_all()}

    emp: dict[str, dict] = {}
    partner: dict[str, dict] = {}
    broker: dict[str, dict] = {}
    category: dict[str, dict] = {}

    total_policies = 0
    async for pf in PolicyFinance.find_all():
        if not _in_window(pf.created_at, lo, hi):
            continue
        pol = policies.get(pf.policy_id)
        if pol is None:
            continue
        total_policies += 1
        owner = users.get(pol.owner_user_id)
        if owner is not None and is_inhouse(owner.account_type):
            _bump(emp, pol.owner_user_id, pol, pf)
        _bump(partner, pol.partner_id, pol, pf)
        _bump(broker, pol.broker_id, pol, pf)
        _bump(category, pol.category_key, pol, pf)

    # Resolve labels for the winners of each dimension (top 5).
    broker_names = {str(b.id): b.name async for b in Broker.find_all()}
    cat_labels = {c.key: c.label async for c in PolicyCategory.find_all()}

    def user_label(k: str) -> str:
        u = users.get(k)
        return u.full_name if u else k

    def top5(bucket: dict, label_fn) -> list[dict]:
        rows = [{"key": k, "label": label_fn(k), **agg}
                for k, agg in bucket.items()]
        rows.sort(key=lambda r: r["profit"], reverse=True)
        return rows[:5]

    # Employees keep their FULL metric bucket (not just profit): the target
    # roll-up needs policies/premium/renewals too, because a target may be set
    # on any of them.
    emp_metrics = {k: {**agg, "label": user_label(k)} for k, agg in emp.items()}

    return {
        "top_employees": top5(emp, user_label),
        "top_partners": top5(partner, user_label),
        "top_brokers": top5(broker, lambda k: broker_names.get(k, k)),
        "top_categories": top5(category, lambda k: cat_labels.get(k, k)),
        "_total_policies": total_policies,
        "_emp_metrics": emp_metrics,
    }


async def _employee_performance(
    lo: datetime, hi: datetime, metric: TargetMetric,
    emp_metrics: dict[str, dict], top_employees: list[dict],
) -> tuple[list[dict], list[dict]]:
    """Employee actuals vs goals for the window, plus the re-ranked Top
    Employees card.

    Two things the old version got wrong:

      - It only looked at house_profit targets, so a policies or premium target
        simply did not exist as far as the dashboard was concerned.
      - It ranked Top Employee on raw profit alone. The owner wants profit AND
        target achievement to count, so ranking now runs through
        services/targets.rank_performers, which blends the two and explains
        itself via the `score` it attaches.

    A target that overlaps the window contributes its FULL value (see
    services/targets.full_goals). It used to contribute a time-slice, which is
    why this panel showed a July goal of Rs 20,752.90 on the 26th while the
    Targets page showed Rs 25,000 — the same goal, silently scaled by how much
    of the month had gone, and creeping up every time the page was opened.
    """
    users = {str(u.id): u async for u in User.find_all()}
    all_targets = await Target.find_all().to_list()

    goals_by_emp: dict[str, dict[str, int]] = {}
    for t in tsvc.overlapping(all_targets, lo, hi):
        if t.assignee_type != "employee":
            continue
        bucket = goals_by_emp.setdefault(t.assignee_id, {})
        for m, v in tsvc.full_goals([t], lo, hi).items():
            bucket[m] = bucket.get(m, 0) + v

    def actual_for(agg: dict) -> int:
        return {
            TargetMetric.POLICIES.value: agg.get("policies", 0),
            TargetMetric.PREMIUM.value: agg.get("premium", 0),
            TargetMetric.RENEWALS.value: agg.get("renewals", 0),
        }.get(metric.value, agg.get("profit", 0))

    # Anyone with activity OR a goal shows up — an employee who was given a
    # number and booked nothing is exactly who the owner needs to see.
    rows: list[dict] = []
    for key in set(emp_metrics) | set(goals_by_emp):
        u = users.get(key)
        if u is not None and not is_inhouse(u.account_type):
            continue
        agg = emp_metrics.get(key, {})
        goal = goals_by_emp.get(key, {}).get(metric.value, 0)
        actual = actual_for(agg)
        rows.append({
            "key": key,
            "label": agg.get("label") or (u.full_name if u else key),
            "actual": actual,
            "target": goal,
            "has_target": key in goals_by_emp,
            "attainment_pct": tsvc.attainment_pct(actual, goal),
            "profit": agg.get("profit", 0),
            "policies": agg.get("policies", 0),
        })
    tsvc.rank_performers(rows)

    # Mirror the ranking onto the Top Employees card so the two never disagree
    # about who is first.
    by_key = {r["key"]: r for r in rows}
    ranked_top = sorted(
        top_employees,
        key=lambda t: (by_key.get(t["key"], {}).get("score", 0.0),
                       t.get("profit", 0)),
        reverse=True)
    for t in ranked_top:
        r = by_key.get(t["key"], {})
        t["score"] = r.get("score", 0.0)
        t["rank"] = r.get("rank", 0)
        t["attainment_pct"] = r.get("attainment_pct", 0.0)
        t["has_target"] = r.get("has_target", False)
    return rows, ranked_top


async def _pending_now() -> dict:
    """Point-in-time balances, NETTED so each party shows on exactly one side.

    For every party we compute a single net = (what they owe us) − (what we owe
    them); a positive net lands on "to collect", a negative on "to pay". This is
    what the owner wants: a partner who owes ₹1180 premium and is owed ₹200 reward
    shows once as "collect ₹980", never as a ₹1180 receivable AND a ₹200 payable.
    The full premium/reward breakdown rides along (owed_to_us / owed_to_them) for
    the expandable view; the itemised statement lives on the balance sheet.

      - Customer: premium balance only (can go negative = discount refund owed).
      - Partner:  premium owed to us (party ledger) − reward we owe (wallet).
      - Broker:   reward still due to us (expected − received). Premium the
                  agency fronts is a pass-through (auto-logged, balance-neutral),
                  so it never sits as a broker payable here.
    """
    from app.services.finance_balance import broker_net_balance
    # Every read below is independent — one parallel batch, then aggregate in
    # memory (read-only, no shared state → concurrency-safe).
    (customers_l, partners_l, brokers_l, cust_accts, partner_accts,
     wallets_l, policies_l, pfs, reward_txns, broker_accts) = \
        await asyncio.gather(
            Customer.find_all().to_list(),
            User.find_all().to_list(),
            Broker.find_all().to_list(),
            PartyAccount.find(
                PartyAccount.party_type == PartyType.CUSTOMER).to_list(),
            PartyAccount.find(
                PartyAccount.party_type == PartyType.CHANNEL_PARTNER).to_list(),
            Wallet.find_all().to_list(),
            Policy.find_all().to_list(),
            PolicyFinance.find_all().to_list(),
            LedgerTxn.find(
                LedgerTxn.party_type == PartyType.BROKER,
                LedgerTxn.txn_type == LedgerTxnType.REWARD_RECEIVED).to_list(),
            PartyAccount.find(
                PartyAccount.party_type == PartyType.BROKER).to_list(),
        )
    customers = {str(c.id): c for c in customers_l}
    partners = {str(u.id): u for u in partners_l}
    broker_names = {str(b.id): b.name for b in brokers_l}

    collect_items: list[dict] = []
    pay_items: list[dict] = []

    def emit(party_type: str, party_id: str, label: str,
             owed_to_us: int, owed_to_them: int) -> None:
        net = net_pending(owed_to_us, owed_to_them)
        if net == 0:
            return
        row = {"party_type": party_type, "party_id": party_id, "label": label,
               "owed_to_us": owed_to_us, "owed_to_them": owed_to_them}
        if net > 0:
            collect_items.append({**row, "amount": net})
        else:
            pay_items.append({**row, "amount": -net})

    # --- Customers: premium receivable (negative = discount refund we owe) ---
    for a in cust_accts:
        c = customers.get(a.party_id)
        name = c.name if c else a.party_id
        emit("customer", a.party_id, name,
             max(a.balance_paise, 0), max(-a.balance_paise, 0))

    # --- Partners: premium owed to us − reward we owe (wallet) ---
    partner_premium = {a.party_id: a.balance_paise for a in partner_accts}
    reward_owed = {w.partner_id: w.available_paise + w.pending_paise
                   for w in wallets_l}
    for pid in set(partner_premium) | set(reward_owed):
        u = partners.get(pid)
        name = u.full_name if u else pid
        owed_to_us, owed_to_them = partner_pending_gross(
            partner_premium.get(pid, 0), reward_owed.get(pid, 0))
        emit("partner", pid, name, owed_to_us, owed_to_them)

    # --- Brokers: same single-source net as the balance sheet — the derived
    # reward receivable (expected − received, floored at 0) plus any real
    # ledger positions, with the REWARD_RECEIVED postings backed out so a
    # receipt clears the receivable instead of reading as a payable.
    policies = {str(p.id): p for p in policies_l}
    expected_by_broker: dict[str, int] = {}
    for pf in pfs:
        pol = policies.get(pf.policy_id)
        if pol is None or not pol.broker_id:
            continue
        expected_by_broker[pol.broker_id] = \
            expected_by_broker.get(pol.broker_id, 0) + pf.agency_reward
    received_by_broker: dict[str, int] = {}
    for t in reward_txns:
        received_by_broker[t.party_id] = \
            received_by_broker.get(t.party_id, 0) + (-t.amount_paise)
    broker_balance = {a.party_id: a.balance_paise for a in broker_accts}
    for broker_id in (set(expected_by_broker) | set(broker_balance)):
        due = broker_net_balance(
            expected_by_broker.get(broker_id, 0),
            received_by_broker.get(broker_id, 0),
            broker_balance.get(broker_id, 0))
        emit("broker", broker_id, broker_names.get(broker_id, broker_id),
             max(due, 0), max(-due, 0))

    collect_items.sort(key=lambda r: r["amount"], reverse=True)
    pay_items.sort(key=lambda r: r["amount"], reverse=True)

    return {
        "to_collect": sum(i["amount"] for i in collect_items),
        "to_pay": sum(i["amount"] for i in pay_items),
        "collect_items": collect_items,
        "pay_items": pay_items,
    }
