"""Relationship managers — an employee and the channel partners under them.

Replaces routers/teams.py (owner 2026-08-05). There is no new record here: a
manager is an EMPLOYEE, and the roster is `User.relationship_manager_id`, which
has been mandatory on every channel partner since partners were built. What was
missing was anywhere to read it.

THIS IS A VIEW, NOT A RESTRICTION (owner T1). Every in-house user can still open
every customer, policy and lead — access is permission flags, never record
ownership, and `core/scoping.py` was deleted on purpose. The roster is filtered
because that is what the page is for, not because the caller is forbidden the
rest. The one thing that IS gated is other people's numbers: an employee sees
their own row and roster, the owner sees the league table (owner T4.3b).

Money conventions, all borrowed rather than reinvented:
  * house profit is zeroed server-side without `view_agency_profit`
  * a partner's net balance is `finance_balance.partner_net_balance`, the same
    function the Balance Sheet and the partner's own statement use — a manager's
    page and the partner's statement disagreeing is the worst bug this app can
    have
  * the date window is `finance_reports.resolve_period`, so "last 3 months"
    means here what it means on every other screen
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import get_active_user, get_inhouse_user
from app.core.enums import (
    AccountStatus, AccountType, PartyType, PolicyStatus,
)
from app.core.permissions import (
    can,
    MANAGE_PARTNERS, MANAGE_TARGETS, VIEW_AGENCY_PROFIT, VIEW_PARTNERS,
)
from app.models.finance import PartyAccount, PolicyFinance
from app.models.policy import Policy
from app.models.user import User
from app.models.wallet import Wallet
from app.routers._helpers import parse_object_id
from app.schemas.manager import (
    ManagerRollup, ManagerRoster, ManagerRow, PartnerRosterRow,
    TargetAllocationRow, TeamPolicies, TeamPolicyRow,
)
from app.schemas.target import TargetMetricRow
from app.services import finance_balance
from app.services import policy_scope
from app.services import targets as target_svc
from app.services.finance_reports import IST, resolve_period, to_ist

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/managers", tags=["managers"],
                   dependencies=[Depends(get_inhouse_user)])

# A partner who has not written a policy in this many days is flagged (owner
# T6.1). ONE number, set once — not a per-user setting, because "quiet" has to
# mean the same thing on every manager's page for the flag to be worth anything.
QUIET_AFTER_DAYS = 60

# How far ahead the roster looks for expiring cover.
RENEWAL_HORIZON_DAYS = 30

# Cover that is still live, and therefore renewable.
_LIVE_STATUSES = (PolicyStatus.ACTIVE.value, PolicyStatus.RENEWAL_DUE.value)


# --- Helpers ---------------------------------------------------------------------


def _window(period: str, date_from: Optional[str], date_to: Optional[str]):
    """The shared date filter. A picked date is a CALENDAR date and therefore
    IST, not UTC — attaching UTC to "2026-07-01" starts the range at 05:30 IST
    and silently drops half a day (the same trap `reports._parse_ist` exists
    for)."""
    def _ist(value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return dt.replace(tzinfo=IST) if dt.tzinfo is None else dt

    return resolve_period(period, to_ist(datetime.now(tz=IST)),
                          _ist(date_from), _ist(date_to))


def _is_manager_account(user: User) -> bool:
    """Who can hold partners: in-house staff. The owner holds partners too —
    they are the relationship manager on plenty of accounts in practice."""
    return user.account_type in (AccountType.EMPLOYEE, AccountType.OWNER)


async def _load_manager(manager_id: str) -> User:
    user = await User.get(await parse_object_id(manager_id))
    if user is None or not _is_manager_account(user):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Manager not found.")
    return user


def _assert_may_read(actor: User, manager_id: str) -> None:
    """Owner T4.3b: the owner reads everyone, an employee reads themselves.

    About whose NUMBERS you may read — the roster, the targets, the attainment —
    which is the same category as `view_agency_profit`.

    IT IS NOT THE POLICY SCOPE, and since 2026-08-24 that distinction matters.
    This used to end "the records themselves stay open to every in-house user",
    which is no longer true: policies are scoped (services/policy_scope), and
    the one route here that returns policy ROWS carries a second check of its
    own. See `manager_team_policies`.
    """
    if actor.account_type == AccountType.OWNER:
        return
    if str(actor.id) == manager_id:
        return
    if not can(actor, VIEW_PARTNERS):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You can only see your own channel partners.")


def _may_read_all(actor: User) -> bool:
    return actor.account_type == AccountType.OWNER \
        or can(actor, VIEW_PARTNERS)


async def _policies_in_window(lo: datetime, hi: datetime) -> list[Policy]:
    """Policies booked in the window. Bucketed on the entry date, like the
    Overview and Reports pages (the Balance Sheet buckets on cover start — the
    split is deliberate, see CLAUDE.md)."""
    return await Policy.find({"created_at": {"$gte": lo, "$lte": hi}}).to_list()


async def _finance_for(policies: list[Policy]) -> dict[str, PolicyFinance]:
    """P&L snapshots for exactly these policies.

    `$in`-scoped rather than `PolicyFinance.find_all()` — CLAUDE.md asks new
    finance reads not to widen that pattern, and this is a new finance read.
    """
    ids = [str(p.id) for p in policies]
    if not ids:
        return {}
    return {pf.policy_id: pf async for pf in
            PolicyFinance.find({"policy_id": {"$in": ids}})}


# --- The league table ------------------------------------------------------------


@router.get("", response_model=ManagerRollup)
async def managers_rollup(
    actor: User = Depends(get_active_user),
    period: str = Query(default="current_month"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
) -> ManagerRollup:
    """Every manager's book for the window.

    Reads the policy's FROZEN manager stamp, so the numbers are what each
    manager brought in AT THE TIME — not what today's roster would imply.
    Reassigning a partner tomorrow must not move last quarter's business onto
    someone who did not do the work.
    """
    lo, hi, label = _window(period, date_from, date_to)
    can_all = _may_read_all(actor)
    can_profit = can(actor, VIEW_AGENCY_PROFIT)

    staff = {str(u.id): u async for u in User.find(
        {"account_type": {"$in": [AccountType.EMPLOYEE.value,
                                  AccountType.OWNER.value]},
         "is_deleted": {"$ne": True}})}

    # Roster sizes, in one pass over the partners.
    partner_counts: dict[str, int] = {}
    partner_manager: dict[str, str] = {}
    async for p in User.find(
            {"account_type": AccountType.CHANNEL_PARTNER.value,
             "is_deleted": {"$ne": True}}):
        rm = p.relationship_manager_id
        if rm:
            partner_counts[rm] = partner_counts.get(rm, 0) + 1
            partner_manager[str(p.id)] = rm

    policies = await _policies_in_window(lo, hi)
    finance = await _finance_for(policies)

    rows: dict[str, ManagerRow] = {}
    unassigned = ManagerRow(manager_id="", manager_name="Unassigned")
    # Partners who actually wrote something in the window, per manager.
    produced: dict[str, set[str]] = {}

    def row_for(manager_id: str) -> ManagerRow:
        row = rows.get(manager_id)
        if row is None:
            u = staff.get(manager_id)
            row = rows[manager_id] = ManagerRow(
                manager_id=manager_id,
                manager_name=u.full_name if u else "Former employee",
                manager_code=u.code if u else None,
                active_account=bool(u and u.status == AccountStatus.ACTIVE),
                partners=partner_counts.get(manager_id, 0))
        return row

    for p in policies:
        key = p.manager_id or ""
        row = row_for(key) if key else unassigned
        pf = finance.get(str(p.id))

        row.policies += 1
        row.premium += p.premium_amount
        if pf is not None:
            row.reward_earned += pf.agency_reward
            row.partner_share += pf.partner_share
            row.profit += pf.house_profit
        if p.renewed_from_policy_id:
            row.renewals += 1

        if p.partner_id:
            row.partner_policies += 1
            row.partner_premium += p.premium_amount
            if key:
                produced.setdefault(key, set()).add(p.partner_id)
        else:
            row.own_policies += 1
            row.own_premium += p.premium_amount

    # Managers with a roster but no business in the window still belong on the
    # page — a manager whose partners all went quiet is exactly what the owner
    # opened this to find.
    for manager_id in partner_counts:
        row_for(manager_id)
    for manager_id, row in rows.items():
        row.active_partners = len(produced.get(manager_id, ()))

    if not can_profit:
        for row in list(rows.values()) + [unassigned]:
            row.profit = 0

    ordered = sorted(rows.values(), key=lambda r: -r.premium)
    if not can_all:
        # An employee sees their own row and nothing about anyone else.
        ordered = [r for r in ordered if r.manager_id == str(actor.id)]
        unassigned = ManagerRow(manager_id="", manager_name="Unassigned")

    return ManagerRollup(
        can_view_profit=can_profit, can_view_all=can_all,
        date_from=lo, date_to=hi, period_label=label, rows=ordered,
        unassigned=unassigned if (can_all and unassigned.policies) else None)


# --- One manager's roster --------------------------------------------------------
#
# NOTE: /me/partners MUST stay registered before /{manager_id}/partners, or the
# dynamic route swallows "me" and tries to load a user with that id.


@router.get("/me/partners", response_model=ManagerRoster)
async def my_partners(
    actor: User = Depends(get_active_user),
    period: str = Query(default="current_month"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
) -> ManagerRoster:
    """The signed-in employee's own channel partners."""
    return await _roster(actor, actor, period, date_from, date_to)


@router.get("/{manager_id}/partners", response_model=ManagerRoster)
async def manager_partners(
    manager_id: str,
    actor: User = Depends(get_active_user),
    period: str = Query(default="current_month"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
) -> ManagerRoster:
    _assert_may_read(actor, manager_id)
    return await _roster(actor, await _load_manager(manager_id),
                         period, date_from, date_to)


# One screen's worth of business. A manager with 40 partners across a year can
# hold thousands of policies, and this endpoint hydrates Pydantic objects — the
# same memory ceiling CLAUDE.md describes for the finance reads. Past this the
# response says so and points at /policies, which is paginated.
MAX_TEAM_POLICIES = 500


@router.get("/me/policies", response_model=TeamPolicies)
async def my_team_policies(
    actor: User = Depends(get_active_user),
    period: str = Query(default="current_month"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
) -> TeamPolicies:
    """The business the signed-in employee's own partners wrote."""
    return await _team_policies(actor, actor, period, date_from, date_to)


@router.get("/{manager_id}/policies", response_model=TeamPolicies)
async def manager_team_policies(
    manager_id: str,
    actor: User = Depends(get_active_user),
    period: str = Query(default="current_month"),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
) -> TeamPolicies:
    """The business one manager's partners wrote.

    TWO GATES, and the second one arrived on 2026-08-24 with the policy scope.

    `_assert_may_read` decides whose NUMBERS you may read — the roster, the
    targets, the attainment — and `view_partners` is enough for that. It is NOT
    enough for the POLICIES themselves any more: this endpoint returns actual
    policy rows, and without the second check it would be the way straight round
    the whole scope (hold `view_partners`, pass somebody else's id, read their
    entire book).

    Your OWN team is always readable — that is what `/me/policies` is, and it is
    the same answer this route gives when the ids match.
    """
    _assert_may_read(actor, manager_id)
    if (str(actor.id) != manager_id
            and not policy_scope.sees_everything(actor)):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You can see your own team's policies. Reading another team's "
            "book needs the whole-book permission.")
    return await _team_policies(actor, await _load_manager(manager_id),
                                period, date_from, date_to)


async def _team_policies(actor: User, manager: User, period: str,
                         date_from: Optional[str],
                         date_to: Optional[str]) -> TeamPolicies:
    """The policies behind the roster's totals.

    The Team view could say what a partner was GIVEN and what they TOTALLED and
    not show one line of the actual business, so answering "why is that number
    what it is" meant leaving for /policies and filtering by partner, one at a
    time, for a roster of ten.

    Bucketed on `created_at` — the ENTRY date — because that is what the roster
    totals directly above this list are bucketed on. The Balance Sheet buckets
    on cover start; mixing the two here would give a list that does not add up
    to the header it sits under.
    """
    lo, hi, label = _window(period, date_from, date_to)

    partners = await User.find(
        {"relationship_manager_id": str(manager.id),
         "is_deleted": {"$ne": True}}).to_list()
    names = {str(p.id): p.full_name for p in partners}
    ids = list(names)
    if not ids:
        return TeamPolicies(
            manager_id=str(manager.id), manager_name=manager.full_name,
            date_from=lo, date_to=hi, period_label=label)

    query = {"partner_id": {"$in": ids},
             "created_at": {"$gte": lo, "$lte": hi}}
    total = await Policy.find(query).count()
    policies = (await Policy.find(query).sort("-created_at")
                .limit(MAX_TEAM_POLICIES).to_list())
    finance = await _finance_for(policies)

    # Display names, resolved in ONE pass each rather than per row — the same
    # bulk-map shape every list serialiser in the app uses.
    from app.models.customer import Customer
    from app.models.insurer import Insurer
    from app.models.master import PolicyCategory

    cust_ids = {p.customer_id for p in policies if p.customer_id}
    ins_ids = {p.insurer_id for p in policies if p.insurer_id}
    customers = {str(c.id): c.name for c in await Customer.find(
        {"_id": {"$in": [await parse_object_id(i) for i in cust_ids]}}
    ).to_list()} if cust_ids else {}
    insurers = {str(i.id): i.name for i in await Insurer.find(
        {"_id": {"$in": [await parse_object_id(i) for i in ins_ids]}}
    ).to_list()} if ins_ids else {}
    categories = {c.key: c.label async for c in PolicyCategory.find_all()}

    rows = [TeamPolicyRow(
        policy_id=str(p.id), code=p.code, policy_number=p.policy_number,
        partner_id=p.partner_id,
        partner_name=names.get(p.partner_id or ""),
        customer_name=customers.get(p.customer_id or ""),
        category_label=categories.get(p.category_key, p.category_key),
        insurer_name=insurers.get(p.insurer_id or ""),
        premium=p.premium_amount,
        their_reward=(finance[str(p.id)].partner_share
                      if str(p.id) in finance else 0),
        status=p.status.value if hasattr(p.status, "value") else str(p.status),
        is_renewal=bool(p.renewed_from_policy_id),
        booked_at=p.created_at, expiry_date=p.expiry_date,
    ) for p in policies]

    return TeamPolicies(
        manager_id=str(manager.id), manager_name=manager.full_name,
        date_from=lo, date_to=hi, period_label=label,
        total=total,
        # The TOTALS are of what is listed, not of the whole window, and the
        # `truncated` flag is what makes that honest — a footer summing 500 rows
        # under a count of 900 is a spreadsheet that lies quietly.
        premium=sum(r.premium for r in rows),
        their_reward_total=sum(r.their_reward for r in rows),
        rows=rows,
        truncated=total > len(rows))


def _may_set_targets(actor: User, manager: User) -> bool:
    """May the caller hand out the targets on this roster?

    Either they assign targets across the agency (`manage_targets`), or this is
    their OWN roster — splitting your own goal across your own partners is the
    relationship manager's job, not a privilege (owner F1). Mirrors
    `routers/targets._may_assign`; the two must agree, or the page shows a
    button that 403s.
    """
    return (can(actor, MANAGE_TARGETS)
            or str(actor.id) == str(manager.id))


async def _target_rows(assignee_type: str, assignee_ids: list[str],
                       actuals: dict[str, dict[str, int]],
                       lo: datetime, hi: datetime, allow_profit: bool
                       ) -> dict[str, dict]:
    """{assignee_id: {has_target, target_id, attainment_pct, metrics}}.

    One query for the whole roster. The goal is the FULL period goal, never a
    slice of elapsed time (services/targets.full_goals) — a manager opening this
    on the 26th is still working to the whole month's number, and a figure that
    creeps upward as the month passes matches nothing else on screen.
    """
    out: dict[str, dict] = {}
    if not assignee_ids:
        return out
    targets = await target_svc.targets_for(assignee_ids, lo, hi)
    by_person: dict[str, list] = {}
    for t in targets:
        by_person.setdefault(t.assignee_id, []).append(t)
    for uid in assignee_ids:
        held = by_person.get(uid, [])
        goals = target_svc.full_goals(held, lo, hi)
        rows = target_svc.metric_rows(
            goals, actuals.get(uid, target_svc.blank_metrics()),
            allow_profit=allow_profit)
        out[uid] = {
            "has_target": bool(goals),
            # Only when there is exactly one: the inline editor edits A target,
            # and two overlapping ones have no single id to point at.
            "target_id": str(held[0].id) if len(held) == 1 else None,
            "attainment_pct": target_svc.overall_attainment(rows),
            "metrics": [TargetMetricRow(**r) for r in rows],
        }
    return out


def _allocation(manager_metrics, rows: list[PartnerRosterRow]
                ) -> list[TargetAllocationRow]:
    """Per metric: what the manager was asked for, and what they handed on.

    Only metrics the MANAGER carries a goal for. A partner goal on something
    their manager was never given is not "over-allocation" — it is a different
    conversation, and putting it in this list would make the one number the row
    exists to show (the gap) meaningless.

    Deactivated partners are skipped, matching `partners_with_target` (owner
    J3): counting a goal nobody can work makes a manager look allocated when
    they are not.
    """
    out: list[TargetAllocationRow] = []
    for m in manager_metrics:
        key = m.metric.value if hasattr(m.metric, "value") else str(m.metric)
        total = 0
        holders = 0
        for r in rows:
            if not r.active_account:
                continue
            for pm in r.target_metrics:
                pk = pm.metric.value if hasattr(pm.metric, "value")                     else str(pm.metric)
                if pk == key and pm.target_value:
                    total += pm.target_value
                    holders += 1
        out.append(TargetAllocationRow(
            metric=key, label=m.label, is_money=m.is_money,
            target_value=m.target_value, allocated=total,
            partners_with_goal=holders))
    return out


async def _roster(actor: User, manager: User, period: str,
                  date_from: Optional[str],
                  date_to: Optional[str]) -> ManagerRoster:
    """ONE serialiser for both endpoints, so the owner's view of an employee and
    that employee's own view of themselves can never disagree."""
    lo, hi, label = _window(period, date_from, date_to)
    now = datetime.now(tz=IST)
    allow_profit = target_svc.can_see_profit_targets(actor)

    partners = await User.find(
        {"relationship_manager_id": str(manager.id),
         "is_deleted": {"$ne": True}}).sort("full_name").to_list()
    ids = [str(p.id) for p in partners]

    # The manager's OWN target is loaded even when the roster is empty — an
    # employee with no partners yet still carries a number, and the Team tab is
    # where they read it (owner G7).
    emp_actuals, partner_actuals = await target_svc.actuals_by_assignee(lo, hi)
    mine = (await _target_rows("employee", [str(manager.id)], emp_actuals,
                               lo, hi, allow_profit))[str(manager.id)]

    rows: list[PartnerRosterRow] = []
    if not ids:
        return ManagerRoster(
            manager_id=str(manager.id), manager_name=manager.full_name,
            manager_code=manager.code,
            can_view_profit=can(actor, VIEW_AGENCY_PROFIT),
            can_manage=can(actor, MANAGE_PARTNERS),
            can_manage_targets=_may_set_targets(actor, manager),
            manager_has_target=mine["has_target"],
            manager_attainment_pct=mine["attainment_pct"],
            manager_metrics=mine["metrics"],
            # Nothing allocated, because there is nobody to allocate to. Still
            # returned, so an empty roster with a goal on it reads as "100
            # policies, none handed out" rather than as a missing section.
            allocation=_allocation(mine["metrics"], []),
            date_from=lo, date_to=hi, period_label=label, rows=rows)

    # Every read below is $in-scoped to this manager's partners. Four queries
    # for the whole roster, however many partners it holds.
    policies = await Policy.find({"partner_id": {"$in": ids}}).to_list()
    finance = await _finance_for(policies)
    wallets = {w.partner_id: w async for w in
               Wallet.find({"partner_id": {"$in": ids}})}
    accounts = {a.party_id: a async for a in PartyAccount.find(
        {"party_type": PartyType.CHANNEL_PARTNER.value,
         "party_id": {"$in": ids}})}

    horizon = now + timedelta(days=RENEWAL_HORIZON_DAYS)
    per: dict[str, dict] = {pid: {"policies": 0, "premium": 0, "reward": 0,
                                  "renewals": 0, "last": None} for pid in ids}

    for p in policies:
        bucket = per.get(p.partner_id or "")
        if bucket is None:
            continue
        # "Last seen" is the partner's whole history, not the window — a page
        # that says "quiet for 61 days" must not change its mind because you
        # switched the filter to This month.
        created = _aware(p.created_at)
        if bucket["last"] is None or created > bucket["last"]:
            bucket["last"] = created
        expiry = _aware(p.expiry_date) if p.expiry_date else None
        if (expiry is not None and p.status in _LIVE_STATUSES
                and now <= expiry <= horizon):
            bucket["renewals"] += 1
        # Volume figures follow the date filter; the position figures above and
        # the balance below do NOT (see the windowed/all-time split in
        # finance_balance).
        if not (lo <= created <= hi):
            continue
        bucket["policies"] += 1
        bucket["premium"] += p.premium_amount
        pf = finance.get(str(p.id))
        if pf is not None:
            bucket["reward"] += pf.partner_share

    goals = await _target_rows("channel_partner", ids, partner_actuals,
                               lo, hi, allow_profit)

    for partner in partners:
        pid = str(partner.id)
        bucket = per[pid]
        wallet = wallets.get(pid)
        account = accounts.get(pid)
        reward_owed = (wallet.available_paise + wallet.pending_paise) \
            if wallet else 0
        last = bucket["last"]
        days = (now - last).days if last else None
        goal = goals.get(pid, {})
        rows.append(PartnerRosterRow(
            partner_id=pid, partner_name=partner.full_name,
            partner_code=partner.code, mobile=partner.mobile,
            active_account=partner.status == AccountStatus.ACTIVE,
            policies=bucket["policies"], premium=bucket["premium"],
            their_reward=bucket["reward"],
            net_balance=finance_balance.partner_net_balance(
                reward_owed, account.balance_paise if account else 0),
            renewals_due=bucket["renewals"],
            last_policy_at=last,
            days_quiet=days,
            # Never having written anything counts as quiet — it is the same
            # problem, and arguably a worse one.
            is_quiet=days is None or days >= QUIET_AFTER_DAYS,
            has_target=goal.get("has_target", False),
            target_id=goal.get("target_id"),
            attainment_pct=goal.get("attainment_pct", 0.0),
            target_metrics=goal.get("metrics", []),
        ))

    # Quiet first, then biggest book: the page opens on what needs attention.
    rows.sort(key=lambda r: (not r.is_quiet, -r.premium))
    allocation = _allocation(mine["metrics"], rows)
    return ManagerRoster(
        manager_id=str(manager.id), manager_name=manager.full_name,
        manager_code=manager.code,
        can_view_profit=can(actor, VIEW_AGENCY_PROFIT),
        can_manage=can(actor, MANAGE_PARTNERS),
        can_manage_targets=_may_set_targets(actor, manager),
        date_from=lo, date_to=hi, period_label=label,
        partners=len(rows),
        active_partners=sum(1 for r in rows if r.policies),
        quiet_partners=sum(1 for r in rows if r.is_quiet),
        policies=sum(r.policies for r in rows),
        premium=sum(r.premium for r in rows),
        their_reward_total=sum(r.their_reward for r in rows),
        renewals_due=sum(r.renewals_due for r in rows),
        manager_has_target=mine["has_target"],
        manager_attainment_pct=mine["attainment_pct"],
        manager_metrics=mine["metrics"],
        # Only ACTIVE partners count as "given a number" (owner J3): a
        # deactivated partner cannot write the business their goal asks for, and
        # counting them makes a manager look under-allocated for ever.
        partners_with_target=sum(1 for r in rows
                                 if r.has_target and r.active_account),
        allocation=allocation,
        rows=rows,
    )


def _aware(dt: datetime) -> datetime:
    """Stored timestamps are UTC and tz-aware, but older rows can be naive.

    A naive stamp is UTC, not IST. This attached IST to it, which read every
    pre-tz-aware row as 5h30m EARLIER than it was — enough to move a policy
    across the IST day boundary, so "days quiet" and the 30-day renewal horizon
    could each be off by one on exactly the oldest rows in the book. Every other
    `_aware` in the codebase (routers/finance, routers/portal) assumes UTC; this
    one was the odd one out.
    """
    return to_ist(dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc))

# NOTE: there is deliberately NO reassign endpoint here. Moving a partner to
# another manager is a change to `relationship_manager_id`, which
# `PATCH /api/users/{id}` already does — audited, permission-checked, and with
# the picker already on the partner's own page. A second way to write the same
# field is how the two end up disagreeing about what is allowed.
