"""Record + read per-staff daily lead activity.

Kept deliberately best-effort: a bookkeeping failure must never break the
underlying lead action, so every write is wrapped and swallowed on error.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from app.core.enums import AccountType
from app.models.base import utcnow
from app.models.lead_activity import LeadActivityDaily
from app.models.user import User

logger = logging.getLogger("agastyacrm.lead_activity")


def _today() -> str:
    # Per-day buckets follow the Indian calendar (owner Q-P1).
    from app.services.finance_reports import to_ist
    return to_ist(utcnow()).strftime("%Y-%m-%d")


async def record(actor: User, *, kind: str, lead_id: str | None = None) -> None:
    """kind = 'created' | 'updated' | 'converted'. Employees only."""
    try:
        if actor.account_type != AccountType.EMPLOYEE:
            return
        day = _today()
        doc = await LeadActivityDaily.find_one({
            "user_id": str(actor.id), "day": day})
        if doc is None:
            doc = LeadActivityDaily(
                user_id=str(actor.id), user_name=actor.full_name, day=day)
        if kind == "created":
            doc.leads_created += 1
        elif kind == "converted":
            doc.leads_converted += 1
        elif kind == "updated":
            if lead_id and lead_id not in doc.touched_lead_ids:
                doc.touched_lead_ids.append(lead_id)
                doc.leads_updated += 1
            elif not lead_id:
                doc.leads_updated += 1
        doc.user_name = actor.full_name
        doc.updated_at = utcnow()
        await doc.save()
    except Exception:  # noqa: BLE001 — never break the request on bookkeeping
        logger.exception("Failed to record lead activity")


async def summary(*, days: int = 30, user_ids: list[str] | None = None
                  ) -> list[dict]:
    """Aggregate per-user totals over the trailing `days` window."""
    since = (utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
    match: dict = {"day": {"$gte": since}}
    if user_ids is not None:
        match["user_id"] = {"$in": user_ids}
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$user_id",
            "user_name": {"$last": "$user_name"},
            "leads_created": {"$sum": "$leads_created"},
            "leads_updated": {"$sum": "$leads_updated"},
            "leads_converted": {"$sum": "$leads_converted"},
            "active_days": {"$sum": 1},
        }},
        {"$sort": {"leads_converted": -1, "leads_updated": -1}},
    ]
    rows = await LeadActivityDaily.aggregate(pipeline).to_list()
    out = []
    for r in rows:
        out.append({
            "user_id": str(r["_id"]),
            "user_name": r.get("user_name") or "-",
            "leads_created": int(r.get("leads_created", 0)),
            "leads_updated": int(r.get("leads_updated", 0)),
            "leads_converted": int(r.get("leads_converted", 0)),
            "active_days": int(r.get("active_days", 0)),
        })
    return out
