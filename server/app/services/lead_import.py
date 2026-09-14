"""Parse and validate uploaded lead files (CSV / XLSX) for bulk import.

Also owns how a lead's TYPE is written and read in a spreadsheet — the label in
the template dropdown, the label in the export, and the parsing of whatever the
user actually typed. One place, so a file this app exports is always a file this
app can import back.
"""

from __future__ import annotations

import csv
import io

from app.core.enums import LeadType

# How each type is written in a spreadsheet. Human labels, not enum values —
# "Channel partner", not "channel_partner".
LEAD_TYPE_LABELS: dict[str, str] = {
    LeadType.CUSTOMER.value: "Customer",
    LeadType.CHANNEL_PARTNER.value: "Channel partner",
    LeadType.BUSINESS.value: "Business",
}

# Canonical import columns, in template order. Type was re-added 2026-08-03
# (owner Q1.5); Address was dropped the same day, since a lead's address is no
# longer collected anywhere in the UI and importing one would file data that
# nothing can display or edit. Source stays dropped, Interested In stays free
# text.
EXPECTED_HEADERS = [
    "Full Name", "Type", "Mobile", "Email", "Interested In", "Note",
]

# Example row shipped in the downloadable template.
SAMPLE_ROW = [
    "Ramesh Kumar", "Customer", "9812345678", "ramesh@example.com",
    "Motor insurance", "Called once, will follow up",
]


def label_for_type(value) -> str:
    """Spreadsheet label for a lead type. Unknown values fall back to Customer,
    the model's default, rather than leaking a raw enum value into an export."""
    key = getattr(value, "value", value)
    return LEAD_TYPE_LABELS.get(key, LEAD_TYPE_LABELS[LeadType.CUSTOMER.value])


def parse_lead_type(text: str | None) -> LeadType:
    """Read a Type cell.

    Accepts the label ("Channel partner"), the raw value ("channel_partner"),
    and the sloppy real-world variants people type ("partner", "cp", "company").
    A blank cell is Customer — the owner's default — so an old template without
    the column still imports (owner Q1.5).
    """
    raw = (text or "").strip().lower().replace("-", " ").replace("_", " ")
    if not raw:
        return LeadType.CUSTOMER
    if raw in ("channel partner", "channelpartner", "partner", "cp", "agent"):
        return LeadType.CHANNEL_PARTNER
    if raw in ("business", "company", "corporate", "firm"):
        return LeadType.BUSINESS
    return LeadType.CUSTOMER


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


def build_template_xlsx(category_labels: list[str] | None = None) -> bytes:
    """Excel template with a styled header, one example row, and a dropdown on
    Type. Interested In is free text, so it has no validation.
    `category_labels` is accepted for call-site compatibility but unused.
    Falls back if openpyxl is missing."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation

    wb = Workbook()
    ws = wb.active
    ws.title = "Leads"

    ws.append(EXPECTED_HEADERS)
    ws.append(SAMPLE_ROW)

    header_fill = PatternFill("solid", fgColor="1F2937")
    header_font = Font(color="FFFFFF", bold=True)
    for col, _ in enumerate(EXPECTED_HEADERS, start=1):
        cell = ws.cell(row=1, column=col)
        cell.fill = header_fill
        cell.font = header_font
        ws.column_dimensions[cell.column_letter].width = 24

    # Pick-list on Type so the common case needs no typing. Left as a warning
    # rather than a hard stop (allow_blank, no `showErrorMessage=False` games):
    # parse_lead_type accepts the variants anyway, and a template that refuses
    # to let someone paste a column of data is a template they abandon.
    type_col = ws.cell(row=1, column=EXPECTED_HEADERS.index("Type") + 1)
    validation = DataValidation(
        type="list",
        formula1='"' + ",".join(LEAD_TYPE_LABELS.values()) + '"',
        allow_blank=True,
    )
    validation.prompt = "Customer, Channel partner or Business. Blank = Customer."
    validation.promptTitle = "Lead type"
    ws.add_data_validation(validation)
    validation.add(f"{type_col.column_letter}2:{type_col.column_letter}1000")

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# Columns a file may leave out entirely. Type is optional so a sheet saved from
# the pre-2026-08-03 template still imports — every row in it is a Customer,
# which is what those rows were.
OPTIONAL_HEADERS = {"type"}

# Columns we no longer use but still ACCEPT, so a file the owner already has
# does not get rejected over a column we chose to stop reading. The values are
# parsed and then ignored — dropping the column is our decision, not theirs.
IGNORED_HEADERS = {"address"}


def _validate_headers(headers: list[str]) -> None:
    provided = {_norm(h) for h in headers if _norm(h)}
    expected = {_norm(h) for h in EXPECTED_HEADERS}
    missing = (expected - provided) - OPTIONAL_HEADERS
    extra = provided - expected - IGNORED_HEADERS
    # Note the test is on missing/extra, NOT on set inequality: a file that only
    # leaves out an optional column is fine, and comparing the sets would reject
    # it with an empty "()" reason.
    if not missing and not extra:
        return
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
    """Return a list of row dicts keyed by normalised header.

    Raises ImportFormatError if the columns don't match the template.
    """
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
            "Unsupported file type. Upload a .csv or .xlsx file."
        )

    _validate_headers(headers)
    # Drop fully-empty trailing rows.
    cleaned = [r for r in data if any(
        ("" if c is None else str(c)).strip() for c in r)]
    return _rows_to_dicts(headers, cleaned)
