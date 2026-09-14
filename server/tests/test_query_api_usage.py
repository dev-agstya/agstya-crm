"""Queries call methods that actually exist on the object they're called on.

The bug this exists for (2026-07-26, ERR-F74F0D / ERR-F42A41): the reference
counters were written as

    await LedgerTxn.find(LedgerTxn.party_type == PartyType.BROKER)
                   .distinct("party_id")

Beanie puts `distinct` on the DOCUMENT class, taking a filter mapping — a
find() query object has no such method. So this raised AttributeError at request
time and took the whole Brokers list down with it; the page rendered no brokers
at all. The People lists were about to break the same way.

It got through because every other guard in this suite is static and the test
suite has no database, so nothing ever executed the query layer. These tests
close that specific gap: they check the SHAPE of every ODM call against what the
installed Beanie actually provides, which needs no database at all.
"""

import ast
import inspect
import pathlib

import pytest
from beanie import Document
from beanie.odm.queries.find import FindMany

from app.models.finance import LedgerTxn, PolicyFinance, TdsEntry
from app.models.lead import Lead
from app.models.policy import Policy
from app.models.rate_rule import RateRule
from app.models.wallet import WalletTxn
from app.services import references

APP = pathlib.Path("app")

# Methods Beanie exposes on the Document CLASS but not on a find() query. Calling
# one of these on a query object is the mistake above.
CLASS_ONLY = {"distinct"}


def test_beanie_still_puts_distinct_where_we_think_it_does():
    """Guard the premise. If a Beanie upgrade moves `distinct` onto FindMany,
    this fails and the rule below can be relaxed on purpose rather than by
    accident."""
    assert hasattr(Document, "distinct")
    assert not hasattr(FindMany, "distinct")


@pytest.mark.parametrize("model", [Policy, RateRule, TdsEntry, LedgerTxn,
                                   Lead, WalletTxn, PolicyFinance])
def test_every_model_the_counters_use_supports_distinct(model):
    """The counters call Model.distinct(...) directly on these seven."""
    assert callable(getattr(model, "distinct", None)), \
        f"{model.__name__}.distinct is gone"


def _class_only_calls_on_queries(path: pathlib.Path) -> list[str]:
    """Find `<something>.find(...).distinct(...)` — a class-only method invoked
    on the result of a call rather than on a class name."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    bad: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if not isinstance(fn, ast.Attribute) or fn.attr not in CLASS_ONLY:
            continue
        # Receiver is itself a call => a query object, not a Document class.
        if isinstance(fn.value, ast.Call):
            bad.append(f"{path}:{node.lineno}  .{fn.attr}() on a query result")
    return bad


def test_no_class_only_method_is_called_on_a_query_object():
    offenders: list[str] = []
    for path in APP.rglob("*.py"):
        offenders.extend(_class_only_calls_on_queries(path))
    assert offenders == [], (
        "these call a Document-class method on a find() result, which raises "
        "AttributeError at request time: " + "; ".join(offenders))


def test_the_detector_fires_on_the_code_that_broke(tmp_path):
    """Guard the guard: a rule that matches nothing always passes."""
    broken = tmp_path / "broken.py"
    broken.write_text(
        "async def f():\n"
        "    return await LedgerTxn.find(LedgerTxn.party_type == x)"
        ".distinct('party_id')\n",
        encoding="utf-8")
    assert _class_only_calls_on_queries(broken), "detector missed the real bug"

    fixed = tmp_path / "fixed.py"
    fixed.write_text(
        "async def f():\n"
        "    return await LedgerTxn.distinct('party_id', {'party_type': x})\n",
        encoding="utf-8")
    assert _class_only_calls_on_queries(fixed) == []


def test_ledger_lookups_go_through_the_one_helper():
    """Three call sites needed this; one wrapper means they can't diverge."""
    src = inspect.getsource(references)
    assert "async def _ledger_party_ids" in src
    for fn in (references.brokers_in_use, references.users_in_use,
               references.customers_in_use):
        body = inspect.getsource(fn)
        assert "_ledger_party_ids(" in body, f"{fn.__name__} rolled its own"
        assert ".find(" not in body, f"{fn.__name__} builds a query inline again"


def test_the_helper_filters_by_the_stored_value_not_the_enum_object():
    """PartyType is a str-Enum, but the filter goes to Mongo as a raw document —
    pass `.value` so it matches what is actually stored."""
    src = inspect.getsource(references._ledger_party_ids)
    assert "party_type.value" in src


@pytest.mark.parametrize("fn_name", [
    "insurers_in_use", "brokers_in_use", "policy_types_in_use",
    "users_in_use", "customers_in_use",
])
def test_bulk_lookups_short_circuit_on_an_empty_page(fn_name):
    """An empty list must not fan out into a handful of collection scans."""
    src = inspect.getsource(getattr(references, fn_name))
    assert "if not wanted:" in src
    assert "return set()" in src


# --- Single-entity finance reads are SCOPED, not scanned -------------------------
#
# Added 2026-08-07 (SUG-01). The three balance-sheet detail panels and the three
# statement builders each did:
#
#     policies = {str(p.id): p async for p in Policy.find({"broker_id": ...})}
#     async for pf in PolicyFinance.find_all():        # <- every row in the DB
#         pol = policies.get(pf.policy_id)
#         if pol is None: continue                     # <- throw most of them away
#
# which hydrates the whole PolicyFinance collection to keep one party's slice of
# it. CLAUDE.md calls this "the free win" and the fix is behaviour-preserving:
# `{"policy_id": {"$in": list(policies)}}` returns precisely the rows the loop
# kept. These tests fail if a seventh one is written the old way, or if one of
# the six regresses.

def test_the_six_single_entity_reads_scope_by_policy_id():
    from app.services import finance_balance

    src = inspect.getsource(finance_balance)
    assert "async for pf in PolicyFinance.find_all():" not in src, (
        "a single-entity finance read is scanning the whole PolicyFinance "
        "collection again — use _finance_for(policies)")
    assert src.count("async for pf in _finance_for(policies):") == 6


def test_the_scoping_helper_uses_in_on_policy_id():
    from app.services import finance_balance

    src = inspect.getsource(finance_balance._finance_for)
    assert '"policy_id": {"$in": list(policies)}' in src


def test_the_whole_collection_reads_that_remain_are_the_cross_party_lists():
    """_list_brokers / _list_partners / _list_customers aggregate across EVERY
    party, so they legitimately read everything. Exactly three, and no more —
    if this count rises somebody widened the find_all pattern, which CLAUDE.md
    forbids."""
    from app.services import finance_balance

    src = inspect.getsource(finance_balance)
    assert src.count("PolicyFinance.find_all().to_list()") == 3
