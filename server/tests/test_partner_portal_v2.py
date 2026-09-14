"""The Channel Partner portal, v2 (owner 2026-08-05).

The portal was rebuilt around what a partner actually does: they ASK, they
WATCH, they get paid. Their entire write surface is a quote request and a claim.
Policies, premiums, rewards, customers, leads and payouts are written by staff
on staff screens.

What these pin, in order of how badly it would hurt to get wrong:

  1. The write surface is exactly two things, and the removed endpoints stay
     removed.
  2. Money a partner sees comes from the SAME functions the agency's own Balance
     Sheet and statement use — never a recomputation.
  3. Nothing partner-facing carries an agency figure, a rate, a broker or a
     staff note.
  4. Every read is scoped in the QUERY.

Source-reading, like tests/test_partner_boundary.py: these are decisions inside
a router, and standing up Mongo to observe them would test the harness.
"""

import ast
import inspect
import textwrap

import pytest

from app.main import app
from app.models.policy import Policy
from app.routers import announcements as ann_router
from app.routers import claims as claims_router
from app.routers import portal as portal_router
from app.routers import quotes as quotes_router


def _code(fn) -> str:
    """Source with comments and docstrings stripped — several of these explain
    in prose the very thing being asserted absent."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.ClassDef, ast.Module)) \
                and ast.get_docstring(node):
            node.body = node.body[1:]
    return ast.unparse(tree)


def _portal_paths() -> list[str]:
    return [getattr(r, "path", "") for r in app.routes
            if getattr(r, "path", "").startswith("/api/portal")]


def _portal_writes() -> set[str]:
    out = set()
    for r in app.routes:
        path = getattr(r, "path", "")
        methods = getattr(r, "methods", set()) or set()
        if path.startswith("/api/portal") and methods & {"POST", "PATCH",
                                                         "PUT", "DELETE"}:
            out.add(path)
    return out


# --- 1. The write surface -------------------------------------------------------


def test_a_partner_can_no_longer_submit_a_policy():
    """They never had the policy number, the insurer or the rate, so the form
    only ever worked as retrospective data entry."""
    for gone in ("submit_policy", "edit_pending_policy",
                 "upload_my_policy_document", "PortalPolicyIn"):
        assert not hasattr(portal_router, gone), (
            f"{gone} came back. A partner asks for a quote; STAFF book the "
            "policy.")


def test_the_removed_partner_surface_stays_removed():
    for gone in ("create_customer", "my_customers", "create_lead", "my_leads",
                 "comment_on_lead", "my_wallet", "my_wallet_transactions"):
        assert not hasattr(portal_router, gone), f"{gone} came back"


def test_partners_cannot_reach_the_wallet_or_withdrawal_routers():
    """Payouts are made by the team and reach the partner as transactions."""
    from app.core.dependencies import get_inhouse_user

    for route in app.routes:
        path = getattr(route, "path", "")
        if not (path.startswith("/api/wallet")
                or path.startswith("/api/withdrawals")):
            continue
        deps = getattr(route, "dependant", None)
        chain = []
        if deps:
            for d in deps.dependencies:
                chain.append(d.call)
                chain.extend(s.call for s in d.dependencies)
        assert get_inhouse_user in chain, (
            f"{path} is reachable by a channel partner; payouts are staff-only")


def test_the_write_surface_is_exactly_quotes_and_claims():
    writes = _portal_writes()
    allowed_roots = ("/api/portal/quotes", "/api/portal/claims",
                     "/api/portal/notices")
    stray = [w for w in writes if not w.startswith(allowed_roots)]
    assert not stray, (
        "A partner may write a quote request, a claim, and a read-receipt on a "
        f"notice. Nothing else. Found: {sorted(stray)}")


def test_the_quote_form_cannot_state_what_the_agency_decides():
    """The omission IS the safeguard — a field that does not exist cannot be
    smuggled in."""
    banned = ("policy_number", "insurer_id", "premium", "sum_insured",
              "broker_id", "reward", "discount", "partner_earning",
              "commissionable")
    fields = portal_router.QuoteRequestIn.model_fields
    for b in banned:
        assert not any(b in f for f in fields), (
            f"QuoteRequestIn carries '{b}' — that is an OUTPUT of quoting")


def test_a_partner_cannot_price_their_own_quote():
    """Accepting a quote does not create a policy or book a reward."""
    src = _code(portal_router.decide_on_quote)
    for forbidden in ("Policy(", "sync_reward", "book_policy_finance",
                      "credit_reward"):
        assert forbidden not in src


# --- 2. Money comes from the shared functions ------------------------------------


def test_the_net_balance_is_the_same_function_the_balance_sheet_uses():
    """A partner and the agency reading different numbers for the same
    relationship is the worst bug this app can have."""
    src = _code(portal_router._money)
    assert "partner_net_balance(" in src
    assert "reward_owed - premium_owed" not in src, "do not reinvent the netting"


def test_transactions_are_the_statement_ledger():
    src = _code(portal_router.my_transactions)
    assert "partner_ledger(" in src


def test_an_earning_is_read_off_the_booked_reward_not_recomputed():
    """`Reward.partner_amount` is what the wallet was credited with. Deriving
    it from the rate here would let the screen and the wallet disagree."""
    src = _code(portal_router._earnings_for)
    assert "partner_amount" in src
    for forbidden in ("agency_value", "partner_value", "commissionable"):
        assert forbidden not in src


def test_both_sides_of_the_position_are_always_shown():
    """Owner E2: hiding what they owe makes what they are owed wrong by
    subtraction, which is how every payout ends in an argument."""
    fields = portal_router.PortalMoney.model_fields
    assert {"net_balance", "reward_earned_unpaid", "premium_owed"} <= set(fields)
    # The switch that used to hide one side is gone.
    from app.models.settings import PartnerPortalSettings

    assert "show_amount_payable" not in PartnerPortalSettings.model_fields


# --- 3. Nothing leaks ------------------------------------------------------------


# The ONLY percentages a partner may see, and why each one is not a rate.
#
# Owner E1 is "rupees only, never a percentage", and it is about MONEY: a
# reward rate on a screen they can screenshot is a negotiation waiting to
# happen, and it also gives away what the agency keeps. Target attainment is a
# different animal — it is progress against a goal that the agency handed the
# partner on purpose (owner E2/E3, 2026-08-06), and it says nothing whatsoever
# about the economics of a policy.
#
# Keep this list SHORT and keep the reason next to the entry. A new percentage
# that cannot be justified in one line is a rate wearing a different name.
ALLOWED_PERCENT_FIELDS = {
    # PortalTarget / PortalTargetMetric — "you are at 60% of your 10 policies".
    "attainment_pct",
}


def test_no_partner_facing_schema_carries_a_RATE():
    """Owner E1: rupees only, never a commission percentage.

    Target attainment is allow-listed above with its reason — everything else
    that reads as a percentage is a rate until somebody argues otherwise here.
    """
    offenders = []
    for name, obj in vars(portal_router).items():
        fields = getattr(obj, "model_fields", None)
        if not fields or not name.startswith("Portal"):
            continue
        for field in fields:
            if field in ALLOWED_PERCENT_FIELDS:
                continue
            if "percent" in field.lower() or "_pct" in field.lower():
                offenders.append(f"{name}.{field}")
    assert not offenders, (
        "A partner sees rupees, not rates: " + ", ".join(offenders)
        + ". If this is genuinely not a commission rate, add it to "
          "ALLOWED_PERCENT_FIELDS with the reason.")


def test_the_allow_listed_percentage_is_not_attached_to_money():
    """The carve-out must stay on the TARGET schemas.

    `attainment_pct` appearing on an earnings or policy schema would mean the
    exemption had drifted onto exactly the surface it was written to protect.
    """
    for name, obj in vars(portal_router).items():
        fields = getattr(obj, "model_fields", None)
        if not fields or not name.startswith("Portal"):
            continue
        if "attainment_pct" in fields:
            assert "Target" in name, (
                f"{name} carries attainment_pct but is not a target schema.")


def test_the_partner_never_sees_staff_chatter_or_staffing():
    """`internal_notes` and `assigned_to` are on the MODELS and must not be on
    the partner's schemas."""
    from app.models.claim import Claim
    from app.models.quote_request import QuoteRequest

    assert "internal_notes" in QuoteRequest.model_fields
    assert "internal_notes" in Claim.model_fields
    for schema in (portal_router.PortalQuoteDetail,
                   portal_router.PortalClaimDetail):
        for leaked in ("internal_notes", "assigned_to_id", "assigned_to_name",
                       "manager_id", "manager_name"):
            assert leaked not in schema.model_fields, (
                f"{schema.__name__} leaks {leaked}")


def test_a_partner_only_sees_a_discount_never(): # noqa: N802
    """A discount is house-borne and is not in the partner's number."""
    assert not any("discount" in f
                   for f in portal_router.PortalPolicyDetail.model_fields)


# --- 4. Scoping ------------------------------------------------------------------


def test_someone_elses_record_is_a_404_not_a_403():
    """A 403 confirms the record exists, which is itself a leak on a numbered
    resource."""
    for loader in (portal_router._own_policy, portal_router._own_quote,
                   portal_router._own_claim):
        src = _code(loader)
        assert "HTTP_404_NOT_FOUND" in src
        assert "str(actor.id)" in src


def test_a_notice_not_addressed_to_them_is_also_a_404():
    src = _code(portal_router.mark_notice_read)
    assert "HTTP_404_NOT_FOUND" in src
    assert "receipt is None" in src


def test_a_document_download_is_scoped_twice():
    """The policy must be theirs AND the document must belong to that policy.
    Either check alone lets a crafted id through."""
    src = _code(portal_router.download_my_policy_document)
    assert "_own_policy(actor" in src
    assert "doc.entity_id != str(pol.id)" in src


def test_a_renewal_quote_can_only_name_their_own_policy():
    src = _code(portal_router.raise_quote_request)
    assert "_own_policy(" in src


# --- The staff side ---------------------------------------------------------------


def test_the_quote_queue_never_books_a_policy():
    """Owner A3: the broker choice is what makes the reward right, and it is a
    human decision on the policy form. This endpoint only LINKS."""
    src = _code(quotes_router.mark_booked)
    assert "Policy(" not in src
    assert "quote_request_id" in src


def test_the_partner_earning_on_a_quote_is_typed_not_derived():
    """A figure this endpoint invented that the reward engine later disagreed
    with would be worse than no figure at all."""
    src = _code(quotes_router.send_quote)
    assert "payload.partner_earning" in src
    for forbidden in ("resolve_reward_terms", "compute_reward", "rate_rule"):
        assert forbidden not in src


def test_a_requote_replaces_rather_than_piling_up():
    """Owner B1: one option in practice. Two live prices for the same case is a
    conversation nobody wants."""
    assert "q.options = [option]" in _code(quotes_router.send_quote)


def test_a_claim_never_touches_the_ledger():
    """Owner C4. The money moves between the insurer and the customer."""
    src = inspect.getsource(claims_router)
    for forbidden in ("LedgerTxn", "record_ledger_txn", "book_policy_finance",
                      "PartyAccount", "wallet_svc"):
        assert forbidden not in src, (
            f"claims router references {forbidden} — a claim is information, "
            "not a money movement")


def test_the_broadcast_audience_is_frozen_at_send_time():
    """A notice sent to "everyone under Rahul" in August must still show the
    same people in November, or the read receipts stop meaning anything."""
    src = _code(ann_router.send_announcement)
    assert "receipts=[AnnouncementReceipt(" in src
    # Reading a notice never re-resolves the audience.
    assert "_resolve_audience" not in _code(portal_router.my_notices)


def test_a_broadcast_only_reaches_partners_who_can_actually_sign_in():
    src = _code(ann_router._resolve_audience)
    assert "'portal_access': True" in src
    assert "AccountStatus.ACTIVE.value" in src


def test_the_composer_shows_the_audience_before_it_is_sent():
    """A broadcast cannot be unsent."""
    paths = [getattr(r, "path", "") for r in app.routes]
    assert "/api/announcements/preview" in paths


def test_broadcasting_has_its_own_permission():
    """Owner D5: not a side effect of being able to add an employee."""
    from app.core.permissions import (
        ASSIGNABLE_PERMISSIONS, MANAGE_ANNOUNCEMENTS, VIEW_ANNOUNCEMENTS,
    )

    assert MANAGE_ANNOUNCEMENTS in ASSIGNABLE_PERMISSIONS
    assert VIEW_ANNOUNCEMENTS in ASSIGNABLE_PERMISSIONS


# --- Policy approval is gone -------------------------------------------------------


def test_policy_approval_stays_deleted():
    """It existed only because partners could submit. A pending state nothing
    can produce is a state that only ever confuses a filter."""
    with pytest.raises(ImportError):
        from app.core.enums import ApprovalStatus  # noqa: F401
    for dead in ("approval_status", "approved_by", "approved_at",
                 "rejection_reason"):
        assert dead not in Policy.model_fields
    assert "/api/policies/{policy_id}/approval" not in [
        getattr(r, "path", "") for r in app.routes]


def test_a_policy_can_point_back_at_the_enquiry_it_came_from():
    assert "quote_request_id" in Policy.model_fields


# --- Documents ---------------------------------------------------------------------


def test_the_new_document_types_were_added_explicitly():
    """`_ENTITY_TYPES` REFUSES anything not listed — that refusal is the point,
    so a new type is added by name rather than by loosening the check."""
    from app.routers.documents import _ENTITY_TYPES

    assert set(_ENTITY_TYPES) == {"policy", "customer", "quote_request", "claim"}


# --- Claim document checklists (owner C3) -------------------------------------


def test_a_policy_type_can_carry_its_own_claim_checklist():
    """Motor wants an FIR, photos and an estimate; health wants a discharge
    summary and bills. Same spec shape as the booking documents, configured on
    the same page — one mechanism, not two."""
    from app.models.master import PolicyCategory

    assert "claim_documents" in PolicyCategory.model_fields


def test_the_claim_checklist_survives_a_save():
    """It was on the MODEL and on nothing else for a while, so the Policy Types
    page had no way to set it and a PATCH would have dropped it silently —
    `model_dump(exclude_unset=True)` can only carry a field the schema declares.
    Both claim screens read this list, so an empty one renders as no checklist
    at all rather than as an error."""
    from app.schemas.master import (
        PolicyCategoryCreate, PolicyCategoryOut, PolicyCategoryUpdate,
    )

    for schema in (PolicyCategoryCreate, PolicyCategoryUpdate,
                   PolicyCategoryOut):
        assert "claim_documents" in schema.model_fields, (
            f"{schema.__name__} drops claim_documents")
