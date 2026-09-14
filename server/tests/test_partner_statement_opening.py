"""A partner statement's opening balance comes from the ledger printed under it.

THE BUG (2026-08-21). `finance_balance.partner_statement()` ended with:

    "opening_balance": opening_net,

and `opening_net` did not exist in that function. It had been a local, and it
left when `partner_ledger()` was extracted so the statement PDF and the business
report's partner-ledger sheet would be the same ledger — the extraction took the
opening-balance netting with it and this one line was never updated.

So EVERY channel-partner statement raised a NameError. Nothing caught it: the
line only runs when a statement is actually built, and the suite tests the
statement's HELPERS (see test_partner_statement.py) rather than the builder.

THE FIX, AND WHY IT IS THIS ONE. The opening is taken off the combined ledger
the statement already renders (`combined["opening"]`) instead of being computed
a second time. A statement whose headline opening balance disagrees with the
running balance on its own first transaction row is the single worst thing this
file can produce — the partner and the agency reading different numbers for the
same relationship. Sourcing both from one call makes that disagreement
impossible rather than merely unlikely.

These tests build the statement with the data layer faked out, so they assert
the WIRING — that the number on the statement is the number from the ledger —
which is precisely what was broken.
"""

from __future__ import annotations

import pytest

from app.services import finance_balance as fb


# --- Fakes ------------------------------------------------------------------------


class _AsyncEmpty:
    """A Beanie find() result that yields nothing.

    `partner_statement` consumes these with `async for`, and several of them are
    also awaited via `.to_list()`, so both shapes are provided.
    """

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    async def to_list(self):
        return []


async def _none(*_args, **_kwargs):
    return None


def _empty_find(*_args, **_kwargs):
    return _AsyncEmpty()


class _StubModel:
    """Stands in for a Beanie Document without initialising Beanie.

    The statement builds its queries from class attributes
    (`Reward.partner_id == partner_id`), and on a real Document those only
    resolve once `init_beanie` has run. `__getattr__` answers any field name with
    its own name, which is all these queries need — they are never executed,
    because every `find` here returns nothing.
    """

    class _Meta(type):
        def __getattr__(cls, item):
            return item

    @classmethod
    def find(cls, *_a, **_k):
        return _AsyncEmpty()

    @classmethod
    def find_all(cls, *_a, **_k):
        return _AsyncEmpty()

    @classmethod
    async def find_one(cls, *_a, **_k):
        return None

    @classmethod
    async def get(cls, *_a, **_k):
        return None


class _Stub(_StubModel, metaclass=_StubModel._Meta):
    pass


# The ledger the statement is built around. Opening is deliberately a value that
# could not be arrived at by accident: a NON-ZERO number, of the sign that means
# "the agency owes the partner", with credits and debits that do not sum to it.
LEDGER = {
    "rows": [],
    "opening": 125_00,          # paise — Rs 125 in the partner's favour
    "total_credit": 40_00,
    "total_debit": 15_00,
    "closing": 150_00,
}


@pytest.fixture()
def statement(monkeypatch):
    """`partner_statement` with every read faked, returning a builder to call."""
    monkeypatch.setattr(fb, "_oid", lambda value: None)   # so User.get is skipped
    for name in ("Customer", "Insurer", "Policy", "Reward", "PartyAccount",
                 "Wallet", "User"):
        monkeypatch.setattr(fb, name, _Stub)
    monkeypatch.setattr(fb, "_finance_for", lambda policies: _AsyncEmpty())

    async def _empty_dict():
        return {}
    monkeypatch.setattr(fb, "_cat_index", _empty_dict)
    monkeypatch.setattr(fb, "_cat_labels", _empty_dict)

    calls: list[tuple] = []

    async def _fake_ledger(partner_id, lo, hi, policy_codes=None):
        calls.append((partner_id, lo, hi))
        return dict(LEDGER)

    monkeypatch.setattr(fb, "partner_ledger", _fake_ledger)

    async def _build(partner_id="partner-1", lo=None, hi=None):
        return await fb.partner_statement(partner_id, lo, hi)

    _build.calls = calls
    return _build


# --- The regression ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_building_a_partner_statement_does_not_raise(statement):
    """The bug itself: this raised NameError for every partner, every time."""
    data = await statement()
    assert data["kind"] == "partner"


@pytest.mark.asyncio
async def test_opening_balance_is_the_ledgers_opening(statement):
    """The headline figure IS the ledger's, not a second calculation."""
    data = await statement()
    assert data["opening_balance"] == LEDGER["opening"]


@pytest.mark.asyncio
async def test_opening_balance_matches_the_ledger_printed_below_it(statement):
    """The two must be the same object's answer — that is the whole fix.

    A statement is handed to a channel partner. If its opening balance and the
    opening of the transaction table underneath it disagree, the partner and the
    agency are reading different numbers for the same relationship.
    """
    data = await statement()
    assert data["opening_balance"] == data["combined_account"]["opening"]


@pytest.mark.asyncio
async def test_a_partner_in_debit_keeps_its_sign(statement, monkeypatch):
    """Not defaulted to zero, and not made positive.

    `?? 0` on a money figure is banned in this app for exactly this reason: a
    zero is a claim, and "you owe us Rs 300" must not be able to render as
    "nothing outstanding".
    """
    async def _debit_ledger(partner_id, lo, hi, policy_codes=None):
        return {**LEDGER, "opening": -300_00}
    monkeypatch.setattr(fb, "partner_ledger", _debit_ledger)

    data = await statement()
    assert data["opening_balance"] == -300_00


@pytest.mark.asyncio
async def test_the_window_reaches_the_ledger(statement):
    """The opening is as-at the window START, so the bounds must be passed on.

    Sourcing the figure from `combined` is only correct while the ledger is
    asked for the same period as the statement.
    """
    from datetime import datetime, timezone
    lo = datetime(2026, 4, 1, tzinfo=timezone.utc)
    hi = datetime(2026, 6, 30, tzinfo=timezone.utc)
    await statement(lo=lo, hi=hi)
    assert statement.calls[-1] == ("partner-1", lo, hi)


@pytest.mark.asyncio
async def test_the_live_closing_positions_are_still_reported(statement):
    """Guards against "fixing" the opening by dropping what sits beside it.

    Closing positions are LIVE (they must tie to today's Balance Sheet), not the
    window's arithmetic — a separate rule from the opening, and still in force.
    """
    data = await statement()
    for key in ("premium_balance", "reward_owed", "reward_available",
                "net_balance"):
        assert key in data, key
