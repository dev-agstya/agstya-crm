"""The Channel Partner security boundary.

The portal is back, and roughly two hundred existing endpoints were written when
only staff could sign in — they hand out house profit, rate cards, other
partners' balances and the whole customer book without a second thought.

So the boundary is enforced the safe way round: staff routers are closed to
partners AS A WHOLE, and partners reach only the explicitly partner-safe surface
in routers/portal.py. These tests fail when someone adds a route that is neither.

If one of these fails, you have added an endpoint. Do one of:
  * it is for staff       -> it belongs on a router carrying get_inhouse_user
  * it is for partners    -> put it in routers/portal.py and check what it leaks
  * it is genuinely open  -> add it to PUBLIC_PREFIXES below, with a reason
"""

import inspect

import pytest

from app.core.dependencies import get_inhouse_user
from app.core.enums import AccountType
from app.core.feature_flags import partner_can_sign_in, partner_portal_blocked
from app.main import app

# Routers a channel partner is allowed to reach, and why.
PARTNER_REACHABLE_PREFIXES = {
    "/api/auth",           # login, password, own profile, own documents
    "/api/portal",         # the partner-safe surface itself
    "/api/notifications",  # their own bell rows, filtered by user id
    # NOTE: /api/wallet and /api/withdrawals are NO LONGER partner-reachable.
    # Payouts are made by the team and reach the partner as transactions on
    # their earnings screen (owner A1, 2026-08-05).
}

# Open to anyone, signed in or not.
PUBLIC_PREFIXES = {
    "/api/public",   # tokenised customer document upload (no account at all)
    "/health", "/", "/docs", "/redoc", "/openapi.json",
}


def _routes():
    for route in app.routes:
        path = getattr(route, "path", "")
        if path.startswith("/api") or path in PUBLIC_PREFIXES:
            yield route


def _has_inhouse_guard(route) -> bool:
    """True when get_inhouse_user is in the route's resolved dependency chain."""
    for dep in getattr(route, "dependant", None).dependencies \
            if getattr(route, "dependant", None) else []:
        if dep.call is get_inhouse_user:
            return True
        for sub in dep.dependencies:
            if sub.call is get_inhouse_user:
                return True
    return False


def test_every_staff_endpoint_is_closed_to_partners():
    """The important one. A new staff route with no guard shows up here."""
    unguarded = []
    for route in _routes():
        path = getattr(route, "path", "")
        if any(path.startswith(p) for p in PARTNER_REACHABLE_PREFIXES):
            continue
        if any(path.startswith(p) or path == p for p in PUBLIC_PREFIXES):
            continue
        if not _has_inhouse_guard(route):
            unguarded.append(f"{sorted(route.methods)} {path}")
    assert not unguarded, (
        "These endpoints are reachable by a signed-in channel partner. Add "
        "get_inhouse_user to their router, or move them into routers/portal.py:"
        "\n  " + "\n  ".join(sorted(unguarded)))


def test_the_partner_surface_is_small_enough_to_read():
    """The portal's whole value is that it can be audited by reading it. If this
    grows past a few dozen routes, the boundary has stopped being obvious."""
    portal = [r for r in _routes()
              if getattr(r, "path", "").startswith("/api/portal")]
    assert portal, "the portal router must be registered"
    assert len(portal) <= 40, (
        f"{len(portal)} portal routes — split or re-review before growing it")


def test_the_portal_never_exposes_agency_money():
    """A partner sees the premium, their own share and their own wallet. The
    partner-facing schemas must not even HAVE a field for the agency's reward,
    house profit, the rate card or the broker (owner A1.2)."""
    from app.routers import portal as portal_module

    banned = ("agency_reward", "agency_amount", "house_profit", "house_amount",
              "commissionable", "reward_percent", "rate", "broker_id",
              "broker_name", "tds")
    offenders = []
    for name, obj in vars(portal_module).items():
        fields = getattr(obj, "model_fields", None)
        if not fields or not name.startswith("Portal"):
            continue
        for field in fields:
            if any(b in field.lower() for b in banned):
                offenders.append(f"{name}.{field}")
    assert not offenders, (
        "Partner-facing schemas must not carry agency figures: "
        + ", ".join(offenders))


def test_the_portal_scopes_every_query_to_the_calling_partner():
    """Scope belongs in the QUERY, not the serialiser: a filter applied while
    reading cannot be undone by a mistake in a response model."""
    from app.routers import portal as portal_module

    source = inspect.getsource(portal_module)
    # Every list endpoint builds its query from _me(actor) or an explicit
    # owner_user_id / partner_id clause on the calling partner.
    assert "def _me(actor: User)" in source
    # Every list endpoint the portal has. Customers and leads went with the
    # partner write surface (2026-08-05); quotes, claims and notices arrived.
    for reader in ("my_policies", "my_quotes", "my_claims", "my_renewals",
                   "my_earnings", "my_transactions", "my_notices"):
        fn_src = inspect.getsource(getattr(portal_module, reader))
        assert ("_me(actor)" in fn_src
                or 'str(actor.id)' in fn_src), \
            f"{reader} does not scope its query to the calling partner"


# --- The two access gates ----------------------------------------------------------


class _U:
    def __init__(self, account_type, portal_access=False):
        self.account_type = account_type
        self.portal_access = portal_access


class _S:
    def __init__(self, enabled=True):
        self.partner_portal = type("P", (), {"enabled": enabled})()


def test_a_partner_needs_every_gate_open():
    """The master switch AND their own flag — see tests/test_feature_flags.py,
    which owns the gates in detail."""
    ok = _U(AccountType.CHANNEL_PARTNER, True)
    assert partner_can_sign_in(ok, _S(True))
    assert not partner_can_sign_in(
        _U(AccountType.CHANNEL_PARTNER, False), _S(True))
    assert not partner_can_sign_in(ok, _S(False))


def test_partners_are_locked_out_by_default():
    """An account that never went through create_partner has made no decision,
    and the safe reading of that is "no"."""
    assert partner_portal_blocked(_U(AccountType.CHANNEL_PARTNER), _S(True))


def test_staff_are_never_affected_by_the_portal_switch():
    for kind in (AccountType.OWNER, AccountType.EMPLOYEE):
        assert partner_can_sign_in(_U(kind), _S(False))
        assert not partner_portal_blocked(_U(kind), _S(False))


def test_the_blocked_message_leaks_nothing():
    from app.core import feature_flags as ff

    msg = ff.PARTNER_PORTAL_BLOCKED_MESSAGE.lower()
    assert "@" not in msg
    for leak in ("not enabled for you", "disabled account", "no such"):
        assert leak not in msg
