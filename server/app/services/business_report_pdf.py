"""The business report's PDF half — what gets printed and handed over.

It carries the summary, EVERY policy in the period, the channel-partner ledgers,
and a capped slice of transactions (owner 2026-08-04). The policy list is the
part somebody actually reads down and ticks off, so leaving it out — as the old
month pack did — made the PDF a cover sheet rather than a report.

The transaction CAP is the one deliberate omission. A PDF holding four thousand
ledger rows takes seconds to build, is megabytes to email and nobody reads past
the second page; the workbook in the same download carries all of them, and the
PDF says how many it left behind rather than pretending there were no more.

Reuses the statement PDF's typography and company header so the two documents
look like they came from the same office.
"""

from __future__ import annotations

from typing import Optional

from fpdf.enums import XPos, YPos

from app.core.enums import EXPENSE_CATEGORY_LABELS, LedgerTxnType, PartyType
from app.services import company
from app.services.business_report import (
    PDF_POLICY_COLUMNS, POLICY_HEADERS, policy_rows,
)
from app.services.statement_pdf import (
    BLACK,
    FAINT,
    GREEN,
    GREY,
    LIGHT,
    RED,
    RULE,
    _Statement,
    _date,
    _scaled,
    _table,
)

# How many ledger rows the PDF prints before it stops and says so. Chosen so a
# busy month still fits inside a document somebody will open.
MAX_PDF_TRANSACTIONS = 300


class _Pack(_Statement):
    """Reuses the statement chrome (header, footer, fonts, watermark) with the
    report's own title block."""

    def _title_block(self) -> None:
        self.font("B", 13)
        self.set_text_color(*BLACK)
        self.cell(0, 6, self.data.get("title", "Business report"),
                  new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.font("", 8.5)
        self.set_text_color(*GREY)
        self.cell(0, 4.6, self.data.get("subtitle", ""),
                  new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(2)


def _rows(pdf: _Pack, headings: list[str], weights: list[float],
          rows: list[list[str]], aligns: list[str]) -> None:
    """Thin wrapper over the statement table so this module talks in column
    WEIGHTS (which is what the layouts below think in) rather than millimetres."""
    _table(pdf, headings, _scaled(pdf, weights), aligns, rows)


def _tiles(pdf: _Pack, tiles: list[tuple[str, str, Optional[tuple]]]) -> None:
    """A row of headline figures. Three per line, wrapping."""
    per_row = 3
    width = pdf.content_width / per_row
    for i in range(0, len(tiles), per_row):
        chunk = tiles[i:i + per_row]
        top = pdf.get_y()
        for j, (label, value, colour) in enumerate(chunk):
            x = pdf.l_margin + j * width
            pdf.set_xy(x, top)
            pdf.set_fill_color(*LIGHT)
            pdf.rect(x + 1, top, width - 2, 15, style="F")
            pdf.set_xy(x + 3, top + 2)
            pdf.font("", 7)
            pdf.set_text_color(*GREY)
            pdf.cell(width - 6, 4, label.upper())
            pdf.set_xy(x + 3, top + 7)
            pdf.fit_font(value, width - 6, "B", 12)
            pdf.set_text_color(*(colour or BLACK))
            pdf.cell(width - 6, 6, value)
        pdf.set_y(top + 17)
    pdf.set_text_color(*BLACK)


def _section(pdf: _Pack, title: str, note: str = "") -> None:
    pdf.ln(1)
    pdf.font("B", 10)
    pdf.set_text_color(*BLACK)
    pdf.cell(0, 5.5, title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    if note:
        pdf.font("", 7.5)
        pdf.set_text_color(*FAINT)
        pdf.cell(0, 4, note, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_draw_color(*RULE)
    pdf.set_line_width(0.2)
    y = pdf.get_y() + 0.5
    pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
    pdf.ln(2.5)


def build_pdf(data: dict, period_label: str) -> bytes:
    """Render the report PDF for a collected period (see business_report
    .collect)."""
    pdf = _Pack({
        "title": f"Business report — {period_label}",
        "subtitle": f"{company.COMPANY_NAME} · generated "
                    f"{_date(data['hi'])}",
        "kind": "business_report",
        "label": period_label,
        # The continuation-page header reads these.
        "period_label": period_label,
        "date_from": data["lo"], "date_to": data["hi"],
    })
    # The document owns the rupee formatter (it knows whether the Unicode face
    # loaded), so it can only be taken after construction.
    money = pdf.money
    pdf.add_page()

    policies = data["policies"]
    finance = data["finance"]
    cash = data["cash"]
    can_profit = data["can_view_profit"]

    premium = sum(p.premium_amount for p in policies)
    reward = sum(f.agency_reward for f in finance.values())
    partner_share = sum(f.partner_share for f in finance.values())
    profit = sum(f.house_profit for f in finance.values())
    renewals = sum(1 for p in policies if p.renewed_from_policy_id)
    tds_total = sum(e.tds_paise for e in data["tds"])
    net = cash["net_profit"]

    _section(pdf, "The month at a glance",
             "Volume figures cover the period. Balances are current positions.")
    tiles: list[tuple[str, str, Optional[tuple]]] = [
        ("Policies booked", str(len(policies)), None),
        ("Gross premium", money(premium), None),
        ("Reward earned", money(reward), None),
        ("Premium collected", money(cash["premium_collected"]), None),
        ("Reward received", money(cash["reward_received"]), None),
        ("Expenses", money(cash["expenses"]), None),
    ]
    if can_profit:
        tiles.append(("Net profit (cash)", money(net),
                      GREEN if net >= 0 else RED))
    tiles.append(("Renewals booked", str(renewals), None))
    tiles.append(("TDS withheld", money(tds_total), None))
    _tiles(pdf, tiles)

    # --- Cash in / out, the reconciling view ---
    _section(pdf, "Cash movement", "Money that actually moved in the period.")
    rows = [
        ["Premium collected from buyers", money.plain(cash["premium_collected"])],
        ["Reward received from brokers", money.plain(cash["reward_received"])],
        ["Premium fronted to insurers", "-" + money.plain(cash["premium_fronted"])],
        ["Paid to channel partners", "-" + money.plain(cash["partner_payouts"])],
        ["Refunds paid", "-" + money.plain(cash["refunds"])],
        ["House expenses", "-" + money.plain(cash["expenses"])],
    ]
    if can_profit:
        rows.append(["Net profit (cash basis)", money.signed(net)])
    _rows(pdf, ["Movement", "Amount"], [0.75, 0.25], rows, ["L", "R"])

    # --- Accrual view ---
    _section(pdf, "Booked business",
             "What the policies written this period are worth, whether or not "
             "the money has moved yet.")
    accrual = [
        ["Gross premium", money.plain(premium)],
        ["Reward earned from insurers", money.plain(reward)],
        ["Share owed to channel partners", money.plain(partner_share)],
    ]
    if can_profit:
        accrual.append(["House profit", money.signed(profit)])
    _rows(pdf, ["Figure", "Amount"], [0.75, 0.25], accrual, ["L", "R"])

    # --- Per-party summaries ---
    def rollup(key_of, label_of, limit: int = 15) -> list[list[str]]:
        agg: dict[str, dict] = {}
        for p in policies:
            key = key_of(p)
            if not key:
                continue
            row = agg.setdefault(key, {"n": 0, "premium": 0, "profit": 0})
            row["n"] += 1
            row["premium"] += p.premium_amount
            pf = finance.get(str(p.id))
            if pf:
                row["profit"] += pf.house_profit
        ordered = sorted(agg.items(), key=lambda kv: -kv[1]["premium"])[:limit]
        return [[label_of(k), str(v["n"]), money.plain(v["premium"])]
                + ([money.signed(v["profit"])] if can_profit else [])
                for k, v in ordered]

    customers, brokers, users = data["customers"], data["brokers"], data["users"]

    def brok(bid): return brokers[bid].name if bid in brokers else "-"
    def person(uid): return users[uid].full_name if uid in users else "-"
    def cust(cid): return customers[cid].name if cid in customers else "-"

    headings = ["Name", "Policies", "Premium"] + (["Profit"] if can_profit else [])
    weights = [0.5, 0.14, 0.18] + ([0.18] if can_profit else [])
    align = ["L", "R", "R"] + (["R"] if can_profit else [])

    for title, rows_fn in (
        ("Brokers", lambda: rollup(lambda p: p.broker_id, brok)),
        ("Channel partners", lambda: rollup(lambda p: p.partner_id, person)),
        ("Top customers", lambda: rollup(lambda p: p.customer_id, cust, 10)),
    ):
        body = rows_fn()
        if not body:
            continue
        _section(pdf, title)
        _rows(pdf, headings, weights, body, align)

    # --- Expenses by category ---
    expenses = [t for t in data["txns"] if t.txn_type == LedgerTxnType.EXPENSE]
    if expenses:
        by_cat: dict[str, int] = {}
        for t in expenses:
            key = t.expense_category or "other"
            by_cat[key] = by_cat.get(key, 0) + abs(t.amount_paise)
        _section(pdf, "Expenses by category")
        _rows(pdf, ["Category", "Amount"], [0.75, 0.25],
              [[EXPENSE_CATEGORY_LABELS.get(k, "Other"), money.plain(v)]
               for k, v in sorted(by_cat.items(), key=lambda kv: -kv[1])],
              ["L", "R"])

    # --- Outstanding, point in time ---
    balances = [(a, a.balance_paise) for a in data.get("party_accounts", [])
                if a.balance_paise]
    if balances:
        def label(a) -> str:
            ptype = a.party_type.value if hasattr(a.party_type, "value") \
                else a.party_type
            if ptype == PartyType.CUSTOMER.value:
                return cust(a.party_id)
            if ptype == PartyType.BROKER.value:
                return brok(a.party_id)
            if ptype == PartyType.CHANNEL_PARTNER.value:
                return person(a.party_id)
            return "House"

        receivable = sum(b for _a, b in balances if b > 0)
        payable = -sum(b for _a, b in balances if b < 0)
        _section(pdf, "Outstanding as of today",
                 "A current position, not a figure for the period.")
        _tiles(pdf, [
            ("To collect", money(receivable), GREEN),
            ("To pay", money(payable), RED),
            ("Net", money(receivable - payable), None),
        ])
        top = sorted(balances, key=lambda ab: -abs(ab[1]))[:12]
        _rows(pdf, ["Party", "They owe us", "We owe them"],
              [0.5, 0.25, 0.25],
              [[label(a), money.plain(b) if b > 0 else "",
                money.plain(b) if b < 0 else ""] for a, b in top],
              ["L", "R", "R"])

    # --- Renewals coming up ---
    due = data.get("renewals_due", [])
    if due:
        _section(pdf, "Renewals due next month",
                 f"{len(due)} polic{'ies' if len(due) != 1 else 'y'} expiring.")
        _rows(pdf, ["Policy", "Customer", "Expires", "Premium"],
              [0.22, 0.4, 0.18, 0.2],
              [[p.code, cust(p.customer_id), _date(p.expiry_date),
                money.plain(p.premium_amount)] for p in due[:20]],
              ["L", "L", "L", "R"])

    # --- EVERY policy, in full ---
    # The part somebody reads down and ticks off. Landscape, because the reward
    # rate is only meaningful next to the base it was applied to, and those two
    # plus the parties do not fit across a portrait page.
    if policies:
        pdf.add_page(orientation="L")
        _section(pdf, "Policies booked",
                 f"All {len(policies)} in the period, in the order they were "
                 f"entered.")
        headings = [POLICY_HEADERS[i] for i in PDF_POLICY_COLUMNS]
        weights = [0.11, 0.15, 0.12, 0.11, 0.12, 0.08, 0.08, 0.06, 0.07, 0.05,
                   0.05]
        aligns = ["L", "L", "L", "L", "L", "R", "R", "L", "R", "R", "R"]
        if not can_profit:
            # Drop the trailing profit column rather than printing a column of
            # zeroes that reads like every policy lost money.
            headings, weights, aligns = headings[:-1], weights[:-1], aligns[:-1]
        body = []
        for row in policy_rows(data):
            picked = [row[i] for i in PDF_POLICY_COLUMNS]
            if not can_profit:
                picked = picked[:-1]
            body.append([f"{v:,.2f}" if isinstance(v, float) else str(v or "")
                         for v in picked])
        _rows(pdf, headings, weights, body, aligns)

    # --- Channel partner ledgers ---
    # One running account per partner: the page that gets printed and handed to
    # them. Same numbers as their own statement — both come from
    # finance_balance.partner_ledger.
    ledgers = data.get("partner_ledgers", [])
    if ledgers:
        pdf.add_page()
        _section(pdf, "Channel partner accounts",
                 "Reward owed to them, netted against premium they owe us. A "
                 "positive balance means the agency owes the partner.")
        for led in ledgers:
            pdf.ln(1)
            pdf.font("B", 9)
            pdf.set_text_color(*BLACK)
            who = f"{led['name']} ({led['code']})" if led["code"] else led["name"]
            pdf.cell(0, 5, who, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
            body = [["", "Opening balance", "", "", money.signed(led["opening"])]]
            for r in led["rows"]:
                body.append([
                    _date(r["date"]), r["label"], r["policy"] or "",
                    money.plain(r["credit"]) if r["credit"]
                    else "-" + money.plain(r["debit"]),
                    money.signed(r["balance"]),
                ])
            body.append(["", "Closing balance", "", "",
                         money.signed(led["closing"])])
            _rows(pdf, ["Date", "Entry", "Policy", "Amount", "Balance"],
                  [0.14, 0.4, 0.16, 0.15, 0.15], body,
                  ["L", "L", "L", "R", "R"])

    # --- Transactions, capped ---
    txns = data.get("txns", [])
    if txns:
        pdf.add_page()
        shown = txns[:MAX_PDF_TRANSACTIONS]
        note = "Every cash movement in the period."
        if len(txns) > len(shown):
            note = (f"The first {len(shown)} of {len(txns)}. The remaining "
                    f"{len(txns) - len(shown)} are in the Excel download.")
        _section(pdf, "Transactions", note)

        def party(t) -> str:
            ptype = t.party_type.value if hasattr(t.party_type, "value") \
                else t.party_type
            if ptype == PartyType.CUSTOMER.value:
                return cust(t.party_id)
            if ptype == PartyType.BROKER.value:
                return brok(t.party_id)
            if ptype == PartyType.CHANNEL_PARTNER.value:
                return person(t.party_id)
            return t.paid_to_name or "House"

        from app.services.txn_display import ledger_label

        _rows(pdf, ["Date", "Type", "Party", "Reference", "Amount"],
              [0.13, 0.28, 0.28, 0.16, 0.15],
              [[_date(t.occurred_at), ledger_label(t.txn_type, t.party_type),
                party(t), t.reference or "",
                money.plain(abs(t.amount_paise))] for t in shown],
              ["L", "L", "L", "L", "R"])

    if not can_profit:
        pdf.ln(2)
        pdf.font("", 7.5)
        pdf.set_text_color(*FAINT)
        pdf.cell(0, 4, "Profit figures are hidden for your permission level.",
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    return bytes(pdf.output())
