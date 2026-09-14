"""Adding a channel partner invites them (owner 2026-08-04, A1a).

Until now `POST /api/users/partners` generated a temporary password, hashed it,
and then threw it away: the welcome email only went out when `portal_access` was
true, the create schema defaulted that to false, and the Add form never sent the
field at all. Every partner was therefore created mute — no login, no email, and
the one copy of their password gone. The screen even advertised it
("No onboarding email will be sent in v1").

Now creation ALWAYS grants portal access and ALWAYS emails the invitation, and a
partner's temporary password does not expire (owner A4) — it lasts until their
first sign-in, at which point `must_change_password` walks them into onboarding
and they set their own.

Source-reading, like tests/test_partner_boundary.py: what is being pinned is a
set of decisions inside one endpoint, and standing up Mongo + SMTP to observe
them would test the harness rather than the rule.
"""

import inspect

from app.core.enums import AccountType
from app.routers import users as users_router
from app.schemas.user import ChannelPartnerCreate, UserUpdate
from app.services import email as email_svc


def _source(fn) -> str:
    return inspect.getsource(fn)


# --- Portal access + the invitation ---------------------------------------------


def test_creating_a_partner_grants_portal_access():
    src = _source(users_router.create_partner)
    assert "portal_access=True" in src, (
        "A new channel partner must be given portal access. Without it the "
        "invitation below hands them credentials for a door that is shut.")


def test_the_create_payload_can_no_longer_withhold_portal_access():
    """The decision moved out of the request body deliberately."""
    assert "portal_access" not in ChannelPartnerCreate.model_fields, (
        "ChannelPartnerCreate must not carry portal_access — creation always "
        "grants it (owner A1a). Revoking is done from the partner's own page "
        "via UserUpdate, which still has the field.")
    assert "portal_access" in UserUpdate.model_fields


def test_the_invitation_does_not_depend_on_the_request():
    """It used to sit behind `if payload.portal_access:` — a field the Add form
    never sent, so the email never went."""
    src = _source(users_router.create_partner)
    assert "_send_welcome" in src
    assert "if payload.portal_access" not in src


def test_the_invitation_goes_out_with_the_account():
    """The temporary password exists NOWHERE else. An account created without
    the email is one nobody can ever sign into without a reset — which is
    exactly what the old default-off behaviour produced."""
    src = _source(users_router.create_partner)
    assert "background.add_task(_send_welcome" in src
    # No condition wrapping it. The portal shipped; there is nothing to wait for.
    assert "if invited:" not in src
    assert "portal_launched" not in src


def test_the_audit_line_says_an_email_left_the_building():
    assert "invitation emailed" in _source(users_router.create_partner)


def test_credentials_are_never_emailed_to_someone_who_cannot_sign_in():
    """Both invite paths go through one guard, so they cannot drift."""
    for fn in (users_router.resend_invite, users_router.admin_reset_password):
        assert "_ensure_invitable(target)" in _source(fn), (
            f"{fn.__name__} must refuse while the portal is shut — a partner "
            "with nowhere to sign in is only confused by a password email.")
    guard = _source(users_router._ensure_invitable)
    assert "portal_access" in guard
    # Staff are never caught by it: they always have an account to come back to.
    assert "if target.account_type != AccountType.CHANNEL_PARTNER" in guard


# --- How long the temporary password lasts --------------------------------------


def test_a_partners_temporary_password_never_expires():
    assert users_router._temp_password_expiry(
        AccountType.CHANNEL_PARTNER) is None


def test_staff_still_get_a_seven_day_window():
    for account_type in (AccountType.EMPLOYEE, AccountType.OWNER):
        expiry = users_router._temp_password_expiry(account_type)
        assert expiry is not None, f"{account_type} must keep an expiry"
        days = (expiry - users_router.utcnow()).days
        assert days == users_router._STAFF_TEMP_PASSWORD_DAYS - 1 or days == 7


def test_every_password_email_path_uses_the_one_expiry_rule():
    """Three endpoints mint a temporary password. A hard-coded 7 days in any of
    them would quietly re-expire a partner's invitation."""
    for fn in (users_router.create_partner, users_router.create_employee,
               users_router.resend_invite, users_router.admin_reset_password,
               users_router.update_user):
        src = _source(fn)
        assert "timedelta(days=7)" not in src, (
            f"{fn.__name__} hard-codes a 7-day expiry; use "
            "_temp_password_expiry(account_type) so partners stay exempt.")


def test_the_validity_sentence_matches_the_rule():
    partner = users_router._temp_password_validity_note(
        AccountType.CHANNEL_PARTNER)
    assert "until they sign in" in partner
    assert "7 days" not in partner, (
        "Telling a partner the password lasts 7 days when it never expires is "
        "the message contradicting the app.")
    assert "7 days" in users_router._temp_password_validity_note(
        AccountType.EMPLOYEE)


# --- What the email actually says -----------------------------------------------


def _render(role: str) -> str:
    return email_svc.render(
        "account_created.html",
        name="Prakash Dangi",
        role=email_svc._ROLE_LABELS.get(role, role),
        role_blurb=email_svc._ROLE_BLURBS.get(role),
        email="prakash@example.com",
        temp_password="Xk92-aB7q",
        login_url="https://example.test/login",
        expires_days=None if role == "channel_partner" else 7,
    )


def test_a_partner_is_addressed_as_a_channel_partner_not_an_enum():
    html = _render("channel_partner")
    assert "Channel Partner" in html
    assert "channel_partner" not in html, (
        "The raw enum value went straight into the greeting — the one word in "
        "the message that is obviously written by a machine.")


def test_the_partner_email_says_what_the_portal_is_for():
    """And describes the portal they will actually land in.

    This assertion used to require the word "approve", which pinned a sentence
    promising they could "send a new policy over for the team to approve" —
    written for the old portal and left behind when submission was removed
    (2026-08-05). The first thing a new partner read was an instruction for a
    screen that no longer exists.
    """
    html = _render("channel_partner").lower()
    assert "portal" in html
    # The two things they can actually do, and the two they mostly come for.
    for real in ("quote", "claim", "renewal", "earned"):
        assert real in html, f"the partner's welcome email never mentions {real}"
    for gone in ("approve", "submit a policy", "add a policy"):
        assert gone not in html, (
            f"the welcome email still describes '{gone}' — a partner cannot "
            "book a policy; staff do that")


def test_the_partner_email_promises_no_expiry_it_cannot_keep():
    html = _render("channel_partner")
    assert "valid for" not in html, (
        "A partner's temporary password does not expire; the email must not "
        "say it does.")
    # Staff still get told.
    assert "valid for 7 days" in _render("employee")


def test_the_credentials_are_both_in_the_email():
    html = _render("channel_partner")
    assert "prakash@example.com" in html
    assert "Xk92-aB7q" in html
    assert "https://example.test/login" in html
