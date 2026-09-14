"""Read a downloaded bank statement and turn it into rows a human can assign.

WHY THIS IS NOT `customer_import` WITH DIFFERENT COLUMNS
--------------------------------------------------------
The lead and customer importers take a file that matches OUR template exactly
and reject anything else. That is right for them: the columns are ours, we
publish the template, and a mismatch means somebody used an old one.

A bank statement is the opposite. HDFC writes "Withdrawal Amt." and "Deposit
Amt."; SBI writes "Debit" and "Credit"; Bank of Baroda writes one amount column
and a separate Dr/Cr flag; ICICI writes "Transaction Date" where Axis writes
"Tran Date". None of them is going to change to suit us, and demanding the owner
re-type a year of transactions into our template is how a feature stops being
used in week two.

So this module MAPS instead of validating. It reads whatever columns the file
has, guesses which is which from the header names, and hands both the guess and
the alternatives back for a human to confirm. The guess is a starting point,
never a silent decision — a mis-mapped amount column would book real money
wrongly, and there would be nothing on screen to notice it by.

WHAT IT NEVER DECIDES
---------------------
The COUNTERPARTY. A bank narration is free text written by a payment system —
"NEFT-CITIN52025-RAMESH KUMAR-HDFC0000123" — and matching it to a customer is a
guess. It is offered as a suggestion (see `suggest_terms`), the row stays
unassigned until a person picks, and nothing posts without an explicit choice.

DIRECTION comes from the file and is not editable: if the bank says the money
left, it left. What a person chooses is who it concerns and what kind of
movement it was.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Iterable, Optional

from app.services.finance_reports import IST

# A statement is a working document, not a database. This is a hard ceiling on
# rows pulled out of one file: every row becomes a real money write, and this is
# ONE small instance (CLAUDE.md, "Scaling blockers"). A year of a busy current
# account sits well under it.
MAX_ROWS = 2000

# How many rows to show before the mapping is confirmed. Enough to see that the
# date column really is dates and the amount column really is amounts.
SAMPLE_ROWS = 5


class StatementFormatError(ValueError):
    """The file could not be read at all — not a mapping problem."""


# --- Column guessing ----------------------------------------------------------
#
# Header fragments seen on real Indian bank statements, most specific first.
# Matching is case-insensitive on a squashed form of the header, so
# "Withdrawal Amt." and "withdrawal amt" are the same thing.

_DATE_HINTS = ("valuedate", "transactiondate", "trandate", "txndate", "postdate",
               "date")
_DESC_HINTS = ("narration", "particulars", "description", "transactiondetails",
               "remarks", "details")
_REF_HINTS = ("chequenumber", "chqno", "refno", "referencenumber", "reference",
              "utr", "transactionid", "chequeno")
_DEBIT_HINTS = ("withdrawalamt", "withdrawal", "debitamount", "debit", "dr",
                "paid", "withdrawals")
_CREDIT_HINTS = ("depositamt", "deposit", "creditamount", "credit", "cr",
                 "received", "deposits")
_AMOUNT_HINTS = ("amount", "transactionamount", "txnamount", "amt")
_DRCR_HINTS = ("drcr", "crdr", "type", "transactiontype", "debitcredit")
_BALANCE_HINTS = ("closingbalance", "balance", "runningbalance")


def _squash(header: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (header or "").lower())


def _pick(headers: list[str], hints: Iterable[str],
          taken: set[str]) -> Optional[str]:
    """First header matching any hint, preferring an exact squashed match.

    `taken` stops one column being guessed into two roles — "Amount" cannot be
    both the debit and the credit column, and a file where the guess collides is
    exactly the file a human needs to look at.
    """
    squashed = {h: _squash(h) for h in headers if h and h not in taken}
    for hint in hints:
        for header, sq in squashed.items():
            if sq == hint:
                return header
    for hint in hints:
        for header, sq in squashed.items():
            # A BALANCE column contains the word "amount" on some statements, so
            # never let a substring match steal it.
            if hint in sq and not any(b in sq for b in _BALANCE_HINTS):
                return header
    return None


@dataclass
class ColumnMapping:
    """Which column means what. Every field is a HEADER NAME from the file."""

    date: Optional[str] = None
    description: Optional[str] = None
    reference: Optional[str] = None
    # Two shapes, and a file uses one or the other:
    #   split    debit + credit columns, one of them blank per row
    #   single   one amount column plus a Dr/Cr flag column
    debit: Optional[str] = None
    credit: Optional[str] = None
    amount: Optional[str] = None
    dr_cr: Optional[str] = None

    @property
    def is_split(self) -> bool:
        return bool(self.debit or self.credit)

    def missing(self) -> list[str]:
        """What still has to be chosen before the file can be read."""
        gaps = []
        if not self.date:
            gaps.append("the date column")
        if not (self.is_split or (self.amount and self.dr_cr)):
            gaps.append("either a debit and credit column, or one amount "
                        "column plus a Dr/Cr column")
        return gaps


def guess_mapping(headers: list[str]) -> ColumnMapping:
    """A first guess at what each column is. Confirmed by a human, never used
    blind — see the module docstring."""
    taken: set[str] = set()
    m = ColumnMapping()

    def take(value: Optional[str]) -> Optional[str]:
        if value:
            taken.add(value)
        return value

    m.date = take(_pick(headers, _DATE_HINTS, taken))
    m.description = take(_pick(headers, _DESC_HINTS, taken))
    m.reference = take(_pick(headers, _REF_HINTS, taken))
    m.debit = take(_pick(headers, _DEBIT_HINTS, taken))
    m.credit = take(_pick(headers, _CREDIT_HINTS, taken))
    if not (m.debit and m.credit):
        # Not a split-column statement. Fall back to one amount + a Dr/Cr flag,
        # and drop any half-guess so the form asks rather than half-fills.
        m.debit = m.credit = None
        taken = {h for h in (m.date, m.description, m.reference) if h}
        m.amount = take(_pick(headers, _AMOUNT_HINTS, taken))
        m.dr_cr = take(_pick(headers, _DRCR_HINTS, taken))
    return m


# --- Reading the file ---------------------------------------------------------


def read_table(data: bytes, filename: str) -> tuple[list[str], list[list[str]]]:
    """(headers, rows) from a CSV or XLSX, as plain strings.

    Bank exports are frequently ragged: a title line above the headers, a
    "Statement of account" banner, blank separators, and a totals row at the
    bottom. `_find_header_row` walks down to the first row that looks like a
    header rather than assuming line 1, because assuming line 1 is how the whole
    file reads as one unnamed column.
    """
    if filename.lower().endswith((".xlsx", ".xls")):
        rows = _read_xlsx(data)
    else:
        rows = _read_csv(data)
    if not rows:
        raise StatementFormatError("That file has no rows in it.")

    start = _find_header_row(rows)
    headers = [str(c).strip() for c in rows[start]]
    body = [r for r in rows[start + 1:] if any(str(c).strip() for c in r)]
    if not headers or not any(headers):
        raise StatementFormatError(
            "The column headings could not be found in that file. Delete any "
            "title rows above the table and try again.")
    return headers, [[str(c).strip() for c in r] for r in body]


def _read_csv(data: bytes) -> list[list[str]]:
    # Bank CSVs come in whatever the export machine felt like. utf-8-sig strips
    # the BOM Excel adds; cp1252 covers the Windows-encoded ones; latin-1 never
    # fails, so it is the backstop rather than a guess.
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover — latin-1 decodes any byte sequence
        raise StatementFormatError("That file's text could not be read.")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [row for row in csv.reader(io.StringIO(text), dialect)]


def _read_xlsx(data: bytes) -> list[list[str]]:
    from openpyxl import load_workbook

    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001
        raise StatementFormatError(
            "That spreadsheet could not be opened. Save it as CSV and try "
            "again.") from exc
    ws = wb.active
    out: list[list[str]] = []
    for row in ws.iter_rows(values_only=True):
        out.append(["" if c is None else
                    (c.date().isoformat() if isinstance(c, datetime) else str(c))
                    for c in row])
        if len(out) > MAX_ROWS + 50:      # + slack for banner/footer rows
            break
    return out


def _find_header_row(rows: list[list[str]]) -> int:
    """Index of the row that carries the column names.

    A header row is the first one with at least two non-empty cells where none
    of them parses as a number — a data row always has an amount in it, a banner
    line has one cell, and a header has words.
    """
    for i, row in enumerate(rows[:25]):
        cells = [str(c).strip() for c in row if str(c).strip()]
        if len(cells) < 2:
            continue
        if any(_to_decimal(c) is not None for c in cells):
            continue
        return i
    return 0


# --- Parsing one row ----------------------------------------------------------

_DATE_FORMATS = (
    "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y",
    "%Y-%m-%d", "%Y/%m/%d",
    "%d %b %Y", "%d-%b-%Y", "%d/%b/%Y", "%d %B %Y", "%d-%b-%y",
    "%m/%d/%Y",
)


def parse_date(value: str) -> Optional[date]:
    """A statement date, read DAY-FIRST.

    Day-first is not a preference here, it is the only safe reading: Indian bank
    statements are day-first, and "03/04/2026" is the 3rd of April. Trying
    month-first first would silently turn it into the 4th of March — a date that
    parses cleanly, lands in the wrong month, and moves the transaction into the
    wrong reporting period with nothing on screen to notice it by. `%m/%d/%Y` is
    LAST, so it only ever catches a value no day-first format could read
    (a "12/25/2026").
    """
    text = (value or "").strip()
    if not text:
        return None
    # Some exports carry a time ("03/04/2026 14:22:01"); the date is all we
    # want. Split ONLY when what follows really is a time — a bare length check
    # decapitated "03 Apr 2026" (11 characters) down to "03", which then failed
    # every format and reported a perfectly good date as unreadable.
    text = re.sub(r"[ T]\d{1,2}:\d{2}(:\d{2})?(\s*[AaPp][Mm])?$", "", text)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _to_decimal(value: str) -> Optional[Decimal]:
    """A money cell as a Decimal, or None when it is not a number.

    Handles the Indian grouping ("1,20,000.50"), a trailing Cr/Dr suffix, a
    currency symbol, and the parenthesised negative some exports use. Returns
    the MAGNITUDE's sign as written — direction is decided by the caller, from
    the column, never from a minus sign that may or may not be there.
    """
    text = (value or "").strip()
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    text = text.strip("()")
    text = re.sub(r"(?i)\b(cr|dr)\b\.?$", "", text).strip()
    text = re.sub(r"[₹$,\s]", "", text)
    if not text or text in ("-", "."):
        return None
    try:
        d = Decimal(text)
    except InvalidOperation:
        return None
    return -d if negative else d


def to_paise(value: Decimal) -> int:
    """Rupees to paise, rounded to the nearest paisa.

    `int(value * 100)` truncates, which loses a paisa on a value like 10.999 —
    small, and it accumulates across a statement until the account no longer
    reconciles by a few rupees, which is the sort of drift nobody can trace.

    ROUND_HALF_UP is stated explicitly because `quantize` defaults to
    ROUND_HALF_EVEN (banker's rounding), under which exactly half a paisa
    rounds DOWN on an even boundary and UP on an odd one. That is the right
    default for statistics and the wrong one for money, where the convention
    every ledger in the country uses is half-up.
    """
    return int((value * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


_CR_WORDS = {"cr", "credit", "c", "+", "deposit", "dep"}
_DR_WORDS = {"dr", "debit", "d", "-", "withdrawal", "wdl"}


@dataclass
class StatementRow:
    """One line of the statement, normalised. Nothing here is a decision."""

    line: int                       # 1-based row number in the file
    occurred_on: Optional[date] = None
    description: str = ""
    reference: str = ""
    # POSITIVE magnitude in paise; `direction` carries the sign's meaning.
    amount_paise: int = 0
    direction: str = ""             # "in" | "out"
    # Why this row cannot be used, if it cannot. A row with a problem is shown
    # and skipped, never dropped silently — a statement that imports 38 of 40
    # lines without saying which two is worse than one that refuses.
    problem: Optional[str] = None
    # Set when a transaction that looks like this one is already recorded.
    duplicate_of: Optional[str] = None
    duplicate_note: Optional[str] = None
    # Free-text hints pulled out of the narration, for the party suggestion.
    terms: list[str] = field(default_factory=list)


def parse_rows(headers: list[str], body: list[list[str]],
               mapping: ColumnMapping) -> list[StatementRow]:
    """Normalise every line. Rows with problems are KEPT and flagged."""
    gaps = mapping.missing()
    if gaps:
        raise StatementFormatError(
            "Tell us which column holds " + ", and ".join(gaps) + ".")

    index = {h: i for i, h in enumerate(headers)}

    def cell(row: list[str], header: Optional[str]) -> str:
        if not header or header not in index:
            return ""
        i = index[header]
        return row[i].strip() if i < len(row) else ""

    out: list[StatementRow] = []
    for n, raw in enumerate(body[:MAX_ROWS], start=1):
        row = StatementRow(
            line=n,
            description=cell(raw, mapping.description),
            reference=cell(raw, mapping.reference),
        )
        row.occurred_on = parse_date(cell(raw, mapping.date))
        if row.occurred_on is None:
            row.problem = "The date could not be read."

        if mapping.is_split:
            debit = _to_decimal(cell(raw, mapping.debit))
            credit = _to_decimal(cell(raw, mapping.credit))
            # A statement puts a figure in ONE of the two columns. Both filled
            # means the mapping is wrong, and booking either would be a guess.
            if debit and credit:
                row.problem = row.problem or (
                    "Both the debit and credit columns have a value — check "
                    "the column mapping.")
            elif debit:
                row.amount_paise, row.direction = to_paise(abs(debit)), "out"
            elif credit:
                row.amount_paise, row.direction = to_paise(abs(credit)), "in"
        else:
            amount = _to_decimal(cell(raw, mapping.amount))
            flag = _squash(cell(raw, mapping.dr_cr))
            if amount is not None:
                row.amount_paise = to_paise(abs(amount))
                if flag in _CR_WORDS:
                    row.direction = "in"
                elif flag in _DR_WORDS:
                    row.direction = "out"
                elif amount < 0:
                    # No usable flag, but the amount carries its own sign.
                    row.direction = "out"
                elif amount > 0 and not flag:
                    row.direction = "in"

        if not row.problem and row.amount_paise <= 0:
            row.problem = "No amount on this line."
        elif not row.problem and not row.direction:
            row.problem = "Could not tell whether money came in or went out."

        row.terms = suggest_terms(row.description)
        out.append(row)
    return out


# --- Reading the narration ----------------------------------------------------

# Everything a payment rail stuffs into a narration that is not a person's name.
_NOISE = {
    "neft", "rtgs", "imps", "upi", "ach", "nach", "ecs", "chq", "cheque", "clg",
    "inf", "int", "ib", "mb", "pos", "atm", "cash", "dep", "wdl", "trf",
    "transfer", "to", "from", "by", "for", "ref", "no", "and", "the", "via",
    "payment", "paid", "recd", "received", "credit", "debit", "charges", "gst",
    "sms", "emi", "ecom", "online", "bank", "ltd", "limited", "pvt", "private",
    "india", "inb", "billpay", "自",
}


def suggest_terms(description: str, limit: int = 3) -> list[str]:
    """Words from the narration worth searching a party list for.

    A narration is machine-written — "UPI/DR/451234567890/RAMESH K/HDFC/paytm"
    — so this strips the rails, the reference numbers and the bank codes and
    keeps what is left, longest first, on the theory that the longest surviving
    word is most likely a name.

    Advisory ONLY. The caller offers these as a suggestion; nothing is assigned
    or posted from them. A wrong guess that books itself is far worse than no
    guess, and this is a guess about free text.
    """
    if not description:
        return []
    words = re.split(r"[^A-Za-z]+", description)
    seen: set[str] = set()
    keep: list[str] = []
    for w in words:
        low = w.lower()
        if len(low) < 4 or low in _NOISE or low in seen:
            continue
        seen.add(low)
        keep.append(w)
    keep.sort(key=len, reverse=True)
    return keep[:limit]


# --- Duplicate detection ------------------------------------------------------


def fingerprint(account_id: str, on: Optional[date], amount_paise: int,
                direction: str) -> str:
    """What makes two statement lines "the same transaction".

    Account + calendar day + magnitude + direction. NOT the narration: the same
    payment re-exported from a different screen of the same bank carries a
    different narration often enough that including it would report nothing.

    Deliberately coarse, because it drives a WARNING and not a block. Two
    genuine ₹5,000 cash deposits on the same day into the same account are a
    real thing that happens; the default is to skip them and the person can tick
    one back on. A hard block would make that data un-enterable.
    """
    day = on.isoformat() if on else "?"
    return f"{account_id}|{day}|{amount_paise}|{direction}"


def ist_instant(on: date) -> datetime:
    """A statement DATE as the instant to store.

    Midday IST, not midnight. A statement gives a calendar day and no time, and
    midnight sits one minute from the IST day boundary — so any later rounding,
    any timezone slip, any comparison done in UTC moves the transaction into the
    previous day and therefore, at a month end, into the previous month's
    figures. Midday is eleven hours from either edge and cannot.
    """
    return datetime.combine(on, time(12, 0), tzinfo=IST)
