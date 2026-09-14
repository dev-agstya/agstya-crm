"""Reusable CSV / Excel export helpers so any list endpoint can stream a
download of the current (filtered) data. openpyxl is already a dependency."""

from __future__ import annotations

import csv
import io
from typing import Iterable, Sequence

from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

_XLSX_MIME = ("application/vnd.openxmlformats-officedocument"
              ".spreadsheetml.sheet")

# Excel and Sheets treat a cell beginning with any of these as a FORMULA, not
# text. Exported values are customer names, notes, references and payee names —
# all typed by someone. A customer saved as `=cmd|'/c calc'!A1` would run when
# the owner opened the download, and `@SUM(...)`/`+HYPERLINK(...)` are the same
# trick. Prefixing a single quote makes the cell literal text; Excel does not
# display the quote.
_FORMULA_LEADERS = ("=", "+", "-", "@", "\t", "\r")


def _safe_cell(value):
    """Neutralise a spreadsheet formula trigger, leaving everything else alone.

    Numbers and dates are passed through untouched so the cell keeps its type —
    only strings can carry a formula, and only when they LEAD with one of the
    trigger characters. (A negative number arrives as an int/float, not a "-"
    string, so real figures are unaffected.)
    """
    if value is None:
        return ""
    if isinstance(value, str) and value.startswith(_FORMULA_LEADERS):
        return "'" + value
    return value


def csv_response(filename: str, headers: Sequence[str],
                 rows: Iterable[Sequence]) -> StreamingResponse:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for r in rows:
        writer.writerow([_safe_cell(v) for v in r])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'})


def excel_response(filename: str, headers: Sequence[str],
                   rows: Iterable[Sequence], *,
                   sheet_title: str = "Export") -> StreamingResponse:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_title[:31] or "Export"

    ws.append(list(headers))
    head_fill = PatternFill("solid", fgColor="1F2937")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = head_fill

    widths = [len(str(h)) for h in headers]
    for r in rows:
        row = [_safe_cell(v) for v in r]
        ws.append(row)
        for i, v in enumerate(row):
            widths[i] = max(widths[i], min(60, len(str(v))))
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w + 2
    ws.freeze_panes = "A2"

    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)
    return StreamingResponse(
        bio, media_type=_XLSX_MIME,
        headers={"Content-Disposition":
                 f'attachment; filename="{filename}.xlsx"'})


def export_response(fmt: str, filename: str, headers: Sequence[str],
                    rows: Iterable[Sequence], *, sheet_title: str = "Export"):
    """Dispatch on format: 'excel'/'xlsx' -> .xlsx, anything else -> .csv."""
    if fmt in ("excel", "xlsx"):
        return excel_response(filename, headers, rows, sheet_title=sheet_title)
    return csv_response(filename, headers, rows)
