"""Who may open the Channel Partners page, and what they see on it.

Owner G1 (2026-08-06): "the employee can only see the channel partners that are
under him on that page". The page needed `view_team` — the STAFF DIRECTORY
right — so an ordinary employee could not open the page their own partners live
on at all.

This is a ROSTER FILTER, not a return of record-level scoping (deleted on
purpose, see CLAUDE.md). It widens who may read a roster and narrows nothing:
everyone who could open a record before still can, and every in-house user can
still open every customer, policy and lead.

What these pin:
  * an employee with no view_team may list CHANNEL PARTNERS, filtered in the
    QUERY to their own roster
  * the same employee may NOT list employees, and may not drop the filter by
    asking for "all account types"
  * they may open one of their own partners' records, and nobody else's
  * ADDING a partner still needs manage_team (owner G3 = b)
  * a partner's first login is not blocked on KYC (owner I1)
"""

from __future__ import annotations

import inspect

import pytest
from fastapi import HTTPException

from app.core.enums import AccountType
from app.core.permissions import (
    MANAGE_EMPLOYEES, MANAGE_PARTNERS, VIEW_EMPLOYEES, VIEW_PARTNERS,
)
from app.routers import users as users_router
from app.schemas.auth import OnboardingRequest


class _User:
    def __init__(self, uid, account_type=AccountType.EMPLOYEE, perms=None,
                 manager_id=None, deleted=False):
        self.id = uid
        self.account_type = account_type
        self.permissions = list(perms or [])
        self.relationship_manager_id = manager_id
        self.is_deleted = deleted
        self.full_name = f"User {uid}"


RAHUL = _User("rahul")
PRIYA = _User("priya")
HR = _User("hr", perms=[VIEW_EMPLOYEES])
MY_PARTNER = _User("p1", AccountType.CHANNEL_PARTNER, manager_id="rahul")
HER_PARTNER = _User("p2", AccountType.CHANNEL_PARTNER, manager_id="priya")


# --- Reading one record ----------------------------------------------------------


def test_a_manager_may_open_their_own_partner():
    assert users_router._is_my_partner(RAHUL, MY_PARTNER)


def test_a_manager_may_not_open_someone_elses_partner():
    assert not users_router._is_my_partner(RAHUL, HER_PARTNER)


def test_the_exception_is_partners_only_never_colleagues():
    """`reports_to_id` was deleted because nothing read it. An employee is not
    'under' another employee, so this must never widen to staff records."""
    assert not users_router._is_my_partner(RAHUL, PRIYA)
    assert not users_router._is_my_partner(
        RAHUL, _User("boss", AccountType.OWNER))


def test_a_partner_with_no_manager_belongs_to_nobody():
    orphan = _User("p9", AccountType.CHANNEL_PARTNER, manager_id=None)
    assert not users_router._is_my_partner(RAHUL, orphan)
    # An empty-string manager id must not match an empty-string actor id either.
    assert not users_router._is_my_partner(_User(""), orphan)


# --- Listing ---------------------------------------------------------------------


def _list_source() -> str:
    return inspect.getsource(users_router.list_users)


def test_the_roster_filter_is_applied_to_the_query():
    """Scope in the QUERY, never in the serialiser — the rule the portal is
    built on, for the same reason: a filter applied while reading cannot be
    undone by a mistake in a response model."""
    source = _list_source()
    assert 'filters.append({"relationship_manager_id": str(actor.id)})' in source


def test_only_the_partner_list_is_opened_up():
    """An employee without the directory right must still be refused the staff
    list, and must not be able to reach it by omitting account_type (which would
    otherwise fall through to 'both types').

    The condition reads `if not wants_partners` since the 2026-08-07 split —
    same rule, but the flag consulted now depends on which population was
    asked for."""
    source = _list_source()
    assert "wants_partners = account_type == AccountType.CHANNEL_PARTNER" in source
    assert "if not wants_partners:" in source
    assert "own_roster_only = True" in source


def test_the_directory_right_matches_the_population_asked_for():
    """Holding the directory right is what widens the list back to everyone.

    Two changes to the same line, both behaviour-preserving for the rule this
    pins: it moved from `VIEW_TEAM in actor.permissions` to `can(actor, ...)`
    (2026-08-07, SUG-05) so a stale owner snapshot still passes, and then
    `view_team` split into `view_employees` / `view_partners` — the flag
    consulted is now the one for the list actually requested, so reading the
    partner roster can no longer be widened by holding the STAFF directory
    right.
    """
    source = _list_source()
    assert "can_see_everyone = can(actor, VIEW_PARTNERS if wants_partners" in source
    assert "else VIEW_EMPLOYEES)" in source


# --- Writing still needs manage_team (owner G3 = b) --------------------------------


def test_creating_a_partner_requires_the_partner_manage_right():
    """Adding a partner is still a deliberate grant (owner G3) — and since the
    2026-08-07 split it is the PARTNER one, not the staff one. Somebody who runs
    the employee directory has no business creating channel partners."""
    from app.main import app

    route = next(r for r in app.routes
                 if getattr(r, "path", "") == "/api/users/partners")
    guards = inspect.getsource(users_router.create_partner)
    # The dependency is declared on the decorator, which is part of the source
    # of the surrounding statement — assert on the router registration instead.
    assert "POST" in route.methods
    assert MANAGE_PARTNERS in users_router.ASSIGNABLE_PERMISSIONS
    src = inspect.getsource(users_router)
    assert "require_permission(MANAGE_PARTNERS)" in src[
        :src.index("async def create_partner")][-400:]
    assert guards  # the endpoint exists


def test_managing_an_account_is_unchanged_by_the_read_widening():
    """`_can_manage` is what gates every write. Opening a record must not have
    opened editing it (owner G4)."""
    assert users_router._can_manage(RAHUL, AccountType.CHANNEL_PARTNER) is False
    assert users_router._can_manage(
        _User("x", perms=[MANAGE_PARTNERS]), AccountType.CHANNEL_PARTNER) is True
    assert users_router._can_manage(HR, AccountType.CHANNEL_PARTNER) is False


def test_the_two_populations_are_separate_grants():
    """The point of splitting manage_team: an HR user who manages staff must not
    thereby be able to edit, deactivate or reset the password of a channel
    partner, and the partner desk must not be able to touch staff records."""
    hr_only = _User("hr", perms=[MANAGE_EMPLOYEES])
    partner_only = _User("pd", perms=[MANAGE_PARTNERS])

    assert users_router._can_manage(hr_only, AccountType.EMPLOYEE) is True
    assert users_router._can_manage(hr_only, AccountType.CHANNEL_PARTNER) is False
    assert users_router._can_manage(partner_only, AccountType.CHANNEL_PARTNER) is True
    assert users_router._can_manage(partner_only, AccountType.EMPLOYEE) is False


# --- A partner's first login (owner I1) --------------------------------------------


def test_kyc_is_optional_on_the_wire():
    """The wizard demanded a PAN and a 12-digit Aadhaar before it would let a
    brand-new partner into the portal they had just been emailed a password
    for."""
    payload = OnboardingRequest(new_password="abcd1234")
    assert payload.pan_number is None
    assert payload.aadhaar_number is None


def test_a_supplied_kyc_value_is_still_validated():
    """Optional is not unvalidated: a malformed PAN is worse than a missing one,
    because it looks collected."""
    with pytest.raises(ValueError):
        OnboardingRequest(new_password="abcd1234", pan_number="NOPE")
    with pytest.raises(ValueError):
        OnboardingRequest(new_password="abcd1234", aadhaar_number="12")


def test_blank_strings_are_stored_as_nothing_not_as_empty_kyc():
    payload = OnboardingRequest(new_password="abcd1234", pan_number="   ",
                                aadhaar_number="  ")
    assert payload.pan_number is None
    assert payload.aadhaar_number is None


def test_staff_are_still_required_to_provide_kyc():
    """Enforced in the ROUTER, because the rule depends on who is onboarding —
    which the schema cannot see."""
    from app.routers import auth as auth_router

    source = inspect.getsource(auth_router.complete_onboarding)
    assert "if user.account_type != AccountType.CHANNEL_PARTNER:" in source
    assert "Enter your PAN to finish setting up." in source
    assert "Enter your Aadhaar number to finish setting" in source


def test_skipping_kyc_never_wipes_what_staff_already_recorded():
    from app.routers import auth as auth_router

    source = inspect.getsource(auth_router.complete_onboarding)
    assert "payload.pan_number or prof.pan" in source
    assert "aadhaar_last4 or prof.aadhaar_last4" in source


def test_a_password_is_still_mandatory_for_everyone():
    """Onboarding is also where the temporary password is replaced. Making KYC
    optional must not have made the whole wizard skippable."""
    with pytest.raises(ValueError):
        OnboardingRequest()
