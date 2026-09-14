"""Channel-partner portal access gates.

TWO gates, and both must be open:

  1. The owner's in-app master switch, checked on EVERY request.
  2. The per-partner `portal_access` flag.

There was briefly a third, config-level launch gate holding the portal back
before it shipped (2026-08-05). It went with the launch — a permanently-true
flag is one nobody reads correctly later.

These are pure (no DB). Router-level enforcement is covered by
tests/test_partner_boundary.py.
"""

import app.core.feature_flags as ff
from app.core.enums import AccountType
from app.core.feature_flags import (
    partner_can_sign_in,
    partner_portal_blocked,
    portal_globally_enabled,
)


class _User:
    def __init__(self, account_type, portal_access=False):
        self.account_type = account_type
        self.portal_access = portal_access


class _Settings:
    def __init__(self, enabled=True):
        self.partner_portal = type("P", (), {"enabled": enabled})()


def _partner(access=True):
    return _User(AccountType.CHANNEL_PARTNER, portal_access=access)


# --- Gate 1: the owner's master switch -------------------------------------------


def test_the_master_switch_is_on_by_default():
    """A deployment with no setting document yet still works."""
    assert portal_globally_enabled(None) is True
    assert portal_globally_enabled(_Settings(True)) is True


def test_the_owner_can_shut_the_portal_in_one_click():
    assert portal_globally_enabled(_Settings(False)) is False
    assert partner_can_sign_in(
        _partner(access=True), _Settings(False)) is False


# --- Gate 2: the per-partner flag ------------------------------------------------


def test_a_partner_without_access_cannot_sign_in():
    assert partner_can_sign_in(
        _partner(access=False), _Settings(True)) is False


def test_a_granted_partner_can_sign_in():
    assert partner_can_sign_in(
        _partner(access=True), _Settings(True)) is True


def test_a_new_partner_is_granted_access_on_creation():
    """The stored default stays False — an account that never went through
    create_partner has made no decision — but the endpoint always grants it.
    See tests/test_partner_onboarding.py."""
    from app.models.user import User

    assert User.model_fields["portal_access"].default is False


# --- Staff are never gated ------------------------------------------------------


def test_staff_are_never_blocked():
    for kind in (AccountType.OWNER, AccountType.EMPLOYEE):
        assert partner_can_sign_in(_User(kind), _Settings(True)) is True
        assert partner_can_sign_in(_User(kind), _Settings(False)) is True
        assert partner_portal_blocked(_User(kind), _Settings(False)) is False


# --- What the refusal says ------------------------------------------------------


def test_blocked_message_is_generic():
    """Must not leak whether an email exists or which gate is closed."""
    msg = ff.PARTNER_PORTAL_BLOCKED_MESSAGE.lower()
    assert "@" not in msg
    assert "partner" in msg
    for leak in ("not open", "disabled", "switch"):
        assert leak not in msg


def test_the_old_name_still_resolves():
    """Kept as an alias so a stale import cannot 500 a login."""
    assert ff.PARTNER_PORTAL_PAUSED_MESSAGE == ff.PARTNER_PORTAL_BLOCKED_MESSAGE
