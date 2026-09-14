"""A manager's target is their TEAM's number (owner B1-B3 / F1-F5, 2026-08-06).

The owner's description of how targets work — "an employee gets a 100-policy
target, has ten channel partners under him, gives them ten each" — only adds up
if the partners' business FEEDS the manager's own attainment. It did not: an
employee's number counted `Policy.owner_user_id` (whoever keyed the policy in)
and a partner's counted `Policy.partner_id`, and nothing joined the two. Ten
partners could hit ten each and their manager would still read 0%.

What these pin:
  * a partner's policy credits the partner AND the partner's FROZEN manager
  * an in-house sale credits the booking employee exactly once (the manager
    stamp is that same person, and a set is what stops it counting twice)
  * reassigning a partner does not move business already booked
  * a relationship manager may set their own roster's targets without
    `manage_targets`, may not set anyone else's, and may never set their own
  * a partner may read their own target and never the agency's margin
"""

from __future__ import annotations

import inspect
from datetime import datetime, timezone

import pytest

from app.core.enums import AccountType, PolicyStatus, TargetMetric
from app.core.permissions import MANAGE_TARGETS, VIEW_TARGETS
from app.main import app
from app.models.policy import Policy
from app.routers import managers as managers_router
from app.routers import targets as targets_router
from app.services import targets as svc


# --- Fixtures: plain stand-ins, no database -------------------------------------


class _User:
    """Enough of a User for the permission helpers, which only read attributes."""

    def __init__(self, uid, account_type=AccountType.EMPLOYEE, perms=None,
                 manager_id=None):
        self.id = uid
        self.account_type = account_type
        self.permissions = list(perms or [])
        self.relationship_manager_id = manager_id
        self.is_owner = account_type == AccountType.OWNER
        self.full_name = f"User {uid}"


def _policy(owner=None, partner=None, manager=None, renewed=False):
    return Policy.model_construct(
        owner_user_id=owner, partner_id=partner, manager_id=manager,
        renewed_from_policy_id="prev" if renewed else None,
        status=PolicyStatus.ACTIVE, premium_amount=100_000)


# --- The roll-up ----------------------------------------------------------------


def test_a_partners_policy_credits_the_partners_manager():
    """The whole point: ten partners at ten each has to reach their manager."""
    credited = svc.employees_credited(
        _policy(owner="backoffice", partner="p1", manager="rahul"))
    assert credited == {"backoffice", "rahul"}


def test_an_in_house_sale_credits_the_employee_exactly_once():
    """`manager_id` on an in-house policy IS the booking employee.

    Adding both without deduplicating would double every direct sale a manager
    made — the reason employees_credited returns a set.
    """
    credited = svc.employees_credited(
        _policy(owner="rahul", partner=None, manager="rahul"))
    assert credited == {"rahul"}


def test_a_managers_own_direct_business_still_counts():
    assert svc.employees_credited(_policy(owner="rahul")) == {"rahul"}


def test_an_unstamped_partner_policy_credits_nobody_extra():
    """Older than the backfill, or a partner who had no manager.

    "Unassigned" is the honest answer; guessing today's manager would move
    history every time somebody was reassigned.
    """
    assert svc.employees_credited(
        _policy(owner="backoffice", partner="p1", manager=None)) \
        == {"backoffice"}


def test_the_manager_credit_reads_the_frozen_stamp_not_the_roster():
    """Owner B3. `manager_id` is stamped at booking; the roster is not consulted.

    Asserted on the source, because the failure mode is somebody "helpfully"
    resolving the live relationship_manager_id here — which reads fine and
    silently rewrites last quarter whenever a partner moves.
    """
    source = inspect.getsource(svc.employees_credited)
    assert "manager_id" in source
    assert "relationship_manager_id" not in source, (
        "The roll-up must read the FROZEN stamp. Resolving the current "
        "relationship manager moves business that was already booked.")


def test_accumulate_counts_a_renewal_as_both():
    bucket = svc.blank_metrics()
    pf = type("PF", (), {"gross_premium": 100_000, "house_profit": 5_000,
                         "partner_share": 2_000})()
    svc.accumulate(bucket, _policy(owner="rahul", renewed=True), pf)
    assert bucket[TargetMetric.POLICIES.value] == 1
    assert bucket[TargetMetric.RENEWALS.value] == 1
    assert bucket[TargetMetric.PREMIUM.value] == 100_000


def test_a_cancelled_policy_counts_for_nobody():
    pol = _policy(owner="rahul", partner="p1", manager="rahul")
    pol.status = PolicyStatus.CANCELLED
    assert not svc.counts_for_targets(pol)


# --- Who may assign a target (owner F1, F2, F5) ---------------------------------


OWNER = _User("owner1", AccountType.OWNER, [MANAGE_TARGETS])
RAHUL = _User("rahul", AccountType.EMPLOYEE)
PRIYA = _User("priya", AccountType.EMPLOYEE)
ADMIN = _User("admin", AccountType.EMPLOYEE, [MANAGE_TARGETS])
MY_PARTNER = _User("p1", AccountType.CHANNEL_PARTNER, manager_id="rahul")
HER_PARTNER = _User("p2", AccountType.CHANNEL_PARTNER, manager_id="priya")
NO_MANAGER = _User("p3", AccountType.CHANNEL_PARTNER, manager_id=None)


def test_a_manager_may_set_their_own_partners_target():
    assert targets_router._may_assign(RAHUL, MY_PARTNER)


def test_a_manager_may_not_set_another_managers_partners_target():
    assert not targets_router._may_assign(RAHUL, HER_PARTNER)


def test_a_partner_with_no_manager_is_nobodys_to_assign():
    assert not targets_router._may_assign(RAHUL, NO_MANAGER)
    # And not even for an actor whose id stringifies to "" — an orphan belongs
    # to nobody by construction, not by luck.
    assert not targets_router._may_assign(_User(""), NO_MANAGER)


def test_an_employee_may_not_set_their_own_target():
    """Owner F2. You do not get to lower your own number."""
    assert not targets_router._may_assign(RAHUL, RAHUL)


def test_an_employee_may_not_set_a_colleagues_target():
    assert not targets_router._may_assign(RAHUL, PRIYA)


def test_manage_targets_still_assigns_anyone():
    for who in (MY_PARTNER, HER_PARTNER, PRIYA, NO_MANAGER):
        assert targets_router._may_assign(ADMIN, who)
        assert targets_router._may_assign(OWNER, who)


def test_a_manager_may_overwrite_an_owner_set_partner_target():
    """Owner F5: one number per partner per month, last edit wins.

    There is no "who set it" check anywhere in the assign path — that absence
    IS the rule, so it is asserted rather than left to be noticed.
    """
    assert targets_router._may_assign(RAHUL, MY_PARTNER)
    assert "created_by" not in inspect.getsource(targets_router._may_assign)


@pytest.mark.asyncio
async def test_assert_may_assign_names_the_rule_it_enforced():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as own:
        await targets_router._assert_may_assign(RAHUL, RAHUL)
    assert "your own target" in own.value.detail

    with pytest.raises(HTTPException) as theirs:
        await targets_router._assert_may_assign(RAHUL, HER_PARTNER)
    assert "channel partners you manage" in theirs.value.detail


def test_no_route_level_manage_targets_on_the_assign_paths():
    """The check MOVED into the body; it must not also sit on the route.

    A surviving route-level `require_permission(MANAGE_TARGETS)` would refuse
    the relationship manager before the body ever ran — the feature would be
    dead with the code that implements it still in place.
    """
    blocked = []
    for route in app.routes:
        path, methods = getattr(route, "path", ""), getattr(route, "methods", set())
        if not path.startswith("/api/targets"):
            continue
        if path.endswith("/bulk"):
            continue        # bulk assign is an admin action and keeps the flag
        if not ({"POST", "PATCH", "DELETE"} & set(methods)):
            continue
        source = inspect.getsource(route.endpoint)
        if "_assert_may_assign" not in source:
            blocked.append(f"{sorted(methods)} {path}")
    assert not blocked, (
        "These target writes do not run the per-assignee check: "
        + ", ".join(blocked))


# --- Who may READ a roster's targets --------------------------------------------


def test_a_manager_may_set_targets_on_their_own_roster_page():
    assert managers_router._may_set_targets(RAHUL, RAHUL)


def test_a_manager_may_not_set_targets_on_someone_elses_roster_page():
    assert not managers_router._may_set_targets(RAHUL, PRIYA)


def test_manage_targets_may_set_them_on_any_roster_page():
    assert managers_router._may_set_targets(ADMIN, PRIYA)
    assert managers_router._may_set_targets(OWNER, PRIYA)


def test_the_two_permission_checks_agree():
    """managers._may_set_targets decides whether the BUTTON is drawn;
    targets._may_assign decides whether the SAVE works. If they disagree the
    page shows a control that 403s."""
    for actor, manager in ((RAHUL, RAHUL), (RAHUL, PRIYA), (ADMIN, PRIYA)):
        partner = _User("px", AccountType.CHANNEL_PARTNER,
                        manager_id=str(manager.id))
        assert managers_router._may_set_targets(actor, manager) \
            == targets_router._may_assign(actor, partner)


# --- What the partner may see ----------------------------------------------------


def test_the_portal_target_endpoint_exists_and_is_a_read():
    paths = {getattr(r, "path", ""): getattr(r, "methods", set())
             for r in app.routes}
    assert "/api/portal/target" in paths
    assert paths["/api/portal/target"] <= {"GET", "HEAD"}, (
        "A target is set by staff. The partner's surface stays two writes.")


def test_the_partner_never_sees_house_profit_on_their_target():
    from app.routers import portal as portal_module

    source = inspect.getsource(portal_module.my_target)
    assert "allow_profit=False" in source, (
        "The house-profit row must be stripped before serialisation — it is "
        "the agency's margin on the partner's own business.")
    assert "house_profit" not in portal_module.PortalTargetMetric.model_fields


def test_visible_metrics_drops_profit_for_a_partner():
    metrics = {TargetMetric.POLICIES.value: 10,
               TargetMetric.PREMIUM.value: 500_000,
               TargetMetric.HOUSE_PROFIT.value: 50_000}
    allowed = svc.visible_metrics(metrics, allow_profit=False)
    assert set(allowed) == {TargetMetric.POLICIES.value,
                            TargetMetric.PREMIUM.value}


def test_target_alerts_now_reach_channel_partners():
    """Owner E4/E5. They used to be skipped for having no portal — they have
    one now, and a target nobody is told about is not a target."""
    from app.services import target_alerts

    assert AccountType.CHANNEL_PARTNER in target_alerts._MESSAGEABLE
    assert AccountType.OWNER not in target_alerts._MESSAGEABLE, (
        "The owner sets the numbers; they do not carry one.")


def test_milestones_score_a_partner_against_the_partner_book():
    """Passing "employee" for a partner scores them against the wrong half of
    the book and silently reports 0%."""
    from app.services import target_alerts

    source = inspect.getsource(target_alerts.check_milestones)
    assert "_assignee_type(user)" in source
    assert '"employee"' not in source


def test_a_partner_gets_a_welcome_that_describes_their_own_app():
    """The staff tour walks you through booking policies and adding customers.
    A partner can do neither, and it is the first thing they ever read."""
    from app.services import target_alerts

    body = target_alerts.PARTNER_WELCOME_BODY
    assert "Quote Requests" in body and "Earnings" in body
    for staff_only in ("Add Policy", "Leads", "sidebar"):
        assert staff_only not in body


# --- The roster carries targets ---------------------------------------------------


def test_the_roster_row_carries_the_partners_target():
    from app.schemas.manager import ManagerRoster, PartnerRosterRow

    for field in ("has_target", "attainment_pct", "target_metrics", "target_id"):
        assert field in PartnerRosterRow.model_fields, field
    for field in ("manager_has_target", "manager_attainment_pct",
                  "manager_metrics", "partners_with_target",
                  "can_manage_targets"):
        assert field in ManagerRoster.model_fields, field


def test_the_roster_uses_the_full_period_goal_not_a_prorated_slice():
    """A manager opening this on the 26th is still working to the whole month's
    number. `prorated_goals` would shrink the goal by however much of the month
    had elapsed and creep upward on every reload."""
    source = inspect.getsource(managers_router._target_rows)
    assert "full_goals" in source
    assert "prorated_goals" not in source


def test_a_deactivated_partner_does_not_count_as_allocated():
    """Owner J3: they cannot write the business their goal asks for."""
    source = inspect.getsource(managers_router._roster)
    assert "r.has_target and r.active_account" in source


def test_period_windows_are_still_whole_ist_months():
    """The roll-up must not have disturbed the period maths every screen shares."""
    lo, hi = svc.normalise_period(
        __import__("app.core.enums", fromlist=["TargetPeriod"]).TargetPeriod.MONTH,
        datetime(2026, 7, 26, 18, 30, tzinfo=timezone.utc))
    assert svc.to_ist(lo).day == 1 and svc.to_ist(lo).month == 7
    assert svc.to_ist(hi).day == 1 and svc.to_ist(hi).month == 8
