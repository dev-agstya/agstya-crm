"""No module in app/ may reference a name that does not exist.

THE BUG THIS PINS (2026-08-21). The owner created the first employee account,
logged in with the emailed credentials, finished onboarding, landed on the
dashboard and got a 500 — with an error email reading:

    GET /api/reports/dashboard
    NameError: name 'can_any' is not defined

`routers/reports.py` called `can_any(...)` and imported only `can`. What made it
survive months of use is the shape of the line it was on:

    can_finance = (can(actor, MANAGE_TRANSACTIONS)
                   or can_any(actor, *FINANCE_VIEW_ANY))

`or` SHORT-CIRCUITS. For an owner the left side is True, so the right side is
never evaluated and the missing name never matters. For anybody without
`manage_transactions` — which is every fresh employee — Python evaluates it and
raises. The bug was invisible to the only account that had ever opened the page,
and fired on the first login of the first employee, on the screen they land on
after onboarding.

That is the general lesson, and why this file sweeps rather than asserting one
import: **a name inside a permission branch is only executed by the accounts
that fail the check.** Owner-first testing cannot reach it, and neither can a
test suite built from fakes.

The same sweep found THREE more, all live, all reachable only on paths the owner
does not take:

  * routers/policies.py — `Optional`, in the `PolicyNumberCheck` model. Pydantic
    could not finish building the class, so GET /api/policies/number-available
    (the live "is this policy number taken?" check on the booking form) raised
    on every single call.
  * routers/system.py — `QuoteRequest`, in the owner-only health strip.
  * services/finance_balance.py — `opening_net`, a local left behind when
    `partner_ledger()` was extracted. EVERY channel-partner statement PDF raised.

All four shipped past a suite of 985 passing tests, because that suite is static
AST sweeps and monkeypatched fakes — thorough about rules, and blind to whether
the modules' names resolve at all. This closes that gap for good.

Only UNDEFINED NAMES are enforced. Unused imports and the rest of pyflakes'
output are style, they churn, and a test that fails on style is a test people
learn to ignore.
"""

from __future__ import annotations

import pathlib

import pytest

pyflakes_api = pytest.importorskip(
    "pyflakes.api",
    reason="pyflakes is a pinned test dependency — see requirements.txt")
from pyflakes import reporter as pyflakes_reporter  # noqa: E402


APP = pathlib.Path(__file__).resolve().parents[1] / "app"


class _Collector:
    """Captures pyflakes messages instead of printing them.

    pyflakes reports through a writer-shaped object, so this only needs the two
    streams it writes to. A syntax error goes to `stderr` and is a hard failure
    of its own — a module that does not parse is worse than one with a bad name.
    """

    def __init__(self):
        self.out: list[str] = []
        self.err: list[str] = []

    def write(self, text: str) -> None:      # pragma: no cover - stream shim
        self.out.append(text)

    def flush(self) -> None:                 # pragma: no cover - stream shim
        pass


def _sweep() -> tuple[list[str], list[str]]:
    """Run pyflakes over app/ and return (undefined-name lines, syntax errors)."""
    out, err = _Collector(), _Collector()
    reporter = pyflakes_reporter.Reporter(out, err)
    pyflakes_api.checkRecursive([str(APP)], reporter)

    lines = "".join(out.out).splitlines()
    undefined = [ln for ln in lines if "undefined name" in ln]
    syntax = [ln for ln in "".join(err.out).splitlines() if ln.strip()]
    return undefined, syntax


def test_no_module_references_a_name_that_does_not_exist():
    """The whole point of the file. See the module docstring for the four."""
    undefined, _ = _sweep()
    assert undefined == [], (
        "These names are used but never defined or imported. Every one of them "
        "is a 500 waiting for the first request that reaches the line:\n  "
        + "\n  ".join(undefined))


def test_every_module_parses():
    """A file that does not compile cannot be caught by the check above."""
    _, syntax = _sweep()
    assert syntax == [], "pyflakes could not parse:\n  " + "\n  ".join(syntax)


def test_the_sweep_actually_looks_at_the_app():
    """Guards the guard.

    If `APP` were ever wrong, or `checkRecursive` silently found nothing, both
    tests above would pass by sweeping an empty directory — a green test that
    checks nothing, which is worse than no test. So assert the sweep really
    reaches a module it must have seen.
    """
    assert (APP / "routers" / "reports.py").exists()
    assert len(list(APP.rglob("*.py"))) > 50


def test_a_planted_undefined_name_is_caught(tmp_path):
    """And that the sweep would FAIL if one came back.

    Same reasoning as above, from the other side: a passing assertion proves
    nothing unless the mechanism can also fail. This plants the exact shape of
    the reports.py bug — a name behind a short-circuiting `or` — in a throwaway
    file and checks pyflakes flags it.
    """
    planted = tmp_path / "planted.py"
    planted.write_text(
        "def f(actor):\n"
        "    return can(actor) or can_any(actor)\n"
        "\n"
        "def can(actor):\n"
        "    return True\n",
        encoding="utf-8")

    out, err = _Collector(), _Collector()
    reporter = pyflakes_reporter.Reporter(out, err)
    pyflakes_api.checkRecursive([str(tmp_path)], reporter)
    found = [ln for ln in "".join(out.out).splitlines() if "undefined name" in ln]

    assert any("can_any" in ln for ln in found), (
        "the sweep did not flag a planted undefined name — it is not actually "
        "guarding anything")
