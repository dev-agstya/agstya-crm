"""Balance Sheet roster pagination (owner 2026-09-12).

The left-hand broker/partner/customer list used to hand the browser the
WHOLE section in one response and let the page filter/sort/slice it in
memory. The owner asked for real 25-per-page pagination, which means the
server has to do the searching, sorting AND slicing — a client that only
ever sees page 1 cannot search or sort across page 2 onward itself.

`list_section` still computes every row's money for the whole section in one
pass (see its own docstring: that cost is unavoidable without a larger
finance-read-path rework, and CLAUDE.md is explicit that this app must never
widen the find_all() pattern). `list_section_page` is the thin slice on top
that the router actually serves.
"""

from __future__ import annotations

import asyncio
import inspect

from app.routers import finance as finance_router
from app.services import finance_balance


def _rows(n: int) -> list[dict]:
    return [{"id": str(i), "label": f"Party {i}", "code": f"P-{i:03d}",
             "net_balance": i, "profit": -i, "premium": i, "earnings": i,
             "policies": 1} for i in range(n)]


def test_list_section_page_slices_and_reports_the_true_total(monkeypatch):
    async def fake_list_section(section, lo, hi, sort, *, q=None,
                                order="desc"):
        rows = _rows(60)
        rows.sort(key=lambda r: r[sort], reverse=(order != "asc"))
        return rows

    monkeypatch.setattr(finance_balance, "list_section", fake_list_section)

    rows, total = asyncio.run(finance_balance.list_section_page(
        "broker", None, None, "net_balance", page=2, page_size=25))

    assert total == 60
    assert len(rows) == 25
    # Descending net_balance: page 1 is 59..35, page 2 is 34..10.
    assert rows[0]["id"] == "34"
    assert rows[-1]["id"] == "10"


def test_list_section_page_last_page_is_a_partial_page(monkeypatch):
    async def fake_list_section(section, lo, hi, sort, *, q=None,
                                order="desc"):
        return _rows(60)

    monkeypatch.setattr(finance_balance, "list_section", fake_list_section)

    rows, total = asyncio.run(finance_balance.list_section_page(
        "broker", None, None, "net_balance", page=3, page_size=25))
    assert total == 60
    assert len(rows) == 10          # 60 - 25 - 25


def test_search_is_applied_before_pagination_not_after(monkeypatch):
    """Filtering AFTER slicing would make "page 2" mean something different
    depending on the search box — the search has to narrow the whole set
    first, then page 25-at-a-time over what's left."""
    async def fake_list_section(section, lo, hi, sort, *, q=None,
                                order="desc"):
        rows = _rows(60)
        if q:
            rows = [r for r in rows if q in r["label"]]
        return rows

    monkeypatch.setattr(finance_balance, "list_section", fake_list_section)

    rows, total = asyncio.run(finance_balance.list_section_page(
        "broker", None, None, "net_balance", q="Party 5", page=1,
        page_size=25))
    # "Party 5", "Party 50".."Party 59" -> 11 matches, one page.
    assert total == 11
    assert len(rows) == 11


# --- the router actually returns a Page, not a bare list --------------------


def test_router_returns_a_paged_response_not_a_bare_list():
    source = inspect.getsource(finance_router.balance_sheet_list)
    sig = inspect.signature(finance_router.balance_sheet_list)
    assert "page" in sig.parameters and "page_size" in sig.parameters
    assert "list_section_page" in source, (
        "balance_sheet_list must call list_section_page, not the "
        "unpaginated list_section — serving the whole section defeats the "
        "point of adding pagination")


def test_router_response_model_is_a_page():
    import typing
    hint = typing.get_type_hints(finance_router.balance_sheet_list)
    ret = hint.get("return")
    assert ret is not None and "Page" in str(ret)
