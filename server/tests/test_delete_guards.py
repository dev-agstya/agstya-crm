"""Delete is allowed or refused by the LINKS, never by who is asking.

The owner's rule (2026-07-26): every entity keeps its delete button. What
decides is whether anything points at the record. An insurer, broker or policy
type that nothing references is a typo someone should be able to clear up; one
that a policy names must be deactivated instead, because a policy stores only
`insurer_id` / `broker_id` / `category_key` and resolves the NAME when it
renders — delete the master row and every historic policy shows a blank column,
silently, with no error anywhere.

Records that BELONG to the thing being deleted are undone rather than treated as
blockers: a deleted policy reverses its wallet credit and ledger rows, a deleted
customer takes their documents with them.

These tests pin the guard, and the wording of the refusal — "used by 3 policies
and 1 rate card" tells someone what to do next, "cannot delete" does not.
"""

import inspect

import pytest
from fastapi.routing import APIRoute

from app.main import app
from app.services import references


# The six relational entities and the route that permanently removes one.
GUARDED_DELETES = [
    ("/api/insurers/{insurer_id}", "insurer"),
    ("/api/brokers/{broker_id}", "broker"),
    ("/api/policy-categories/{category_id}", "policy type"),
    ("/api/customers/{customer_id}", "customer"),
    ("/api/users/{user_id}", "staff account"),
]


def _delete_route(path: str) -> APIRoute:
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path == path \
                and "DELETE" in route.methods:
            return route
    raise AssertionError(f"DELETE {path} is not registered")


def _effective_source(fn) -> str:
    """The handler's source plus that of any helper in its own module that it
    calls — the users route does its checking in `_assert_deletable`, and a
    guard that only reads the handler body would miss it."""
    import sys

    src = inspect.getsource(fn)
    module = sys.modules[fn.__module__]
    for name, obj in vars(module).items():
        if name.startswith("_") and callable(obj) and f"{name}(" in src:
            try:
                src += "\n" + inspect.getsource(obj)
            except (OSError, TypeError):    # pragma: no cover
                pass
    return src


def _dependency_names(fn) -> set[str]:
    """Names of every callable the handler takes via Depends(...)."""
    names = set()
    for param in inspect.signature(fn).parameters.values():
        dep = getattr(param.default, "dependency", None)
        if dep is not None:
            names.add(getattr(dep, "__name__", ""))
    return names


# --- the button stays available to everyone who manages the entity --------------------


@pytest.mark.parametrize("path,_noun", GUARDED_DELETES)
def test_delete_is_not_restricted_by_account_type(path, _noun):
    """Deleting is gated on the usual manage-permission, not on being the owner.

    An earlier pass made these owner-only; the owner's rule is that anyone who
    can manage the entity can also clear up a mistake, and the reference check
    is what keeps that safe.
    """
    route = _delete_route(path)
    assert "require_owner" not in _dependency_names(route.endpoint)
    src = _effective_source(route.endpoint)
    assert "account_type" not in src or "AccountType.OWNER" not in src, (
        f"DELETE {path} still branches on account type")


@pytest.mark.parametrize("path,_noun", GUARDED_DELETES)
def test_every_delete_route_checks_references_first(path, _noun):
    """Owner-only is not enough: the owner must not be able to delete an
    insurer that fifty policies point at either."""
    src = _effective_source(_delete_route(path).endpoint)
    assert "references." in src, f"DELETE {path} does not check references"
    assert "409" in src or "HTTP_409_CONFLICT" in src, (
        f"DELETE {path} does not refuse with a conflict")


def test_the_delete_routes_answer_with_a_body():
    """Same class of bug as the ledger delete that 500d after succeeding."""
    for path, _ in GUARDED_DELETES:
        route = _delete_route(path)
        assert route.response_model is not None, f"DELETE {path} promises nothing"


# --- what counts as "in use" ----------------------------------------------------------


def test_nothing_pointing_at_it_means_not_in_use():
    assert references.in_use({"policies": 0, "rate_cards": 0}) is False
    assert references.in_use({}) is False


def test_a_single_reference_is_enough_to_block():
    assert references.in_use({"policies": 0, "rate_cards": 1}) is True
    assert references.in_use({"policies": 5}) is True


def test_every_entity_declares_the_relations_it_can_have():
    """A relation nobody counts is a hole. The counters hit the database, so
    this asserts on their source — which is the part that rots when a new
    foreign key is added and nobody updates the guard."""
    src = inspect.getsource(references)
    assert "Policy.insurer_id" in src and "RateRule.insurer_id" in src
    # A broker is the finance counterparty as well as the rate-card owner — the
    # old guard only looked at policies and would have let one be deleted with
    # live ledger rows against it.
    for needle in ("Policy.broker_id", "RateRule.broker_id",
                   "TdsEntry.broker_id", "LedgerTxn.party_type"):
        assert needle in src, f"broker_refs no longer counts {needle}"
    # Both "credited on" and "entered by" count for a person.
    assert '"partner_id"' in src and '"created_by"' in src


# --- the message someone actually reads -----------------------------------------------


def test_one_relation_reads_naturally():
    msg = references.blocked_message("insurer", {"policies": 1, "rate_cards": 0})
    assert "used by 1 policy." in msg
    assert "Deactivate it instead" in msg


def test_counts_are_pluralised():
    msg = references.blocked_message("insurer", {"policies": 3})
    assert "3 policies" in msg


def test_two_relations_are_joined_with_and():
    msg = references.blocked_message(
        "broker", {"policies": 3, "rate_cards": 1})
    assert "3 policies and 1 rate card" in msg


def test_three_relations_use_commas_then_and():
    msg = references.blocked_message(
        "broker", {"policies": 2, "rate_cards": 1, "transactions": 4})
    assert "2 policies, 1 rate card and 4 transactions" in msg


def test_empty_relations_are_left_out_entirely():
    msg = references.blocked_message(
        "broker", {"policies": 2, "rate_cards": 0, "tds_entries": 0})
    assert "rate card" not in msg
    assert "TDS" not in msg


def test_the_alternative_action_can_be_reworded_per_entity():
    # A customer is archived, not deactivated — the message has to say the right
    # thing or it sends someone hunting for a button that isn't there.
    msg = references.blocked_message("customer", {"policies": 1},
                                     alternative="Archive them instead")
    assert "Archive them instead" in msg
    assert "Deactivate" not in msg


def test_the_message_promises_nothing_is_lost():
    msg = references.blocked_message("broker", {"policies": 1})
    assert "keeps working" in msg


# --- the deactivate path stayed available ---------------------------------------------


def test_policy_type_deactivation_is_no_longer_hidden_behind_delete():
    """It used to be: DELETE /policy-categories/{id} set active=False. A verb
    that does something else is a trap for the next reader."""
    src = inspect.getsource(_delete_route(
        "/api/policy-categories/{category_id}").endpoint)
    assert "cat.active = False" not in src
    assert "await cat.delete()" in src


def test_customer_delete_no_longer_silently_archives():
    src = inspect.getsource(_delete_route("/api/customers/{customer_id}").endpoint)
    assert "is_archived = True" not in src


def test_the_archive_and_status_routes_still_exist():
    """Deactivating must remain reachable — it is now the primary action."""
    paths = {(r.path, tuple(sorted(r.methods))) for r in app.routes
             if isinstance(r, APIRoute)}
    flat = {p for p, _ in paths}
    assert "/api/customers/{customer_id}/archive" in flat
    assert "/api/users/{user_id}/status" in flat
    # Insurers / brokers / policy types deactivate through their PATCH update.
    for p in ("/api/insurers/{insurer_id}", "/api/brokers/{broker_id}",
              "/api/policy-categories/{category_id}"):
        assert any(path == p and "PATCH" in methods for path, methods in paths), \
            f"{p} has no PATCH to deactivate through"

# --- what is undone rather than blocking ----------------------------------------------
#
# Some records BELONG to the thing being deleted. Blocking on those would mean a
# customer added by mistake off the back of a lead could never be tidied away —
# so they are cleaned up instead, and the delete goes ahead.


def _code_only(fn) -> str:
    """The function's body with its docstring removed — these assertions are
    about what the code DOES, and the docstring here names the very things it
    must not be counting."""
    import ast
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    body = tree.body[0].body
    if body and isinstance(body[0], ast.Expr) \
            and isinstance(body[0].value, ast.Constant):
        body = body[1:]
    return "\n".join(ast.unparse(node) for node in body)


def test_a_customer_is_blocked_only_by_policies_and_money():
    src = _code_only(references.customer_refs)
    assert "Policy.customer_id" in src
    assert "LedgerTxn" in src
    # Their documents and the lead they converted from must NOT be blockers.
    assert "converted_customer_id" not in src
    assert "DocumentRecord" not in src


def test_deleting_a_customer_cleans_up_what_they_own():
    """Otherwise the S3 objects leak and a lead keeps claiming it converted into
    someone who no longer exists."""
    src = inspect.getsource(
        _delete_route("/api/customers/{customer_id}").endpoint)
    assert "DocumentRecord" in src and "s3.delete_object" in src
    assert "DocumentRequest" in src
    assert "converted_customer_id = None" in src


def test_deleting_a_policy_reverses_its_money():
    """The owner's "relational undo": a deleted policy must not leave a partner
    credited, a party balance wrong, or a TDS entry in the report."""
    src = inspect.getsource(_delete_route("/api/policies/{policy_id}").endpoint)
    for needle in ("reverse_reward",              # partner wallet credit back
                   "PolicyFinance",               # P&L snapshot
                   "TdsEntry",                    # TDS report
                   "LedgerTxn",                   # cash rows
                   "recompute_party_account"):    # balances re-derived after
        assert needle in src, f"policy delete no longer handles {needle}"


def test_policy_delete_recomputes_every_balance_it_touched():
    """Deleting the rows is not enough — a party account is a running total, so
    each affected party has to be re-derived or the balance silently drifts."""
    src = inspect.getsource(_delete_route("/api/policies/{policy_id}").endpoint)
    assert "impacted" in src
    assert src.index("await t.delete()") < src.index("recompute_party_account")
