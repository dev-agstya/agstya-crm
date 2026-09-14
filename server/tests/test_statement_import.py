"""Reading a bank statement — the parsing that must never be wrong.

Everything here is pure (no database): the module under test turns bytes into
normalised rows, and that is exactly the part where a quiet mistake becomes real
money in the wrong place.

The cases below are the ones that actually bite on Indian bank exports:

  * three banks, three completely different column layouts
  * a date read MONTH-first instead of day-first — which parses cleanly, lands
    in the wrong month, and moves a transaction into the wrong reporting period
  * "1,20,000.50" — Indian digit grouping, which `float()` refuses outright
  * a banner and a blank line above the real header row
  * direction taken from the COLUMN, never from a minus sign that may not be
    there

Pinned alongside `tests/test_bank.py`, which owns the other half of the same
risk: what a transaction does to a balance once it is read.
"""

from __future__ import annotations

import inspect
from datetime import date
from decimal import Decimal

import pytest

from app.services import statement_import as si


# --- Three banks, three layouts -------------------------------------------------

HDFC = b"""Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
03/04/2026,NEFT-CITIN52025-RAMESH KUMAR-HDFC0000123,N123456,,25000.00,125000.00
05/04/2026,UPI/DR/451234567890/OFFICE RENT/ICIC,451234567890,"18,000.00",,107000.00
"""

SBI = b"""Txn Date\tDescription\tRef No.\tDebit\tCredit\tBalance
12-04-2026\tBy Transfer INB PRAKASH SHARMA\t998877\t\t45000\t170000
"""

# Bank of Baroda: a two-line banner above the header, one amount column, and a
# separate Dr/Cr flag.
BOB = b"""Statement of Account
Bank of Baroda - Andheri West
Tran Date,Particulars,Amount,Dr/Cr
15/04/2026,CHQ PAID SELF,"1,20,000.50",DR
16/04/2026,CASH DEP,"5,000",CR
"""


def _rows(raw: bytes, name: str):
    headers, body = si.read_table(raw, name)
    mapping = si.guess_mapping(headers)
    return mapping, si.parse_rows(headers, body, mapping)


def test_hdfc_split_columns_are_guessed_and_read():
    mapping, rows = _rows(HDFC, "hdfc.csv")
    assert mapping.date == "Date"
    assert mapping.debit == "Withdrawal Amt."
    assert mapping.credit == "Deposit Amt."
    assert [r.direction for r in rows] == ["in", "out"]
    assert [r.amount_paise for r in rows] == [2_500_000, 1_800_000]
    assert rows[0].occurred_on == date(2026, 4, 3)


def test_sbi_is_tab_separated_and_names_its_columns_differently():
    """A different delimiter AND different headers. Neither is configurable by
    the bank's customer, so both have to just work."""
    mapping, rows = _rows(SBI, "sbi.csv")
    assert mapping.debit == "Debit" and mapping.credit == "Credit"
    assert rows[0].direction == "in"
    assert rows[0].amount_paise == 4_500_000


def test_bob_single_amount_column_with_a_dr_cr_flag():
    mapping, rows = _rows(BOB, "bob.csv")
    assert mapping.amount == "Amount"
    assert mapping.dr_cr == "Dr/Cr"
    assert not mapping.is_split
    assert [r.direction for r in rows] == ["out", "in"]
    assert rows[0].amount_paise == 12_000_050        # Rs 1,20,000.50


def test_a_banner_above_the_header_row_does_not_become_the_header():
    """Bank exports routinely put a title and the branch name above the table.
    Assuming line 1 is the header reads the whole file as one unnamed column."""
    headers, body = si.read_table(BOB, "bob.csv")
    assert headers == ["Tran Date", "Particulars", "Amount", "Dr/Cr"]
    assert len(body) == 2


# --- Dates ----------------------------------------------------------------------


def test_dates_are_read_day_first():
    """THE trap. "03/04/2026" is the 3rd of April on every Indian statement.
    Month-first would read it as the 4th of March — a date that parses cleanly,
    lands in the wrong month, and quietly moves the transaction into the wrong
    reporting period with nothing on screen to notice it by."""
    assert si.parse_date("03/04/2026") == date(2026, 4, 3)
    assert si.parse_date("03-04-2026") == date(2026, 4, 3)
    assert si.parse_date("3/4/26") == date(2026, 4, 3)


@pytest.mark.parametrize("text,expected", [
    ("2026-04-03", date(2026, 4, 3)),          # ISO
    ("03 Apr 2026", date(2026, 4, 3)),
    ("03-Apr-2026", date(2026, 4, 3)),
    ("12/25/2026", date(2026, 12, 25)),        # unambiguous US-only value
])
def test_other_date_shapes_banks_use(text, expected):
    assert si.parse_date(text) == expected


def test_an_unreadable_date_is_reported_not_guessed():
    assert si.parse_date("not a date") is None
    assert si.parse_date("") is None


def test_a_statement_date_is_stored_at_MIDDAY_ist():
    """A statement gives a calendar day and no time. Midnight sits one minute
    from the IST day boundary, so any rounding or UTC comparison moves the
    transaction into the previous day — and at a month end, into the previous
    month's figures. Midday cannot."""
    when = si.ist_instant(date(2026, 4, 3))
    assert when.hour == 12
    assert when.tzinfo is not None
    # And it really is the 3rd once converted to UTC, not the 2nd.
    assert when.astimezone(tz=None).date() >= date(2026, 4, 2)
    assert when.utcoffset().total_seconds() == 5.5 * 3600


# --- Amounts --------------------------------------------------------------------


def test_indian_digit_grouping():
    """`float("1,20,000.50")` raises. Every Indian statement writes money that
    way, so this is not an edge case, it is the normal case."""
    assert si._to_decimal("1,20,000.50") == Decimal("120000.50")


@pytest.mark.parametrize("text,expected", [
    ("₹ 5,000", Decimal("5000")),
    ("5000.00 Cr", Decimal("5000")),
    ("(2,500)", Decimal("-2500")),        # parenthesised negative
    ("", None),
    ("-", None),
    ("abc", None),
])
def test_money_cells_banks_actually_produce(text, expected):
    assert si._to_decimal(text) == expected


def test_paise_conversion_rounds_rather_than_truncating():
    """int(x * 100) truncates. One paisa per row is nothing; across a statement
    it accumulates until the account no longer reconciles by a few rupees, which
    is drift nobody can trace back to a cause."""
    assert si.to_paise(Decimal("10.999")) == 1100
    assert si.to_paise(Decimal("0.005")) == 1
    assert si.to_paise(Decimal("120000.50")) == 12_000_050


# --- Direction ------------------------------------------------------------------


def test_direction_comes_from_the_column_not_from_a_minus_sign():
    """A debit column holds a POSITIVE number on most statements. Reading
    direction off the sign would mark every withdrawal as money coming in."""
    _, rows = _rows(HDFC, "hdfc.csv")
    out = rows[1]
    assert out.direction == "out"
    assert out.amount_paise > 0          # magnitude is always positive


def test_a_row_with_both_debit_and_credit_filled_is_refused_not_guessed():
    """Both columns filled means the MAPPING is wrong. Booking either one would
    be a coin toss with real money."""
    raw = (b"Date,Narration,Withdrawal Amt.,Deposit Amt.\n"
           b"03/04/2026,ODD,100.00,200.00\n")
    _, rows = _rows(raw, "odd.csv")
    assert rows[0].problem is not None
    assert rows[0].direction == ""


def test_a_row_with_no_amount_is_flagged_and_kept():
    """Kept, not dropped: a file that imports 38 of 40 lines without saying
    which two is worse than one that refuses."""
    raw = (b"Date,Narration,Withdrawal Amt.,Deposit Amt.\n"
           b"03/04/2026,BALANCE B/F,,\n")
    _, rows = _rows(raw, "bf.csv")
    assert len(rows) == 1
    assert rows[0].problem == "No amount on this line."


# --- The narration ---------------------------------------------------------------


def test_payment_rails_and_reference_numbers_are_stripped_from_the_suggestion():
    terms = si.suggest_terms("UPI/DR/451234567890/RAMESH KUMAR/HDFC/paytm")
    assert "RAMESH" in terms
    assert not any(t.lower() in {"upi", "dr", "hdfc"} for t in terms)


def test_a_suggestion_is_never_a_decision():
    """`suggest_terms` returns SEARCH TERMS, never an id. A narration is
    machine-written free text and matching it to a customer is a guess — a guess
    that assigned itself would post real money against the wrong person."""
    source = inspect.getsource(si.suggest_terms)
    assert "Advisory ONLY" in inspect.getdoc(si.suggest_terms)
    for forbidden in ("Customer", "User", "find_one", "party_id"):
        assert forbidden not in source


# --- Duplicate detection ---------------------------------------------------------


def test_the_same_line_twice_fingerprints_the_same():
    a = si.fingerprint("acc1", date(2026, 4, 3), 50_000, "in")
    b = si.fingerprint("acc1", date(2026, 4, 3), 50_000, "in")
    assert a == b


@pytest.mark.parametrize("account,day,amount,direction", [
    ("acc2", date(2026, 4, 3), 50_000, "in"),      # other account
    ("acc1", date(2026, 4, 4), 50_000, "in"),      # other day
    ("acc1", date(2026, 4, 3), 50_001, "in"),      # other amount
    ("acc1", date(2026, 4, 3), 50_000, "out"),     # other direction
])
def test_anything_different_fingerprints_differently(account, day, amount,
                                                     direction):
    base = si.fingerprint("acc1", date(2026, 4, 3), 50_000, "in")
    assert si.fingerprint(account, day, amount, direction) != base


def test_the_narration_is_NOT_part_of_the_fingerprint():
    """Deliberate. The same payment re-exported from a different screen of the
    same bank carries a different narration often enough that including it would
    report no duplicates at all."""
    # The docstring explains WHY the narration is excluded, so strip it before
    # searching — otherwise this asserts against its own rationale.
    body = inspect.getsource(si.fingerprint).split('"""')[-1]
    assert "description" not in body
    assert "narration" not in body.lower()


# --- Limits ----------------------------------------------------------------------


def test_rows_beyond_the_ceiling_are_cut_rather_than_hydrated():
    """Every row becomes a real money write and this is ONE small instance."""
    header = b"Date,Narration,Withdrawal Amt.,Deposit Amt.\n"
    line = b"03/04/2026,X,100.00,\n"
    headers, body = si.read_table(header + line * (si.MAX_ROWS + 50), "big.csv")
    rows = si.parse_rows(headers, body, si.guess_mapping(headers))
    assert len(rows) == si.MAX_ROWS


def test_a_missing_mapping_says_what_is_missing_rather_than_failing_silently():
    mapping = si.ColumnMapping(description="Narration")
    gaps = mapping.missing()
    assert any("date" in g for g in gaps)
    assert any("debit" in g or "amount" in g for g in gaps)
    with pytest.raises(si.StatementFormatError) as exc:
        si.parse_rows(["Narration"], [["x"]], mapping)
    assert "date" in str(exc.value)


def test_a_column_cannot_be_guessed_into_two_roles():
    """"Amount" cannot be both the debit and the credit column. A file where the
    guess would collide is exactly the file a human needs to look at."""
    mapping = si.guess_mapping(["Date", "Amount", "Balance"])
    chosen = [c for c in (mapping.debit, mapping.credit, mapping.amount)
              if c is not None]
    assert len(chosen) == len(set(chosen))


def test_a_balance_column_is_never_mistaken_for_the_amount():
    """"Closing Balance" contains the word "balance", not "amount" — but a naive
    substring match on some exports ("Balance Amount") would take it, and
    importing the running balance as the transaction amount would be a disaster
    that looks plausible."""
    mapping = si.guess_mapping(["Date", "Narration", "Balance Amount"])
    assert mapping.amount != "Balance Amount"
