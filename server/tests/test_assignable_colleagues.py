"""Who can a lead reminder be given to (owner Q4.2, 2026-08-03).

Only colleagues who can actually OPEN the Leads page. Assigning a follow-up to
someone without `view_policies` would put a task on a screen they get a 403
from, and they would have no way to act on it or clear it.

The other thing pinned here is that this endpoint is NOT the People list. The
People list needs `view_team`; an executive who works the pipeline may not have
it, and they still have to be able to name a colleague on a follow-up. Reusing
the People list would have meant granting the staff directory to everyone who
can set a reminder.
"""

import asyncio
from dataclasses import dataclass, field

import pytest
from fastapi import HTTPException

from app.core.enums import AccountStatus, AccountType
from app.core.permissions import (
    ALL_PERMISSIONS,
    MANAGE_EMPLOYEES,
    VIEW_POLICIES,
    VIEW_EMPLOYEES,
)
from app.routers import users as users_router


def _run(coro):
    return asyncio.run(coro)


@dataclass
class _Actor:
    permissions: list
    account_type: object = AccountType.EMPLOYEE
    id: str = "actor"
    full_name: str = "Actor"


@dataclass
class _Row:
    id: str
    full_name: str
    email: str
    account_type: object
    permissions: list = field(default_factory=list)


@pytest.fixture
def people(monkeypatch):
    """Captures the query and returns whatever rows the test sets."""
    state = {"rows": [], "query": None}

    class _FakeUser:
        @staticmethod
        def find(query):
            state["query"] = query

            class _Cursor:
                def sort(self, _key):
                    return self

                async def to_list(self):
                    return state["rows"]
            return _Cursor()

    monkeypatch.setattr(users_router, "User", _FakeUser)
    return state


def _call(actor, permission=VIEW_POLICIES):
    return _run(users_router.colleagues_with_permission(
        actor=actor, permission=permission))


# --- Who is allowed to ask ------------------------------------------------------------


def test_you_must_hold_the_permission_you_are_asking_about(people):
    """Otherwise this becomes a way to enumerate staff by capability from an
    account that holds nothing."""
    with pytest.raises(HTTPException) as exc:
        _call(_Actor(permissions=["view_finance"]))
    assert exc.value.status_code == 403


def test_an_unknown_permission_is_refused(people):
    with pytest.raises(HTTPException) as exc:
        _call(_Actor(permissions=ALL_PERMISSIONS), permission="view_everything")
    assert exc.value.status_code == 400


def test_view_team_is_NOT_required(people):
    """The point of the endpoint. Someone who can work leads but cannot read the
    staff directory must still be able to assign a follow-up."""
    actor = _Actor(permissions=[VIEW_POLICIES])
    assert VIEW_EMPLOYEES not in actor.permissions
    assert MANAGE_EMPLOYEES not in actor.permissions
    _call(actor)   # does not raise
    assert people["query"] is not None


# --- Who comes back --------------------------------------------------------------------


def test_only_active_undeleted_people(people):
    q = str(_call(_Actor(permissions=[VIEW_POLICIES])) or people["query"])
    conditions = str(people["query"])
    assert "is_deleted" in conditions
    assert AccountStatus.ACTIVE.value in conditions


def test_employees_are_filtered_on_the_permission(people):
    _call(_Actor(permissions=[VIEW_POLICIES]))
    conditions = str(people["query"])
    assert "permissions" in conditions
    assert VIEW_POLICIES in conditions


def test_the_owner_is_included_by_account_type_not_by_flag(people):
    """An owner holds every permission by definition, but the stored list is a
    snapshot that goes stale when a flag is added. Matching on account type as
    well means an unhealed owner still appears in the picker."""
    _call(_Actor(permissions=[VIEW_POLICIES]))
    conditions = str(people["query"])
    assert AccountType.OWNER.value in conditions


def test_channel_partners_are_never_listed(people):
    """Owner Q4.3: staff only. A partner cannot reach the Leads page at all."""
    _call(_Actor(permissions=[VIEW_POLICIES]))
    conditions = str(people["query"])
    assert AccountType.CHANNEL_PARTNER.value not in conditions


def test_it_returns_names_and_emails_and_nothing_else(people):
    """Enough to tell two colleagues named Rajan apart, and no more — this is
    reachable by anyone who can set a reminder."""
    people["rows"] = [
        _Row("u1", "Asha Rao", "asha@example.com", AccountType.EMPLOYEE,
             [VIEW_POLICIES]),
    ]
    out = _call(_Actor(permissions=[VIEW_POLICIES]))
    assert len(out) == 1
    fields = out[0].model_dump()
    assert set(fields) == {"id", "full_name", "email", "account_type"}
    assert fields["full_name"] == "Asha Rao"


def test_nobody_eligible_is_an_empty_list_not_an_error(people):
    people["rows"] = []
    assert _call(_Actor(permissions=[VIEW_POLICIES])) == []
