"""Render a party statement (broker / channel partner / customer) to a PDF.

Uses fpdf2 — pure Python, no system deps, so it runs on Render.

Layout rules, in one place because they are what makes a statement readable:

* **Portrait A4** for all three kinds (owner 2026-07-23). Narrow margins plus a
  wrapping table engine buy enough width for the 10-11 column policy tables, so
  nothing is ever truncated mid-word.
* **Every page carries a header and a footer** — the company block, the party
  and period on continuation pages, and "Page N of M". A table that spills over
  a page break repeats its column headings.
* **Money is right-aligned**, grouped in the Indian digit convention, and
  printed with a real rupee sign (a subset DejaVu face is bundled; see
  ``assets/fonts/README.txt``). If the font is missing we fall back to Helvetica
  and "Rs." rather than failing to produce a statement.
* **The account section reconciles**: opening balance, every movement with a
  running balance, closing balance. The reader can add it up and get our number.
* **Audience gates the content.** ``audience == "internal"`` (broker) may show
  reward and house profit; ``"external"`` (partner, customer) never does.

Money arrives in paise and is shown in rupees. Everything here is defensive: a
missing logo, an absent font or an odd value must degrade the look, never break
statement generation.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fpdf import FPDF
from fpdf.enums import TableCellFillMode, TableHeadingsDisplay, XPos, YPos
from fpdf.fonts import FontFace

from app.services import company

# --- Palette (near-monochrome; prints cleanly on a mono printer) --------------
BLACK = (17, 24, 39)          # slate-900 — body text, table headings
GREY = (100, 116, 139)        # slate-500 — labels, secondary lines
FAINT = (148, 163, 184)       # slate-400 — footnotes
LIGHT = (243, 244, 246)       # slate-100 — summary tiles
ZEBRA = (242, 244, 247)       # alternating table rows (visible, still light)
RULE = (209, 213, 219)        # slate-300 — hairlines
SUBTOTAL = (233, 236, 240)    # group subtotal band
GREEN = (21, 128, 61)         # positive closing figure
RED = (185, 28, 28)           # negative closing figure

PAGE_MARGIN = 9               # mm — narrow, to fit the wide policy tables
BOTTOM_MARGIN = 16

_KIND_TITLE = {
    "partner": "Channel Partner Statement",
    "customer": "Customer Statement",
    "broker": "Broker Statement",
    # The business report reuses this chrome. It runs to several pages now that
    # it carries the policy list and the partner ledgers, and without an entry
    # here every continuation page would head itself "Statement".
    "business_report": "Business Report",
}


# --- Formatting ---------------------------------------------------------------
def _indian_digits(value: str) -> str:
    """Regroup a plain '1234567.89' into the Indian '12,34,567.89'."""
    whole, _, frac = value.partition(".")
    if len(whole) <= 3:
        head = whole
    else:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        head = ",".join(parts) + "," + tail
    return f"{head}.{frac}" if frac else head


class _Money:
    """Rupee formatter that knows whether the Unicode face is available."""

    def __init__(self) -> None:
        self.symbol = "₹"     # replaced with "Rs." on the fallback font

    def __call__(self, paise: Optional[int], *, blank_zero: bool = False) -> str:
        v = paise or 0
        if blank_zero and v == 0:
            return ""
        body = _indian_digits(f"{abs(v) / 100:.2f}")
        sign = "-" if v < 0 else ""
        joiner = "" if self.symbol == "₹" else " "
        return f"{sign}{self.symbol}{joiner}{body}"

    def plain(self, paise: Optional[int]) -> str:
        """Magnitude only — for columns where the header already says the sign
        (Debit / Credit / Premium …)."""
        return _indian_digits(f"{abs(paise or 0) / 100:.2f}")

    def whole(self, paise: Optional[int]) -> str:
        """Rounded to whole rupees — for sum-insured / cover figures, where the
        paise are noise and the extra characters cost table width."""
        return _indian_digits(f"{round(abs(paise or 0) / 100):d}")

    def signed(self, paise: Optional[int]) -> str:
        """Magnitude WITH a leading minus — for running-balance columns, where a
        balance legitimately swings either way and dropping the sign would print
        a credit balance as if it were a debit."""
        v = paise or 0
        return ("-" if v < 0 else "") + self.plain(v)


def _date(dt) -> str:
    if not dt:
        return "-"
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.strftime("%d %b %Y")
    return str(dt)[:10]


def _short_date(dt) -> str:
    """Two-digit year, for the wide policy tables where a wrapped date column
    would double every row's height."""
    if not dt:
        return "-"
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.strftime("%d %b %y")
    return str(dt)[:10]


def _pct(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:g}%"


def _tds_rate(percent: Optional[int]) -> str:
    """Broker TDS rate stored as percent*100 (500 -> 5%)."""
    if percent is None:
        return "-"
    return f"{percent / 100:g}%"


# --- Document -----------------------------------------------------------------
class _Statement(FPDF):
    """A4 portrait document that repaints its own header/footer on every page."""

    def __init__(self, data: dict) -> None:
        super().__init__(orientation="P", unit="mm", format="A4")
        self.data = data
        self.money = _Money()
        self.base_font = "Helvetica"
        self._register_fonts()
        self.set_margins(PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN)
        self.set_auto_page_break(auto=True, margin=BOTTOM_MARGIN)
        self.alias_nb_pages()

    def _register_fonts(self) -> None:
        faces = company.font_faces()
        if not faces:
            self.money.symbol = "Rs."      # core fonts are latin-1 only
            return
        try:
            for style, path in faces.items():
                self.add_font("Statement", style, path)
            self.base_font = "Statement"
        except Exception:  # noqa: BLE001 — a font problem must not lose the PDF
            self.money.symbol = "Rs."
            self.base_font = "Helvetica"

    def font(self, style: str = "", size: float = 9) -> None:
        self.set_font(self.base_font, style, size)

    def fit_font(self, text: str, width: float, style: str = "",
                 size: float = 9, floor: float = 6) -> None:
        """Select the largest size <= `size` at which `text` fits `width`.

        fpdf's ``cell`` does not clip, so an over-long party name would run
        straight across the meta column on its right. Shrinking is better than
        truncating a customer's own name on their own statement."""
        self.font(style, size)
        while size > floor and self.get_string_width(text) > width:
            size -= 0.4
            self.font(style, size)

    @property
    def content_width(self) -> float:
        return self.w - self.l_margin - self.r_margin

    # fpdf hooks ---------------------------------------------------------------
    def header(self) -> None:
        self._watermark()
        if self.page_no() == 1:
            self._full_header()
        else:
            self._running_header()

    def footer(self) -> None:
        self.set_y(-13)
        self.set_draw_color(*RULE)
        self.set_line_width(0.2)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin,
                  self.get_y())
        self.ln(1.5)
        self.set_font(self.base_font, "", 7)
        self.set_text_color(*FAINT)
        left = (f"{company.COMPANY_NAME}  |  {company.COMPANY_EMAIL}"
                f"  |  {company.COMPANY_PHONE}")
        self.cell(self.content_width * 0.8, 4, left)
        self.cell(self.content_width * 0.2, 4,
                  f"Page {self.page_no()} of {{nb}}", align="R")

    # header pieces ------------------------------------------------------------
    def _watermark(self) -> None:
        path = company.logo_watermark_path()
        if not path:
            return
        try:
            w = 110
            with self.local_context(fill_opacity=0.045, stroke_opacity=0.045):
                self.image(path, x=(self.w - w) / 2, y=(self.h - w) / 2, w=w)
        except Exception:  # noqa: BLE001 — decoration only
            pass

    def _full_header(self) -> None:
        top = self.get_y()
        text_x = self.l_margin
        logo = company.logo_full_path()
        if logo:
            try:
                self.image(logo, x=self.l_margin, y=top, h=15)
                text_x = self.l_margin + 44
            except Exception:  # noqa: BLE001
                pass
        self.set_xy(text_x, top)
        self.font("B", 15)
        self.set_text_color(*BLACK)
        self.cell(0, 7, company.COMPANY_NAME, new_x=XPos.LMARGIN,
                  new_y=YPos.NEXT)
        self.font("", 8)
        self.set_text_color(*GREY)
        lines = [company.COMPANY_ADDRESS,
                 f"{company.COMPANY_EMAIL}  |  {company.COMPANY_PHONE}"]
        if company.COMPANY_WEBSITE:
            lines[-1] += f"  |  {company.COMPANY_WEBSITE}"
        if company.COMPANY_GSTIN:
            lines.append(f"GSTIN: {company.COMPANY_GSTIN}")
        for line in lines:
            self.set_x(text_x)
            self.cell(0, 4.2, line, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

        self.set_y(max(self.get_y(), top + 16))
        self.set_draw_color(*BLACK)
        self.set_line_width(0.6)
        y = self.get_y() + 1
        self.line(self.l_margin, y, self.w - self.r_margin, y)
        self.ln(4)
        self._title_block()

    def _running_header(self) -> None:
        """Compact identity strip so a loose page is still identifiable."""
        self.set_y(self.t_margin)
        self.font("B", 8.5)
        self.set_text_color(*BLACK)
        title = _KIND_TITLE.get(self.data.get("kind"), "Statement")
        self.cell(self.content_width * 0.6, 5,
                  f"{title} — {self.data.get('label', '')}")
        self.font("", 8)
        self.set_text_color(*GREY)
        self.cell(self.content_width * 0.4, 5, self._period_text(), align="R",
                  new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_draw_color(*RULE)
        self.set_line_width(0.25)
        y = self.get_y() + 0.5
        self.line(self.l_margin, y, self.w - self.r_margin, y)
        self.ln(3)

    def _period_text(self) -> str:
        label = self.data.get("period_label")
        span = f"{_date(self.data.get('date_from'))} to " \
               f"{_date(self.data.get('date_to'))}"
        return f"{label} ({span})" if label else span

    def _title_block(self) -> None:
        d = self.data
        # The left identity block and the right meta column share the width;
        # everything on the left is shrunk to fit so the two can never collide.
        left_w = self.content_width * 0.60 - 4
        top = self.get_y()

        self.font("B", 13)
        self.set_text_color(*BLACK)
        self.cell(left_w, 7, _KIND_TITLE.get(d.get("kind"), "Statement"),
                  new_x=XPos.LMARGIN, new_y=YPos.NEXT)

        self.font("", 7.5)
        self.set_text_color(*GREY)
        self.cell(left_w, 4.5, "STATEMENT FOR", new_x=XPos.LMARGIN,
                  new_y=YPos.NEXT)
        name = str(d.get("label", "-"))
        if d.get("code"):
            name += f"   ({d['code']})"
        self.fit_font(name, left_w, "B", 11, floor=7)
        self.set_text_color(*BLACK)
        self.cell(left_w, 5.5, name, new_x=XPos.LMARGIN, new_y=YPos.NEXT)

        self.set_text_color(*GREY)
        for line in (d.get("address"), d.get("mobile"), d.get("email")):
            if not line:
                continue
            self.fit_font(str(line), left_w, "", 8, floor=6)
            self.cell(left_w, 4.2, str(line), new_x=XPos.LMARGIN,
                      new_y=YPos.NEXT)
        left_bottom = self.get_y()

        # Right column: statement no / period / generated-on.
        meta = []
        if d.get("statement_no"):
            meta.append(("Statement No.", d["statement_no"]))
        meta.append(("Period", self._period_text()))
        meta.append(("Generated", _date(datetime.now(timezone.utc))))
        x = self.l_margin + left_w
        w = self.content_width - left_w
        self.set_y(top)
        for label, value in meta:
            self.set_x(x)
            self.font("", 7.5)
            self.set_text_color(*GREY)
            self.cell(w, 4, label, align="R", new_x=XPos.LMARGIN,
                      new_y=YPos.NEXT)
            self.set_x(x)
            self.font("B", 8.5)
            self.set_text_color(*BLACK)
            self.cell(w, 4.6, str(value), align="R", new_x=XPos.LMARGIN,
                      new_y=YPos.NEXT)
            self.ln(0.8)

        self.set_y(max(left_bottom, self.get_y()) + 2)

    # building blocks ----------------------------------------------------------
    def tiles(self, items: list[tuple[str, str, Optional[str]]]) -> None:
        """A row of summary tiles: (label, value, optional sub-caption).

        The value is auto-shrunk to fit its tile, so a large figure can never
        run into the tile beside it."""
        if not items:
            return
        gap = 2.0
        w = (self.content_width - gap * (len(items) - 1)) / len(items)
        h = 15.5
        y = self.get_y()
        for i, (label, value, sub) in enumerate(items):
            x = self.l_margin + i * (w + gap)
            self.set_fill_color(*LIGHT)
            self.set_draw_color(*RULE)
            self.set_line_width(0.2)
            self.rect(x, y, w, h, style="DF")

            self.set_xy(x + 2, y + 1.8)
            self.font("", 6.6)
            self.set_text_color(*GREY)
            self.cell(w - 4, 3.4, label.upper())

            size = 10.5
            self.font("B", size)
            while size > 6.5 and self.get_string_width(value) > w - 4:
                size -= 0.5
                self.font("B", size)
            self.set_xy(x + 2, y + 5.8)
            self.set_text_color(*BLACK)
            self.cell(w - 4, 5, value)

            if sub:
                self.set_xy(x + 2, y + 11)
                self.font("", 6.2)
                self.set_text_color(*FAINT)
                self.cell(w - 4, 3.2, sub[:44])
        self.set_y(y + h + 4)

    def section(self, title: str, note: Optional[str] = None) -> None:
        """A black section bar — the strongest divider on the page."""
        self._space(11)
        self.set_fill_color(*BLACK)
        self.set_text_color(255, 255, 255)
        self.font("B", 8.5)
        self.cell(self.content_width, 6.4, f"  {title}", fill=True,
                  new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        if note:
            self.font("", 6.8)
            self.set_text_color(*FAINT)
            self.ln(0.8)
            self.cell(self.content_width, 3.4, note, new_x=XPos.LMARGIN,
                      new_y=YPos.NEXT)
        self.ln(1.2)

    def note(self, text: str) -> None:
        self.font("I", 7)
        self.set_text_color(*FAINT)
        self.multi_cell(self.content_width, 3.6, text, new_x=XPos.LMARGIN,
                        new_y=YPos.NEXT)

    def muted(self, text: str) -> None:
        self.font("I", 8)
        self.set_text_color(*GREY)
        self.cell(0, 6, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(1)

    def reconciliation(self, steps: list[tuple[str, str]]) -> None:
        """Opening -> movements -> closing, as one line of arithmetic that the
        reader can verify. This is what ties the statement together."""
        self.ln(1.5)
        w = self.content_width / len(steps)
        y = self.get_y()
        self.set_draw_color(*RULE)
        self.set_line_width(0.2)
        self.rect(self.l_margin, y, self.content_width, 12)
        for i, (label, value) in enumerate(steps):
            x = self.l_margin + i * w
            if i:
                self.set_draw_color(*RULE)
                self.line(x, y + 1.5, x, y + 10.5)
            self.set_xy(x + 2, y + 1.8)
            self.font("", 6.6)
            self.set_text_color(*GREY)
            self.cell(w - 4, 3.4, label.upper())
            self.set_xy(x + 2, y + 5.6)
            self.font("B", 9.5)
            self.set_text_color(*BLACK)
            self.cell(w - 4, 5, value)
        self.set_y(y + 12 + 2)

    def closing(self, label: str, value: int, caption: str,
                *, positive_is_good: bool = True) -> None:
        """The single figure the whole document exists to communicate."""
        self._space(16)
        self.ln(1)
        h = 12
        y = self.get_y()
        self.set_fill_color(*BLACK)
        self.rect(self.l_margin, y, self.content_width, h, style="F")
        self.set_xy(self.l_margin + 3, y + 1.4)
        self.font("B", 10)
        self.set_text_color(255, 255, 255)
        self.cell(self.content_width * 0.6, 5, label)
        self.set_xy(self.l_margin + 3, y + 6.4)
        self.font("", 7.2)
        self.set_text_color(200, 205, 215)
        self.cell(self.content_width * 0.6, 4, caption)

        tone = (255, 255, 255)
        if value:
            good = value > 0 if positive_is_good else value < 0
            tone = (134, 239, 172) if good else (252, 165, 165)
        self.set_xy(self.l_margin + self.content_width * 0.6, y + 3)
        self.font("B", 14)
        self.set_text_color(*tone)
        self.cell(self.content_width * 0.4 - 3,
                  6, self.money(abs(value)), align="R")
        self.set_y(y + h)

    def _space(self, needed: float) -> None:
        """Start a new page rather than orphan a heading at the foot of one."""
        if self.get_y() + needed > self.h - BOTTOM_MARGIN:
            self.add_page()


# --- Table helper -------------------------------------------------------------
def _table(pdf: _Statement, headings: list[str], widths: list[float],
           aligns: list[str], rows: list[list[str]],
           *, totals: Optional[list[str]] = None,
           group_rows: Optional[set[int]] = None,
           font_size: float = 6.6) -> None:
    """Render one data table.

    Wrapping, zebra striping, per-column alignment and heading repetition across
    page breaks all come from fpdf2's table engine — the previous hand-rolled
    version truncated text and left continuation pages headerless.

    ``group_rows`` marks indexes in ``rows`` that are group subtotal bands.
    """
    if not rows:
        pdf.muted("No records in this period.")
        return

    heading_style = FontFace(emphasis="BOLD", color=(255, 255, 255),
                             fill_color=BLACK, size_pt=font_size + 0.4)
    group_style = FontFace(emphasis="BOLD", color=BLACK, fill_color=SUBTOTAL)
    total_style = FontFace(emphasis="BOLD", color=BLACK, fill_color=LIGHT)
    groups = group_rows or set()

    pdf.font("", font_size)
    pdf.set_text_color(*BLACK)
    pdf.set_draw_color(*RULE)
    pdf.set_line_width(0.1)
    # fpdf2 2.8 ignores the table's own `cell_fill_color` and stripes with the
    # document's CURRENT fill colour — which is black right after a section bar.
    # Setting it here is what actually makes the zebra light.
    pdf.set_fill_color(*ZEBRA)
    with pdf.table(
        col_widths=widths,
        text_align=aligns,
        headings_style=heading_style,
        line_height=3.6,
        padding=(1.1, 1.2, 1.1, 1.2),
        cell_fill_color=ZEBRA,
        # Zebra only on the plain rows; group/total bands paint themselves.
        cell_fill_mode=TableCellFillMode.EVEN_ROWS,
        repeat_headings=TableHeadingsDisplay.ON_TOP_OF_EVERY_PAGE,
        first_row_as_headings=True,
        borders_layout="HORIZONTAL_LINES",
        width=pdf.content_width,
    ) as table:
        head = table.row()
        for text in headings:
            head.cell(text)
        for i, cells in enumerate(rows):
            style = group_style if i in groups else None
            row = table.row(style=style)
            for text in cells:
                row.cell(str(text))
        if totals:
            row = table.row(style=total_style)
            for text in totals:
                row.cell(str(text))
    pdf.ln(1)


def _scaled(pdf: _Statement, weights: list[float]) -> list[float]:
    """Turn column weights into millimetre widths filling the content area."""
    total = sum(weights)
    return [w / total * pdf.content_width for w in weights]


# --- Public entry point -------------------------------------------------------
def render_statement_pdf(data: dict) -> bytes:
    """Return PDF bytes for a statement dict (see finance_balance builders)."""
    pdf = _Statement(data)
    pdf.add_page()

    kind = data.get("kind", "partner")
    if kind == "customer":
        _render_customer(pdf, data)
    elif kind == "broker":
        _render_broker(pdf, data)
    else:
        _render_partner(pdf, data)

    _sign_off(pdf)
    return bytes(pdf.output())


def _sign_off(pdf: _Statement) -> None:
    pdf._space(20)
    pdf.ln(4)
    pdf.set_draw_color(*RULE)
    pdf.set_line_width(0.2)
    y = pdf.get_y()
    pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
    pdf.ln(2.5)
    pdf.font("", 7.4)
    pdf.set_text_color(*GREY)
    pdf.multi_cell(
        pdf.content_width, 3.8,
        f"This is a computer-generated statement issued by "
        f"{company.COMPANY_NAME} and is valid without a signature. Figures are "
        f"in Indian Rupees. If anything here does not match your records, "
        f"write to {company.COMPANY_EMAIL} or call {company.COMPANY_PHONE} "
        f"quoting the statement number above.",
        new_x=XPos.LMARGIN, new_y=YPos.NEXT)


# --- Shared sections ----------------------------------------------------------
def _account_section(pdf: _Statement, data: dict, *, title: str,
                     debit_head: str, credit_head: str,
                     note: Optional[str] = None) -> None:
    """The money ledger: opening balance, every movement, running balance."""
    acct = data.get("account") or {}
    rows = acct.get("rows") or []
    m = pdf.money
    pdf.section(title, note)

    widths = _scaled(pdf, [11, 30, 15, 13, 13, 13])
    aligns = ["LEFT", "LEFT", "LEFT", "RIGHT", "RIGHT", "RIGHT"]
    headings = ["Date", "Particulars", "Reference / Policy",
                debit_head, credit_head, "Balance"]

    opening = data.get("opening_balance") or 0
    table_rows = [["", "Opening balance", "", "", "", m.signed(opening)]]
    for r in rows:
        ref = r.get("reference") or r.get("policy") or "-"
        table_rows.append([
            _date(r.get("date")), r.get("label") or "-", str(ref),
            m.plain(r["debit"]) if r.get("debit") else "",
            m.plain(r["credit"]) if r.get("credit") else "",
            m.signed(r.get("balance")),
        ])
    closing = acct.get("closing", opening)
    totals = ["", "Total", "", m.plain(acct.get("total_debit")),
              m.plain(acct.get("total_credit")), m.signed(closing)]

    if not rows:
        _table(pdf, headings, widths, aligns, table_rows)
        pdf.muted("No transactions in this period.")
    else:
        _table(pdf, headings, widths, aligns, table_rows, totals=totals)

    pdf.reconciliation([
        ("Opening balance", m(opening)),
        (f"+ {debit_head}", m(acct.get("total_debit"))),
        (f"- {credit_head}", m(acct.get("total_credit"))),
        ("Closing balance", m(closing)),
    ])


# --- Partner combined transactions ledger -------------------------------------
def _partner_transactions_section(pdf: _Statement, data: dict) -> None:
    """The partner's ONE netted account: reward we owe them less premium they owe
    us, as a single running balance ending at the Net Balance (owner 2026-07-24).
    Balance is in the partner-favour view — positive means the agency owes them.
    """
    acct = data.get("combined_account") or {}
    rows = acct.get("rows") or []
    m = pdf.money
    opening = acct.get("opening", data.get("opening_balance") or 0)
    pdf.section("Transactions")

    widths = _scaled(pdf, [12, 34, 16, 15, 15, 16])
    aligns = ["LEFT", "LEFT", "LEFT", "RIGHT", "RIGHT", "RIGHT"]
    headings = ["Date", "Particulars", "Reference / Policy",
                "Credit (+)", "Debit (-)", "Balance"]

    table_rows = [["", "Opening balance", "", "", "", m.signed(opening)]]
    for r in rows:
        ref = r.get("reference") or r.get("policy") or "-"
        table_rows.append([
            _date(r.get("date")), r.get("label") or "-", str(ref),
            m.plain(r["credit"]) if r.get("credit") else "",
            m.plain(r["debit"]) if r.get("debit") else "",
            m.signed(r.get("balance")),
        ])
    closing = acct.get("closing", opening)
    if rows:
        _table(pdf, headings, widths, aligns, table_rows, totals=[
            "", "Total", "", m.plain(acct.get("total_credit")),
            m.plain(acct.get("total_debit")), m.signed(closing)])
    else:
        _table(pdf, headings, widths, aligns, table_rows)
        pdf.muted("No transactions in this period.")

    pdf.reconciliation([
        ("Opening balance", m(opening)),
        ("+ Credits", m(acct.get("total_credit"))),
        ("- Debits", m(acct.get("total_debit"))),
        ("Closing balance", m(closing)),
    ])


# --- Broker (internal) --------------------------------------------------------
def _render_broker(pdf: _Statement, data: dict) -> None:
    m = pdf.money
    pdf.tiles([
        ("Total Reward", m(data.get("total_reward")), "earned this period"),
        ("Reward Received", m(data.get("reward_received")), "this period"),
        ("Reward Pending to Collect", m(data.get("reward_pending")),
         "current, all-time"),
        ("TDS", m(data.get("total_tds")),
         f"withheld at {_tds_rate(data.get('tds_percent'))}"),
    ])

    pdf.section("Policies placed through this broker")

    # Flat, date-sorted table (owner 2026-07-24) with a Type column, since the
    # rows are no longer grouped under type band headings.
    widths = _scaled(pdf, [12, 17, 15, 19, 17, 16, 16, 10, 16, 12, 15])
    aligns = ["LEFT", "LEFT", "LEFT", "LEFT", "LEFT",
              "RIGHT", "RIGHT", "RIGHT", "RIGHT", "RIGHT", "RIGHT"]
    headings = ["Date", "Policy No", "Type", "Customer", "Channel Partner",
                "Premium", "Reward Base", "Rate", "Reward", "TDS", "Net Profit"]

    rows: list[list[str]] = []
    for r in data.get("policies") or []:
        base = m.plain(r.get("reward_base"))
        if r.get("reward_base_note"):
            base = f"{base}\n{r['reward_base_note']}"
        rows.append([
            _short_date(r.get("date")), r.get("policy_number") or "-",
            r.get("category") or "-", r.get("customer") or "-",
            r.get("partner") or "Direct",
            m.plain(r.get("premium")), base, _pct(r.get("reward_pct")),
            m.plain(r.get("reward")), m.plain(r.get("tds")),
            m.plain(r.get("profit")),
        ])

    totals = ["", "TOTAL", "", "", "",
              m.plain(data.get("total_premium")),
              m.plain(data.get("total_reward_base")), "",
              m.plain(data.get("total_reward")),
              m.plain(data.get("total_tds")),
              m.plain(data.get("total_profit"))]
    _table(pdf, headings, widths, aligns, rows,
           totals=totals if rows else None)

    _account_section(
        pdf, data, title="Transactions",
        debit_head="Debit", credit_head="Credit")

    # Position: what is still to collect, and how we got there.
    pdf._space(30)
    pdf.section("Reward position (all-time)")
    widths = _scaled(pdf, [55, 25])
    body = [
        ["Total reward earned on all policies booked",
         m.plain(data.get("reward_expected_all_time"))],
        ["Less: reward received to date",
         m.plain(data.get("reward_received_all_time"))],
    ]
    _table(pdf, ["Particulars", "Amount"], widths, ["LEFT", "RIGHT"], body,
           totals=["Reward still to collect",
                   m.plain(data.get("reward_pending"))],
           font_size=7.4)

    net = data.get("net_balance") or 0
    caption = ("Nothing outstanding either way" if net == 0
               else "Receivable from this broker" if net > 0
               else "Payable to this broker")
    pdf.closing("Net Balance", net, caption)


# --- Channel partner (handed to the partner) ----------------------------------
def _render_partner(pdf: _Statement, data: dict) -> None:
    m = pdf.money
    reward_owed = data.get("reward_owed") or 0
    premium_balance = data.get("premium_balance") or 0
    pdf.tiles([
        ("Business Generated", m(data.get("total_premium")), "this period"),
        ("Your Reward", m(data.get("total_reward")), "earned this period"),
        ("Reward Payable", m(reward_owed), "current, all-time"),
        ("Premium Recoverable", m(max(0, premium_balance)),
         "premium due from you"),
    ])

    pdf.section("Policies you brought in")

    # Flat, date-sorted table showing the reward % you earned on each policy and
    # the base it was applied to (owner 2026-07-26).
    widths = _scaled(pdf, [13, 19, 24, 15, 17, 19, 12, 18])
    aligns = ["LEFT", "LEFT", "LEFT", "LEFT", "RIGHT", "RIGHT", "RIGHT", "RIGHT"]
    headings = ["Date", "Policy No", "Customer", "Type", "Premium",
                "Commissionable Premium", "Reward %", "Your Reward"]

    rows: list[list[str]] = []
    for r in data.get("policies") or []:
        base = m.plain(r.get("reward_base"))
        if r.get("reward_base_note"):
            base = f"{base}\n{r['reward_base_note']}"
        rows.append([
            _short_date(r.get("date")), r.get("policy_number") or "-",
            r.get("customer") or "-", r.get("category") or "-",
            m.plain(r.get("premium")), base, _pct(r.get("reward_pct")),
            m.plain(r.get("reward")),
        ])

    totals = ["", "TOTAL", "", "", m.plain(data.get("total_premium")),
              m.plain(data.get("total_reward_base")), "",
              m.plain(data.get("total_reward"))]
    _table(pdf, headings, widths, aligns, rows,
           totals=totals if rows else None)

    # One netted account — reward we owe you less premium you owe us.
    _partner_transactions_section(pdf, data)

    net = data.get("net_balance") or 0
    caption = ("Nothing outstanding either way" if net == 0
               else "Payable to you by the agency" if net > 0
               else "Recoverable from you")
    pdf.closing("Net Balance", net, caption)


# --- Customer (handed to the customer) ----------------------------------------
def _render_customer(pdf: _Statement, data: dict) -> None:
    m = pdf.money
    balance = data.get("net_balance") or 0
    pdf.tiles([
        ("Policies", str(len(data.get("policies") or [])), "in this period"),
        ("Total Premium", m(data.get("total_premium")), "this period"),
        ("Paid", m(data.get("total_paid")), "against these policies"),
        ("Net Balance", m(abs(balance)),
         "payable by you" if balance > 0
         else "refundable to you" if balance < 0 else "settled"),
    ])

    pdf.section("Your policies")

    widths = _scaled(pdf, [14, 20, 21, 13, 14, 15, 17, 15, 17, 17, 13])
    aligns = ["LEFT", "LEFT", "LEFT", "LEFT", "RIGHT", "LEFT",
              "RIGHT", "RIGHT", "RIGHT", "RIGHT", "LEFT"]
    headings = ["Date", "Policy No", "Insurer", "Type", "Cover", "Valid Till",
                "Premium", "Discount", "Net Payable", "Paid", "Status"]

    rows: list[list[str]] = []
    for r in data.get("policies") or []:
        rows.append([
            _short_date(r.get("date")), r.get("policy_number") or "-",
            r.get("insurer") or "-", r.get("category") or "-",
            m.whole(r.get("sum_insured")) if r.get("sum_insured") else "-",
            _short_date(r.get("valid_till")),
            m.plain(r.get("premium")),
            m.plain(r["discount"]) if r.get("discount") else "-",
            m.plain(r.get("net_payable")), m.plain(r.get("paid")),
            r.get("status") or "-",
        ])

    totals = ["", "TOTAL", "", "", "", "",
              m.plain(data.get("total_premium")),
              m.plain(data.get("total_discount")),
              m.plain(data.get("total_net_payable")),
              m.plain(data.get("total_paid")), ""]
    _table(pdf, headings, widths, aligns, rows,
           totals=totals if rows else None)

    _account_section(
        pdf, data, title="Transactions",
        debit_head="Charges", credit_head="Payments")

    caption = ("Nothing outstanding — your account is settled" if balance == 0
               else "Payable by you" if balance > 0
               else "Refundable to you by the agency")
    # A customer's balance is "good" when they owe nothing, so a positive
    # (payable) figure is the one flagged red.
    pdf.closing("Net Balance", balance, caption, positive_is_good=False)
