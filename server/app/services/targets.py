"""Target periods, attainment and the performance leaderboard.

This is the single source of truth for "how is this person doing against their
goal". Everything here is derived from the live policy book at read time — no
score is ever stored — so cancelling or deleting a policy takes it back out of
the numbers with no extra bookkeeping.

Three rules the old implementation got wrong and this one holds to:

  1. ONE SOURCE FOR ACTUALS. Attainment is computed from the frozen
     PolicyFinance snapshots, the same source Top Performers and the P&L read.
     The old code summed the Reward collection for house profit and counted
     Policy rows for everything else, so a target could disagree with the
     dashboard sitting next to it.

  2. BOOKED, NOT BANKED. A policy counts for the period it was BOOKED in
     (accrual), because that is what the employee controls — not when the
     insurer eventually pays. Bucketing follows IST calendar months, like every
     other finance boundary in the app.

  3. TARGETS SPREAD OVER THEIR REAL WINDOW. A quarterly target spreads across
     three months and a yearly one across twelve, pro-rated by time. The old
     prorated_target() charged a target's entire value to the month it started
     in and read zero everywhere else.

Attribution: a policy counts for `Policy.owner_user_id` — the employee it is
booked UNDER, which the form lets you set — so a manager entering a policy on
behalf of an executive credits the executive. Partner targets follow
`Policy.partner_id`.

A MANAGER'S NUMBER IS THEIR TEAM'S NUMBER (owner B1, 2026-08-06)
---------------------------------------------------------------
A relationship manager hands their own goal out across the channel partners
under them — "you have 100 policies, your ten partners get ten each" — so their
attainment has to be FED by those partners. A partner's policy therefore credits
two people: the partner, and the partner's manager.

That is deliberate double counting, and it has one consequence worth stating
plainly: the company total is NOT the sum of every employee's target actuals.
A manager's row is a roll-up of a team, not a slice of a pie (owner B2).

The manager comes from `Policy.manager_id`, the stamp FROZEN at booking
(services/policy_ops.stamp_manager) — never from today's roster (owner B3).
Move a partner to a new manager and the old manager keeps credit for what they
already brought in; resolving it live would rewrite last quarter every time
somebody was reassigned. An unstamped policy (older than the backfill, or a
partner who had no manager) simply credits nobody, which is the same "Unassigned"
the manager league table shows.

The manager credit applies ONLY to partner-sourced policies. On an in-house sale
`manager_id` IS the booking employee, so crediting both would count one policy
twice for one person.
"""

from __future__ import annotations

import asyncio
from calendar import monthrange
from datetime import datetime, timezone
from typing import Iterable, Optional

from app.core.enums import AccountType, PolicyStatus, TargetMetric, TargetPeriod
from app.core.permissions import MANAGE_TARGETS
from app.models.finance import PolicyFinance
from app.models.policy import Policy
from app.models.target import Target
from app.services.finance_reports import to_ist

# The metric the dashboard and the Top Employee ranking score on when a target
# carries several. Owner's answer to Q2.1: house profit.
PRIMARY_METRIC = TargetMetric.HOUSE_PROFIT

# --- Who may see the agency's margin (owner rule, 2026-07-26) --------------------
# A house-profit target tells the person carrying it exactly how much the agency
# made off their work. The owner's reasoning: an employee who sees "you brought
# in Rs 20,000 against a Rs 10,000 goal" is no longer discussing the job, they
# are discussing the split — so this metric is visible ONLY to the owner and to
# the people trusted to ASSIGN targets (manage_targets). Everyone else never
# sees the goal, the actual, or any percentage derived from it: the rows are
# stripped server-side, so no client tweak can bring them back.
PROFIT_METRICS: frozenset[str] = frozenset({TargetMetric.HOUSE_PROFIT.value})

# Money metrics are stored and compared in paise; the rest are plain counts.
MONEY_METRICS: frozenset[str] = frozenset(
    {TargetMetric.PREMIUM.value, TargetMetric.HOUSE_PROFIT.value})

METRIC_LABELS: dict[str, str] = {
    TargetMetric.POLICIES.value: "Policies",
    TargetMetric.PREMIUM.value: "Premium",
    TargetMetric.HOUSE_PROFIT.value: "House profit",
    TargetMetric.RENEWALS.value: "Renewals",
}

_MONTHS_IN = {TargetPeriod.MONTH: 1, TargetPeriod.QUARTER: 3,
              TargetPeriod.YEAR: 12}

# Progress milestones an employee is congratulated on, low to high.
MILESTONES: tuple[int, ...] = (50, 90, 100)

# Attainment above this counts as "maxed out" when scoring, so an employee
# handed a token target cannot outrank someone doing several times the profit.
ATTAINMENT_CAP_PCT = 150.0
# Top Employee = mostly what they brought in, partly how they did against plan.
PROFIT_WEIGHT = 0.6
TARGET_WEIGHT = 0.4


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# --- Visibility ------------------------------------------------------------------


def can_see_profit_targets(actor) -> bool:
    """May this user see house-profit goals/actuals on target screens?

    Owner, or anyone holding manage_targets (the people who set the numbers in
    the first place — hiding it from them would make the assign screen
    unusable). Deliberately NOT tied to view_agency_profit: that flag governs
    the finance screens, and the owner wants the target surfaces gated on who
    assigns targets, not on who reconciles cash.
    """
    if actor is None:
        return False
    if getattr(actor, "is_owner", False) \
            or getattr(actor, "account_type", None) == AccountType.OWNER:
        return True
    return MANAGE_TARGETS in (getattr(actor, "permissions", None) or [])


def visible_metrics(metrics: dict[str, int] | None,
                    allow_profit: bool) -> dict[str, int]:
    """A target's goals as `actor` is allowed to see them."""
    metrics = metrics or {}
    if allow_profit:
        return dict(metrics)
    return {k: v for k, v in metrics.items() if k not in PROFIT_METRICS}


def visible_actuals(actuals: dict[str, int] | None,
                    allow_profit: bool) -> dict[str, int]:
    """Actuals with the agency's margin removed for viewers who may not see it."""
    actuals = actuals or {}
    if allow_profit:
        return dict(actuals)
    return {k: v for k, v in actuals.items() if k not in PROFIT_METRICS}


# --- Milestones ------------------------------------------------------------------


def crossed_milestones(pct: float) -> list[int]:
    """Every milestone this attainment has reached."""
    return [m for m in MILESTONES if pct >= m]


def due_milestone(pct: float, already_notified) -> Optional[int]:
    """The ONE milestone worth telling someone about right now, or None.

    Only the highest newly-crossed milestone is returned: a single big policy
    that takes someone from 20% to 100% earns one "target achieved", not three
    messages in a row. Callers record every crossed milestone (not just the one
    returned) so the ones skipped over never fire later.
    """
    done = set(already_notified or [])
    fresh = [m for m in crossed_milestones(pct) if m not in done]
    return max(fresh) if fresh else None


# --- Period maths ----------------------------------------------------------------


def add_months(dt: datetime, months: int) -> datetime:
    """Add whole months, clamping the day to the target month's length."""
    total = dt.month - 1 + months
    year = dt.year + total // 12
    month = total % 12 + 1
    return dt.replace(year=year, month=month,
                      day=min(dt.day, monthrange(year, month)[1]))


def month_start_ist(dt: datetime) -> datetime:
    """Midnight on the 1st of `dt`'s IST month, as a tz-aware IST datetime."""
    ist = to_ist(_aware(dt))
    return ist.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def normalise_period(period: TargetPeriod,
                     start: datetime) -> tuple[datetime, datetime]:
    """Snap a requested start to the beginning of its IST period and return
    (start, end) with end EXCLUSIVE, both in UTC.

    This is what stops "from 26/07/2026" ever becoming a July target that covers
    only the last six days of the month: pick any day in July and you get
    1 Jul 00:00 IST -> 1 Aug 00:00 IST. Quarters snap to Jan/Apr/Jul/Oct, and
    years to the Indian financial year (1 April) like the rest of the app.
    """
    ist = month_start_ist(start)
    if period == TargetPeriod.QUARTER:
        ist = ist.replace(month=((ist.month - 1) // 3) * 3 + 1)
    elif period == TargetPeriod.YEAR:
        fy_year = ist.year if ist.month >= 4 else ist.year - 1
        ist = ist.replace(year=fy_year, month=4)
    end = add_months(ist, _MONTHS_IN.get(period, 1))
    return ist.astimezone(timezone.utc), end.astimezone(timezone.utc)


def period_label(period: TargetPeriod, start: datetime) -> str:
    ist = to_ist(_aware(start))
    if period == TargetPeriod.MONTH:
        return ist.strftime("%b %Y")
    if period == TargetPeriod.QUARTER:
        return f"Q{(ist.month - 1) // 3 + 1} {ist.year}"
    return f"FY {ist.year}-{str(ist.year + 1)[2:]}"


def prorate(value: int, window_start: datetime, window_end: datetime,
            lo: datetime, hi: datetime) -> int:
    """The slice of a target that falls inside [lo, hi].

    Every moment of the target's window carries an equal share, so a quarterly
    goal spreads over all three months and a weekly graph bucket gets an honest
    fraction of its month. Returns 0 when the ranges do not overlap.
    """
    window_start, window_end = _aware(window_start), _aware(window_end)
    lo, hi = _aware(lo), _aware(hi)
    total = max((window_end - window_start).total_seconds(), 1.0)
    overlap_lo, overlap_hi = max(window_start, lo), min(window_end, hi)
    if overlap_hi <= overlap_lo:
        return 0
    share = (overlap_hi - overlap_lo).total_seconds() / total
    return int(round(value * share))


def attainment_pct(actual: int, target: int) -> float:
    """Percent of goal reached. A goal of zero has no meaningful percentage, so
    it returns 0.0 rather than dividing by zero or claiming 100%."""
    if target <= 0:
        return 0.0
    return round(actual / target * 100, 1)


# --- Actuals ---------------------------------------------------------------------


def counts_for_targets(pol: Policy) -> bool:
    """Cancelled policies stop counting for anyone (owner Q2.7).

    Deleted policies never reach here — they are gone from the collection, and
    because attainment is recomputed on every read that is all it takes. The
    old "and not rejected" clause went with policy approval (2026-08-05): a
    policy is written by staff and is real the moment it is saved.
    """
    return pol.status != PolicyStatus.CANCELLED


async def _load_book(lo: datetime, hi: datetime) -> list[tuple[Policy,
                                                               PolicyFinance]]:
    """Every (policy, finance-snapshot) pair BOOKED inside [lo, hi).

    One read of each collection, paired in memory — the alternative is a query
    per assignee per metric, which is what made the old target roll-up slow.
    """
    policies, finances = await asyncio.gather(
        Policy.find({"created_at": {"$gte": lo, "$lt": hi}}).to_list(),
        PolicyFinance.find({"created_at": {"$gte": lo, "$lt": hi}}).to_list(),
    )
    by_policy = {pf.policy_id: pf for pf in finances}
    return [(p, by_policy[str(p.id)]) for p in policies
            if str(p.id) in by_policy and counts_for_targets(p)]


def blank_metrics() -> dict[str, int]:
    return {m.value: 0 for m in TargetMetric}


def accumulate(bucket: dict[str, int], pol: Policy,
               pf: PolicyFinance) -> None:
    bucket[TargetMetric.POLICIES.value] += 1
    bucket[TargetMetric.PREMIUM.value] += pf.gross_premium
    bucket[TargetMetric.HOUSE_PROFIT.value] += pf.house_profit
    if pol.renewed_from_policy_id:
        bucket[TargetMetric.RENEWALS.value] += 1


def employees_credited(pol: Policy) -> set[str]:
    """Which employees this ONE policy counts towards (see the module docstring).

    A set, not a list, and that matters: on an in-house sale the booking
    employee and the frozen manager are the same person, and adding them twice
    would double a manager's own direct business.
    """
    credited: set[str] = set()
    if pol.owner_user_id:
        credited.add(pol.owner_user_id)
    # Partner-sourced business rolls up to whoever managed that partner AT
    # BOOKING TIME — never to today's roster (owner B3).
    if pol.partner_id and pol.manager_id:
        credited.add(pol.manager_id)
    return credited


async def actuals_by_assignee(
    lo: datetime, hi: datetime,
) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, int]]]:
    """Every metric, for every employee and every partner, booked in [lo, hi).

    Returns (by_employee, by_partner) keyed by user id. One pass over the book
    fills both, so the targets page, the dashboard and the leaderboard share a
    single read instead of three.
    """
    by_employee: dict[str, dict[str, int]] = {}
    by_partner: dict[str, dict[str, int]] = {}
    for pol, pf in await _load_book(lo, hi):
        for uid in employees_credited(pol):
            accumulate(by_employee.setdefault(uid, blank_metrics()), pol, pf)
        if pol.partner_id:
            accumulate(by_partner.setdefault(pol.partner_id,
                                             blank_metrics()), pol, pf)
    return by_employee, by_partner


async def compute_actuals(assignee_type: str, assignee_id: str,
                          lo: datetime, hi: datetime) -> dict[str, int]:
    """Every metric for ONE assignee over [lo, hi). Convenience wrapper for the
    per-person views; bulk callers should use actuals_by_assignee."""
    by_employee, by_partner = await actuals_by_assignee(lo, hi)
    source = by_partner if assignee_type == "channel_partner" else by_employee
    return source.get(assignee_id, blank_metrics())


# --- Target roll-up --------------------------------------------------------------


def metric_rows(target_metrics: dict[str, int],
                actuals: dict[str, int],
                allow_profit: bool = True) -> list[dict]:
    """One row per metric the owner actually set a goal for, in a stable order.

    A metric absent from the target means "no goal for this", which is
    deliberately different from a goal of zero and is simply not listed.

    `allow_profit=False` drops the house-profit row entirely (see
    can_see_profit_targets) — the employee's own screens are built from this,
    so the figure never reaches the wire.
    """
    target_metrics = visible_metrics(target_metrics, allow_profit)
    rows = []
    for metric in TargetMetric:
        goal = (target_metrics or {}).get(metric.value)
        if goal is None:
            continue
        actual = (actuals or {}).get(metric.value, 0)
        rows.append({
            "metric": metric.value,
            "label": METRIC_LABELS[metric.value],
            "is_money": metric.value in MONEY_METRICS,
            "target_value": goal,
            "actual_value": actual,
            "attainment_pct": attainment_pct(actual, goal),
        })
    return rows


def overall_attainment(rows: Iterable[dict]) -> float:
    """A single headline percentage for a multi-metric target.

    The primary metric (house profit) wins when it is one of the goals, because
    that is what the owner judges people on. Otherwise it is the plain average
    of whatever goals were set, so a policies-only target still reads sensibly.
    """
    rows = [r for r in rows if r["target_value"] > 0]
    if not rows:
        return 0.0
    for r in rows:
        if r["metric"] == PRIMARY_METRIC.value:
            return r["attainment_pct"]
    return round(sum(r["attainment_pct"] for r in rows) / len(rows), 1)


def overlapping(targets: Iterable[Target], lo: datetime,
                hi: datetime) -> list[Target]:
    """Targets whose window intersects [lo, hi]."""
    return [t for t in targets
            if _aware(t.period_start) < _aware(hi)
            and _aware(t.period_end) > _aware(lo)]


def prorated_goals(targets: Iterable[Target], lo: datetime,
                   hi: datetime) -> dict[str, int]:
    """Combined per-metric goal for an arbitrary window.

    Each overlapping target contributes the slice of its own window that falls
    inside [lo, hi], so the Performance-vs-Target graph shows a fair goal for a
    week bucket, a month bucket or a custom date range alike.
    """
    out: dict[str, int] = {}
    for t in overlapping(targets, lo, hi):
        for metric, value in (t.metrics or {}).items():
            slice_ = prorate(value, t.period_start, t.period_end, lo, hi)
            if slice_:
                out[metric] = out.get(metric, 0) + slice_
    return out


def full_goals(targets: Iterable[Target], lo: datetime,
               hi: datetime) -> dict[str, int]:
    """Combined per-metric goal for a REPORTING window, un-prorated.

    Use this — not prorated_goals — whenever the window comes from a date
    FILTER a person chose ("This month", "Last 3 months"). A monthly target is
    a whole-month commitment: someone looking at July on the 26th is still
    working to the full July number, not to 83% of it.

    That distinction is the bug the owner caught (2026-07-26): the overview
    said the July house-profit goal was Rs 20,752.90 while the Targets page
    said Rs 25,000, and the smaller figure crept upwards every time the page
    was opened — it was the month's goal sliced by how much of the month had
    elapsed, so it changed by the minute and matched nothing.

    prorated_goals is still right for GRAPH BUCKETS, where each bar covers a
    slice of time inside a series and a week must not be judged against a
    month's number.
    """
    out: dict[str, int] = {}
    for t in overlapping(targets, lo, hi):
        for metric, value in (t.metrics or {}).items():
            out[metric] = out.get(metric, 0) + value
    return out


def sum_metrics(buckets: Iterable[dict[str, int]]) -> dict[str, int]:
    """Add several metric maps together (used for team totals)."""
    out: dict[str, int] = {}
    for bucket in buckets:
        for metric, value in (bucket or {}).items():
            out[metric] = out.get(metric, 0) + value
    return out


# --- Dashboard progress windows --------------------------------------------------
# The tile offers this month, each of the two months before it, and the three
# combined (owner, 2026-07-26). Anything else falls back to the current month
# rather than erroring — a bad query string should never break a dashboard.

PROGRESS_WINDOWS: tuple[str, ...] = ("current", "prev1", "prev2", "last3")


def month_window(offset: int, now: Optional[datetime] = None
                 ) -> tuple[datetime, datetime]:
    """The whole IST calendar month `offset` months back (0 = this month)."""
    start_ist = add_months(month_start_ist(now or datetime.now(timezone.utc)),
                           -abs(offset))
    end_ist = add_months(start_ist, 1)
    return start_ist.astimezone(timezone.utc), end_ist.astimezone(timezone.utc)


def progress_window(key: str, now: Optional[datetime] = None
                    ) -> tuple[datetime, datetime, str]:
    """(start, end, label) for one dashboard-tile window key."""
    now = now or datetime.now(timezone.utc)
    if key == "last3":
        lo, _ = month_window(2, now)
        _, hi = month_window(0, now)
        return lo, hi, (f"{to_ist(lo):%b} – {to_ist(now):%b %Y}")
    offset = {"prev1": 1, "prev2": 2}.get(key, 0)
    lo, hi = month_window(offset, now)
    return lo, hi, f"{to_ist(lo):%B %Y}"


# --- Leaderboard -----------------------------------------------------------------


def score_row(profit: int, best_profit: int, attainment: float,
              has_target: bool) -> float:
    """Top Employee score in 0..1 — profit contribution AND target achievement.

    The owner wants both to count: raw contribution is the bulk of it, but
    someone who beat an ambitious number should outrank someone coasting on a
    big account. Attainment is capped (ATTAINMENT_CAP_PCT) so a token target
    cannot buy the top spot, and an employee with no target simply scores
    nothing on that half rather than being penalised into oblivion.
    """
    profit_part = (max(profit, 0) / best_profit) if best_profit > 0 else 0.0
    target_part = (min(attainment, ATTAINMENT_CAP_PCT) / ATTAINMENT_CAP_PCT
                   if has_target else 0.0)
    return round(PROFIT_WEIGHT * profit_part + TARGET_WEIGHT * target_part, 4)


def rank_performers(rows: list[dict]) -> list[dict]:
    """Attach `score` and `rank` to performance rows and sort them.

    Each row needs profit, attainment_pct and has_target. Ties break on profit
    so the order is stable and explainable to the person being ranked.
    """
    best = max((r.get("profit", 0) for r in rows), default=0)
    for r in rows:
        r["score"] = score_row(r.get("profit", 0), best,
                               r.get("attainment_pct", 0.0),
                               bool(r.get("has_target")))
    rows.sort(key=lambda r: (r["score"], r.get("profit", 0)), reverse=True)
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return rows


# --- Queries ---------------------------------------------------------------------


async def targets_for(assignee_ids: Optional[Iterable[str]] = None,
                      lo: Optional[datetime] = None,
                      hi: Optional[datetime] = None) -> list[Target]:
    """Targets for the given people (or everyone) overlapping [lo, hi]."""
    query: dict = {}
    if assignee_ids is not None:
        query["assignee_id"] = {"$in": list(assignee_ids)}
    if lo is not None and hi is not None:
        query["period_start"] = {"$lt": hi}
        query["period_end"] = {"$gt": lo}
    return await Target.find(query).sort("-period_start").to_list()


async def find_existing(assignee_id: str, period: TargetPeriod,
                        period_start: datetime) -> Optional[Target]:
    """The target already covering this person and period, if any — this is what
    makes the bulk-assign screen an upsert instead of a duplicate factory."""
    return await Target.find_one(
        Target.assignee_id == assignee_id,
        Target.period == period,
        Target.period_start == period_start,
    )


def period_end(period: TargetPeriod, start: datetime) -> datetime:
    """Window end for a period start (kept as the small public helper)."""
    return normalise_period(period, start)[1]
