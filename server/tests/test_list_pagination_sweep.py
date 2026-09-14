"""Pagination added to the lists that kept handing the browser a whole
collection (owner 2026-09-12: "on entire website, where the data rows are to
be exceeding 25, just add pagination, better").

The Balance Sheet roster (`test_balance_sheet_pagination.py`) was the first of
these and is a Python-side aggregation that has to search/sort the WHOLE
section before slicing (see its own docstring). Every endpoint here is a
plain Mongo query instead, so the count/sort/skip/limit all run at the
database — there is no in-memory `list_section_page` equivalent to test, so
these are `inspect.getsource` checks that the router actually asks the
database to skip/limit/count rather than pulling everything into memory and
slicing in Python (which would defeat the point: page 5 would still cost what
page 1 costs).

Same house style as `test_balance_sheet_pagination.py` and
`test_money_corrections.py` — no live DB fixture harness in this repo, so the
routers are inspected rather than exercised end to end.
"""

from __future__ import annotations

import inspect
import typing

from app.routers import attendance as attendance_router
from app.routers import leave as leave_router
from app.routers import payslips as payslips_router
from app.routers import policy_access as policy_access_router


def _default_of(param: inspect.Parameter):
    """A FastAPI `Query(...)` default, or a plain default -- either way, the
    actual value the parameter falls back to."""
    d = param.default
    return getattr(d, "default", d)


def _assert_paged(fn, *, needs_sort: bool = True) -> None:
    source = inspect.getsource(fn)
    sig = inspect.signature(fn)
    hints = typing.get_type_hints(fn)

    assert "page" in sig.parameters, f"{fn.__name__} takes no page parameter"
    assert "page_size" in sig.parameters, (
        f"{fn.__name__} takes no page_size parameter")
    assert _default_of(sig.parameters["page_size"]) == 25, (
        f"{fn.__name__} must default page_size to 25, matching the rest of "
        "the app (owner 2026-09-12)")

    ret = hints.get("return")
    assert ret is not None and "Page" in str(ret), (
        f"{fn.__name__} must return a Page[...], not a bare list — a bare "
        "list is exactly the shape this sweep is removing")

    # The count must run over the WHOLE (filtered) query, never just the
    # page — that is what makes `total` honest and `Pagination` draw the
    # right number of page buttons.
    assert ".count()" in source, (
        f"{fn.__name__} must count the whole filtered query, not the page")
    assert ".skip(" in source and ".limit(" in source, (
        f"{fn.__name__} must page at the database with skip()/limit(), not "
        "by fetching everything and slicing in Python")
    if needs_sort:
        assert ".sort(" in source, (
            f"{fn.__name__} must keep an explicit sort — pagination with no "
            "stable order makes \"page 2\" meaningless")


def test_policy_access_queue_is_paged():
    _assert_paged(policy_access_router.list_requests)


def test_attendance_corrections_queue_is_paged():
    _assert_paged(attendance_router.list_corrections)


def test_leave_requests_are_paged():
    _assert_paged(leave_router.list_requests)


def test_payslip_history_is_paged():
    _assert_paged(payslips_router.list_payslips)


def test_leave_ledger_is_paged():
    """The ledger is built from `hr_leave.ledger_rows` (already a full leave
    year in memory — that IS the sum the balance is derived from) and then
    sliced, the same shape as `list_section_page` for the Balance Sheet. So
    this one is checked for the slice rather than skip()/limit()."""
    source = inspect.getsource(leave_router.ledger)
    sig = inspect.signature(leave_router.ledger)
    hints = typing.get_type_hints(leave_router.ledger)

    assert "page" in sig.parameters and "page_size" in sig.parameters
    assert _default_of(sig.parameters["page_size"]) == 25
    ret = hints.get("return")
    assert ret is not None and "Page" in str(ret)
    assert "start = (page - 1) * page_size" in source
    assert "total = len(rows)" in source


def test_none_of_these_widen_the_finance_find_all_pattern():
    """None of these five endpoints are finance reads — CLAUDE.md's rule is
    specifically about the `find_all()` aggregation pattern in
    `services/finance_*`. Confirms none of them import from there."""
    for mod in (attendance_router, leave_router, payslips_router,
                policy_access_router):
        source = inspect.getsource(mod)
        assert "finance_balance" not in source
        assert "services.finance" not in source


def test_pagination_does_not_change_the_page_1_default():
    """A client that forgets `page` must still land on page 1, not an error
    or an empty response — the same "safe default" rule this codebase already
    applies to `mine` on these same endpoints."""
    for fn in (policy_access_router.list_requests,
               attendance_router.list_corrections,
               leave_router.list_requests, leave_router.ledger,
               payslips_router.list_payslips):
        sig = inspect.signature(fn)
        assert _default_of(sig.parameters["page"]) == 1
