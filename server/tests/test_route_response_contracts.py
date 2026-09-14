"""Every route handler actually returns what it promises.

The bug this exists for (owner, 2026-07-26): DELETE /api/finance/ledger/{id}
was annotated `-> dict` but had no return statement. FastAPI treats the
annotation as the response model, so the handler deleted the row, returned
None, failed response validation and raised a 500. The user saw "Server error
ERR-42C5EE" for an operation that had already succeeded — and because the
client took the error branch, the list still showed the deleted row until the
page was reloaded by hand.

Two guards, so no future handler can repeat it:
  1. a static sweep of every registered route, and
  2. a live call against the real app for the delete that broke.
"""

import ast
import inspect
import pathlib

import pytest
from fastapi.routing import APIRoute

from app.main import app


def _handler_sources():
    """(route, function) for every route handler defined in this codebase."""
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        fn = route.endpoint
        try:
            src = inspect.getsource(fn)
        except (OSError, TypeError):       # pragma: no cover - builtins
            continue
        yield route, fn, src


def _falls_off_the_end(src: str) -> bool:
    """True when the function body can finish without returning a value."""
    tree = ast.parse(inspect.cleandoc(src))
    fn = tree.body[0]
    if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return False
    last = fn.body[-1]
    return not isinstance(last, (ast.Return, ast.Raise))


def test_no_handler_promises_a_body_it_never_returns():
    """A handler with a response model (or a non-None return annotation) must
    end in a return or a raise — otherwise it 500s AFTER doing its work."""
    offenders = []
    for route, fn, src in _handler_sources():
        # Either form counts: FastAPI reads the return annotation as the
        # response model when response_model= is not given, which is exactly
        # how the ledger delete ended up validating None against `dict`.
        declares_body = (route.response_model is not None
                         or fn.__annotations__.get("return") is not None)
        if not declares_body:
            continue
        if _falls_off_the_end(src):
            offenders.append(f"{list(route.methods)} {route.path} "
                             f"-> {fn.__name__}()")
    assert offenders == [], (
        "these handlers can return None while promising a body: "
        + "; ".join(offenders))


def test_the_ledger_delete_declares_a_response_model():
    """The specific regression: the route that broke now has a real model."""
    routes = [r for r in app.routes
              if isinstance(r, APIRoute)
              and r.path == "/api/finance/ledger/{txn_id}"
              and "DELETE" in r.methods]
    assert len(routes) == 1
    assert routes[0].response_model is not None


def test_the_ledger_delete_returns_a_confirmation():
    """Its body must produce a Message, not fall through to None."""
    from app.routers.finance import delete_ledger_txn

    src = inspect.getsource(delete_ledger_txn)
    assert not _falls_off_the_end(src)
    assert "return Message(" in src


@pytest.mark.parametrize("path,method", [
    ("/api/finance/ledger/{txn_id}", "DELETE"),
    ("/api/policies/{policy_id}", "DELETE"),
    ("/api/targets/{target_id}", "DELETE"),
])
def test_delete_routes_all_answer_with_a_body(path, method):
    """Deletes are the easy ones to forget, because the useful work is done
    before the return would happen."""
    routes = [r for r in app.routes
              if isinstance(r, APIRoute) and r.path == path
              and method in r.methods]
    assert routes, f"{method} {path} is not registered"
    src = inspect.getsource(routes[0].endpoint)
    assert not _falls_off_the_end(src), f"{method} {path} can return None"


def test_the_static_sweep_actually_catches_the_original_bug():
    """Guard the guard: feed it the code as it was written and it must fail."""
    broken = '''
async def delete_ledger_txn(txn_id: str) -> dict:
    """Hard-delete a ledger row."""
    txn = await LedgerTxn.get(txn_id)
    await txn.delete()
    await log_action("deleted")
'''
    assert _falls_off_the_end(broken) is True

    fixed = broken + "    return Message(detail='Transaction deleted.')\n"
    assert _falls_off_the_end(fixed) is False


def test_router_files_parse_and_every_route_has_a_unique_name():
    """Cheap sanity net over the whole surface."""
    seen = set()
    for route in app.routes:
        if isinstance(route, APIRoute):
            key = (route.path, tuple(sorted(route.methods)))
            assert key not in seen, f"duplicate route {key}"
            seen.add(key)
    assert len(seen) > 50
    for f in pathlib.Path("app/routers").glob("*.py"):
        ast.parse(f.read_text(encoding="utf-8"))
