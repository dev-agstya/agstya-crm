"""The quote request flow, end to end — six breaks the owner reported as
"the flow is a bit broken from both ends".

They were, and each one had the same shape: a piece of the loop that was written
and then never connected to anything.

  D1  An accepted quote could NEVER become a policy. The staff screen sent people
      to /policies/new?quote=<id> and the policy form did not read the parameter,
      so nothing was pre-filled and — much worse — nothing linked the two on
      save. `POST /{id}/booked` existed, worked, and was called from nowhere in
      the entire frontend. Quotes sat at ACCEPTED for ever.
  D2  A partner could not open a document they had uploaded themselves. There
      was no endpoint, and the screen said so out loud.
  D3  Every quote notification fired on `manage_policies` — the wrong desk since
      quotes got their own permission pair on 2026-08-07.
  D4  A partner's reply did not take the request off "waiting on them".
  D5  Cancelling told nobody, including the person mid-way through pricing it.
  D6  An expired quotation was a dead end for both sides.
"""

from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.core.enums import QuoteStage
from app.models.quote_request import QuoteOption, option_expired
from app.routers import portal as portal_router
from app.routers import quotes as quotes_router

WEB = Path(__file__).resolve().parents[2] / "web" / "src"


def _option(**kw) -> QuoteOption:
    base = dict(id="opt1", premium_amount=100_000, partner_earning=5_000)
    base.update(kw)
    return QuoteOption(**base)


# --- D1: the accepted quote finally becomes a policy ------------------------------


def test_the_policy_form_reads_the_quote_parameter():
    """The staff screen has linked to `/policies/new?quote=<id>` since quote
    requests shipped, and the form ignored it entirely."""
    form = (WEB / "pages" / "policies" / "PolicyFormPage.tsx").read_text(
        encoding="utf-8")
    assert 'search.get("quote")' in form


def test_saving_a_policy_from_a_quote_LINKS_them():
    """The half that matters. Without markBooked the quote never reaches ISSUED,
    the partner is never told, and `policy_id` is never written — so neither the
    staff nor the portal screen can ever show "Open the policy"."""
    form = (WEB / "pages" / "policies" / "PolicyFormPage.tsx").read_text(
        encoding="utf-8")
    assert "quotesApi.markBooked" in form


def test_the_broker_and_the_reward_are_NOT_prefilled_from_the_quote():
    """Deliberate (owner A3). The broker choice is what prices the reward, and a
    quoted `partner_earning` is a figure a person typed — not a rate this form
    could reverse-engineer. Pre-filling either would put a number on the policy
    that nothing verified."""
    form = (WEB / "pages" / "policies" / "PolicyFormPage.tsx").read_text(
        encoding="utf-8")
    prefill = form[form.index("prefilled.current = true"):
                   form.index("useEffect(() => {\n    const pending")]
    assert "broker_id" not in prefill
    assert "agency_value" not in prefill
    assert "partner_value" not in prefill


def test_a_failed_link_does_not_read_as_a_failed_policy():
    """The policy saved. Reporting that as an error would send somebody back to
    re-enter a policy that already exists — so it is a warning naming the one
    manual step left."""
    form = (WEB / "pages" / "policies" / "PolicyFormPage.tsx").read_text(
        encoding="utf-8")
    assert "The policy saved, but it could not be linked" in form


# --- D2: a partner can open their own documents -----------------------------------


def test_a_partner_can_download_a_document_they_uploaded():
    assert hasattr(portal_router, "download_my_quote_document")


def test_that_download_is_scoped_twice():
    """The request must be theirs AND the document must belong to that request.
    Either check alone lets a crafted id through."""
    source = inspect.getsource(portal_router.download_my_quote_document)
    assert "_own_quote(actor, quote_id)" in source
    assert 'doc.entity_type != "quote_request"' in source
    assert "doc.entity_id != str(q.id)" in source
    # Somebody else's document is a 404, never a 403 — a 403 confirms it exists.
    assert "HTTP_404_NOT_FOUND" in source
    assert "HTTP_403" not in source


def test_the_portal_screen_no_longer_apologises_instead_of_downloading():
    """It used to show an error toast — "Ask your relationship manager for a
    copy of this document" — on a file the partner had attached themselves,
    minutes earlier, off their own phone."""
    page = (WEB / "pages" / "portal" / "PortalQuotesPage.tsx").read_text(
        encoding="utf-8")
    assert "portalApi.quoteDocumentUrl" in page
    assert "Ask your relationship manager for a copy" not in page


# --- D3: the right desk is told ----------------------------------------------------


def test_quote_notifications_go_to_the_quotes_desk():
    """Quotes got their own permission pair in the 2026-08-07 split and every
    notification kept firing on `manage_policies` — so a quotes officer was told
    about none of them, while a policy-booking employee with no quote access was
    notified about a page that refuses to open for them."""
    assert portal_router._QUOTE_DESK == "manage_quotes"
    assert portal_router._CLAIM_DESK == "manage_claims"


def test_no_quote_or_claim_notification_still_names_the_policies_desk():
    source = inspect.getsource(portal_router)
    assert '"manage_policies"' not in source


def test_notifications_resolve_permissions_rather_than_reading_the_snapshot():
    """`User.permissions` is a DENORMALISED SNAPSHOT — the owner's is written
    once at creation and never rewritten. A Mongo query for a NEW flag therefore
    matches nobody, and every notification on it goes silently to an empty list.
    """
    from app.services import notifications

    source = inspect.getsource(notifications.notify_permission)
    assert "can(u, permission)" in source
    assert '"permissions": permission' not in source


# --- D4: a reply hands the ball back -----------------------------------------------


def test_a_reply_moves_an_info_needed_request_back_to_in_review():
    """INFO_NEEDED means "waiting on the partner". Answering is exactly the
    event that stops being true — and nothing moved the stage, so the queue read
    "waiting on them" while the ball was with the agency."""
    source = inspect.getsource(portal_router.reply_on_quote)
    assert "QuoteStage.INFO_NEEDED" in source
    assert "q.stage = QuoteStage.IN_REVIEW" in source


def test_a_reply_on_an_already_open_request_is_a_comment_not_a_transition():
    """A timeline showing "In review" against every single line stops being
    readable, so the stage is stamped only when it actually moved."""
    source = inspect.getsource(portal_router.reply_on_quote)
    assert "if answered else None" in source


# --- D5: cancelling reaches the person working it ----------------------------------


def test_cancelling_notifies_the_assignee_by_name():
    """Somebody is very likely mid-way through pricing it — chasing an
    underwriter, or about to ring a customer whose business has already gone
    elsewhere. This told nobody at all."""
    source = inspect.getsource(portal_router.cancel_quote)
    assert "create_notification(" in source
    assert "q.assigned_to_id" in source


def test_cancelling_also_reaches_the_rest_of_the_desk():
    """So an UNASSIGNED request is not silently dropped."""
    source = inspect.getsource(portal_router.cancel_quote)
    assert "notify_permission(" in source
    assert "exclude_user_id" in source          # and the assignee is not told twice


# --- D6: expiry is a state, not a dead end -----------------------------------------


def test_an_expired_option_is_expired():
    past = datetime.now(tz=timezone.utc) - timedelta(days=1)
    assert option_expired(_option(valid_until=past)) is True


def test_an_ACCEPTED_option_never_expires():
    """The customer said yes inside the window; the clock stops there. A policy
    that takes four days to issue must not retroactively invalidate the
    acceptance it was booked on."""
    past = datetime.now(tz=timezone.utc) - timedelta(days=5)
    assert option_expired(
        _option(valid_until=past, accepted_at=past)) is False


def test_an_option_with_no_expiry_never_expires():
    assert option_expired(_option(valid_until=None)) is False


def test_a_naive_stored_timestamp_is_treated_as_utc():
    """Older rows predate the tz-aware convention. Comparing a naive value
    against an aware one raises outright, which would take out the whole queue
    rather than mis-flag one row."""
    past = datetime.now(tz=timezone.utc).replace(tzinfo=None) \
        - timedelta(days=1)
    assert option_expired(_option(valid_until=past)) is True


def test_all_three_screens_share_ONE_expiry_rule():
    """The partner's card, the partner's re-quote action and the staff queue's
    flag. Two of the three were written inline and the third did not exist,
    which is how a partner could be told a quote was dead on a request staff
    still saw as live."""
    assert "option_expired" in inspect.getsource(portal_router._portal_option)
    assert "option_expired" in inspect.getsource(portal_router.ask_for_fresh_quote)
    assert "option_expired" in inspect.getsource(quotes_router._staff_quote)


def test_the_staff_queue_flags_an_expired_quotation():
    """A QUOTED request with an expired option is NOT workable — the partner
    cannot accept it — but it sat in the open queue looking exactly like a live
    one."""
    source = inspect.getsource(quotes_router._staff_quote)
    assert "expired=" in source
    assert "QuoteStage.QUOTED" in source


def test_a_partner_can_ask_for_a_fresh_quotation():
    assert hasattr(portal_router, "ask_for_fresh_quote")


def test_asking_for_a_re_quote_reopens_the_SAME_request():
    """The customer, the documents and the whole conversation are already on it.
    A second request for one case is how a partner ends up quoted twice."""
    source = inspect.getsource(portal_router.ask_for_fresh_quote)
    assert "q.stage = QuoteStage.IN_REVIEW" in source
    assert "QuoteRequest(" not in source          # nothing new is created


def test_a_re_quote_is_refused_while_the_quotation_is_still_live():
    """"Ask for a fresh one" on a price they can still accept is a way to lose a
    sale to a re-quote that comes back higher."""
    source = inspect.getsource(portal_router.ask_for_fresh_quote)
    assert "has not expired yet" in source


def test_the_expired_option_is_KEPT_when_a_re_quote_is_asked_for():
    """The partner should still be able to see what they were quoted last time;
    staff re-pricing replaces it anyway (send_quote assigns a fresh single-item
    list, owner B1)."""
    source = inspect.getsource(portal_router.ask_for_fresh_quote)
    assert "q.options = []" not in source


# --- The boundary still holds ------------------------------------------------------


@pytest.mark.parametrize("field", [
    "agency_reward", "house_profit", "broker", "tds", "discount", "rate",
])
def test_no_agency_side_figure_leaks_into_the_new_portal_endpoints(field):
    """Every endpoint added to the portal in this pass is checked against the
    same rule the portal was built on: its schemas have no field for the
    agency's own side, and the omission IS the safeguard."""
    for fn in (portal_router.ask_for_fresh_quote,
               portal_router.download_my_quote_document):
        assert field not in inspect.getsource(fn)
