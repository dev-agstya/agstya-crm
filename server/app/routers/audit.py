"""Audit-log viewing + export.

Access is by permission: `view_audit_logs` shows the trail SCOPED to the
viewer's team (their own actions + their reports + their partners), while
`view_all_audit` (the Owner) sees the entire portal. IP addresses are shown to
Owners only.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.permissions import can, VIEW_AUDIT_LOGS
from app.models.audit import AuditLog
from app.models.base import utcnow
from app.models.user import User
from app.schemas.common import Page
from app.services import finance_reports as fr
from app.services.audit import describe_changes
from app.services.exporters import export_response
from app.routers._helpers import parse_object_id, search_regex
from pydantic import BaseModel

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/audit", tags=["audit"],
                   dependencies=[Depends(get_inhouse_user)])


class AuditOut(BaseModel):
    id: str
    action: str
    actor_id: Optional[str] = None
    actor_name: Optional[str] = None
    actor_role: Optional[str] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    entity_code: Optional[str] = None
    summary: str
    meta: dict
    ip_address: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, a, *, show_ip: bool = True) -> "AuditOut":
        return cls(
            id=str(a.id),
            action=a.action.value if hasattr(a.action, "value") else a.action,
            actor_id=a.actor_id, actor_name=a.actor_name, actor_role=a.actor_role,
            entity_type=a.entity_type, entity_id=a.entity_id,
            entity_code=a.entity_code, summary=a.summary, meta=a.meta,
            ip_address=a.ip_address if show_ip else None,
            created_at=a.created_at,
        )


# The audit filter's dates are picked out of a calendar like every other
# filter's, so they are Indian days — shared reader, see services/finance_reports.
_parse_dt = fr.parse_ist_bound


async def _build_query(
    actor: User, action: Optional[str], actor_id: Optional[str],
    entity_type: Optional[str], entity_id: Optional[str],
    date_from: Optional[str], date_to: Optional[str], q: Optional[str],
) -> dict:
    filters: list[dict] = []

    # v1 has no record-level scoping: every in-house user sees the whole audit
    # log. Fall back to a default 90-day window only when no explicit range given.
    #
    # `date_to` is promoted to end-of-day: it was read as bare midnight, so a
    # range ending "31 Jul" returned nothing that happened ON the 31st — the
    # same off-by-one that was fixed on the ledger filter and missed here.
    rng = fr.ist_range(date_from, date_to)
    if rng:
        filters.append({"created_at": rng})
    else:
        filters.append({"created_at": {"$gte": utcnow() - timedelta(days=90)}})

    if actor_id:
        filters.append({"actor_id": actor_id})
    if action:
        filters.append({"action": action})
    if entity_type:
        filters.append({"entity_type": entity_type})
    if entity_id:
        filters.append({"entity_id": entity_id})
    if q:
        rx = search_regex(q)
        filters.append({"$or": [
            {"summary": rx}, {"action": rx}, {"actor_name": rx},
            {"actor_id": rx}, {"actor_role": rx}, {"entity_type": rx},
            {"entity_id": rx}, {"entity_code": rx},
        ]})
    return {"$and": filters} if len(filters) > 1 else filters[0]


@router.get("", response_model=Page[AuditOut],
            dependencies=[Depends(require_permission(VIEW_AUDIT_LOGS))])
async def list_audit(
    actor: User = Depends(get_active_user),
    action: str | None = Query(default=None),
    actor_id: str | None = Query(default=None),
    entity_type: str | None = Query(default=None),
    entity_id: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    q: str | None = Query(default=None, description="Free-text search"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
) -> Page[AuditOut]:
    query = await _build_query(actor, action, actor_id, entity_type, entity_id,
                               date_from, date_to, q)
    show_ip = can(actor, VIEW_AUDIT_LOGS)
    total = await AuditLog.find(query).count()
    items = (await AuditLog.find(query).sort("-created_at")
             .skip((page - 1) * page_size).limit(page_size).to_list())
    return Page[AuditOut](
        items=[AuditOut.from_model(a, show_ip=show_ip) for a in items],
        total=total, page=page, page_size=page_size,
    )


# NOTE: registered before GET /{entry_id} would be — /export is a static path
# and a dynamic single segment declared first would swallow it.
@router.get("/export",
            dependencies=[Depends(require_permission(VIEW_AUDIT_LOGS))])
async def export_audit(
    actor: User = Depends(get_active_user),
    fmt: str = Query(default="excel", pattern="^(excel|xlsx|csv)$"),
    action: str | None = Query(default=None),
    actor_id: str | None = Query(default=None),
    entity_type: str | None = Query(default=None),
    entity_id: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    q: str | None = Query(default=None),
):
    """Download the filtered audit trail. Capped so an export can't run away."""
    query = await _build_query(actor, action, actor_id, entity_type, entity_id,
                               date_from, date_to, q)
    show_ip = can(actor, VIEW_AUDIT_LOGS)
    items = (await AuditLog.find(query).sort("-created_at")
             .limit(20000).to_list())

    headers = ["Time (UTC)", "Actor", "Role", "Action", "Entity", "Code",
               "Summary", "Changes"]
    if show_ip:
        headers.append("IP")

    def _row(a: AuditLog):
        changes = (a.meta or {}).get("changes") or {}
        row = [
            a.created_at.strftime("%Y-%m-%d %H:%M:%S"),
            a.actor_name or "System", (a.actor_role or "").title(),
            (a.action.value if hasattr(a.action, "value") else a.action),
            a.entity_type or "", a.entity_code or "", a.summary,
            describe_changes(changes, limit=20) if changes else "",
        ]
        if show_ip:
            row.append(a.ip_address or "")
        return row

    return export_response(fmt, "audit-logs", headers, (_row(a) for a in items),
                           sheet_title="Audit Logs")


@router.get("/{entry_id}", response_model=AuditOut,
            dependencies=[Depends(require_permission(VIEW_AUDIT_LOGS))])
async def get_audit_entry(entry_id: str,
                          actor: User = Depends(get_active_user)) -> AuditOut:
    """One audit entry.

    Added 2026-08-03 when the detail popup became a page: a page is addressed by
    URL, so it has to be able to load the record on its own rather than being
    handed one the list already had. Being able to send someone the link to a
    specific change is most of the point.
    """
    entry = await AuditLog.get(await parse_object_id(entry_id))
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Audit entry not found.")
    return AuditOut.from_model(
        entry, show_ip=can(actor, VIEW_AUDIT_LOGS))
