"""TDS report: the tax brokers withheld on our reward, per broker + financial year.

Sourced entirely from TdsEntry rows (one per reward-received event with TDS), so the
totals are always auditable — never a guessed number. TDS never touches house profit
(owner Q7); it is an advance tax we reclaim, tracked here separately.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from app.models.broker import Broker
from app.models.finance import TdsEntry
from app.models.policy import Policy


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _in_window(dt: datetime, lo: Optional[datetime],
               hi: Optional[datetime]) -> bool:
    dt = _aware(dt)
    if lo and dt < lo:
        return False
    if hi and dt > hi:
        return False
    return True


async def compute_tds_report(lo: Optional[datetime], hi: Optional[datetime],
                             fy_label: Optional[str] = None) -> dict:
    brokers = {str(b.id): b async for b in Broker.find_all()}

    by_broker: dict[str, dict] = {}
    entries: list[dict] = []
    policy_ids: set[str] = set()
    total_gross = total_tds = 0

    rows = await TdsEntry.find_all().to_list()
    rows.sort(key=lambda e: _aware(e.occurred_at), reverse=True)
    for e in rows:
        if not _in_window(e.occurred_at, lo, hi):
            continue
        b = brokers.get(e.broker_id)
        agg = by_broker.setdefault(e.broker_id, {
            "gross": 0, "tds": 0, "entries": 0})
        agg["gross"] += e.gross_reward_paise
        agg["tds"] += e.tds_paise
        agg["entries"] += 1
        total_gross += e.gross_reward_paise
        total_tds += e.tds_paise
        if e.policy_id:
            policy_ids.add(e.policy_id)
        entries.append({
            "id": str(e.id), "date": _aware(e.occurred_at),
            "broker_id": e.broker_id,
            "broker_name": b.name if b else e.broker_id,
            "policy_id": e.policy_id, "policy_code": None,
            "gross_reward": e.gross_reward_paise,
            "tds_percent": e.tds_percent, "tds_deducted": e.tds_paise,
            "reference": e.reference, "note": e.note,
        })

    # Resolve policy codes for display.
    if policy_ids:
        pol_codes = {str(p.id): p.code async for p in Policy.find(
            {"_id": {"$in": _oids(policy_ids)}})}
        for row in entries:
            if row["policy_id"]:
                row["policy_code"] = pol_codes.get(row["policy_id"])

    broker_rows = []
    for broker_id, agg in by_broker.items():
        b = brokers.get(broker_id)
        broker_rows.append({
            "broker_id": broker_id,
            "broker_name": b.name if b else broker_id,
            "broker_code": b.short_code if b else None,
            "tds_percent": b.tds_percent if b else 0,
            "entries": agg["entries"], "gross_reward": agg["gross"],
            "tds_deducted": agg["tds"],
        })
    broker_rows.sort(key=lambda r: r["tds_deducted"], reverse=True)

    return {
        "date_from": lo, "date_to": hi, "fy_label": fy_label,
        "total_gross_reward": total_gross, "total_tds": total_tds,
        "by_broker": broker_rows, "entries": entries,
    }


def _oids(ids):
    from beanie import PydanticObjectId
    out = []
    for i in ids:
        try:
            out.append(PydanticObjectId(i))
        except Exception:  # noqa: BLE001
            continue
    return out
