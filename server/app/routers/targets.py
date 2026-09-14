"""Targets API: set goals for employees / channel partners and read attainment.

Managing targets needs manage_targets; reading other people's needs
view_targets. Everyone can always see THEIR OWN targets without any flag —
being told your own number is not a privilege.

Two owner rules from 2026-07-26 are enforced here and must stay enforced:

  * HOUSE PROFIT IS OWNER-SIDE. The house-profit goal is stripped from every
    response unless the caller may see it (owner, or a manage_targets holder —
    services/targets.can_see_profit_targets). An employee is told how many
    policies they owe the month, never what the agency made on them.
  * TARGETS ARE MONTHLY, AND NEVER FOR THE OWNER. The owner sets the numbers;
    they are not one of the people carrying them, so they are excluded from the
    assign roster, from the leaderboard and from team totals.

Channel partners get targets too (owner Q2.5): staff assign them so they can
judge how a partner is performing and pick up the phone. Since 2026-08-06 the
partner SEES their own target in the portal (GET /api/portal/target) and is told
when it is set — the "partners never sign in" clause that used to be here
described a portal that was switched off, and is gone with it.

A RELATIONSHIP MANAGER MAY SET THEIR OWN ROSTER'S TARGETS (owner F1)
-------------------------------------------------------------------
`manage_targets` is the right to hand somebody a number. An employee splitting
their own goal across the channel partners under them is not exercising that
right over the agency — it is the job the relationship manager was given. So
`_may_assign` allows it for partners whose `relationship_manager_id` is the
actor, and for nobody else:

  * another employee's target — needs manage_targets
  * a partner on somebody else's roster — needs manage_targets
  * THEIR OWN target — always refused without manage_targets (owner F2). You do
    not get to lower your own number.

An owner-set target on a partner can be overwritten by that partner's manager
(owner F5): there is one number per partner per month, the last edit wins, and
every edit is audited.

A MANAGER SETS FUTURE NUMBERS, NOT PAST ONES (owner C4, 2026-08-21)
-------------------------------------------------------------------
`_assert_period_open` refuses a create, edit or delete on a month that has
already finished — for callers WITHOUT `manage_targets` only.

Reading is untouched: the month picker goes back as far as anyone likes, because
deciding this month's number for a partner means looking at last month's first.
What the rule stops is reaching back and moving a goal somebody has already been
measured against, which is not setting a target — it is editing history, and it
would silently rewrite an attainment figure that has already been reported.

`manage_targets` is exempt because correcting a number that was keyed in wrong
two months ago is a real administrative job, and the owner already carries every
other irreversible action in this app.

The boundary is the IST month (`_period_is_past`), like every other reporting
boundary here — comparing raw instants would leave the first five and a half
hours of each 1st behaving as though last month were still open.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from beanie import PydanticObjectId
from fastapi import (
    APIRouter, BackgroundTasks, Depends, HTTPException, Query, status,
)

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import (
    AccountStatus, AccountType, AuditAction, TargetMetric, TargetPeriod,
    is_inhouse,
)
from app.core.permissions import can, MANAGE_TARGETS, VIEW_TARGETS
from app.models.base import utcnow
from app.models.finance import PolicyFinance
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.target import Target
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.target import (
    AssigneeAnalytics,
    BulkTargetAssign,
    PerformanceReport,
    PerformanceRow,
    TargetCreate,
    TargetMetricRow,
    TargetOut,
    TargetProgress,
    TargetUpdate,
    TrendPoint,
)
from app.services import target_alerts
from app.services import targets as svc
from app.services.audit import log_action

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/targets", tags=["targets"],
                   dependencies=[Depends(get_inhouse_user)])


# --- Helpers ---------------------------------------------------------------------


def _can_see_everyone(actor: User) -> bool:
    return actor.is_owner or can(actor, VIEW_TARGETS)


def _manages(actor: User, assignee: User) -> bool:
    """Is `assignee` a channel partner on `actor`'s own roster?

    The single test behind every relationship-manager allowance in this file.
    It is deliberately narrow: partners only (an employee is never "under"
    another employee — `reports_to_id` was deleted for being a hierarchy nothing
    read), and the actor's own id only.
    """
    manager_id = assignee.relationship_manager_id or ""
    # An unassigned partner is nobody's to assign — asserted here rather than
    # left to the fact that a real user id never stringifies to "".
    if not manager_id:
        return False
    return (assignee.account_type == AccountType.CHANNEL_PARTNER
            and manager_id == str(actor.id))


def _may_assign(actor: User, assignee: User) -> bool:
    """May `actor` set/change/remove `assignee`'s target? (see module docstring)"""
    if can(actor, MANAGE_TARGETS):
        return True
    return _manages(actor, assignee)


async def _assert_may_assign(actor: User, assignee: User) -> None:
    if _may_assign(actor, assignee):
        return
    if str(assignee.id) == str(actor.id):
        # Naming the rule beats a generic 403: people try this once.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You can't set your own target. Ask an owner.")
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        "You can only set targets for the channel partners you manage.")


def _period_is_past(lo: datetime) -> bool:
    """Is this target's period already OVER?

    Compared against the IST month the agency is currently in, like every other
    reporting boundary in this app — not against a raw instant, which would make
    the first five and a half hours of every 1st of the month behave as though
    the previous month were still open.
    """
    return svc.normalise_period(TargetPeriod.MONTH, utcnow())[0] > lo


async def _assert_period_open(actor: User, lo: datetime) -> None:
    """A relationship manager sets FUTURE numbers, not past ones (owner C4).

    Managers may look back as far as they like — judging a partner means reading
    last month before deciding this month's number, so the month picker is
    unrestricted and `_may_read` is untouched by this. What they may not do is
    reach back and change a goal somebody has already been measured against,
    which is the difference between setting a target and editing history.

    `manage_targets` is exempt: correcting a number that was keyed in wrong two
    months ago is a real administrative job, and the owner already carries every
    other irreversible action in the app. Every edit is audited either way.
    """
    if can(actor, MANAGE_TARGETS) or not _period_is_past(lo):
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        f"{svc.period_label(TargetPeriod.MONTH, lo)} has finished, so its "
        "target can't be changed now. Set the target for this month or a "
        "later one.")


async def _may_read(actor: User, assignee_id: str) -> bool:
    """May `actor` read this person's targets and attainment?

    Your own, anybody's with view_targets, and — for a relationship manager —
    the partners on your roster, because the Team tab on your record is built
    out of exactly those numbers.
    """
    if _can_see_everyone(actor) or assignee_id == str(actor.id):
        return True
    # `assignee_id` reaches here straight off a query string, so a malformed one
    # is a "no", not a 500 raised inside a permission check.
    try:
        who = await User.get(await parse_object_id(assignee_id))
    except HTTPException:
        return False
    return who is not None and _manages(actor, who)


def _profit_ok(actor: User) -> bool:
    """Whether this caller may see house-profit goals (see module docstring)."""
    return svc.can_see_profit_targets(actor)


def _gate_profit(actor: User, rows: list[dict]) -> list[dict]:
    """Drop house-profit metric rows the caller is not allowed to see."""
    if _profit_ok(actor):
        return rows
    return [r for r in rows if r["metric"] not in svc.PROFIT_METRICS]


def _gate_amount(actor: User, value: int) -> int:
    """Zero a raw house-profit amount for callers who may not see it."""
    return value if _profit_ok(actor) else 0


async def _assignee(assignee_id: str) -> User:
    user = await User.get(await parse_object_id(assignee_id))
    if user is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown assignee.")
    return user


async def _assignable(assignee_id: str) -> User:
    """The assignee, for the paths that SET a target.

    Reading someone's numbers and giving them a number are different questions,
    so the owner check lives here rather than in _assignee: the owner still has
    an analytics page, they just cannot be handed a goal.
    """
    user = await _assignee(assignee_id)
    if user.account_type == AccountType.OWNER:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "The owner cannot be assigned a target.")
    return user


def _assignee_type(user: User) -> str:
    return ("channel_partner"
            if user.account_type == AccountType.CHANNEL_PARTNER else "employee")


def _resolve_month(value: str | None) -> datetime:
    """Parse a `YYYY-MM` (or full ISO date) month selector, defaulting to now.

    The whole targets UI talks in months, so this is the one place a missing
    month falls back to the current one instead of 500-ing.
    """
    if not value:
        return utcnow()
    try:
        if len(value) == 7:                      # YYYY-MM
            return datetime.strptime(value, "%Y-%m").replace(
                tzinfo=timezone.utc)
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Invalid month. Use YYYY-MM.")


async def _people(kind: str) -> list[User]:
    """Active EMPLOYEES, or active channel partners.

    The owner is excluded from the employee roster: they are the one setting
    the numbers, and counting the boss's own book into "team progress" would
    flatter every report they read (owner, 2026-07-26).
    """
    query: dict = {"is_deleted": {"$ne": True},
                   "status": AccountStatus.ACTIVE.value}
    if kind == "channel_partner":
        query["account_type"] = AccountType.CHANNEL_PARTNER.value
        return await User.find(query).sort("full_name").to_list()
    query["account_type"] = AccountType.EMPLOYEE.value
    return await User.find(query).sort("full_name").to_list()


async def _out(t: Target, actor: User, name: str | None = None) -> TargetOut:
    actuals = await svc.compute_actuals(
        t.assignee_type, t.assignee_id, t.period_start, t.period_end)
    if name is None:
        who = await User.get(t.assignee_id)
        name = who.full_name if who else None
    return TargetOut.from_model(t, actuals=actuals, assignee_name=name,
                                allow_profit=_profit_ok(actor))


async def _names_for(user_ids) -> dict[str, str]:
    """{user_id: full_name} for just the ids given, in one query."""
    oids = []
    for uid in user_ids:
        try:
            oids.append(PydanticObjectId(uid))
        except Exception:  # noqa: BLE001 — skip malformed ids
            continue
    if not oids:
        return {}
    return {str(u.id): u.full_name
            for u in await User.find({"_id": {"$in": oids}}).to_list()}


# --- Read ------------------------------------------------------------------------


@router.get("", response_model=list[TargetOut])
async def list_targets(
    assignee_id: str | None = Query(default=None),
    actor: User = Depends(get_active_user),
) -> list[TargetOut]:
    """Targets for one person (or everyone, for those who may see them)."""
    if not _can_see_everyone(actor):
        # No flag: your own, and the partners you manage. Asking for "everyone"
        # falls back to your own rather than erroring — the Targets screen opens
        # without an id and should show you something.
        if assignee_id and not await _may_read(actor, assignee_id):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "You can only view your own targets and those of the channel "
                "partners you manage.")
        if not assignee_id:
            assignee_id = str(actor.id)

    query: dict = {"assignee_id": assignee_id} if assignee_id else {}
    items = await Target.find(query).sort("-period_start").to_list()
    if not items:
        return []

    # Actuals are window-specific, so compute each distinct window once rather
    # than once per target — a person with 12 monthly targets is 12 windows,
    # not 12 full scans of the book.
    # Only the people these targets actually belong to. This was find_all(),
    # which pulled every user document on every call just to label a handful of
    # rows.
    assignee_ids = {t.assignee_id for t in items if t.assignee_id}
    names = await _names_for(assignee_ids)
    windows = list({(t.period_start, t.period_end) for t in items})
    computed = await asyncio.gather(*[
        svc.actuals_by_assignee(lo, hi) for lo, hi in windows])
    by_window = dict(zip(windows, computed))

    allow_profit = _profit_ok(actor)
    out: list[TargetOut] = []
    for t in items:
        emp, partner = by_window[(t.period_start, t.period_end)]
        source = partner if t.assignee_type == "channel_partner" else emp
        out.append(TargetOut.from_model(
            t, actuals=source.get(t.assignee_id, svc.blank_metrics()),
            assignee_name=names.get(t.assignee_id),
            allow_profit=allow_profit))
    return out


@router.get("/progress", response_model=TargetProgress)
async def progress(
    window: str = Query(default="current",
                        pattern="^(current|prev1|prev2|last3)$"),
    actor: User = Depends(get_active_user),
) -> TargetProgress:
    """The dashboard tile: how am I (or how is the team) doing this month?

    An employee gets THEIR OWN progress — their booked policies against their
    own goals. The owner has no target of their own, so they get the team's
    combined position instead: every active employee's goals and actuals added
    up, which is the number that actually tells them how the month is going.

    Registered before /{target_id} would ever be reached (there is no such
    route here, but the convention holds across the app).
    """
    lo, hi, label = svc.progress_window(window, utcnow())
    allow_profit = _profit_ok(actor)
    team = actor.is_owner

    emp_actuals, _partner_actuals = await svc.actuals_by_assignee(lo, hi)

    if not team:
        me = str(actor.id)
        targets = await svc.targets_for([me], lo, hi)
        # Full goal, never a slice of elapsed time — the tile must read the
        # same number as the Targets page all month long (see full_goals).
        goals = svc.full_goals(targets, lo, hi)
        actuals = emp_actuals.get(me, svc.blank_metrics())
        rows = svc.metric_rows(goals, actuals, allow_profit=allow_profit)
        return TargetProgress(
            scope="self", window=window, label=label,
            period_start=lo, period_end=hi,
            has_target=bool(goals),
            metrics=[TargetMetricRow(**r) for r in rows],
            attainment_pct=svc.overall_attainment(rows),
        )

    people = await _people("employee")
    ids = [str(u.id) for u in people]
    targets = await svc.targets_for(ids, lo, hi)
    goals = svc.full_goals(targets, lo, hi)
    actuals = svc.sum_metrics(emp_actuals.get(uid, svc.blank_metrics())
                              for uid in ids)
    rows = svc.metric_rows(goals, actuals, allow_profit=allow_profit)
    return TargetProgress(
        scope="team", window=window, label=label,
        period_start=lo, period_end=hi,
        has_target=bool(goals),
        metrics=[TargetMetricRow(**r) for r in rows],
        attainment_pct=svc.overall_attainment(rows),
        people_with_target=len({t.assignee_id for t in targets}),
        people=len(people),
    )


@router.get("/performance", response_model=PerformanceReport)
async def performance(
    month: str | None = Query(default=None, description="YYYY-MM"),
    period: TargetPeriod = Query(default=TargetPeriod.MONTH),
    kind: str = Query(default="employee",
                      pattern="^(employee|channel_partner)$"),
    actor: User = Depends(get_active_user),
) -> PerformanceReport:
    """The leaderboard: everyone's actuals vs their goals for one period.

    Ranked by the combined profit + attainment score (services/targets), which
    is what the owner asked "Top Employee" to mean.
    """
    if not _can_see_everyone(actor):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You can't view the team's targets.")
    lo, hi = svc.normalise_period(period, _resolve_month(month))

    people, (emp_actuals, partner_actuals) = await asyncio.gather(
        _people(kind), svc.actuals_by_assignee(lo, hi))
    ids = [str(u.id) for u in people]
    targets = await svc.targets_for(ids, lo, hi)
    by_person: dict[str, Target] = {}
    for t in targets:
        # One target per person per window; if an older build left duplicates,
        # the most recent wins (targets_for sorts newest first).
        by_person.setdefault(t.assignee_id, t)

    source = partner_actuals if kind == "channel_partner" else emp_actuals
    allow_profit = _profit_ok(actor)
    rows: list[dict] = []
    for u in people:
        uid = str(u.id)
        actuals = source.get(uid, svc.blank_metrics())
        target = by_person.get(uid)
        metrics = svc.metric_rows(target.metrics if target else {}, actuals,
                                  allow_profit=allow_profit)
        rows.append({
            "assignee_id": uid,
            "assignee_type": kind,
            "name": u.full_name,
            "code": u.code,
            "policies": actuals[TargetMetric.POLICIES.value],
            "renewals": actuals[TargetMetric.RENEWALS.value],
            "premium": actuals[TargetMetric.PREMIUM.value],
            # Ranking still uses the real profit (see below); what leaves the
            # server is zeroed for viewers who may not see the agency's margin.
            "profit": actuals[TargetMetric.HOUSE_PROFIT.value],
            "has_target": target is not None,
            "target_id": str(target.id) if target else None,
            "attainment_pct": svc.overall_attainment(metrics),
            "metrics": metrics,
        })
    svc.rank_performers(rows)

    totals = {
        "policies": sum(r["policies"] for r in rows),
        "renewals": sum(r["renewals"] for r in rows),
        "premium": sum(r["premium"] for r in rows),
        "profit": _gate_amount(actor, sum(r["profit"] for r in rows)),
    }
    for r in rows:
        r["profit"] = _gate_amount(actor, r["profit"])

    return PerformanceReport(
        period=period, period_start=lo, period_end=hi,
        period_label=svc.period_label(period, lo),
        rows=[PerformanceRow(**{**r, "metrics": [TargetMetricRow(**m)
                                                 for m in r["metrics"]]})
              for r in rows],
        totals=totals,
        with_target=sum(1 for r in rows if r["has_target"]),
        on_track=sum(1 for r in rows
                     if r["has_target"] and r["attainment_pct"] >= 100),
    )


@router.get("/analytics/{assignee_id}", response_model=AssigneeAnalytics)
async def analytics(
    assignee_id: str,
    months: int = Query(default=6, ge=1, le=24),
    metric: TargetMetric = Query(default=TargetMetric.HOUSE_PROFIT),
    actor: User = Depends(get_active_user),
) -> AssigneeAnalytics:
    """Deep-dive for one person: this month vs goal, a month-by-month trend and
    where their business came from. Drives the Analytics popup on the People
    pages (owner Q2.5)."""
    if not await _may_read(actor, assignee_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You can only view your own analytics and those of the channel "
            "partners you manage.")
    who = await _assignee(assignee_id)
    kind = _assignee_type(who)
    allow_profit = _profit_ok(actor)
    # House profit is the default deep-dive metric — swap it for something the
    # viewer may actually see rather than drawing them a chart of zeroes.
    if metric == TargetMetric.HOUSE_PROFIT and not allow_profit:
        metric = TargetMetric.POLICIES

    lo, hi = svc.normalise_period(TargetPeriod.MONTH, utcnow())

    # The last `months` monthly windows, oldest first, ending with this month.
    windows: list[tuple[datetime, datetime]] = []
    cursor = lo
    for _ in range(months):
        windows.append(svc.normalise_period(TargetPeriod.MONTH, cursor))
        # Step back one day from the window start to land in the month before.
        cursor = svc.month_start_ist(cursor) - timedelta(days=1)
    windows.reverse()

    all_targets = await svc.targets_for([assignee_id])
    actual_sets = await asyncio.gather(*[
        svc.actuals_by_assignee(w_lo, w_hi) for w_lo, w_hi in windows])

    trend: list[TrendPoint] = []
    for (w_lo, w_hi), (emp, partner) in zip(windows, actual_sets):
        source = partner if kind == "channel_partner" else emp
        actuals = source.get(assignee_id, svc.blank_metrics())
        goals = svc.prorated_goals(all_targets, w_lo, w_hi)
        actual, goal = actuals.get(metric.value, 0), goals.get(metric.value, 0)
        trend.append(TrendPoint(
            key=w_lo.strftime("%Y-%m"),
            label=svc.period_label(TargetPeriod.MONTH, w_lo),
            actual=actual, target=goal,
            attainment_pct=svc.attainment_pct(actual, goal),
        ))

    # Current period detail.
    emp_now, partner_now = actual_sets[-1]
    source_now = partner_now if kind == "channel_partner" else emp_now
    actuals_now = source_now.get(assignee_id, svc.blank_metrics())
    current = next(iter(svc.overlapping(all_targets, lo, hi)), None)
    metrics = svc.metric_rows(current.metrics if current else {}, actuals_now,
                              allow_profit=allow_profit)

    # Where the business came from — and, for a partner, what we owe them.
    field = "partner_id" if kind == "channel_partner" else "owner_user_id"
    policies = await Policy.find(
        {field: assignee_id, "created_at": {"$gte": lo, "$lt": hi}}).to_list()
    kept = [p for p in policies if svc.counts_for_targets(p)]
    finances = {pf.policy_id: pf for pf in await PolicyFinance.find(
        {"policy_id": {"$in": [str(p.id) for p in kept]}}).to_list()}
    cat_labels = {c.key: c.label
                  for c in await PolicyCategory.find_all().to_list()}
    by_cat: dict[str, dict] = {}
    payout = 0
    for p in kept:
        pf = finances.get(str(p.id))
        if pf is None:
            continue
        payout += pf.partner_share
        agg = by_cat.setdefault(p.category_key, {
            "key": p.category_key,
            "label": cat_labels.get(p.category_key, p.category_key),
            "policies": 0, "premium": 0, "profit": 0})
        agg["policies"] += 1
        agg["premium"] += pf.gross_premium
        agg["profit"] += _gate_amount(actor, pf.house_profit)

    return AssigneeAnalytics(
        assignee_id=assignee_id, assignee_type=kind, name=who.full_name,
        code=who.code, metric=metric,
        period_label=svc.period_label(TargetPeriod.MONTH, lo),
        policies=actuals_now[TargetMetric.POLICIES.value],
        renewals=actuals_now[TargetMetric.RENEWALS.value],
        premium=actuals_now[TargetMetric.PREMIUM.value],
        profit=_gate_amount(actor, actuals_now[TargetMetric.HOUSE_PROFIT.value]),
        partner_payout=payout,
        attainment_pct=svc.overall_attainment(metrics),
        has_target=current is not None,
        metrics=[TargetMetricRow(**m) for m in metrics],
        trend=trend,
        top_categories=sorted(by_cat.values(), key=lambda r: r["profit"],
                              reverse=True)[:5],
    )


# --- Write -----------------------------------------------------------------------


@router.post("", response_model=TargetOut, status_code=status.HTTP_201_CREATED)
async def create_target(payload: TargetCreate, background: BackgroundTasks,
                        actor: User = Depends(get_active_user)) -> TargetOut:
    who = await _assignable(payload.assignee_id)
    # NOT a route-level require_permission any more: a relationship manager may
    # set their own roster's targets without manage_targets (see the module
    # docstring). The check needs the assignee, so it has to be in the body.
    await _assert_may_assign(actor, who)
    lo, hi = svc.normalise_period(payload.period, payload.period_start)
    await _assert_period_open(actor, lo)

    # One target per person per period — setting the "same" target again edits
    # the existing one instead of quietly stacking a second goal on top of it.
    existing = await svc.find_existing(payload.assignee_id, payload.period, lo)
    if existing is not None:
        changed = existing.metrics != payload.metrics
        existing.metrics = payload.metrics
        existing.note = payload.note
        if changed:
            # New numbers, new run: milestones already announced no longer
            # describe the goal the person is being measured against.
            existing.notified_pcts = []
        existing.updated_at = utcnow()
        await existing.save()
        target, action, verb = existing, AuditAction.TARGET_UPDATED, "Updated"
    else:
        target = Target(
            assignee_type=_assignee_type(who),
            assignee_id=payload.assignee_id,
            period=payload.period, period_start=lo, period_end=hi,
            metrics=payload.metrics, note=payload.note,
            created_by=str(actor.id),
        )
        await target.insert()
        action, verb = AuditAction.TARGET_CREATED, "Set"

    await log_action(
        action, actor_id=str(actor.id), actor_name=actor.full_name,
        actor_role=actor.account_type.value,
        entity_type="target", entity_id=str(target.id),
        summary=(f"{verb} {svc.period_label(target.period, lo)} target for "
                 f"{who.full_name}"),
        meta={"metrics": payload.metrics},
    )
    # Tell them what they are aiming for — after the response, so setting a
    # target never waits on SMTP.
    background.add_task(target_alerts.notify_target_assigned, target)
    return await _out(target, actor, name=who.full_name)


@router.post("/bulk", response_model=list[TargetOut],
             dependencies=[Depends(require_permission(MANAGE_TARGETS))])
async def bulk_assign(payload: BulkTargetAssign, background: BackgroundTasks,
                      actor: User = Depends(get_active_user)
                      ) -> list[TargetOut]:
    """Assign the whole team's targets for one period in a single save.

    Upserts row by row: a row with values creates or updates that person's
    target, a row with no values REMOVES it. That makes the assign screen
    idempotent — you can save it as often as you like without breeding
    duplicate goals.
    """
    lo, hi = svc.normalise_period(payload.period, payload.period_start)
    label = svc.period_label(payload.period, lo)

    users = {str(u.id): u for u in await User.find_all().to_list()}
    saved: list[Target] = []
    announce: list[Target] = []      # only the rows that actually changed
    removed = 0
    for row in payload.rows:
        who = users.get(row.assignee_id)
        # The owner is never one of the people carrying a target, so a stale
        # client that still posts a row for them is ignored rather than 400ing
        # the whole team's save.
        if who is None or who.account_type == AccountType.OWNER:
            continue
        existing = await svc.find_existing(row.assignee_id, payload.period, lo)
        if not row.metrics:
            if existing is not None:
                await existing.delete()
                removed += 1
            continue
        if existing is not None:
            if existing.metrics != row.metrics:
                existing.metrics = row.metrics
                existing.notified_pcts = []      # new numbers, fresh milestones
                announce.append(existing)
            existing.updated_at = utcnow()
            await existing.save()
            saved.append(existing)
        else:
            target = Target(
                assignee_type=_assignee_type(who),
                assignee_id=row.assignee_id,
                period=payload.period, period_start=lo, period_end=hi,
                metrics=row.metrics, created_by=str(actor.id),
            )
            await target.insert()
            saved.append(target)
            announce.append(target)

    await log_action(
        AuditAction.TARGET_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="target", entity_id="bulk",
        summary=f"Assigned {label} targets to {len(saved)} people"
                + (f" ({removed} removed)" if removed else ""),
    )
    # Only people whose numbers actually moved hear about it — re-saving the
    # assign screen unchanged must not spam the whole team.
    background.add_task(target_alerts.notify_targets_assigned, announce)

    emp, partner = await svc.actuals_by_assignee(lo, hi)
    allow_profit = _profit_ok(actor)
    out = []
    for t in saved:
        source = partner if t.assignee_type == "channel_partner" else emp
        who = users.get(t.assignee_id)
        out.append(TargetOut.from_model(
            t, actuals=source.get(t.assignee_id, svc.blank_metrics()),
            assignee_name=who.full_name if who else None,
            allow_profit=allow_profit))
    return out


@router.patch("/{target_id}", response_model=TargetOut)
async def update_target(target_id: str, payload: TargetUpdate,
                        background: BackgroundTasks,
                        actor: User = Depends(get_active_user)) -> TargetOut:
    target = await Target.get(await parse_object_id(target_id))
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Target not found.")
    await _assert_may_assign(actor, await _assignee(target.assignee_id))
    # BOTH ends: the period this target is in now, and the one a `period_start`
    # in the payload would move it to. Checking only the destination would let a
    # finished month be emptied by moving its target somewhere else.
    await _assert_period_open(actor, target.period_start)
    changes = payload.model_dump(exclude_unset=True)
    goals_changed = ("metrics" in changes
                     and changes["metrics"] != target.metrics)
    for field, value in changes.items():
        setattr(target, field, value)
    if "period" in changes or "period_start" in changes:
        target.period_start, target.period_end = svc.normalise_period(
            target.period, target.period_start)
        await _assert_period_open(actor, target.period_start)
    if goals_changed:
        target.notified_pcts = []        # measured against new numbers now
    target.updated_at = utcnow()
    await target.save()
    await log_action(
        AuditAction.TARGET_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="target", entity_id=str(target.id),
        summary="Updated "
                f"{svc.period_label(target.period, target.period_start)} target",
        meta={"fields": list(changes.keys())},
    )
    if goals_changed:
        background.add_task(target_alerts.notify_target_assigned, target)
    return await _out(target, actor)


@router.delete("/{target_id}")
async def delete_target(target_id: str,
                        actor: User = Depends(get_active_user)) -> dict:
    target = await Target.get(await parse_object_id(target_id))
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Target not found.")
    await _assert_may_assign(actor, await _assignee(target.assignee_id))
    await _assert_period_open(actor, target.period_start)
    await target.delete()
    await log_action(
        AuditAction.TARGET_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="target", entity_id=target_id, summary="Deleted a target",
    )
    return {"detail": "Target deleted."}
