"""Parse and validate uploaded customer files (CSV / XLSX) for bulk import.

Mirrors ``lead_import`` but with the customer column set. Mobile is required and
must be 10 digits (customers are unique by mobile).
"""

from __future__ import annotations

import csv
import io

# Owner 2026-07-17: Contact Person and GSTIN dropped from the customer form and
# the import template. Owner 2026-07-26: the postal address columns (Address /
# City / State / Pincode) went the same way — a customer is a name, a mobile and
# an email. Files saved from an older template are rejected by _validate_headers,
# which is deliberate: silently ignoring extra columns would let someone believe
# an address had been imported.
EXPECTED_HEADERS = ["Full Name", "Mobile", "Email", "Notes"]

SAMPLE_ROW = [
    "Ramesh Kumar", "9812345678", "ramesh@example.com", "VIP customer",
]


def _norm(h: str | None) -> str:
    return (h or "").strip().lower()


# Ceiling on rows pulled out of an uploaded sheet (see parse_file).
MAX_SHEET_ROWS = 10_000


class ImportFormatError(ValueError):
    """Raised when the uploaded file's columns don't match the template."""


def build_template_csv() -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(EXPECTED_HEADERS)
    writer.writerow(SAMPLE_ROW)
    return buf.getvalue()


def build_template_xlsx() -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "Customers"
    ws.append(EXPECTED_HEADERS)
    ws.append(SAMPLE_ROW)

    header_fill = PatternFill("solid", fgColor="2563EB")
    header_font = Font(color="FFFFFF", bold=True)
    for col, _ in enumerate(EXPECTED_HEADERS, start=1):
        cell = ws.cell(row=1, column=col)
        cell.fill = header_fill
        cell.font = header_font
        ws.column_dimensions[cell.column_letter].width = 20

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def _validate_headers(headers: list[str]) -> None:
    provided = {_norm(h) for h in headers if _norm(h)}
    expected = {_norm(h) for h in EXPECTED_HEADERS}
    if provided != expected:
        missing = expected - provided
        extra = provided - expected
        parts = []
        if missing:
            parts.append("missing: " + ", ".join(sorted(missing)))
        if extra:
            parts.append("unexpected: " + ", ".join(sorted(extra)))
        raise ImportFormatError(
            "The file columns don't match the template ("
            + "; ".join(parts) + "). Please download and use the sample file."
        )


def _rows_to_dicts(headers: list[str], rows: list[list]) -> list[dict]:
    keys = [_norm(h) for h in headers]
    out: list[dict] = []
    for row in rows:
        record = {}
        for i, key in enumerate(keys):
            value = row[i] if i < len(row) else None
            record[key] = ("" if value is None else str(value)).strip()
        out.append(record)
    return out


def parse_file(filename: str, content: bytes) -> list[dict]:
    name = (filename or "").lower()
    if name.endswith(".csv") or name.endswith(".txt"):
        text = content.decode("utf-8-sig", errors="replace")
        reader = list(csv.reader(io.StringIO(text)))
        if not reader:
            raise ImportFormatError("The file is empty.")
        headers, data = reader[0], reader[1:]
    elif name.endswith(".xlsx") or name.endswith(".xlsm"):
        try:
            from openpyxl import load_workbook
        except ImportError as exc:  # pragma: no cover
            raise ImportFormatError(
                "Excel import is unavailable on the server; upload a CSV instead."
            ) from exc
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb.active
        # Pull rows one at a time against a hard ceiling. An .xlsx is a zip, so
        # a few kilobytes on the wire can expand into millions of cells — read
        # the sheet in full and the process is out of memory before any of our
        # own row limits get a chance to run.
        grid = []
        for row in ws.iter_rows(values_only=True):
            grid.append(list(row))
            if len(grid) > MAX_SHEET_ROWS:
                wb.close()
                raise ImportFormatError(
                    f"That sheet has more than {MAX_SHEET_ROWS:,} rows. Please "
                    f"split it into smaller files.")
        wb.close()
        if not grid:
            raise ImportFormatError("The file is empty.")
        headers = [("" if c is None else str(c)) for c in grid[0]]
        data = grid[1:]
    else:
        raise ImportFormatError(
            "Unsupported file type. Upload a .csv or .xlsx file.")

    _validate_headers(headers)
    cleaned = [r for r in data if any(
        ("" if c is None else str(c)).strip() for c in r)]
    return _rows_to_dicts(headers, cleaned)
