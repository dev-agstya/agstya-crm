"""Async aggregation for the Finance Reports page and entity finance profiles.

Groups policies (joined with their frozen PolicyFinance P&L) by a chosen
dimension, in Python — data volume for a single agency is small and this keeps
the money source (house profit incl. discount) consistent with the dashboard.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from app.core.enums import LedgerTxnType, PartyType
from app.models.broker import Broker
from app.models.customer import Customer
from app.models.finance import LedgerTxn, PartyAccount, PolicyFinance
from app.models.insurer import Insurer
from app.models.policy import Policy
from app.models.user import User
from app.models.wallet import Wallet
from app.services import finance_reports as fr

DIMENSIONS = {"insurer", "broker", "partner", "employee",
              "customer", "month"}

_METRIC_FIELDS = ("policies", "premium", "reward_earned", "reward",
                  "discount", "profit")


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _dim_key(policy: Policy, pf: PolicyFinance, dimension: str) -> Optional[str]:
    if dimension == "insurer":
        return policy.insurer_id
    if dimension == "broker":
        return policy.broker_id
    if dimension == "partner":
        return policy.partner_id
    if dimension == "employee":
        return policy.owner_user_id
    if dimension == "customer":
        return policy.customer_id
    if dimension == "month":
        return fr.month_key(_aware(pf.created_at))
    return None


def _empty() -> dict:
    return {f: 0 for f in _METRIC_FIELDS}


def _add(acc: dict, pf: PolicyFinance) -> None:
    acc["policies"] += 1
    acc["premium"] += pf.gross_premium
    acc["reward_earned"] += pf.agency_reward
    acc["reward"] += pf.partner_share
    acc["discount"] += pf.discount
    acc["profit"] += pf.house_profit


def _group(policies: dict[str, Policy], finances: list[PolicyFinance],
           dimension: str, lo: Optional[datetime], hi: Optional[datetime]
           ) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for pf in finances:
        when = _aware(pf.created_at)
        if lo and when < lo:
            continue
        if hi and when > hi:
            continue
        pol = policies.get(pf.policy_id)
        if pol is None:
            continue
        key = _dim_key(pol, pf, dimension)
        if key is None:
            continue
        out.setdefault(key, _empty())
        _add(out[key], pf)
    return out


async def _labels(dimension: str, keys: list[str]) -> dict[str, str]:
    ids = [k for k in keys if k]
    if not ids:
        return {}
    if dimension in ("partner", "employee"):
        return {str(u.id): u.full_name
                for u in await User.find({"_id": {"$in": _oids(ids)}}).to_list()}
    if dimension == "customer":
        return {str(c.id): c.name
                for c in await Customer.find({"_id": {"$in": _oids(ids)}}).to_list()}
    if dimension == "insurer":
        return {str(i.id): i.name
                for i in await Insurer.find({"_id": {"$in": _oids(ids)}}).to_list()}
    if dimension == "broker":
        return {str(b.id): b.name
                for b in await Broker.find({"_id": {"$in": _oids(ids)}}).to_list()}
    return {k: k for k in ids}   # month


def _oids(ids: list[str]):
    from beanie import PydanticObjectId
    out = []
    for i in ids:
        try:
            out.append(PydanticObjectId(i))
        except Exception:  # noqa: BLE001
            continue
    return out


async def compute_report(dimension: str, date_from: Optional[datetime],
                         date_to: Optional[datetime]) -> dict:
    """Return {dimension, totals, rows} for the Reports page."""
    policies = {str(p.id): p async for p in Policy.find_all()}
    finances = await PolicyFinance.find_all().to_list()

    cur = _group(policies, finances, dimension, date_from, date_to)
    # Previous equal-length window for growth on profit.
    prev: dict[str, dict] = {}
    if date_from and date_to:
        span = date_to - date_from
        prev = _group(policies, finances, dimension,
                      date_from - span, date_from)

    labels = await _labels(dimension, list(cur.keys()))
    pending = await _pending_for(dimension, list(cur.keys()))

    rows = []
    for key, m in cur.items():
        prev_profit = prev.get(key, {}).get("profit", 0)
        p = pending.get(key, {})
        collection = p.get("collection")
        if dimension == "broker":
            # Reward still to receive from this broker.
            collection = max(0, m["reward_earned"] - p.get("received", 0))
        rows.append({
            "key": key,
            "label": labels.get(key, key) or "—",
            **m,
            "pending_collection": collection,
            "pending_payout": p.get("payout"),
            "growth_pct": fr.growth_pct(m["profit"], prev_profit),
        })
    rows.sort(key=lambda r: r["profit"], reverse=True)

    totals = _empty()
    for m in cur.values():
        for f in _METRIC_FIELDS:
            totals[f] += m[f]
    return {"dimension": dimension, "totals": totals, "rows": rows}


_ENTITY_FIELD = {
    "insurer": "insurer_id", "broker": "broker_id",
    "customer": "customer_id", "employee": "owner_user_id",
    "partner": "partner_id",
}
_ENTITY_PARTY = {
    "customer": PartyType.CUSTOMER, "partner": PartyType.CHANNEL_PARTNER,
    "broker": PartyType.BROKER,
}


async def compute_entity_profile(entity_type: str, entity_id: str,
                                 now: datetime) -> dict:
    """A mini finance dashboard for one insurer / broker profile / customer /
    employee / partner: headline metrics, monthly profit, pending, policy stats."""
    field = _ENTITY_FIELD[entity_type]
    policies = {str(p.id): p async for p in Policy.find(
        {field: entity_id})}
    finances = [pf for pf in await PolicyFinance.find_all().to_list()
                if pf.policy_id in policies]

    metrics = _empty()
    keys = fr.last_n_month_keys(now, 12)
    month_profit = {k: 0 for k in keys}
    month_premium = {k: 0 for k in keys}
    status_count: dict[str, int] = {}
    for pf in finances:
        _add(metrics, pf)
        mk = fr.month_key(_aware(pf.created_at))
        if mk in month_profit:
            month_profit[mk] += pf.house_profit
            month_premium[mk] += pf.gross_premium
    for p in policies.values():
        st = p.status.value if hasattr(p.status, "value") else str(p.status)
        status_count[st] = status_count.get(st, 0) + 1

    label = (await _labels(entity_type, [entity_id])).get(entity_id, entity_id)

    pending = {"collection": None, "payout": None, "reward_to_receive": None}
    party = _ENTITY_PARTY.get(entity_type)
    if party in (PartyType.CUSTOMER, PartyType.CHANNEL_PARTNER):
        acct = await PartyAccount.find_one(
            PartyAccount.party_type == party,
            PartyAccount.party_id == entity_id)
        pending["collection"] = acct.balance_paise if acct else 0
    if entity_type == "partner":
        w = await Wallet.find_one(Wallet.partner_id == entity_id)
        pending["payout"] = (w.available_paise + w.pending_paise) if w else 0
    if entity_type == "broker":
        received = 0
        async for t in LedgerTxn.find(
                LedgerTxn.txn_type == LedgerTxnType.REWARD_RECEIVED,
                LedgerTxn.party_id == entity_id):
            received += -t.amount_paise
        pending["reward_to_receive"] = max(
            0, metrics["reward_earned"] - received)

    return {
        "entity_type": entity_type, "entity_id": entity_id, "label": label,
        "party_type": party.value if party else None,
        "metrics": metrics,
        "monthly": [{"month": k, "profit": month_profit[k],
                     "premium": month_premium[k]} for k in keys],
        "pending": pending,
        "policy_status": status_count,
    }


async def _pending_for(dimension: str, keys: list[str]) -> dict[str, dict]:
    """Attach point-in-time pending balances for party dimensions."""
    if dimension == "customer":
        out = {}
        async for a in PartyAccount.find(
                PartyAccount.party_type == PartyType.CUSTOMER):
            if a.party_id in keys and a.balance_paise > 0:
                out[a.party_id] = {"collection": a.balance_paise}
        return out
    if dimension == "partner":
        out: dict[str, dict] = {}
        async for a in PartyAccount.find(
                PartyAccount.party_type == PartyType.CHANNEL_PARTNER):
            if a.party_id in keys and a.balance_paise > 0:
                out.setdefault(a.party_id, {})["collection"] = a.balance_paise
        async for w in Wallet.find_all():
            if w.partner_id in keys:
                out.setdefault(w.partner_id, {})["payout"] = (
                    w.available_paise + w.pending_paise)
        return out
    if dimension == "broker":
        received: dict[str, int] = {}
        async for t in LedgerTxn.find(
                LedgerTxn.party_type == PartyType.BROKER,
                LedgerTxn.txn_type == LedgerTxnType.REWARD_RECEIVED):
            received[t.party_id] = received.get(t.party_id, 0) + (-t.amount_paise)
        # collection here = reward still to receive (expected - received);
        # expected is computed by the caller via the row's reward_earned.
        return {k: {"received": received.get(k, 0)} for k in keys}
    return {}
