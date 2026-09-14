"""Audit summaries must show names, never a raw Mongo ObjectId (2026-09-12).

`diff_dict()` + `describe_changes()` build the one-line audit summary from
whatever raw values sit on the model being edited — so "relationship manager
id 6a6657e6... -> 6a87f0bd..." was never a bug in the audit page, it was a
bug in the audit SERVICE: any field holding another record's id would read
the same way, on every router that calls it. The fix is one resolver
(`services.audit._REF_FIELDS` + `resolve_ref_changes`), applied through
`diff_dict_async`, which every writer of an audit diff must go through.
"""

from __future__ import annotations

import inspect

from app.routers import banks as banks_router
from app.routers import customers as customers_router
from app.routers import finance as finance_router
from app.routers import policies as policies_router
from app.routers import users as users_router
from app.services import audit as audit_svc


# --- the resolver itself -----------------------------------------------------


def test_resolve_ref_changes_ignores_fields_it_does_not_know_about():
    changes = {"full_name": {"from": "A", "to": "B"}}
    import asyncio
    out = asyncio.run(audit_svc.resolve_ref_changes(dict(changes)))
    assert out == changes


def test_resolve_ref_changes_leaves_empty_or_redacted_sides_alone():
    """A field that went from unset to set (or is a redacted PII field that
    slipped in) must not be sent to the resolver at all — there is nothing to
    look up, and an empty string is not a valid ObjectId anyway."""
    import asyncio
    changes = {
        "broker_id": {"from": None, "to": None},
        "pan": {"from": "•••", "to": "•••"},
    }
    out = asyncio.run(audit_svc.resolve_ref_changes(dict(changes)))
    assert out["broker_id"] == {"from": None, "to": None}
    assert out["pan"] == {"from": "•••", "to": "•••"}


def test_resolve_ref_falls_back_to_deleted_record_not_the_raw_id():
    """A reference id that no longer resolves (bad format, or genuinely
    deleted) must never leak the raw string back into the audit trail — that
    would silently reopen the exact bug this fix exists for."""
    import asyncio

    async def run():
        # Not a valid ObjectId at all -- must not raise, must not echo it back.
        return await audit_svc._resolve_ref("user", "not-an-object-id")

    assert asyncio.run(run()) is None  # caller (resolve_ref_changes) maps
    # None -> "Deleted record"; this only tests the id doesn't come back raw.


def test_every_ref_field_maps_to_a_known_kind():
    """Every entry in the registry must dispatch somewhere in `_resolve_ref` —
    a field pointing at an unhandled kind would silently return None for
    everyone and turn every one of its changes into "Deleted record", forever."""
    known_kinds = {
        "user", "broker", "insurer", "policy_category", "customer",
        "bank_account",
    }
    for field, kind in audit_svc._REF_FIELDS.items():
        assert kind in known_kinds, f"{field} maps to unhandled kind {kind!r}"


# --- every writer of an audit diff goes through the resolving version -------


_CALL_SITES = [
    (customers_router, "update_customer"),
    (users_router, "update_user"),
    (finance_router, None),   # inline in edit_ledger_txn; source-scanned below
    (banks_router, None),     # inline in update_bank_account
    (policies_router, None),  # inline in update_policy
]


def test_routers_call_the_resolving_diff_not_the_raw_one():
    """`diff_dict` (no resolver) must not be called directly from a router —
    that is exactly how "relationship manager id X -> Y" got into the audit
    trail in the first place. Every router that diffs a record for audit must
    call `diff_dict_async`, the one place the reference registry is applied."""
    for module in (customers_router, users_router, finance_router,
                   banks_router, policies_router):
        source = inspect.getsource(module)
        assert "diff_dict_async(" in source, (
            f"{module.__name__} builds an audit diff but never calls "
            "diff_dict_async — it will embed raw ids again")
        # A bare `diff_dict(` call (not `diff_dict_async(`) means someone is
        # bypassing the resolver.
        bare_calls = [
            line for line in source.splitlines()
            if "diff_dict(" in line and "diff_dict_async(" not in line
        ]
        assert not bare_calls, (
            f"{module.__name__} still calls the non-resolving diff_dict(): "
            f"{bare_calls}")


def test_users_audit_snapshot_relationship_manager_goes_through_the_resolver():
    """The exact example from the bug report: reassigning a channel partner's
    relationship manager must produce a name-resolved summary, not an id."""
    source = inspect.getsource(users_router)
    assert "relationship_manager_id" in inspect.getsource(
        users_router._user_audit_snapshot)
    # And the diff built from that snapshot is the resolving one.
    assert "diff_dict_async(before, _user_audit_snapshot(target))" in source
