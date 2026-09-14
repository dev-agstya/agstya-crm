"""The business report: one download with everything that happened in a period.

Owner 2026-08-04, replacing the "month pack". The pack answered "how did the
month go"; this answers "show me every policy, every rupee and every party, in
enough detail that I can check it". The difference is mostly in the POLICY
detail — the pack's policy sheet carried no reward rate, no reward base and no
channel-partner name, which are the three columns you actually reconcile with.

WHICH DATE DECIDES THE PERIOD (owner A3.2)
------------------------------------------
The app deliberately runs two conventions: the Balance Sheet buckets a policy on
its COVER START date, while Overview and Reports bucket on the date it was
ENTERED. This report follows Reports, because it sits on that page:

    cash sheets     -> the transaction date (occurred_at)
    policy sheets   -> the entry date (created_at), with the cover start date
                       carried as its own column so nothing is ambiguous

SHAPE
-----
Excel is the data — seventeen sheets, every row, money as NUMBERS so a column
can be summed. The PDF is what gets printed and handed over: the summary, the
full policy list, the partner ledgers, and a capped slice of transactions.

SIZE
----
Every read is bounded by the window and the per-policy finance snapshots are
fetched with an `$in` on the window's policy ids rather than a whole-collection
scan (the rule CLAUDE.md sets for new finance reads). Beyond that there is a
hard row cap: this app runs as ONE small instance, and a "Till date" download on
a big book would exhaust its memory rather than time out. Refusing with a
sentence beats dying silently.
"""

from __future__ import annotations

import io
from datetime import datetime, timedelta
from typing import Optional

from beanie import PydanticObjectId
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from app.core.enums import (
    EXPENSE_CATEGORY_LABELS,
    LedgerTxnType,
    PartyType,
    PolicyStatus,
)
from app.models.bank import BankAccount
from app.models.broker import Broker
from app.models.customer import Customer
from app.models.finance import LedgerTxn, PartyAccount, PolicyFinance, TdsEntry
from app.models.insurer import Insurer
from app.models.lead import Lead
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.reward import Reward
from app.models.user import User
from app.services import finance_balance, finance_profit, policy_columns
from app.services.categories import labels_for_path
from app.services.exporters import _safe_cell
from app.services.finance_reports import (
    IST, month_key, resolve_period, shift_month, to_ist,
)
from app.services.txn_display import ledger_label

_XLSX_MIME = ("application/vnd.openxmlformats-officedocument"
              ".spreadsheetml.sheet")

_HEAD_FILL = PatternFill("solid", fgColor="1F2937")
_TOTAL_FILL = PatternFill("solid", fgColor="F1F5F9")
_THIN = Side(style="thin", color="E2E8F0")

# The ceiling. Chosen to sit far above any real month and far below what would
# take this instance down: hydrating Pydantic documents is the cost here, not
# the query, so the limit is on ROWS rather than on time.
MAX_POLICIES = 25_000
MAX_TRANSACTIONS = 50_000


class ReportTooLarge(Exception):
    """The chosen period holds more rows than one file can carry.

    Raised BEFORE any building starts, so the caller gets a sentence it can show
    rather than a request that dies half-way through a huge workbook.
    """


def rupees(paise: Optional[int]) -> float:
    """Paise -> rupees as a NUMBER, so Excel can sum the column.

    Exporting money as a formatted string is the classic mistake here: the file
    looks right and the accountant cannot add it up.
    """
    return round((paise or 0) / 100, 2)


def month_window(month: str) -> tuple[datetime, datetime, str]:
    """('2026-07') -> (first instant, last instant, 'July 2026'), all IST."""
    year, mon = int(month[:4]), int(month[5:7])
    lo = datetime(year, mon, 1, tzinfo=IST)
    ny, nm = shift_month(year, mon, 1)
    hi = datetime(ny, nm, 1, tzinfo=IST) - timedelta(seconds=1)
    return lo, hi, lo.strftime("%B %Y")


def report_window(period: str, now: datetime, *,
                  date_from: Optional[datetime] = None,
                  date_to: Optional[datetime] = None,
                  ) -> tuple[datetime, datetime, str]:
    """The report's period, from the SAME presets the rest of the app uses.

    `finance_reports.resolve_period` is the one place that knows what "last 3
    months" means and that a year here is the Indian financial year. A second
    copy would eventually disagree with the charts sitting directly above the
    download button.
    """
    return resolve_period(period, now, date_from, date_to)


def filename_stem(lo: datetime, hi: datetime) -> str:
    """`Agastya-Report-Jul-2026` for a whole calendar month, otherwise the range
    spelled out. A file called `report.xlsx` is unfindable a month later in a
    folder of twenty of them."""
    a, b = to_ist(lo), to_ist(hi)
    whole_month = (a.day == 1 and a.month == b.month and a.year == b.year
                   and (b + timedelta(days=1)).month != b.month)
    if whole_month:
        return f"Agastya-Report-{a.strftime('%b-%Y')}"
    return f"Agastya-Report-{a.strftime('%d%b%Y')}-{b.strftime('%d%b%Y')}"


def _date(dt: Optional[datetime]) -> str:
    return to_ist(dt).strftime("%d-%m-%Y") if dt else ""


def _status(value) -> str:
    raw = value.value if hasattr(value, "value") else str(value or "")
    return raw.replace("_", " ").title()


def _enum(value) -> str:
    return value.value if hasattr(value, "value") else str(value or "")


# --- Data gathering ---------------------------------------------------------------


async def collect(lo: datetime, hi: datetime, *, can_view_profit: bool) -> dict:
    """Everything the report needs, read once and shared by both renderers.

    Profit is zeroed HERE, not in the renderers, so a viewer without
    view_agency_profit cannot get it from either format — the same server-side
    blanking the screens do. Doing it in one renderer and forgetting the other
    is exactly how a permission leaks.
    """
    window = {"$gte": lo, "$lte": hi}

    policy_count = await Policy.find({"created_at": window}).count()
    txn_count = await LedgerTxn.find({"occurred_at": window}).count()
    if policy_count > MAX_POLICIES or txn_count > MAX_TRANSACTIONS:
        raise ReportTooLarge(
            f"This period holds {policy_count:,} policies and "
            f"{txn_count:,} transactions, which is more than one file can "
            f"carry. Choose a shorter period.")

    policies = await Policy.find({"created_at": window}).sort("+created_at").to_list()
    policy_ids = [str(p.id) for p in policies]

    # $in-scoped, not a full scan (CLAUDE.md: never widen the find_all pattern).
    finance: dict[str, PolicyFinance] = {}
    rewards: dict[str, str] = {}
    if policy_ids:
        async for pf in PolicyFinance.find({"policy_id": {"$in": policy_ids}}):
            finance[pf.policy_id] = pf
        async for r in Reward.find({"policy_id": {"$in": policy_ids}}):
            rewards[r.policy_id] = _enum(r.status)

    txns = await LedgerTxn.find({"occurred_at": window}).sort("+occurred_at").to_list()
    tds = await TdsEntry.find({"occurred_at": window}).to_list()
    leads = await Lead.find({"created_at": window}).to_list()

    # Positions are point-in-time and deliberately NOT windowed — "what is
    # outstanding" is a fact about today, not about July (the same
    # windowed-volume / current-position split the balance sheet keeps).
    party_accounts = await PartyAccount.find_all().to_list()

    # Renewals falling due in the month AFTER the window.
    ny, nm = shift_month(to_ist(hi).year, to_ist(hi).month, 1)
    next_lo = datetime(ny, nm, 1, tzinfo=IST)
    n2y, n2m = shift_month(ny, nm, 1)
    next_hi = datetime(n2y, n2m, 1, tzinfo=IST) - timedelta(seconds=1)
    renewals_due = await Policy.find({
        "status": {"$in": [PolicyStatus.ACTIVE.value,
                           PolicyStatus.RENEWAL_DUE.value]},
        "expiry_date": {"$gte": next_lo, "$lte": next_hi},
    }).sort("+expiry_date").to_list()

    # Names, resolved in bulk.
    customers = {str(c.id): c for c in await Customer.find_all().to_list()}
    brokers = {str(b.id): b for b in await Broker.find_all().to_list()}
    insurers = {str(i.id): i for i in await Insurer.find_all().to_list()}
    category_docs = {c.key: c for c in await PolicyCategory.find_all().to_list()}
    categories = {k: c.label for k, c in category_docs.items()}
    users = {str(u.id): u for u in await User.find_all().to_list()}
    accounts = {str(a.id): a for a in await BankAccount.find_all().to_list()}
    bank_accounts = sorted(accounts.values(), key=lambda a: (not a.active, a.name))

    if not can_view_profit:
        for pf in finance.values():
            pf.house_profit = 0

    cash = await finance_profit.realized_profit(lo, hi)
    if not can_view_profit:
        cash = {**cash, "net_profit": 0}

    ledgers = await _partner_ledgers(lo, hi, policies, txns, users)

    return {
        "lo": lo, "hi": hi, "policies": policies, "finance": finance,
        "rewards": rewards, "txns": txns, "tds": tds, "leads": leads,
        "customers": customers, "brokers": brokers, "insurers": insurers,
        "categories": categories, "category_docs": category_docs,
        "users": users, "accounts": accounts, "bank_accounts": bank_accounts,
        "cash": cash, "party_accounts": party_accounts,
        "renewals_due": renewals_due, "partner_ledgers": ledgers,
        "monthly": monthly_rows(lo, hi, policies, finance, txns),
        "can_view_profit": can_view_profit,
    }


async def _partner_ledgers(lo: datetime, hi: datetime, policies: list,
                           txns: list, users: dict) -> list[dict]:
    """A running account per channel partner who had ANY activity in the window.

    Built from `finance_balance.partner_ledger` — the same function behind the
    partner Statement PDF — so a partner holding their statement and the agency
    holding this report are reading one ledger, not two.

    Only partners who actually appear are built: a book with three hundred
    partners and four active ones must not cost three hundred ledgers.
    """
    active: set[str] = {p.partner_id for p in policies if p.partner_id}
    for t in txns:
        if _enum(t.party_type) == PartyType.CHANNEL_PARTNER.value and t.party_id:
            active.add(t.party_id)
    if not active:
        return []

    # Codes for any policy a ledger row can point at. Every such row is a
    # LedgerTxn inside the window, so the window's own txns name them all.
    codes = {str(p.id): (p.policy_number or p.code) for p in policies}
    missing = {t.policy_id for t in txns
               if t.policy_id and t.policy_id not in codes}
    oids = []
    for pid in missing:
        try:
            oids.append(PydanticObjectId(pid))
        except Exception:  # noqa: BLE001 — a malformed legacy id
            continue
    if oids:
        for p in await Policy.find({"_id": {"$in": oids}}).to_list():
            codes[str(p.id)] = p.policy_number or p.code

    def _name(pid: str) -> str:
        return users[pid].full_name if pid in users else pid

    out: list[dict] = []
    for pid in sorted(active, key=_name):
        ledger = await finance_balance.partner_ledger(pid, lo, hi, codes)
        if not ledger["rows"] and not ledger["opening"]:
            continue
        user = users.get(pid)
        out.append({
            "partner_id": pid,
            "name": _name(pid),
            "code": user.code if user else "",
            **ledger,
        })
    return out


def monthly_rows(lo: datetime, hi: datetime, policies: list, finance: dict,
                 txns: list) -> list[dict]:
    """One row per calendar month in the window.

    A three-month range that reports only a total hides the very thing it was
    chosen to show — whether the business went up or down across those months.
    """
    buckets: dict[str, dict] = {}

    def bucket(when: datetime) -> dict:
        key = month_key(when)
        return buckets.setdefault(key, {
            "key": key, "label": to_ist(when).strftime("%b %Y"),
            "policies": 0, "premium": 0, "reward": 0, "partner": 0,
            "profit": 0, "expenses": 0, "collected": 0, "received": 0,
        })

    for p in policies:
        row = bucket(p.created_at)
        row["policies"] += 1
        row["premium"] += p.premium_amount
        pf = finance.get(str(p.id))
        if pf:
            row["reward"] += pf.agency_reward
            row["partner"] += pf.partner_share
            row["profit"] += pf.house_profit

    for t in txns:
        row = bucket(t.occurred_at)
        if t.txn_type == LedgerTxnType.EXPENSE:
            row["expenses"] += abs(t.amount_paise)
        elif t.txn_type == LedgerTxnType.PREMIUM_COLLECTED:
            row["collected"] += abs(t.amount_paise)
        elif t.txn_type == LedgerTxnType.REWARD_RECEIVED:
            row["received"] += abs(t.amount_paise)

    return [buckets[k] for k in sorted(buckets)]


def _summary_rows(data: dict) -> list[tuple]:
    policies, finance, cash = data["policies"], data["finance"], data["cash"]
    premium = sum(p.premium_amount for p in policies)
    reward = sum(pf.agency_reward for pf in finance.values())
    partner = sum(pf.partner_share for pf in finance.values())
    profit = sum(pf.house_profit for pf in finance.values())
    renewals = sum(1 for p in policies if p.renewed_from_policy_id)
    tds_total = sum(e.tds_paise for e in data["tds"])

    return [
        ("Policies booked", len(policies)),
        ("— of which renewals", renewals),
        ("Gross premium", rupees(premium)),
        ("Reward earned (accrual)", rupees(reward)),
        ("Partner share (accrual)", rupees(partner)),
        ("House profit (accrual)", rupees(profit)),
        ("", ""),
        ("Premium collected (cash in)", rupees(cash["premium_collected"])),
        ("Reward received (cash in)", rupees(cash["reward_received"])),
        ("Premium fronted (cash out)", rupees(cash["premium_fronted"])),
        ("Partner payouts (cash out)", rupees(cash["partner_payouts"])),
        ("Refunds (cash out)", rupees(cash["refunds"])),
        ("Expenses (cash out)", rupees(cash["expenses"])),
        ("Net profit (cash basis)", rupees(cash["net_profit"])),
        ("", ""),
        ("TDS withheld by brokers", rupees(tds_total)),
    ]


# --- The policy row, shared by both renderers ---------------------------------------

POLICY_HEADERS = [
    "Policy code", "Policy number", "Entered on", "Cover start", "Expiry",
    "Customer", "Policy type", "Sub-type", "Insurer", "Broker",
    "Channel partner", "Booked by", "Relationship manager", "Status", "Renewal",
    "Premium (Rs)", "Reward base amount (Rs)", "Reward base",
    "Agency reward %", "Agency reward (Rs)",
    "Partner %", "Partner share (Rs)",
    "Discount (Rs)", "Net profit (Rs)", "Reward eligibility", "Reward outcome",
]

# Which POLICY_HEADERS columns the PDF prints. The full set is 26 columns wide,
# which is a spreadsheet, not a page — these are the ones you check a policy by.
PDF_POLICY_COLUMNS = [1, 5, 8, 9, 10, 15, 17, 18, 19, 21, 23]


def policy_rows(data: dict) -> list[tuple]:
    """THE policy detail, in one place.

    Both the workbook and the PDF print this and the per-type sheets extend it,
    so the reward rate a policy shows can never differ between the Excel and the
    PDF of the same download.
    """
    customers, brokers = data["customers"], data["brokers"]
    insurers, categories = data["insurers"], data["categories"]
    cat_docs, users = data["category_docs"], data["users"]
    finance, rewards = data["finance"], data["rewards"]

    out = []
    for p in data["policies"]:
        pf = finance.get(str(p.id))
        cat = cat_docs.get(p.category_key)
        # The base the % was actually applied to. The snapshot's figure is
        # authoritative — it is what the money was booked from — and the
        # policy's own commissionable premium is the fallback for a policy that
        # has not been booked yet (a partner's pending submission).
        base = pf.commissionable if pf else p.commissionable_premium
        out.append((
            p.code,
            p.policy_number or "",
            _date(p.created_at),
            _date(p.start_date),
            _date(p.expiry_date),
            customers[p.customer_id].name if p.customer_id in customers else "",
            categories.get(p.category_key, p.category_key or ""),
            " > ".join(labels_for_path(cat.children, p.subcategory_path))
            if cat and p.subcategory_path else "",
            insurers[p.insurer_id].name if p.insurer_id in insurers else "",
            brokers[p.broker_id].name if p.broker_id in brokers else "",
            users[p.partner_id].full_name
            if p.partner_id and p.partner_id in users else "",
            users[p.owner_user_id].full_name
            if p.owner_user_id in users else "",
            p.manager_name or "",
            _status(p.status),
            "Yes" if p.renewed_from_policy_id else "",
            rupees(p.premium_amount),
            rupees(base),
            policy_columns.reward_base_label(p.reward_base_field, cat),
            policy_columns.reward_pct(p.reward.agency_basis,
                                      p.reward.agency_value, base),
            rupees(pf.agency_reward if pf else 0),
            policy_columns.reward_pct(p.reward.partner_basis,
                                      p.reward.partner_value, base)
            if p.partner_id else "",
            rupees(pf.partner_share if pf else 0),
            rupees(pf.discount if pf else 0),
            rupees(pf.house_profit if pf else 0),
            policy_columns.eligibility(rewards.get(str(p.id))),
            policy_columns.outcome_label(rewards.get(str(p.id))),
        ))
    return out


def _policy_total_row(data: dict) -> tuple:
    policies, finance = data["policies"], data["finance"]
    return ("Total",) + ("",) * 14 + (
        rupees(sum(p.premium_amount for p in policies)),
        rupees(sum(f.commissionable for f in finance.values())),
        "", "",
        rupees(sum(f.agency_reward for f in finance.values())),
        "",
        rupees(sum(f.partner_share for f in finance.values())),
        rupees(sum(f.discount for f in finance.values())),
        rupees(sum(f.house_profit for f in finance.values())),
        "", "")


def _manager_totals(data: dict) -> dict[str, dict]:
    """Per-relationship-manager roll-up for the period.

    Reads the FROZEN `manager_name` stamped on each policy at booking, exactly
    like routers/managers — reassigning a partner must not rewrite what their
    old manager is credited with in a report already circulated.

    Policies whose manager could not be resolved land under "Unassigned" rather
    than being dropped, so the sheet still totals to the company figure.
    """
    finance = data["finance"]
    out: dict[str, dict] = {}
    for p in data["policies"]:
        key = p.manager_name or "Unassigned"
        row = out.setdefault(key, {
            "policies": 0, "premium": 0, "partner_premium": 0,
            "own_premium": 0, "reward": 0, "partner_share": 0, "profit": 0})
        f = finance.get(str(p.id))
        row["policies"] += 1
        row["premium"] += p.premium_amount
        # The split the managers page shows: business their partners brought
        # versus what they sold themselves (owner T7).
        if p.partner_id:
            row["partner_premium"] += p.premium_amount
        else:
            row["own_premium"] += p.premium_amount
        if f is not None:
            row["reward"] += f.agency_reward
            row["partner_share"] += f.partner_share
            row["profit"] += f.house_profit
    return out


def _manager_rows(data: dict) -> list[tuple]:
    totals = _manager_totals(data)
    return [
        (name, r["policies"], rupees(r["premium"]),
         rupees(r["partner_premium"]), rupees(r["own_premium"]),
         rupees(r["reward"]), rupees(r["partner_share"]), rupees(r["profit"]))
        for name, r in sorted(totals.items(), key=lambda kv: -kv[1]["premium"])
    ]


def _manager_total_row(data: dict) -> tuple:
    totals = _manager_totals(data).values()
    return ("Total", sum(r["policies"] for r in totals),
            rupees(sum(r["premium"] for r in totals)),
            rupees(sum(r["partner_premium"] for r in totals)),
            rupees(sum(r["own_premium"] for r in totals)),
            rupees(sum(r["reward"] for r in totals)),
            rupees(sum(r["partner_share"] for r in totals)),
            rupees(sum(r["profit"] for r in totals)))


def _detail_value(spec, value) -> object:
    """One type-specific field, in the form Excel should hold it in.

    `amount` fields are stored in paise and come out as summable rupees — being
    able to total an OD column is the whole reason the per-type sheets exist.
    """
    if value is None or value == "":
        return ""
    if spec.type == "amount":
        return rupees(int(value))
    if spec.type == "checkbox":
        return "Yes" if value else "No"
    if spec.type == "multi_select" and isinstance(value, list):
        return ", ".join(str(v) for v in value)
    return str(value)


# --- Excel ----------------------------------------------------------------------


def _sheet(wb: Workbook, title: str, headers: list[str], rows: list[tuple], *,
           total_row: Optional[tuple] = None) -> None:
    ws = wb.create_sheet(title[:31])
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = _HEAD_FILL
        cell.alignment = Alignment(vertical="center")
    widths = [len(str(h)) for h in headers]
    for row in rows:
        ws.append([_safe_cell(v) for v in row])
        for i, v in enumerate(row):
            if i < len(widths):
                widths[i] = max(widths[i],
                                min(50, len(str(v if v is not None else ""))))
    if total_row is not None:
        ws.append([_safe_cell(v) for v in total_row])
        for cell in ws[ws.max_row]:
            cell.font = Font(bold=True)
            cell.fill = _TOTAL_FILL
            cell.border = Border(top=_THIN)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w + 2
    ws.freeze_panes = "A2"
    if not rows:
        ws.append(["No records in this period."])


def build_workbook(data: dict, period_label: str) -> bytes:
    """The workbook. Money is written as numbers, not strings."""
    wb = Workbook()
    wb.remove(wb.active)

    policies = data["policies"]
    finance = data["finance"]
    customers, brokers = data["customers"], data["brokers"]
    insurers, categories = data["insurers"], data["categories"]
    users, accounts = data["users"], data["accounts"]
    cat_docs = data["category_docs"]

    def cust(cid): return customers[cid].name if cid in customers else ""
    def brok(bid): return brokers[bid].name if bid in brokers else ""
    def insr(iid): return insurers[iid].name if iid in insurers else ""
    def person(uid): return users[uid].full_name if uid in users else ""
    def acct(aid): return accounts[aid].name if aid in accounts else ""

    # 1. Summary
    ws = wb.create_sheet("Summary")
    ws.append([f"Business report — {period_label}"])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append([])
    ws.append(["Figure", "Amount (Rs)"])
    for cell in ws[3]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = _HEAD_FILL
    for label, value in _summary_rows(data):
        ws.append([label, value])
    if not data["can_view_profit"]:
        ws.append([])
        ws.append(["Profit figures are hidden for your permission level."])
    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 18

    # 2. Revenue by month — the trend a multi-month range exists to show.
    monthly = data["monthly"]
    _sheet(wb, "Revenue by month",
           ["Month", "Policies", "Premium (Rs)", "Reward earned (Rs)",
            "Partner share (Rs)", "House profit (Rs)",
            "Premium collected (Rs)", "Reward received (Rs)", "Expenses (Rs)"],
           [(m["label"], m["policies"], rupees(m["premium"]),
             rupees(m["reward"]), rupees(m["partner"]), rupees(m["profit"]),
             rupees(m["collected"]), rupees(m["received"]),
             rupees(m["expenses"])) for m in monthly],
           total_row=("Total", sum(m["policies"] for m in monthly),
                      rupees(sum(m["premium"] for m in monthly)),
                      rupees(sum(m["reward"] for m in monthly)),
                      rupees(sum(m["partner"] for m in monthly)),
                      rupees(sum(m["profit"] for m in monthly)),
                      rupees(sum(m["collected"] for m in monthly)),
                      rupees(sum(m["received"] for m in monthly)),
                      rupees(sum(m["expenses"] for m in monthly))))

    # 3. Policies — the master list.
    _sheet(wb, "Policies", POLICY_HEADERS, policy_rows(data),
           total_row=_policy_total_row(data))

    # 4. One sheet per policy TYPE that was actually used, carrying that type's
    #    own configured fields as REAL columns. A flat sheet cannot have a
    #    column for every type's fields, and "Vehicle No: RJ27…" squashed into a
    #    text cell can be read but not sorted, filtered or summed — and an OD
    #    column you cannot total is not much of a report.
    by_type: dict[str, list] = {}
    for p in policies:
        by_type.setdefault(p.category_key or "", []).append(p)
    for key, group in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
        cat = cat_docs.get(key)
        specs = cat.custom_fields if cat else []
        if not specs:
            continue
        label = categories.get(key, key)
        _sheet(wb, f"{label} details"[:31],
               ["Policy number", "Customer", "Sub-type", "Insurer",
                "Premium (Rs)"] + [s.label for s in specs],
               [(p.policy_number or p.code, cust(p.customer_id),
                 " > ".join(labels_for_path(cat.children, p.subcategory_path))
                 if cat and p.subcategory_path else "",
                 insr(p.insurer_id), rupees(p.premium_amount))
                + tuple(_detail_value(s, (p.details or {}).get(s.key))
                        for s in specs)
                for p in group])

    # 5. Relationship managers — one row per manager for the period.
    #    Built from the SAME frozen manager stamp the Relationship Managers page
    #    reads, so the sheet pasted into a monthly review and the screen it was
    #    checked against cannot disagree.
    _sheet(wb, "Relationship managers",
           ["Relationship manager", "Policies", "Premium (Rs)",
            "From partners (Rs)", "Own sales (Rs)", "Reward earned (Rs)",
            "Paid to partners (Rs)", "House profit (Rs)"],
           _manager_rows(data),
           total_row=_manager_total_row(data))

    # 6. Transactions (every cash movement, party-aware labels)
    def party_name(t: LedgerTxn) -> str:
        ptype = _enum(t.party_type)
        if ptype == PartyType.CUSTOMER.value:
            return cust(t.party_id)
        if ptype == PartyType.BROKER.value:
            return brok(t.party_id)
        if ptype == PartyType.CHANNEL_PARTNER.value:
            return person(t.party_id)
        return t.paid_to_name or "House"

    _sheet(wb, "Transactions",
           ["Date", "Type", "Party", "Amount (Rs)", "Bank/cash account",
            "Hit the account (Rs)", "Reference", "Note", "Policy"],
           [(_date(t.occurred_at), ledger_label(t.txn_type, t.party_type),
             party_name(t), rupees(abs(t.amount_paise)),
             acct(t.bank_account_id or ""), rupees(t.bank_delta_paise),
             t.reference or "", t.note or "", t.policy_id or "")
            for t in data["txns"]])

    # 7. Expenses
    expenses = [t for t in data["txns"] if t.txn_type == LedgerTxnType.EXPENSE]
    _sheet(wb, "Expenses",
           ["Date", "Category", "Paid to", "Amount (Rs)", "Account",
            "Reference", "Note"],
           [(_date(t.occurred_at),
             EXPENSE_CATEGORY_LABELS.get(t.expense_category or "", "Other"),
             t.paid_to_name or person(t.paid_to_employee_id or ""),
             rupees(abs(t.amount_paise)), acct(t.bank_account_id or ""),
             t.reference or "", t.note or "") for t in expenses],
           total_row=("Total", "", "",
                      rupees(sum(abs(t.amount_paise) for t in expenses)),
                      "", "", ""))

    # 8. Rewards & TDS
    _sheet(wb, "Rewards & TDS",
           ["Date", "Broker", "Policy", "Gross reward (Rs)", "TDS %",
            "TDS withheld (Rs)", "Net received (Rs)", "Reference"],
           [(_date(e.occurred_at), brok(e.broker_id), e.policy_id or "",
             rupees(e.gross_reward_paise), e.tds_percent / 100,
             rupees(e.tds_paise),
             rupees(e.gross_reward_paise - e.tds_paise), e.reference or "")
            for e in data["tds"]],
           total_row=("Total", "", "",
                      rupees(sum(e.gross_reward_paise for e in data["tds"])), "",
                      rupees(sum(e.tds_paise for e in data["tds"])),
                      rupees(sum(e.gross_reward_paise - e.tds_paise
                                 for e in data["tds"])), ""))

    # 9. Partner payouts
    payouts = [t for t in data["txns"]
               if t.txn_type in (LedgerTxnType.PARTNER_PAYOUT,
                                 LedgerTxnType.PARTNER_ADVANCE)]
    _sheet(wb, "Partner payouts",
           ["Date", "Partner", "Kind", "Amount (Rs)", "Account", "Reference",
            "Note"],
           [(_date(t.occurred_at), person(t.party_id),
             "Advance" if t.txn_type == LedgerTxnType.PARTNER_ADVANCE
             else "Reward payout",
             rupees(abs(t.amount_paise)), acct(t.bank_account_id or ""),
             t.reference or "", t.note or "") for t in payouts],
           total_row=("Total", "", "",
                      rupees(sum(abs(t.amount_paise) for t in payouts)),
                      "", "", ""))

    # 10. Partner ledger — one running account per partner, blocked one after
    #    another with an opening and a closing line each. Same shape and same
    #    numbers as the statement the partner themselves gets.
    ledger_rows: list[tuple] = []
    for led in data["partner_ledgers"]:
        who = f"{led['name']} ({led['code']})" if led["code"] else led["name"]
        ledger_rows.append((who, "", "Opening balance", "", "", "",
                            rupees(led["opening"])))
        for r in led["rows"]:
            ledger_rows.append((
                "", _date(r["date"]), r["label"], r["policy"] or "",
                rupees(r["credit"]) if r["credit"] else "",
                rupees(r["debit"]) if r["debit"] else "",
                rupees(r["balance"])))
        ledger_rows.append(("", "", "Closing balance", "",
                            rupees(led["total_credit"]),
                            rupees(led["total_debit"]),
                            rupees(led["closing"])))
        ledger_rows.append(("", "", "", "", "", "", ""))
    _sheet(wb, "Partner ledger",
           ["Channel partner", "Date", "Entry", "Policy",
            "Credit — owed to them (Rs)", "Debit — owed to us (Rs)",
            "Balance (Rs)"],
           ledger_rows)

    # 10-13. Per-party summaries, built from the window's policies.
    def _rollup(key_of, label_of, extra_of=None) -> list[tuple]:
        agg: dict[str, dict] = {}
        for p in policies:
            key = key_of(p)
            if not key:
                continue
            row = agg.setdefault(key, {"policies": 0, "premium": 0,
                                       "reward": 0, "partner": 0, "profit": 0})
            pf = finance.get(str(p.id))
            row["policies"] += 1
            row["premium"] += p.premium_amount
            if pf:
                row["reward"] += pf.agency_reward
                row["partner"] += pf.partner_share
                row["profit"] += pf.house_profit
        out = []
        for key, row in sorted(agg.items(), key=lambda kv: -kv[1]["premium"]):
            out.append((label_of(key), row["policies"], rupees(row["premium"]),
                        rupees(row["reward"]), rupees(row["partner"]),
                        rupees(row["profit"]))
                       + ((extra_of(key),) if extra_of else ()))
        return out

    balances = {(_enum(a.party_type), a.party_id): a.balance_paise
                for a in data.get("party_accounts", [])}

    _sheet(wb, "Broker summary",
           ["Broker", "Policies", "Premium (Rs)", "Reward earned (Rs)",
            "Partner share (Rs)", "House profit (Rs)", "Balance now (Rs)"],
           _rollup(lambda p: p.broker_id, brok,
                   lambda bid: rupees(
                       balances.get((PartyType.BROKER.value, bid), 0))))

    _sheet(wb, "Insurer summary",
           ["Insurance company", "Policies", "Premium (Rs)",
            "Reward earned (Rs)", "Partner share (Rs)", "House profit (Rs)"],
           _rollup(lambda p: p.insurer_id, insr))

    _sheet(wb, "Partner summary",
           ["Partner", "Policies", "Premium (Rs)", "Reward earned (Rs)",
            "Partner share (Rs)", "House profit (Rs)", "Balance now (Rs)"],
           _rollup(lambda p: p.partner_id, person,
                   lambda pid: rupees(balances.get(
                       (PartyType.CHANNEL_PARTNER.value, pid), 0))))

    _sheet(wb, "Customer summary",
           ["Customer", "Policies", "Premium (Rs)", "Reward earned (Rs)",
            "Partner share (Rs)", "House profit (Rs)", "Balance now (Rs)"],
           _rollup(lambda p: p.customer_id, cust,
                   lambda cid: rupees(balances.get(
                       (PartyType.CUSTOMER.value, cid), 0))))

    # 14. Outstanding (point in time, NOT windowed — a position is what it is
    #     today, which is why it is a separate sheet from the volume ones above).
    def _party_label(ptype: str, pid: str) -> str:
        if ptype == PartyType.CUSTOMER.value:
            return cust(pid)
        if ptype == PartyType.BROKER.value:
            return brok(pid)
        if ptype == PartyType.CHANNEL_PARTNER.value:
            return person(pid)
        return "House"

    outstanding = [(
        _party_label(ptype, pid),
        {"customer": "Customer", "broker": "Broker",
         "channel_partner": "Channel Partner"}.get(ptype, ptype),
        rupees(bal) if bal > 0 else 0,
        rupees(-bal) if bal < 0 else 0,
    ) for (ptype, pid), bal in balances.items()
        if bal and ptype != PartyType.EXPENSE.value]
    outstanding.sort(key=lambda r: -(r[2] + r[3]))
    _sheet(wb, "Outstanding", ["Party", "Kind", "They owe us (Rs)",
                               "We owe them (Rs)"], outstanding,
           total_row=("Total", "", sum(r[2] for r in outstanding),
                      sum(r[3] for r in outstanding)))

    # 15. Bank & cash — where the money actually sits, right now. No account
    #     NUMBERS, no IFSC, no UPI id: this file gets emailed around, and the
    #     account number is encrypted at rest precisely so it does not travel.
    banks = data["bank_accounts"]
    _sheet(wb, "Bank & cash",
           ["Account", "Kind", "Bank", "Balance now (Rs)", "Status",
            "Last movement"],
           [(a.name, _status(a.account_type), a.bank_name or "",
             rupees(a.balance_paise), "Active" if a.active else "Inactive",
             _date(a.last_txn_at)) for a in banks],
           total_row=("Cash + bank in hand", "", "",
                      rupees(sum(a.balance_paise for a in banks
                                 if a.active and a.is_cash_asset)), "", ""))

    # 16. Renewals due next month
    due = data.get("renewals_due", [])
    _sheet(wb, "Renewals next month",
           ["Policy", "Customer", "Type", "Expiry", "Premium (Rs)", "Booked by"],
           [(p.code, cust(p.customer_id),
             categories.get(p.category_key, p.category_key or ""),
             _date(p.expiry_date), rupees(p.premium_amount),
             person(p.owner_user_id)) for p in due])

    # 17. Leads. No mobile number — a lead's phone number is the one thing in
    #     this file that is worth something to whoever it gets forwarded to.
    _sheet(wb, "Leads",
           ["Code", "Name", "Interested in", "Stage", "Added by", "Created"],
           [(l.code, l.name, l.interested_in or l.category_key or "",
             _status(l.stage), l.created_by_name or "", _date(l.created_at))
            for l in data["leads"]])

    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)
    return bio.getvalue()
