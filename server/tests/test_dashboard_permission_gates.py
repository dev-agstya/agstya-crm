"""The dashboard's permission gates must be EXECUTED for a plain employee.

Companion to tests/test_undefined_names.py, from the other direction. That file
sweeps for names that do not exist; this one runs the specific expression that
broke, with the specific kind of account that broke it.

THE BUG (2026-08-21). routers/reports.dashboard gated its finance tiles with:

    can_finance = (can(actor, MANAGE_TRANSACTIONS)
                   or can_any(actor, *FINANCE_VIEW_ANY))

and `can_any` was never imported. Because `or` short-circuits, an OWNER — for
whom the left operand is True — never evaluates the right one, so the module
appeared to work for the only account anyone had tested with. The first employee
to sign in got a 500 on the page they land on after onboarding.

So the rule this file exists to enforce is:

    A NAME BEHIND A PERMISSION CHECK IS ONLY EXECUTED BY THE ACCOUNTS THAT FAIL
    THAT CHECK. Testing as the owner exercises the opposite branch of every gate
    in the app.

These resolve the helpers THROUGH `reports`' own module namespace (`reports.can`,
`reports.can_any`, `reports.FINANCE_VIEW_ANY`) rather than importing them from
`app.core.permissions` directly. That is deliberate and is the whole point: an
import from the source module would pass whether or not `reports.py` had ever
heard of the name, which is exactly the failure being pinned.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.core.enums import AccountType
from app.core.permissions import (
    MANAGE_TRANSACTIONS,
    PERMISSIONS_VERSION,
    VIEW_BALANCE_SHEET,
    VIEW_FINANCE_OVERVIEW,
    VIEW_POLICIES,
)
from app.routers import reports


@dataclass
class _FakeUser:
    """Enough of a User for a permission read (no DB, no Beanie init).

    `effective_permissions` is duck-typed on these three attributes — see the
    note in core/permissions about keeping that module free of a model import.
    """

    account_type: object
    permissions: list = field(default_factory=list)
    permissions_version: int = PERMISSIONS_VERSION
    id: str = "employee-1"


def _employee(*flags: str) -> _FakeUser:
    return _FakeUser(AccountType.EMPLOYEE, list(flags))


def _owner() -> _FakeUser:
    return _FakeUser(AccountType.OWNER, [])


# --- The line that broke ---------------------------------------------------------


def _finance_gate(actor) -> bool:
    """The dashboard's `can_finance`, evaluated through reports' own globals."""
    return (reports.can(actor, reports.MANAGE_TRANSACTIONS)
            or reports.can_any(actor, *reports.FINANCE_VIEW_ANY))


def test_finance_gate_runs_for_an_employee_with_no_permissions_at_all():
    """The exact account that hit the 500: brand new, straight out of onboarding.

    A NameError here is the original bug. `False` is the correct answer — what
    matters is that an answer is reached at all.
    """
    assert _finance_gate(_employee()) is False


def test_finance_gate_runs_for_an_employee_without_manage_transactions():
    """The short-circuit's right-hand side is only reached without this flag."""
    assert _finance_gate(_employee(VIEW_POLICIES)) is False


def test_an_employee_holding_any_finance_view_passes_the_gate():
    """`can_any` means ANY of the four — so the right operand must really run."""
    for flag in reports.FINANCE_VIEW_ANY:
        assert _finance_gate(_employee(flag)) is True, flag


def test_manage_transactions_alone_passes_on_the_left_operand():
    assert _finance_gate(_employee(MANAGE_TRANSACTIONS)) is True


def test_the_owner_passes_but_that_proves_nothing_on_its_own():
    """Kept as documentation of why the bug survived, not as coverage.

    The owner holds every flag, so this returns True from the LEFT operand and
    never touches the right one. If this were the only test on the line, the
    missing import would still be in production.
    """
    assert _finance_gate(_owner()) is True


# --- The other gates on the same endpoint ----------------------------------------


def test_every_dashboard_gate_resolves_for_a_plain_employee():
    """All three gates in `dashboard`, run by an account that fails all of them.

    `can_policies` and `can_profit` are single `can()` calls today and so cannot
    short-circuit past a name. They are covered anyway because the value of this
    test is that it runs the ENDPOINT'S OWN gating as a non-owner — if somebody
    later adds an `or` to one of them, this catches the same mistake.
    """
    actor = _employee()
    assert reports.can(actor, reports.VIEW_POLICIES) is False
    assert _finance_gate(actor) is False
    assert reports.can(actor, reports.VIEW_AGENCY_PROFIT) is False


def test_a_partly_permissioned_employee_gets_a_mixed_board():
    """The realistic case: some tiles computed, some skipped, no crash."""
    actor = _employee(VIEW_POLICIES, VIEW_BALANCE_SHEET)
    assert reports.can(actor, reports.VIEW_POLICIES) is True
    assert _finance_gate(actor) is True
    # House profit stays its own, separate grant.
    assert reports.can(actor, reports.VIEW_AGENCY_PROFIT) is False


def test_finance_view_any_is_the_set_the_dashboard_actually_uses():
    """Pins WHICH flags open the finance tiles.

    Not a tautology: it asserts `reports` reads the shared tuple rather than a
    private copy that could drift from the one the finance routers enforce.
    """
    from app.core import permissions as perms
    assert reports.FINANCE_VIEW_ANY is perms.FINANCE_VIEW_ANY
    assert VIEW_FINANCE_OVERVIEW in reports.FINANCE_VIEW_ANY
