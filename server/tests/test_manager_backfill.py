"""Policies booked before relationship managers existed must not all become
"Unassigned" the day the change ships.

`services/manager_backfill.backfill_policy_managers()` stamps them once, using
the same rule `policy_ops.stamp_manager` applies to new business. Same shape as
the partner-portal backfill: idempotent, marked in the database, never fatal.
"""

import ast
import inspect
import textwrap

from app.models.settings import SystemSettings
from app.services import manager_backfill


def _code(fn) -> str:
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.ClassDef, ast.Module)) \
                and ast.get_docstring(node):
            node.body = node.body[1:]
    return ast.unparse(tree)


def _src() -> str:
    return _code(manager_backfill.backfill_policy_managers)


# --- When it runs -----------------------------------------------------------------


def test_it_runs_once_ever():
    assert "manager_backfilled_at" in _src(), (
        "Without the marker this re-scans the whole policy collection on every "
        "boot for the life of the deployment.")


def test_the_marker_lives_in_the_database():
    assert "manager_backfilled_at" in SystemSettings.model_fields
    assert SystemSettings.model_fields["manager_backfilled_at"].default is None


def test_the_marker_is_checked_before_the_scan():
    """An established deployment should pay one settings read, not a collection
    scan, on every boot."""
    src = _src()
    assert src.index("manager_backfilled_at") < src.index("User.find_all")


# --- What it does -----------------------------------------------------------------


def test_it_only_touches_policies_with_no_stamp():
    src = _src()
    assert "'manager_id': None" in src, (
        "Re-stamping a policy that already has a manager would overwrite the "
        "frozen attribution this whole design exists to protect.")


def test_it_mirrors_the_live_stamping_rule():
    """Partner's manager for partner-sourced business, booking employee for an
    in-house sale — the same order stamp_manager uses."""
    src = _code(manager_backfill.backfill_policy_managers)
    assert "policy.partner_id or policy.owner_user_id" in src
    assert "CHANNEL_PARTNER" in src
    assert "relationship_manager_id" in src


def test_an_unresolvable_policy_is_skipped_not_guessed():
    src = _src()
    assert "continue" in src
    # Guessing here would put someone else's business on a manager's record.
    assert "Unassigned" in inspect.getsource(
        manager_backfill.backfill_policy_managers)


def test_it_loads_the_users_once_not_per_policy():
    """A per-policy lookup would be thousands of round trips for a few hundred
    users."""
    src = _src()
    assert src.index("User.find_all") < src.index("Policy.find")


def test_it_stamps_the_marker_after_the_work():
    """A crash in the middle must resume on the next boot, not be recorded as
    done. The `manager_id: None` filter makes re-running free."""
    src = _src()
    assert src.index("update_one") \
        < src.index("doc.manager_backfilled_at = utcnow()")


def test_it_clears_the_settings_cache():
    assert "settings_svc.invalidate()" in _src()


# --- How it is wired in ------------------------------------------------------------


def test_it_runs_on_startup_and_cannot_take_the_app_down():
    from app import main

    src = inspect.getsource(main.lifespan)
    assert "backfill_policy_managers" in src
    tail = src[src.index("backfill_policy_managers"):]
    assert "except Exception" in tail, (
        "A CRM that will not start because a backfill failed is worse than a "
        "report that reads Unassigned for a deploy.")


def test_the_old_team_values_are_left_alone():
    """Not $unset across every policy. The fields are simply off the model, so
    Beanie stops reading them and the data stays available to check the new
    attribution against the old."""
    src = inspect.getsource(manager_backfill)
    assert "$unset" not in src
    assert "does NOT touch the old" in src
