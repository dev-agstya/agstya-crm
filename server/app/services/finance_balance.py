"""Aggregations for the Balance Sheet page: Broker (a brokerage + its insurer-wise
breakdown), Channel Partner, and Customer statements.

Volume metrics (policies, premium, reward, profit, discount, refund, cash
received) are computed inside the selected date window from the frozen
PolicyFinance snapshots + the ledger. Position metrics (outstanding balance,
receivable/payable, wallet) are current point-in-time values derived from
PartyAccount / Wallet and are deliberately NOT windowed.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

from app.core.enums import (
    REWARD_REVERSAL_STATES,
    LedgerTxnType,
    PartyType,
    PayerType,
    WalletTxnType,
)
from app.models.broker import Broker
from app.models.customer import Customer
from app.models.finance import LedgerTxn, PartyAccount, PolicyFinance, TdsEntry
from app.models.insurer import Insurer
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.reward import Reward
from app.models.user import User
from app.models.wallet import Wallet, WalletTxn
from app.services import finance_reports as fr

SECTIONS = {"broker", "partner", "customer"}


def broker_net_balance(expected: int, received: int,
                       ledger_balance: int) -> int:
    """A broker's net position from the AGENCY-receivable view (>0 they owe us).

    The reward we are owed is DERIVED: expected (Σ agency_reward on ALL booked
    policies, never windowed — N8) minus reward received. The REWARD_RECEIVED
    ledger rows exist to clear that derived receivable, so they must be backed
    OUT of the raw party-ledger balance before it contributes — otherwise a
    ₹1,500 receipt reads as a ₹1,500 payable (owner bug, 2026-07-15). What
    remains of the ledger is real positions (premium→broker, adjustments).
    Over-receipts floor the reward side at 0 (test 3.5)."""
    others = ledger_balance + received   # ledger holds receipts as −received
    return max(0, expected - received) + others


def has_live_position(*amounts: Optional[int]) -> bool:
    """True when any current-position amount is non-zero.

    Decides whether a party still earns a row on a balance-sheet tab when the
    date filter excludes all of its policies. Volume metrics are windowed but
    positions are point-in-time and must NOT be (N8), so an open balance keeps
    the party listed with zeroed volume rather than dropping it off the sheet.
    """
    return any(bool(a) for a in amounts)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _in_window(dt: datetime, lo: Optional[datetime],
               hi: Optional[datetime]) -> bool:
    if lo is None and hi is None:
        return True
    dt = _aware(dt)
    if lo and dt < lo:
        return False
    if hi and dt > hi:
        return False
    return True


def policy_date(pol: Policy, pf: PolicyFinance) -> datetime:
    """The date a policy is REPORTED under on the Balance Sheet + its statements.

    The cover's START date, not the day it was typed into the CRM (owner
    2026-07-23: policies are often entered a day or two after they begin, and a
    statement that files them under the entry date reads wrong). Falls back to
    the issue date, then to the finance snapshot's creation.

    Scope note: this rule is applied consistently across THIS module — the
    balance-sheet list, the detail panel and the PDF all bucket on the same
    date, so the screen and the printed statement can never disagree. The other
    finance surfaces (Overview, Reports) still bucket on the entry date.
    """
    for dt in (pol.start_date, pol.issue_date, pf.created_at):
        if dt:
            return _aware(dt)
    return _aware(pf.created_at)


def _is_active(pol) -> bool:
    status = pol.status.value if hasattr(pol.status, "value") else str(pol.status)
    return status == "active"


def _status_label(pol) -> str:
    raw = pol.status.value if hasattr(pol.status, "value") else str(pol.status)
    return str(raw).replace("_", " ").title()


def _empty() -> dict:
    return {"policies": 0, "premium": 0, "reward_earned": 0,
            "partner_share": 0, "house_profit": 0, "discount": 0,
            "premium_collected": 0}


def _add(agg: dict, pf: PolicyFinance) -> None:
    agg["policies"] += 1
    agg["premium"] += pf.gross_premium
    agg["reward_earned"] += pf.agency_reward
    agg["partner_share"] += pf.partner_share
    agg["house_profit"] += pf.house_profit
    agg["discount"] += pf.discount
    agg["premium_collected"] += pf.premium_collected


async def _cat_labels() -> dict[str, str]:
    return {c.key: c.label async for c in PolicyCategory.find_all()}


async def _party_balances(party_type: PartyType) -> dict[str, PartyAccount]:
    return {a.party_id: a async for a in PartyAccount.find(
        PartyAccount.party_type == party_type)}


def _finance_for(policies: dict):
    """The PolicyFinance rows for exactly `policies`, and nothing else.

    Every single-entity view here — the three detail panels and the three
    statement builders — used to scan the WHOLE PolicyFinance collection and
    then throw away each row whose policy_id was missing from a dict loaded one
    line above. On a broker holding 40 policies out of 8,000 that hydrated 8,000
    Pydantic objects to keep 40.

    Behaviour-preserving by construction: `$in` returns precisely the rows the
    old loop kept. The `if pol is None: continue` guards downstream are now
    unreachable in practice and deliberately left in place — a policy deleted
    between the two queries is still a real (if rare) race.

    An empty `policies` gives `$in: []`, which matches nothing — the same answer
    the scan-and-discard loop produced.

    This is the "single-entity views are the free win" note in CLAUDE.md. It
    does NOT widen the find_all pattern; it narrows six instances of it.
    """
    return PolicyFinance.find({"policy_id": {"$in": list(policies)}})


# --- Master lists ------------------------------------------------------------
async def list_section(section: str, lo: Optional[datetime],
                       hi: Optional[datetime], sort: str,
                       *, q: Optional[str] = None,
                       order: str = "desc") -> list[dict]:
    """Every row for the section, searched and sorted — but NOT paged.

    Every row's own figures (premium, earnings, profit, ...) come from
    scanning ALL of the period's policies once (`_list_brokers` etc.), so the
    expensive part of this call is identical whether the caller wants row 1
    or row 500 — there is no cheaper "just fetch page 3" query to write here
    without a larger rework of the finance read path (see CLAUDE.md's
    "Finance read path" section: never widen the find_all() pattern; page 1
    already costs what page 5 costs). `list_section_page` below is where the
    actual page/search slicing happens, kept as a separate thin function so a
    future caller that genuinely needs the whole section (the CSV/Excel
    export, say) is not forced through a paged shape it doesn't want.
    """
    if section == "broker":
        rows = await _list_brokers(lo, hi)
    elif section == "partner":
        rows = await _list_partners(lo, hi)
    else:
        rows = await _list_customers(lo, hi)

    if q:
        needle = q.strip().lower()
        rows = [r for r in rows if needle in str(r.get("label", "")).lower()
                or needle in str(r.get("code", "")).lower()]

    key = {"premium": "premium", "earnings": "earnings",
           "policies": "policies", "profit": "profit",
           "net_balance": "net_balance"}.get(sort, "net_balance")
    rows.sort(key=lambda r: r.get(key, 0), reverse=(order != "asc"))
    return rows


async def list_section_page(
    section: str, lo: Optional[datetime], hi: Optional[datetime], sort: str,
    *, q: Optional[str] = None, order: str = "desc",
    page: int = 1, page_size: int = 25,
) -> tuple[list[dict], int]:
    """(rows for this page, total row count) — the left-hand roster on the
    Balance Sheet page paginates itself instead of handing the browser every
    broker/partner/customer in one response (owner 2026-09-12)."""
    rows = await list_section(section, lo, hi, sort, q=q, order=order)
    total = len(rows)
    start = (page - 1) * page_size
    return rows[start:start + page_size], total


async def _list_brokers(lo, hi) -> list[dict]:
    # All five reads are independent — fetch them in one parallel batch, then
    # aggregate in memory (read-only, no shared state → safe under concurrency).
    brokers_l, policies_l, pfs, received_txns, balances = await asyncio.gather(
        Broker.find_all().to_list(),
        Policy.find_all().to_list(),
        PolicyFinance.find_all().to_list(),
        LedgerTxn.find(
            LedgerTxn.party_type == PartyType.BROKER,
            LedgerTxn.txn_type == LedgerTxnType.REWARD_RECEIVED).to_list(),
        _party_balances(PartyType.BROKER),
    )
    brokers = {str(b.id): b for b in brokers_l}
    policies = {str(p.id): p for p in policies_l}

    # Volume metrics are windowed; the reward EXPECTED is all-time (the net
    # balance is a current position — it must ignore the date filter, N8).
    agg: dict[str, dict] = {}
    expected: dict[str, int] = {}
    for pf in pfs:
        pol = policies.get(pf.policy_id)
        if pol is None or not pol.broker_id:
            continue
        expected[pol.broker_id] = \
            expected.get(pol.broker_id, 0) + pf.agency_reward
        if not _in_window(policy_date(pol, pf), lo, hi):
            continue
        agg.setdefault(pol.broker_id, _empty())
        _add(agg[pol.broker_id], pf)

    # Gross reward received per broker (tagged to the BROKER party).
    received: dict[str, int] = {}
    for t in received_txns:
        received[t.party_id] = received.get(t.party_id, 0) + (-t.amount_paise)

    rows = []
    for broker_id in set(agg) | set(expected):
        b = brokers.get(broker_id)
        m = agg.get(broker_id, _empty())
        acct = balances.get(broker_id)
        net = broker_net_balance(
            expected.get(broker_id, 0), received.get(broker_id, 0),
            acct.balance_paise if acct else 0)
        rows.append({
            "id": broker_id, "label": b.name if b else broker_id,
            "code": b.short_code if b else None,
            "policies": m["policies"], "premium": m["premium"],
            "earnings": m["reward_earned"], "profit": m["house_profit"],
            "net_balance": net, "outstanding": net,
            "wallet_balance": None,
        })
    return rows


async def _list_partners(lo, hi) -> list[dict]:
    policies_l, partners_l, balances, wallets_l, pfs = await asyncio.gather(
        Policy.find_all().to_list(),
        User.find({"account_type": "channel_partner"}).to_list(),
        _party_balances(PartyType.CHANNEL_PARTNER),
        Wallet.find_all().to_list(),
        PolicyFinance.find_all().to_list(),
    )
    policies = {str(p.id): p for p in policies_l}
    partners = {str(u.id): u for u in partners_l}
    wallets = {w.partner_id: w for w in wallets_l}

    agg: dict[str, dict] = {}
    for pf in pfs:
        pol = policies.get(pf.policy_id)
        if pol is None or not pol.partner_id:
            continue
        if not _in_window(policy_date(pol, pf), lo, hi):
            continue
        agg.setdefault(pol.partner_id, _empty())
        _add(agg[pol.partner_id], pf)

    # A partner carrying an open position stays on the sheet even when the date
    # filter excludes every one of their policies — position metrics are
    # point-in-time and must NOT be windowed (N8). Brokers already did this via
    # the all-time `expected` union; partners were left keyed off the windowed
    # agg alone, so they vanished from the tab whenever the window was empty.
    live = {pid for pid in set(balances) | set(wallets)
            if has_live_position(
                balances[pid].balance_paise if pid in balances else 0,
                wallets[pid].available_paise if pid in wallets else 0,
                wallets[pid].pending_paise if pid in wallets else 0)}

    rows = []
    for pid in set(agg) | live:
        m = agg.get(pid, _empty())
        u = partners.get(pid)
        w = wallets.get(pid)
        bal = balances.get(pid)
        wallet_owed = (w.available_paise + w.pending_paise) if w else 0
        premium_owed = bal.balance_paise if bal else 0
        rows.append({
            "id": pid, "label": u.full_name if u else pid,
            "code": u.code if u else None,
            "policies": m["policies"], "premium": m["premium"],
            "earnings": m["partner_share"], "profit": m["house_profit"],
            # NET position (owner Q8): premium he owes us minus reward we owe
            # him — >0 he pays us, <0 we pay him. Matches the detail card.
            "net_balance": premium_owed - wallet_owed,
            "outstanding": premium_owed - wallet_owed,
            "wallet_balance": wallet_owed,
        })
    return rows


async def _list_customers(lo, hi) -> list[dict]:
    policies_l, customers_l, balances, pfs = await asyncio.gather(
        Policy.find_all().to_list(),
        Customer.find_all().to_list(),
        _party_balances(PartyType.CUSTOMER),
        PolicyFinance.find_all().to_list(),
    )
    policies = {str(p.id): p for p in policies_l}
    customers = {str(c.id): c for c in customers_l}

    agg: dict[str, dict] = {}
    for pf in pfs:
        pol = policies.get(pf.policy_id)
        if pol is None:
            continue
        if not _in_window(policy_date(pol, pf), lo, hi):
            continue
        agg.setdefault(pol.customer_id, _empty())
        _add(agg[pol.customer_id], pf)

    # Same rule as partners: an outstanding premium balance is a current
    # position, so the customer stays listed regardless of the date filter.
    live = {cid for cid, b in balances.items()
            if has_live_position(b.balance_paise)}

    rows = []
    for cid in set(agg) | live:
        m = agg.get(cid, _empty())
        c = customers.get(cid)
        bal = balances.get(cid)
        rows.append({
            "id": cid, "label": c.name if c else cid,
            "code": c.code if c else None,
            "policies": m["policies"], "premium": m["premium"],
            "earnings": m["premium"], "profit": m["house_profit"],
            "net_balance": bal.balance_paise if bal else 0,
            "outstanding": bal.balance_paise if bal else 0,
            "wallet_balance": None,
        })
    return rows


# --- Detail panels -----------------------------------------------------------
async def detail_section(section: str, entity_id: str, lo: Optional[datetime],
                         hi: Optional[datetime]) -> dict:
    if section == "broker":
        return await _broker_detail(entity_id, lo, hi)
    if section == "partner":
        return await _partner_detail(entity_id, lo, hi)
    return await _customer_detail(entity_id, lo, hi)


def _by_category(cats: dict[str, dict], labels: dict[str, str]) -> list[dict]:
    out = [{"key": k, "label": labels.get(k, k), "policies": v["policies"],
            "premium": v["premium"]} for k, v in cats.items()]
    out.sort(key=lambda r: r["premium"], reverse=True)
    return out


def _avg_pct(commission: int, premium: int) -> Optional[float]:
    if premium <= 0:
        return None
    return round(commission / premium * 100, 2)


async def _broker_detail(broker_id: str, lo, hi) -> dict:
    b = await Broker.get(broker_id) if _oid(broker_id) else None
    labels = await _cat_labels()
    insurers = {str(i.id): i async for i in Insurer.find_all()}
    policies = {str(p.id): p async for p in Policy.find(
        {"broker_id": broker_id})}

    total = _empty()
    cats: dict[str, dict] = {}
    profiles: dict[str, dict] = {}      # keyed by insurer_id ("" = none)
    renewals = active = 0
    expected_all_time = 0               # reward expected — never windowed (N8)
    async for pf in _finance_for(policies):
        pol = policies.get(pf.policy_id)
        if pol is None:
            continue
        expected_all_time += pf.agency_reward
        if not _in_window(policy_date(pol, pf), lo, hi):
            continue
        _add(total, pf)
        cats.setdefault(pol.category_key, _empty())
        _add(cats[pol.category_key], pf)
        if pol.renewed_from_policy_id:
            renewals += 1
        if _is_active(pol):
            active += 1
        ins_id = pol.insurer_id or ""
        profiles.setdefault(ins_id, _empty())
        _add(profiles[ins_id], pf)

    # Gross reward received from this broker (all-time, tagged to the party).
    received = 0
    async for t in LedgerTxn.find(
            LedgerTxn.party_type == PartyType.BROKER,
            LedgerTxn.party_id == broker_id,
            LedgerTxn.txn_type == LedgerTxnType.REWARD_RECEIVED):
        received += -t.amount_paise

    # TDS this broker withheld (all-time).
    tds_deducted = 0
    async for e in TdsEntry.find(TdsEntry.broker_id == broker_id):
        tds_deducted += e.tds_paise

    # Current net position (agency-receivable view). Receipts CLEAR the derived
    # reward receivable — they must never read as a payable (owner 2026-07-15).
    acct = await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.BROKER,
        PartyAccount.party_id == broker_id)
    net = broker_net_balance(expected_all_time, received,
                             acct.balance_paise if acct else 0)
    to_receive = max(0, net)
    payable = max(0, -net)
    # Pure reward component (excludes premium→broker / adjustment positions).
    reward_pending = max(0, expected_all_time - received)

    # Per-insurer-company breakdown of what we placed through this broker.
    profile_stats = []
    for ins_id, m in profiles.items():
        ins = insurers.get(ins_id)
        profile_stats.append({
            "id": ins_id or "unassigned",
            "label": ins.name if ins else "Unassigned",
            "code": ins.code if ins else None,
            "policies": m["policies"], "premium": m["premium"],
            "reward_earned": m["reward_earned"],
            "reward_received": 0,
            "reward_to_receive": 0,
            "house_profit": m["house_profit"],
        })
    profile_stats.sort(key=lambda r: r["premium"], reverse=True)

    return {
        "section": "broker", "id": broker_id,
        "label": b.name if b else broker_id,
        "code": b.short_code if b else None,
        "date_from": lo, "date_to": hi,
        "total_policies": total["policies"], "renewals": renewals,
        "active_policies": active,
        "by_category": _by_category(cats, labels),
        "premium": total["premium"],
        "premium_collected": total["premium_collected"],
        "reward_earned": total["reward_earned"],
        "reward_received": received,
        "reward_to_receive": reward_pending,
        "tds_deducted": tds_deducted,
        "tds_percent": b.tds_percent if b else None,
        # What we actually pocketed from this broker so far: rewards RECEIVED
        # net of the TDS they withheld. Zero until a receipt is recorded.
        "total_earnings": received - tds_deducted,
        "house_profit": total["house_profit"],
        "discount": total["discount"], "refund": 0,
        "avg_reward_pct": _avg_pct(total["reward_earned"],
                                   total["premium"]),
        "outstanding": net, "receivable": to_receive, "payable": payable,
        "net_balance": net, "wallet_balance": None,
        "profiles": profile_stats,
    }


async def _partner_detail(partner_id: str, lo, hi) -> dict:
    u = await User.get(partner_id) if _oid(partner_id) else None
    labels = await _cat_labels()
    policies = {str(p.id): p async for p in Policy.find(
        {"partner_id": partner_id})}

    total = _empty()
    cats: dict[str, dict] = {}
    renewals = active = 0
    async for pf in _finance_for(policies):
        pol = policies.get(pf.policy_id)
        if pol is None or not _in_window(policy_date(pol, pf), lo, hi):
            continue
        _add(total, pf)
        cats.setdefault(pol.category_key, _empty())
        _add(cats[pol.category_key], pf)
        if pol.renewed_from_policy_id:
            renewals += 1
        if _is_active(pol):
            active += 1

    acct = await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.CHANNEL_PARTNER,
        PartyAccount.party_id == partner_id)
    balance = acct.balance_paise if acct else 0
    wallet = await Wallet.find_one(Wallet.partner_id == partner_id)
    wallet_owed = (wallet.available_paise + wallet.pending_paise) \
        if wallet else 0

    return {
        "section": "partner", "id": partner_id,
        "label": u.full_name if u else partner_id,
        "code": u.code if u else None,
        "date_from": lo, "date_to": hi,
        "total_policies": total["policies"], "renewals": renewals,
        "active_policies": active,
        "by_category": _by_category(cats, labels),
        "premium": total["premium"],
        "premium_collected": total["premium_collected"],
        "reward_earned": total["partner_share"],
        "reward_received": 0, "reward_to_receive": 0,
        "house_profit": total["house_profit"],
        "discount": total["discount"], "refund": 0,
        "avg_reward_pct": _avg_pct(total["partner_share"],
                                   total["premium"]),
        "outstanding": balance,
        "receivable": max(0, balance),
        "payable": max(0, -balance) + wallet_owed,
        # Net from the partner's perspective: reward we owe him minus premium he
        # owes us. Positive = we must pay him; negative = he must pay us.
        "net_balance": partner_net_balance(wallet_owed, balance),
        "wallet_balance": wallet_owed,
        "profiles": [],
    }


async def _customer_detail(customer_id: str, lo, hi) -> dict:
    c = await Customer.get(customer_id) if _oid(customer_id) else None
    labels = await _cat_labels()
    policies = {str(p.id): p async for p in Policy.find(
        {"customer_id": customer_id})}

    total = _empty()
    cats: dict[str, dict] = {}
    renewals = active = 0
    async for pf in _finance_for(policies):
        pol = policies.get(pf.policy_id)
        if pol is None or not _in_window(policy_date(pol, pf), lo, hi):
            continue
        _add(total, pf)
        cats.setdefault(pol.category_key, _empty())
        _add(cats[pol.category_key], pf)
        if pol.renewed_from_policy_id:
            renewals += 1
        if _is_active(pol):
            active += 1

    # Cash actually collected + refunds paid, within the window.
    collected = refund = 0
    async for t in LedgerTxn.find(
            LedgerTxn.party_type == PartyType.CUSTOMER,
            LedgerTxn.party_id == customer_id):
        if not _in_window(t.occurred_at, lo, hi):
            continue
        if t.txn_type == LedgerTxnType.PREMIUM_COLLECTED:
            collected += -t.amount_paise
        elif t.txn_type == LedgerTxnType.REFUND:
            refund += t.amount_paise

    acct = await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.CUSTOMER,
        PartyAccount.party_id == customer_id)
    balance = acct.balance_paise if acct else 0

    return {
        "section": "customer", "id": customer_id,
        "label": c.name if c else customer_id,
        "code": c.code if c else None,
        "date_from": lo, "date_to": hi,
        "total_policies": total["policies"], "renewals": renewals,
        "active_policies": active,
        "by_category": _by_category(cats, labels),
        "premium": total["premium"],
        "premium_collected": collected,
        "reward_earned": 0, "reward_received": 0,
        "reward_to_receive": 0,
        "house_profit": total["house_profit"],
        "discount": total["discount"], "refund": refund,
        "avg_reward_pct": None,
        "outstanding": max(0, balance),
        "receivable": max(0, balance),
        "payable": max(0, -balance),
        "net_balance": balance,
        "wallet_balance": None,
        "profiles": [],
    }


# --- Channel-partner printable statement -------------------------------------
def wallet_txn_reward_delta(txn_type: WalletTxnType, note: Optional[str],
                            amount_paise: int) -> int:
    """Contribution of one wallet ledger row to a partner's net reward owed.

    The pending->available transition re-emits a REWARD_CREDIT row for the same
    amount that is a MOVE, not new reward earned, so it must contribute zero —
    otherwise reconstructing a historical balance double-counts every reward."""
    if (txn_type == WalletTxnType.REWARD_CREDIT
            and (note or "").startswith("Reward available")):
        return 0
    return amount_paise


def partner_net_balance(reward_owed: int, premium_balance: int) -> int:
    """Net position from the partner's perspective: reward we owe him minus the
    premium he owes us. Positive = we must pay him; negative = he must pay us."""
    return reward_owed - premium_balance


async def _reward_owed_asof(partner_id: str, cutoff: datetime) -> int:
    """Net reward owed to a partner just before `cutoff`, reconstructed from the
    wallet ledger."""
    owed = 0
    async for w in WalletTxn.find(WalletTxn.partner_id == partner_id):
        if _aware(w.created_at) >= cutoff:
            continue
        owed += wallet_txn_reward_delta(w.type, w.note, w.amount_paise)
    return owed


async def _premium_owed_asof(partner_id: str, cutoff: datetime) -> int:
    """Premium the partner owes us just before `cutoff` (>0 he owes), summed from
    the append-only party ledger."""
    bal = 0
    async for t in LedgerTxn.find(
            LedgerTxn.party_type == PartyType.CHANNEL_PARTNER,
            LedgerTxn.party_id == partner_id):
        if t.txn_type in (LedgerTxnType.PREMIUM_PAID_BY_AGENCY,
                          LedgerTxnType.REWARD_CANCELLED,
                          LedgerTxnType.PARTNER_PAYOUT):
            continue                      # balance-neutral, never a position
        if _aware(t.occurred_at) < cutoff:
            bal += t.amount_paise
    return bal


# Statement labels are declared with the statement builders below as
# (direction, label, canonical sign of the stored amount). A row whose sign is
# OPPOSITE its canonical sign is a same-type reversal — it shows flipped
# ("in" <-> "out") and tagged, so totals stay honest.
def statement_txn_row(meta: tuple, amount_paise: int, note: Optional[str],
                      *, is_adjustment: bool = False
                      ) -> Optional[tuple[str, str, int]]:
    """(direction, label, magnitude) for one ledger row on a statement, or None
    for zero rows. Flips the direction for same-type reversal rows; plain
    adjustments flip silently (either direction is a normal adjustment)."""
    direction, base, canonical = meta
    amt = abs(amount_paise)
    if amt == 0:
        return None
    sign = 1 if amount_paise > 0 else -1
    if sign != canonical:
        direction = "out" if direction == "in" else "in"
        if not is_adjustment:
            base = f"{base} (reversed)"
            note = None                  # the note says "Reversal of …" anyway
    return direction, note or base, amt


# --- Printable party statements ----------------------------------------------
# A statement is an ACCOUNT, not a metrics dump: an opening balance, every
# movement inside the window with a running balance, and a closing balance that
# ties back to the party's live position — so the reader can add it up and get
# the same answer we print. Alongside the account sits the policy detail: what
# the money was actually for.
#
# Sign convention inside every statement dict is the AGENCY-RECEIVABLE view
# (+ve = the party owes the agency), matching LedgerTxn.amount_paise. The
# renderer turns that into plain words per audience; nothing downstream has to
# re-derive a sign.
#
# AUDIENCE matters: the broker statement is internal (owners read it to see
# monthly business and what the house made), so it carries house profit. The
# channel-partner and customer statements are HANDED OUT — they must never
# expose agency reward or house profit (owner 2026-07-23).

# Balance-neutral mirrors: visible on the Transactions page, never a position,
# so they must not appear on an account statement or the running balance breaks.
_STATEMENT_SKIP_TYPES = {
    LedgerTxnType.PREMIUM_PAID_BY_AGENCY,
    LedgerTxnType.REWARD_CANCELLED,
    # A partner reward payout lives in the wallet ledger; the ledger row is a
    # Transactions-page mirror. Listing it here too would double-count it.
    LedgerTxnType.PARTNER_PAYOUT,
}

# Types whose sign legitimately swings both ways — a negative one is a normal
# entry, not a reversal, so it flips silently without the "(reversed)" tag.
_SILENT_FLIP_TYPES = {
    LedgerTxnType.ADJUSTMENT,
    LedgerTxnType.PREMIUM_DUE,   # negative when the buyer is owed a discount back
    LedgerTxnType.DISCOUNT,
}


def ledger_entry(txn_type, amount_paise: int, note: Optional[str],
                 labels: dict) -> Optional[tuple[str, int]]:
    """(label, signed ledger delta) for one row of an account statement.

    The signed amount comes straight off the ledger, so the running balance is
    the ledger's own arithmetic. Only the wording is derived — via the same
    reversal-aware rule the Transactions page uses.
    """
    meta = labels.get(txn_type)
    if meta is None or amount_paise == 0:
        return None
    row = statement_txn_row(meta, amount_paise, note,
                            is_adjustment=txn_type in _SILENT_FLIP_TYPES)
    if row is None:
        return None
    _direction, label, _magnitude = row
    return label, amount_paise


async def _partner_combined_account(
        partner_id: str, lo: Optional[datetime], hi: Optional[datetime],
        opening_net: int, policy_codes: dict[str, str]) -> dict:
    """One netted "Transactions" ledger for a partner (owner 2026-07-24).

    Merges the two real money flows into a single running balance held in the
    PARTNER-FAVOUR view (>0 = the agency owes the partner):
      • reward we owe them — from the wallet ledger; earning is a credit (+),
        a payout to them is a debit (−);
      • premium they owe us — from the party ledger; a charge is a debit (−),
        a premium receipt from them is a credit (+).
    So each event's contribution to the net is +reward_delta and −premium_delta.
    Opening is the same netting as-of the window start, and the closing ties to
    the live Net Balance when the window covers everything to date.
    """
    events: list[dict] = []

    wallet_txns = await WalletTxn.find(
        WalletTxn.partner_id == partner_id).to_list()
    for w in wallet_txns:
        delta = wallet_txn_reward_delta(w.type, w.note, w.amount_paise)
        if delta == 0 or not _in_window(w.created_at, lo, hi):
            continue
        events.append({
            "date": _aware(w.created_at),
            "label": w.note or ("Reward earned" if delta > 0
                                else "Reward paid to you"),
            "reference": getattr(w, "ref_id", None),
            "policy": None,
            "contribution": delta,       # reward: earn (+) / payout (−)
        })

    txns = await LedgerTxn.find(
        LedgerTxn.party_type == PartyType.CHANNEL_PARTNER,
        LedgerTxn.party_id == partner_id).to_list()
    for t in txns:
        if t.txn_type in _STATEMENT_SKIP_TYPES:
            continue
        if not _in_window(t.occurred_at, lo, hi):
            continue
        entry = ledger_entry(t.txn_type, t.amount_paise, t.note,
                             _PARTNER_TXN_LABELS)
        if entry is None:
            continue
        label, delta = entry             # agency-receivable signed
        events.append({
            "date": _aware(t.occurred_at),
            "label": label,
            "reference": t.reference,
            "policy": policy_codes.get(t.policy_id or ""),
            "contribution": -delta,      # premium: charge (−) / receipt (+)
        })

    events.sort(key=lambda e: e["date"])
    rows: list[dict] = []
    balance = opening_net
    credit = debit = 0
    for e in events:
        c = e["contribution"]
        balance += c
        if c > 0:
            credit += c
        else:
            debit += -c
        rows.append({
            "date": e["date"], "label": e["label"],
            "reference": e["reference"], "policy": e["policy"],
            "credit": c if c > 0 else 0, "debit": -c if c < 0 else 0,
            "balance": balance,
        })
    return {"rows": rows, "opening": opening_net,
            "total_credit": credit, "total_debit": debit, "closing": balance}


async def _account_rows(party_type: PartyType, party_id: str,
                        lo: Optional[datetime], hi: Optional[datetime],
                        labels: dict, opening: int,
                        policy_codes: dict[str, str]) -> dict:
    """Every balance-affecting ledger row in the window, with a running balance.

    Returns the rows plus the debit/credit totals and the closing balance the
    rows actually add up to, so the renderer never has to compute money.
    """
    txns = await LedgerTxn.find(
        LedgerTxn.party_type == party_type,
        LedgerTxn.party_id == party_id).to_list()
    txns.sort(key=lambda t: _aware(t.occurred_at))

    rows: list[dict] = []
    balance = opening
    debit = credit = 0
    for t in txns:
        if t.txn_type in _STATEMENT_SKIP_TYPES:
            continue
        if not _in_window(t.occurred_at, lo, hi):
            continue
        entry = ledger_entry(t.txn_type, t.amount_paise, t.note, labels)
        if entry is None:
            continue
        label, delta = entry
        balance += delta
        if delta > 0:
            debit += delta
        else:
            credit += -delta
        rows.append({
            "date": _aware(t.occurred_at),
            "label": label,
            "reference": t.reference,
            "policy": policy_codes.get(t.policy_id or ""),
            "debit": delta if delta > 0 else 0,
            "credit": -delta if delta < 0 else 0,
            "balance": balance,
        })
    return {"rows": rows, "total_debit": debit, "total_credit": credit,
            "closing": balance}


async def _cat_index() -> dict[str, PolicyCategory]:
    return {c.key: c async for c in PolicyCategory.find_all()}


def _reward_base_note(pol: Policy,
                      cat: Optional[PolicyCategory]) -> Optional[str]:
    """Label of the custom field the reward % was applied to, or None when the
    policy used the ordinary net-of-GST commissionable premium.

    Surfacing this answers the "was that the default base or a manually entered
    OD/TP amount?" question without a column of its own — the renderer prints it
    under the base figure."""
    field = getattr(pol, "reward_base_field", "commissionable") or "commissionable"
    if field == "commissionable":
        return None
    if cat is not None:
        for spec in cat.custom_fields:
            if spec.key == field:
                return spec.label
    return field.replace("_", " ").title()


def _pct_of(part: int, whole: int) -> Optional[float]:
    if whole <= 0:
        return None
    return round(part / whole * 100, 2)


def _month_key(dt: datetime) -> str:
    """IST month bucket for grouping policy rows, e.g. '2026-04'."""
    d = fr.to_ist(dt)
    return f"{d.year:04d}-{d.month:02d}"


def _month_label(dt: datetime) -> str:
    return fr.to_ist(dt).strftime("%b %Y")


async def _premium_due_by_policy(party_type: PartyType,
                                 party_id: str) -> dict[str, int]:
    """The charged premium per policy, taken from the PREMIUM_DUE ledger rows.

    Using the ledger (not a recomputation) guarantees the per-policy charges on
    a statement sum to exactly what moved the party's balance."""
    out: dict[str, int] = {}
    async for t in LedgerTxn.find(
            LedgerTxn.party_type == party_type,
            LedgerTxn.party_id == party_id,
            LedgerTxn.txn_type == LedgerTxnType.PREMIUM_DUE):
        if t.policy_id:
            out[t.policy_id] = out.get(t.policy_id, 0) + t.amount_paise
    return out


async def _settled_by_policy(party_type: PartyType,
                             party_id: str) -> dict[str, int]:
    """Cash settled against each policy TO DATE (receipts net of refunds).

    Deliberately all-time, not windowed: "how much of this policy is still
    unpaid" is a standing question, and a receipt in a later month still cleared
    that policy."""
    out: dict[str, int] = {}
    async for t in LedgerTxn.find(
            LedgerTxn.party_type == party_type,
            LedgerTxn.party_id == party_id):
        if not t.policy_id:
            continue
        if t.txn_type == LedgerTxnType.PREMIUM_COLLECTED:
            out[t.policy_id] = out.get(t.policy_id, 0) + (-t.amount_paise)
        elif t.txn_type == LedgerTxnType.REFUND:
            out[t.policy_id] = out.get(t.policy_id, 0) - t.amount_paise
    return out


def _by_category_rows(cats: dict[str, dict], labels: dict[str, str],
                      with_reward: bool) -> list[dict]:
    out = []
    for key, m in cats.items():
        row = {"label": labels.get(key, key), "policies": m["policies"],
               "premium": m["premium"]}
        row["reward"] = m["reward_earned"] if with_reward else m["partner_share"]
        out.append(row)
    out.sort(key=lambda r: r["premium"], reverse=True)
    return out


# --- Statement label maps -----------------------------------------------------
# (direction, label, canonical sign) — see statement_txn_row.
_CUSTOMER_TXN_LABELS = {
    LedgerTxnType.PREMIUM_DUE: ("out", "Policy premium charged", 1),
    LedgerTxnType.PREMIUM_COLLECTED: ("in", "Payment received", -1),
    LedgerTxnType.REFUND: ("out", "Refund paid to you", 1),
    LedgerTxnType.DISCOUNT: ("in", "Discount allowed", -1),
    LedgerTxnType.ADJUSTMENT: ("in", "Adjustment", -1),
}
_PARTNER_TXN_LABELS = {
    LedgerTxnType.PREMIUM_DUE: ("out", "Policy premium charged", 1),
    LedgerTxnType.PREMIUM_COLLECTED: ("in", "Premium received from you", -1),
    LedgerTxnType.PARTNER_ADVANCE: ("out", "Advance paid to you", 1),
    LedgerTxnType.REFUND: ("out", "Refund paid to you", 1),
    LedgerTxnType.DISCOUNT: ("in", "Discount allowed", -1),
    LedgerTxnType.ADJUSTMENT: ("in", "Adjustment", -1),
}
_BROKER_TXN_LABELS = {
    LedgerTxnType.REWARD_RECEIVED: ("in", "Reward received", -1),
    LedgerTxnType.PREMIUM_TO_INSURER: ("out", "Premium paid to broker", 1),
    LedgerTxnType.TDS_DEDUCTED: ("in", "TDS withheld on reward", -1),
    LedgerTxnType.ADJUSTMENT: ("in", "Adjustment", -1),
}

_REWARD_STATE_LABEL = {
    "pending": "Pending",
    "received": "Payable",
    "paid_out": "Paid",
}


def _reward_state(reward) -> str:
    """Plain outcome word for a partner's reward on one policy."""
    if reward is None:
        return "Pending"
    status = reward.status
    if status in REWARD_REVERSAL_STATES:
        return "Not eligible"
    raw = status.value if hasattr(status, "value") else str(status)
    if reward.paid_out_at:
        return "Paid"
    if raw == "received" or reward.wallet_available:
        return "Payable"
    return _REWARD_STATE_LABEL.get(raw, "Pending")


# --- Channel partner ----------------------------------------------------------
async def partner_ledger(partner_id: str, lo: Optional[datetime],
                         hi: Optional[datetime],
                         policy_codes: Optional[dict[str, str]] = None) -> dict:
    """ONE partner's running account for a window: opening, every entry in date
    order, closing.

    Reward we owe them netted against premium they owe us, in the partner-favour
    view (>0 = the agency owes them). Extracted so the partner Statement PDF and
    the business report's partner-ledger sheet are the SAME ledger — a partner
    holding a statement that disagrees with the agency's own report is the worst
    kind of argument to have.

    Cheap enough to run per partner: every read here is scoped to the one
    partner (WalletTxn and LedgerTxn by party), so this never touches the
    whole-collection scan that `partner_statement` above still does for its
    policy rows.
    """
    premium_opening = await _party_balance_asof(
        PartyType.CHANNEL_PARTNER, partner_id, lo)
    reward_opening = await _reward_owed_asof(partner_id, lo) if lo else 0
    return await _partner_combined_account(
        partner_id, lo, hi, reward_opening - premium_opening,
        policy_codes or {})


async def partner_statement(partner_id: str, lo: Optional[datetime],
                            hi: Optional[datetime]) -> dict:
    """Statement HANDED TO a channel partner: the business they brought, the
    reward they earned on it, and the two-sided account that says who pays whom.

    Carries no agency reward and no house profit — the partner sees their own
    side only (owner 2026-07-23)."""
    u = await User.get(partner_id) if _oid(partner_id) else None
    cat_index, labels = await _cat_index(), await _cat_labels()
    customers = {str(c.id): c async for c in Customer.find_all()}
    insurers = {str(i.id): i async for i in Insurer.find_all()}
    policies = {str(p.id): p async for p in Policy.find(
        {"partner_id": partner_id})}
    rewards = {r.policy_id: r async for r in Reward.find(
        Reward.partner_id == partner_id)}

    rows: list[dict] = []
    cats: dict[str, dict] = {}
    total_premium = total_reward = total_base = premium_by_us = 0
    async for pf in _finance_for(policies):
        pol = policies.get(pf.policy_id)
        if pol is None:
            continue
        when = policy_date(pol, pf)
        if not _in_window(when, lo, hi):
            continue
        cust = customers.get(pol.customer_id)
        ins = insurers.get(pol.insurer_id or "")
        by_us = pol.payer == PayerType.AGENCY
        rows.append({
            "date": when,
            "month_key": _month_key(when), "month_label": _month_label(when),
            "policy_number": pol.policy_number or pol.code,
            "customer": cust.name if cust else "—",
            "insurer": ins.name if ins else "—",
            "category": labels.get(pol.category_key, pol.category_key),
            "premium": pf.gross_premium,
            # The base the partner's reward % was applied to (net-of-GST premium,
            # or a manually-entered amount field such as OD/TP for some types).
            "reward_base": pf.commissionable,
            "reward_base_note": _reward_base_note(
                pol, cat_index.get(pol.category_key)),
            "premium_by": "Agency" if by_us else "You",
            "reward_pct": _pct_of(pf.partner_share, pf.commissionable),
            "reward": pf.partner_share,
            "reward_state": _reward_state(rewards.get(pf.policy_id)),
        })
        total_premium += pf.gross_premium
        total_reward += pf.partner_share
        total_base += pf.commissionable
        if by_us:
            premium_by_us += pf.gross_premium
        cats.setdefault(pol.category_key, _empty())
        _add(cats[pol.category_key], pf)
    rows.sort(key=lambda r: r["date"])

    # ONE combined "Transactions" ledger (owner 2026-07-24): reward we owe them
    # netted against premium they owe us, in the partner-favour view.
    policy_codes = {pid: (p.policy_number or p.code)
                    for pid, p in policies.items()}
    combined = await partner_ledger(partner_id, lo, hi, policy_codes)

    # Closing positions are LIVE (a statement's bottom line must match what the
    # Balance Sheet shows today), not the window's arithmetic.
    acct = await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.CHANNEL_PARTNER,
        PartyAccount.party_id == partner_id)
    premium_balance = acct.balance_paise if acct else 0
    wallet = await Wallet.find_one(Wallet.partner_id == partner_id)
    reward_owed = (wallet.available_paise + wallet.pending_paise) if wallet else 0
    reward_available = wallet.available_paise if wallet else 0

    return {
        "kind": "partner",
        "audience": "external",
        "entity_id": partner_id,
        "label": u.full_name if u else partner_id,
        "code": u.code if u else None,
        "mobile": u.mobile if u else None,
        "email": u.email if u else None,
        "date_from": lo, "date_to": hi,
        # The opening the LEDGER BELOW IT computed, never a second calculation.
        # This read `opening_net`, a local that stopped existing when
        # `partner_ledger()` was extracted and took the netting with it — so
        # every partner statement raised a NameError (fixed 2026-08-21). Taking
        # it off `combined` is not just the cheap fix: the headline opening and
        # the running balance of the first transaction row underneath it are now
        # the same number by construction, and a statement whose opening figure
        # disagrees with its own first line is the argument this whole file
        # exists to avoid.
        "opening_balance": combined["opening"],
        "policies": rows,
        "total_premium": total_premium,
        "total_reward": total_reward,
        "total_reward_base": total_base,
        "premium_by_us": premium_by_us,
        "by_category": _by_category_rows(cats, labels, with_reward=False),
        "combined_account": combined,
        # Live positions.
        "premium_balance": premium_balance,      # >0 they owe us
        "reward_owed": reward_owed,              # >0 we owe them
        "reward_available": reward_available,
        "net_balance": partner_net_balance(reward_owed, premium_balance),
    }


# --- Customer -----------------------------------------------------------------
async def customer_statement(customer_id: str, lo: Optional[datetime],
                             hi: Optional[datetime]) -> dict:
    """Statement HANDED TO a customer: the policies they hold, what each cost,
    what they have paid, and the one number that matters — the balance."""
    c = await Customer.get(customer_id) if _oid(customer_id) else None
    labels = await _cat_labels()
    insurers = {str(i.id): i async for i in Insurer.find_all()}
    policies = {str(p.id): p async for p in Policy.find(
        {"customer_id": customer_id})}
    charged = await _premium_due_by_policy(PartyType.CUSTOMER, customer_id)
    settled = await _settled_by_policy(PartyType.CUSTOMER, customer_id)

    rows: list[dict] = []
    cats: dict[str, dict] = {}
    total_premium = total_discount = total_net = total_paid = 0
    async for pf in _finance_for(policies):
        pol = policies.get(pf.policy_id)
        if pol is None:
            continue
        when = policy_date(pol, pf)
        if not _in_window(when, lo, hi):
            continue
        ins = insurers.get(pol.insurer_id or "")
        # What this policy actually put on their account. Falls back to the
        # snapshot when a policy predates the PREMIUM_DUE ledger row.
        net = charged.get(pf.policy_id, pf.gross_premium - pf.discount)
        paid = settled.get(pf.policy_id, 0)
        # When the customer paid the premium directly (payer = customer) there is
        # no agency receipt to record, but from their side it IS paid — surface
        # the net payable in the Paid column so the row reads correctly (owner
        # 2026-07-26).
        if pol.payer == PayerType.CUSTOMER and paid == 0:
            paid = net
        rows.append({
            "date": when,
            "month_key": _month_key(when), "month_label": _month_label(when),
            "policy_number": pol.policy_number or pol.code,
            "insurer": ins.name if ins else "—",
            "category": labels.get(pol.category_key, pol.category_key),
            "sum_insured": pol.sum_insured,
            "valid_till": pol.expiry_date,
            "premium": pf.gross_premium,
            "discount": pf.discount,
            "net_payable": net,
            "paid": paid,
            "balance": net - paid,
            "status": _status_label(pol),
        })
        total_premium += pf.gross_premium
        total_discount += pf.discount
        total_net += net
        total_paid += paid
        cats.setdefault(pol.category_key, _empty())
        _add(cats[pol.category_key], pf)
    rows.sort(key=lambda r: r["date"])

    policy_codes = {pid: (p.policy_number or p.code)
                    for pid, p in policies.items()}
    opening = await _party_balance_asof(PartyType.CUSTOMER, customer_id, lo)
    account = await _account_rows(PartyType.CUSTOMER, customer_id, lo, hi,
                                  _CUSTOMER_TXN_LABELS, opening, policy_codes)

    acct = await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.CUSTOMER,
        PartyAccount.party_id == customer_id)
    balance = acct.balance_paise if acct else 0

    return {
        "kind": "customer",
        "audience": "external",
        "entity_id": customer_id,
        "label": c.name if c else customer_id,
        "code": c.code if c else None,
        "mobile": c.mobile if c else None,
        "email": c.email if c else None,
        "address": getattr(c, "address", None) if c else None,
        "date_from": lo, "date_to": hi,
        "opening_balance": opening,
        "policies": rows,
        "total_premium": total_premium,
        "total_discount": total_discount,
        "total_net_payable": total_net,
        "total_paid": total_paid,
        "by_category": _by_category_rows(cats, labels, with_reward=False),
        "account": account,
        "net_balance": balance,      # >0 they owe us, <0 we owe them
    }


# --- Broker (internal) --------------------------------------------------------
async def broker_statement(broker_id: str, lo: Optional[datetime],
                           hi: Optional[datetime]) -> dict:
    """INTERNAL statement: the business we placed through a broker, the reward it
    earned, the TDS withheld and what the house made on it.

    Never handed to the broker — it carries house profit."""
    b = await Broker.get(broker_id) if _oid(broker_id) else None
    cat_index, labels = await _cat_index(), await _cat_labels()
    customers = {str(c.id): c async for c in Customer.find_all()}
    partners = {str(u.id): u async for u in User.find(
        {"account_type": "channel_partner"})}
    policies = {str(p.id): p async for p in Policy.find(
        {"broker_id": broker_id})}

    tds_by_policy: dict[str, int] = {}
    async for e in TdsEntry.find(TdsEntry.broker_id == broker_id):
        if e.policy_id:
            tds_by_policy[e.policy_id] = \
                tds_by_policy.get(e.policy_id, 0) + e.tds_paise

    rows: list[dict] = []
    cats: dict[str, dict] = {}
    total_premium = total_base = total_reward = total_tds = total_profit = 0
    expected_all_time = 0            # never windowed — the position is all-time
    async for pf in _finance_for(policies):
        pol = policies.get(pf.policy_id)
        if pol is None:
            continue
        expected_all_time += pf.agency_reward
        when = policy_date(pol, pf)
        if not _in_window(when, lo, hi):
            continue
        cust = customers.get(pol.customer_id)
        partner = partners.get(pol.partner_id or "")
        tds = tds_by_policy.get(pf.policy_id, 0)
        cat = cat_index.get(pol.category_key)
        rows.append({
            "date": when,
            "month_key": _month_key(when), "month_label": _month_label(when),
            "policy_number": pol.policy_number or pol.code,
            "customer": cust.name if cust else "—",
            "partner": partner.full_name if partner else "Direct",
            "category": labels.get(pol.category_key, pol.category_key),
            "premium": pf.gross_premium,
            "reward_base": pf.commissionable,
            "reward_base_note": _reward_base_note(pol, cat),
            "reward_pct": _pct_of(pf.agency_reward, pf.commissionable),
            "reward": pf.agency_reward,
            "tds": tds,
            "profit": pf.house_profit,
        })
        total_premium += pf.gross_premium
        total_base += pf.commissionable
        total_reward += pf.agency_reward
        total_tds += tds
        total_profit += pf.house_profit
        cats.setdefault(pol.category_key, _empty())
        _add(cats[pol.category_key], pf)
    # Flat, date-sorted table (owner 2026-07-24: no grouping by type).
    rows.sort(key=lambda r: r["date"])

    # Reward received: windowed (for the period tile) and all-time (for the
    # position). Stored negative, so same-type reversals net out on their own.
    received_window = received_all = 0
    async for t in LedgerTxn.find(
            LedgerTxn.party_type == PartyType.BROKER,
            LedgerTxn.party_id == broker_id,
            LedgerTxn.txn_type == LedgerTxnType.REWARD_RECEIVED):
        received_all += -t.amount_paise
        if _in_window(t.occurred_at, lo, hi):
            received_window += -t.amount_paise

    policy_codes = {pid: (p.policy_number or p.code)
                    for pid, p in policies.items()}
    opening = await _party_balance_asof(PartyType.BROKER, broker_id, lo)
    account = await _account_rows(PartyType.BROKER, broker_id, lo, hi,
                                  _BROKER_TXN_LABELS, opening, policy_codes)

    acct = await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.BROKER,
        PartyAccount.party_id == broker_id)
    ledger_balance = acct.balance_paise if acct else 0
    # Same single source as the Balance Sheet list + detail, so the printed
    # bottom line can never disagree with the screen.
    net = broker_net_balance(expected_all_time, received_all, ledger_balance)

    return {
        "kind": "broker",
        "audience": "internal",
        "entity_id": broker_id,
        "label": b.name if b else broker_id,
        "code": b.short_code if b else None,
        "mobile": None,
        "tds_percent": b.tds_percent if b else None,
        "date_from": lo, "date_to": hi,
        "opening_balance": opening,
        "policies": rows,
        "total_premium": total_premium,
        "total_reward_base": total_base,
        "total_reward": total_reward,
        "total_tds": total_tds,
        "total_profit": total_profit,
        "by_category": _by_category_rows(cats, labels, with_reward=True),
        "account": account,
        # Period figures.
        "reward_received": received_window,
        # Live positions (all-time) — these are what "still to collect" means.
        "reward_expected_all_time": expected_all_time,
        "reward_received_all_time": received_all,
        "reward_pending": max(0, expected_all_time - received_all),
        "net_balance": net,
    }


async def _party_balance_asof(party_type: PartyType, party_id: str,
                              cutoff: Optional[datetime]) -> int:
    """Party ledger balance strictly before `cutoff` (for the opening balance)."""
    if cutoff is None:
        return 0
    bal = 0
    async for t in LedgerTxn.find(
            LedgerTxn.party_type == party_type,
            LedgerTxn.party_id == party_id):
        if t.txn_type in _STATEMENT_SKIP_TYPES:
            continue
        if _aware(t.occurred_at) < cutoff:
            bal += t.amount_paise
    return bal


# Filename prefix per section — the owner's convention, e.g.
# CP_statement_Ramesh_Kothari_CP-AA00012.pdf
_FILE_PREFIX = {"partner": "CP", "broker": "BRK", "customer": "CUS"}


def statement_filename(section: str, label: str, code: Optional[str],
                       entity_id: str) -> str:
    """Download name for a statement PDF: PREFIX_statement_Name_Code.pdf."""
    def slug(value: str) -> str:
        cleaned = "".join(ch if (ch.isalnum() or ch in "-_") else " "
                          for ch in str(value or ""))
        return "_".join(cleaned.split())[:48] or "unknown"

    prefix = _FILE_PREFIX.get(section, "STMT")
    return f"{prefix}_statement_{slug(label)}_{slug(code or entity_id)}.pdf"


async def build_statement(section: str, entity_id: str, lo: Optional[datetime],
                          hi: Optional[datetime], *,
                          period_label: Optional[str] = None,
                          statement_no: Optional[str] = None) -> dict:
    """Dispatch to the right statement builder for a balance-sheet section."""
    if section == "broker":
        data = await broker_statement(entity_id, lo, hi)
    elif section == "customer":
        data = await customer_statement(entity_id, lo, hi)
    else:
        data = await partner_statement(entity_id, lo, hi)
    data["period_label"] = period_label
    data["statement_no"] = statement_no
    data["filename"] = statement_filename(
        section, data.get("label", ""), data.get("code"), entity_id)
    return data


def _oid(value: str):
    from beanie import PydanticObjectId
    try:
        return PydanticObjectId(value)
    except Exception:  # noqa: BLE001
        return None
