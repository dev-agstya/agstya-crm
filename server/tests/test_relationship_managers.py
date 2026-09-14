"""Relationship managers replace teams (owner 2026-08-05).

There used to be THREE hierarchies: `relationship_manager_id` (partner ->
employee, mandatory since partners were built), a named `Team` with its own
membership list, and `reports_to_id` (employee -> employee) which nothing in the
app ever read. A partner's team was itself inherited from their relationship
manager, so the Team object was a copy of a fact already stored on the user —
and copies drift.

Now there is one: an employee, and the channel partners under them.

What these pin:
  * Team is gone and stays gone (the pattern this repo already uses for
    SYSTEM_ROLE_SEEDS and the lead /convert endpoint)
  * the manager stamped on a policy is FROZEN, and resolves partner-first
  * the roll-up reads that stamp, not today's roster
  * an employee sees their own numbers, the owner sees everyone's
  * house profit stays behind view_agency_profit
  * an employee holding partners cannot be switched off
"""

import inspect

import pytest

from app.core.enums import AccountType
from app.main import app
from app.models.policy import Policy
from app.models.user import User
from app.routers import managers as managers_router
from app.routers import users as users_router
from app.schemas.manager import ManagerRollup, ManagerRoster
from app.services import policy_ops


# --- Teams are gone -------------------------------------------------------------


def test_the_team_model_stays_deleted():
    for module in ("app.models.team", "app.routers.teams", "app.schemas.team"):
        with pytest.raises(ModuleNotFoundError):
            __import__(module)


def test_no_team_routes_survive():
    paths = [getattr(r, "path", "") for r in app.routes]
    assert not [p for p in paths if p.startswith("/api/teams")], (
        "The teams API is gone; a surviving route means half a migration.")
    assert any(p.startswith("/api/managers") for p in paths)


def test_the_user_carries_one_hierarchy_only():
    fields = User.model_fields
    assert "relationship_manager_id" in fields
    for dead in ("team_id", "team_name", "reports_to_id"):
        assert dead not in fields, (
            f"{dead} is one of the hierarchies the rebuild removed. Three "
            "answers to 'who does this person sit under' is two too many.")


def test_a_policy_carries_the_manager_not_the_team():
    fields = Policy.model_fields
    assert "manager_id" in fields and "manager_name" in fields
    for dead in ("team_id", "team_name"):
        assert dead not in fields


def test_the_manager_stamp_is_indexed():
    """The roll-up filters on it; an unindexed scan on the policies collection
    is the one query this page makes on every load."""
    specs = str(Policy.Settings.indexes)
    assert "manager_id" in specs


# --- The frozen stamp -------------------------------------------------------------


def test_the_stamp_resolves_the_partners_manager_first():
    src = inspect.getsource(policy_ops.stamp_manager)
    assert "policy.partner_id or owner_user_id" in src, (
        "A manager's book is the business their PARTNERS bring, whoever keys "
        "it in. Crediting the booking employee on a partner's policy would "
        "hand the business to whoever happened to be at the keyboard.")
    assert "AccountType.CHANNEL_PARTNER" in src
    assert "relationship_manager_id" in src


def test_an_in_house_sale_is_credited_to_whoever_booked_it():
    """Owner T7: the page has to add up to the company total, so direct
    business cannot fall into an unassigned hole."""
    src = inspect.getsource(policy_ops.stamp_manager)
    assert "else:\n        manager = user" in src


def test_an_unresolvable_policy_is_left_unstamped_not_guessed():
    src = inspect.getsource(policy_ops.stamp_manager)
    # Three early returns: no credited id, no such user, no manager on file.
    assert src.count("return") >= 3
    assert "Unassigned" in src


def test_the_stamp_lives_in_the_shared_service():
    """Partners can no longer submit a policy (2026-08-05), so there is now ONE
    booking path — but the stamp stays in policy_ops rather than inline in the
    router, because renewals call it too."""
    from app.routers import policies as policies_router

    assert policies_router._stamp_manager.__module__ == "app.services.policy_ops"
    src = inspect.getsource(policies_router)
    assert src.count("_stamp_manager(") >= 2, "create and renew both stamp"


def test_nothing_still_calls_the_old_stamp():
    assert not hasattr(policy_ops, "stamp_team")


# --- The roll-up ------------------------------------------------------------------


def test_the_rollup_reads_the_frozen_stamp():
    src = inspect.getsource(managers_router.managers_rollup)
    assert "p.manager_id" in src, (
        "Resolving live through the partner's CURRENT manager would rewrite "
        "last quarter's league table every time somebody is reassigned.")


def test_managers_with_a_roster_but_no_business_still_appear():
    """A manager whose partners all went quiet is exactly what the owner opened
    the page to find, so an empty row is the answer, not a missing one."""
    src = inspect.getsource(managers_router.managers_rollup)
    assert "for manager_id in partner_counts:" in src


def test_house_profit_is_zeroed_without_the_permission():
    src = inspect.getsource(managers_router.managers_rollup)
    assert "if not can_profit:" in src
    assert "row.profit = 0" in src


def test_an_employee_sees_only_their_own_row():
    """Owner T4.3b. Not data scoping — the RECORDS stay open to every in-house
    user; this is about whose numbers you may read."""
    src = inspect.getsource(managers_router.managers_rollup)
    assert "if not can_all:" in src
    assert "r.manager_id == str(actor.id)" in src


def test_unassigned_business_is_shown_not_dropped():
    src = inspect.getsource(managers_router.managers_rollup)
    assert 'ManagerRow(manager_id="", manager_name="Unassigned")' in src
    assert "unassigned" in ManagerRollup.model_fields


def test_the_partner_own_split_is_on_the_row():
    for field in ("partner_policies", "partner_premium",
                  "own_policies", "own_premium"):
        assert field in \
            __import__("app.schemas.manager", fromlist=["ManagerRow"]) \
            .ManagerRow.model_fields


# --- The roster --------------------------------------------------------------------


def test_one_serialiser_feeds_both_roster_endpoints():
    """The owner's view of an employee and that employee's own view of
    themselves must not be able to disagree."""
    for fn in (managers_router.my_partners, managers_router.manager_partners):
        assert "_roster(" in inspect.getsource(fn)


def test_the_me_route_is_registered_before_the_dynamic_one():
    """Otherwise "/{manager_id}/partners" swallows "me" and tries to load a
    user with that id."""
    paths = [getattr(r, "path", "") for r in app.routes]
    assert paths.index("/api/managers/me/partners") \
        < paths.index("/api/managers/{manager_id}/partners")


def test_a_partners_balance_comes_from_the_shared_function():
    """A manager's page and the partner's own statement showing different
    numbers for the same relationship is the worst bug this app can have."""
    src = inspect.getsource(managers_router._roster)
    assert "finance_balance.partner_net_balance(" in src


def _code(fn) -> str:
    """Source with comments and docstrings stripped — several of these explain
    in prose the very thing being asserted absent."""
    import ast
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.ClassDef, ast.Module)) \
                and ast.get_docstring(node):
            node.body = node.body[1:]
    return ast.unparse(tree)


def test_the_roster_is_in_scoped_not_a_full_scan():
    """CLAUDE.md: new finance reads must not add a find_all()."""
    src = _code(managers_router._roster)
    assert "'partner_id': {'$in': ids}" in src
    assert "find_all()" not in src
    assert "find_all()" not in _code(managers_router._finance_for)


def test_last_seen_ignores_the_date_filter():
    """"Quiet for 61 days" must not change its mind because somebody switched
    the filter to This month."""
    src = inspect.getsource(managers_router._roster)
    before = src.index('bucket["last"] = created')
    guard = src.index("if not (lo <= created <= hi):")
    assert before < guard, "last-seen must be computed before the window guard"


def test_quiet_is_one_number_for_everyone():
    assert managers_router.QUIET_AFTER_DAYS == 60
    src = inspect.getsource(managers_router._roster)
    assert "QUIET_AFTER_DAYS" in src


def test_never_having_written_anything_counts_as_quiet():
    src = inspect.getsource(managers_router._roster)
    assert "days is None or days >= QUIET_AFTER_DAYS" in src


def test_renewals_are_on_the_roster():
    assert "renewals_due" in ManagerRoster.model_fields
    assert managers_router.RENEWAL_HORIZON_DAYS == 30


# --- Guards ------------------------------------------------------------------------


def test_a_manager_holding_partners_cannot_be_switched_off():
    """Owner T5.2: an orphaned partner is a partner nobody calls, and the
    relationship manager is mandatory precisely so that cannot happen."""
    src = inspect.getsource(users_router.update_status)
    assert "partners_under(" in src
    assert "Reassign them to" in src


def test_the_partner_count_helper_only_counts_live_partners():
    src = inspect.getsource(users_router.partners_under)
    assert "AccountType.CHANNEL_PARTNER.value" in src
    assert '"is_deleted": {"$ne": True}' in src


def test_reassignment_has_exactly_one_endpoint():
    """It is a change to relationship_manager_id, which PATCH /api/users/{id}
    already does — audited and permission-checked. A second writer for the same
    field is how the two end up disagreeing about what is allowed."""
    paths = [getattr(r, "path", "") for r in app.routes]
    assert "/api/managers/{manager_id}/partners/{partner_id}" not in paths
    assert "relationship_manager_id" in \
        inspect.getsource(users_router.update_user)


def test_the_managers_router_is_closed_to_channel_partners():
    """The whole router carries the in-house guard, so a new route added here
    is shut to partners by default (see tests/test_partner_boundary.py)."""
    from app.core.dependencies import get_inhouse_user

    deps = [d.dependency for d in managers_router.router.dependencies]
    assert get_inhouse_user in deps


# --- The report -------------------------------------------------------------------


def test_the_business_report_names_the_manager_not_the_team():
    from app.services import business_report

    assert "Relationship manager" in business_report.POLICY_HEADERS
    assert "Team" not in business_report.POLICY_HEADERS
    assert "p.manager_name" in inspect.getsource(business_report.policy_rows)


def test_the_report_rolls_up_by_manager_from_the_same_stamp():
    from app.services import business_report

    src = inspect.getsource(business_report._manager_totals)
    assert "p.manager_name or \"Unassigned\"" in src
    assert "if p.partner_id:" in src, "the partner/own split has to be there too"
