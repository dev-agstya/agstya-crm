"""An owner must never be locked out of a permission that was added after
their account was created.

THE BUG THIS PINS (2026-08-02). `User.permissions` is a denormalised snapshot,
written only when an account is created or edited. The owner is created once by
scripts/create_owner.py and then never re-saved. So when the
view/manage_bank_accounts pair was added to the model, the live owner's document
still held the previous 16 flags — and because ~50 call sites read
`X in actor.permissions` directly, the effects were split and confusing:

  - the sidebar showed Bank & Cash (nav gates on account type: owner sees all),
  - GET /api/banks 403'd (require_permission reads the stored list),
  - the page rendered "0 accounts / Rs 0.00" from its `?? 0` fallback, and
  - "Add account" was hidden, with the empty state telling the OWNER to
    "ask an owner".

Two defences, tested here: the stored set self-heals at authentication, and
every read of it goes through effective_permissions() so a stale document can
never be the answer even before the heal lands.
"""

import asyncio
from dataclasses import dataclass, field

import pytest

from app.core import permissions as perms
from app.core.enums import AccountType
from app.models.user import User
from app.services import permissions_svc


@dataclass
class _FakeUser:
    """Enough of a User for the heal (no DB, no Beanie init)."""

    account_type: object
    permissions: list
    id: str = "owner-1"


class _FakeCollection:
    """Stands in for User.get_motor_collection(), recording the $set that would
    have hit Mongo."""

    def __init__(self, fail: bool = False):
        self.writes: list = []
        self.fail = fail

    async def update_one(self, query, update):
        if self.fail:
            raise RuntimeError("mongo is unreachable")
        self.writes.append((query, update))


@pytest.fixture
def collection(monkeypatch):
    col = _FakeCollection()
    monkeypatch.setattr(User, "get_motor_collection",
                        classmethod(lambda cls: col))
    return col


def _run(coro):
    return asyncio.run(coro)


# --- Detection -------------------------------------------------------------------


def test_an_owner_short_of_a_flag_is_stale():
    owner = _FakeUser(AccountType.OWNER, ["view_policies"])
    assert permissions_svc.owner_permissions_are_stale(owner)


def test_an_owner_missing_only_the_new_bank_pair_is_stale():
    """The exact live shape: everything except the two flags added last."""
    old_set = [p for p in perms.ALL_PERMISSIONS
               if p not in ("view_bank_accounts", "manage_bank_accounts")]
    # A hard-coded count here has been wrong twice already (the bank pair, then
    # the announcements pair). The COUNT was never the point — what is being
    # pinned is that an owner's stored set can be short of the current one and
    # is still recognised as stale.
    assert len(old_set) == len(perms.ALL_PERMISSIONS) - 2
    assert permissions_svc.owner_permissions_are_stale(
        _FakeUser(AccountType.OWNER, old_set))


def test_a_current_owner_is_not_stale():
    owner = _FakeUser(AccountType.OWNER, list(perms.ALL_PERMISSIONS))
    assert not permissions_svc.owner_permissions_are_stale(owner)


def test_staleness_ignores_ordering():
    """Order is presentation only — a reordered list must not trigger a write
    on every single request."""
    owner = _FakeUser(AccountType.OWNER, list(reversed(perms.ALL_PERMISSIONS)))
    assert not permissions_svc.owner_permissions_are_stale(owner)


def test_an_employee_is_never_stale():
    """Employees legitimately hold a subset. Healing them would hand a junior
    the whole application."""
    employee = _FakeUser(AccountType.EMPLOYEE, ["view_policies"])
    assert not permissions_svc.owner_permissions_are_stale(employee)


def test_a_partner_is_never_stale():
    partner = _FakeUser(AccountType.CHANNEL_PARTNER, [])
    assert not permissions_svc.owner_permissions_are_stale(partner)


# --- Healing ---------------------------------------------------------------------


def test_healing_gives_the_owner_every_flag(collection):
    owner = _FakeUser(AccountType.OWNER, ["view_policies"])
    _run(permissions_svc.heal_owner_permissions(owner))
    assert owner.permissions == perms.ALL_PERMISSIONS
    assert "manage_bank_accounts" in owner.permissions


def test_healing_persists_the_full_set_to_that_owner_only(collection):
    owner = _FakeUser(AccountType.OWNER, ["view_policies"])
    _run(permissions_svc.heal_owner_permissions(owner))
    (query, update), = collection.writes
    assert query == {"_id": "owner-1"}
    assert update["$set"]["permissions"] == perms.ALL_PERMISSIONS


def test_healing_writes_once_and_then_stops(collection):
    """This runs on EVERY authenticated request. A write per request would be a
    performance bug of its own."""
    owner = _FakeUser(AccountType.OWNER, ["view_policies"])
    for _ in range(6):
        _run(permissions_svc.heal_owner_permissions(owner))
    assert len(collection.writes) == 1


def test_healing_leaves_an_employee_alone(collection):
    employee = _FakeUser(AccountType.EMPLOYEE, ["view_policies"])
    _run(permissions_svc.heal_owner_permissions(employee))
    assert employee.permissions == ["view_policies"]
    assert collection.writes == []


def test_a_failed_write_still_fixes_the_current_request(monkeypatch):
    """The heal is a convenience, not a gate. If Mongo refuses the write the
    request must still proceed with the correct permissions rather than 500 —
    otherwise a transient database blip signs the owner out of half the app."""
    col = _FakeCollection(fail=True)
    monkeypatch.setattr(User, "get_motor_collection",
                        classmethod(lambda cls: col))
    owner = _FakeUser(AccountType.OWNER, ["view_policies"])
    _run(permissions_svc.heal_owner_permissions(owner))
    assert owner.permissions == perms.ALL_PERMISSIONS
    assert col.writes == []


# --- The read path, independent of the heal --------------------------------------


def test_a_stale_owner_reads_as_full_even_before_healing():
    """Belt and braces: authentication heals the document, but every serialised
    read resolves the owner rule on its own. An owner OTHER than the one signed
    in is never rendered as missing a flag they hold."""
    owner = _FakeUser(AccountType.OWNER, ["view_policies"])
    assert perms.effective_permissions(owner) == perms.ALL_PERMISSIONS
    assert owner.permissions == ["view_policies"], "a read must not mutate"
