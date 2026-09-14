"""Account-type gates for the Channel Partner portal.

Access is gated TWICE, and both gates must be open:

  1. The owner's in-app master switch (`SystemSettings.partner_portal.enabled`),
     checked on EVERY request rather than only at login — so switching it off
     signs every partner out at once, without a deploy.
  2. The per-partner `portal_access` flag, granted when the account is created
     and revocable from the partner's own page.

There used to be a third, config-level launch gate holding the portal back
before it shipped. The portal shipped on 2026-08-05 and the gate went with it:
a permanently-true flag is one nobody reads correctly six months later.

Everything behind the door is closed by default too: staff routers carry
`get_inhouse_user`, and partners reach only the explicitly partner-safe
endpoints. See core/dependencies.get_inhouse_user and routers/portal.py.
"""

from app.core.enums import AccountType

# Shown wherever a channel-partner account is refused. Kept generic so it never
# leaks whether an email exists, which gate is shut, or whether that particular
# partner is enabled.
PARTNER_PORTAL_BLOCKED_MESSAGE = (
    "Channel partner portal access is not available for this account. "
    "Contact your relationship manager."
)

# Back-compat alias: the old name is still imported in a couple of places.
PARTNER_PORTAL_PAUSED_MESSAGE = PARTNER_PORTAL_BLOCKED_MESSAGE


def portal_globally_enabled(settings_doc=None) -> bool:
    """Gate 1 — the owner's master switch. Defaults to ON once the setting
    exists.

    Takes the already-loaded settings document so callers inside a request do
    not pay for another read (services/settings_svc caches it in-process).
    """
    if settings_doc is None:
        return True
    partner = getattr(settings_doc, "partner_portal", None)
    return True if partner is None else bool(getattr(partner, "enabled", True))


def partner_can_sign_in(user, settings_doc=None) -> bool:
    """True when this account may authenticate.

    Staff always can — neither gate applies to them. A channel partner needs
    both.
    """
    if user.account_type != AccountType.CHANNEL_PARTNER:
        return True
    if not portal_globally_enabled(settings_doc):
        return False
    return bool(getattr(user, "portal_access", False))


def partner_portal_blocked(user, settings_doc=None) -> bool:
    """Inverse of partner_can_sign_in, for the `if blocked: raise` call sites."""
    return not partner_can_sign_in(user, settings_doc)


def is_partner(account_type) -> bool:
    return account_type == AccountType.CHANNEL_PARTNER
