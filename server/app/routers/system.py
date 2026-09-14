"""Owner-only operational views: third-party API usage/cost and server errors.
These read the DB logs written in Phase 1/2 (never shown in the audit trail)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_role,
)
from app.core.enums import AccountType
from app.models.base import utcnow
from app.models.system_logs import ApiCallLog, ErrorLog
from app.models.user import User
from app.schemas.common import Page
from app.services.exporters import export_response
from app.routers._helpers import search_regex

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/system", tags=["system"],
                   dependencies=[Depends(get_inhouse_user)])

_OWNER = Depends(require_role(AccountType.OWNER))


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class HealthStrip(BaseModel):
    errors_today: int = 0
    emails_failed_today: int = 0
    api_calls_today: int = 0
    api_cost_today_paise: int = 0
    pending_approvals: int = 0
    overdue_renewals: int = 0


@router.get("/health", response_model=HealthStrip, dependencies=[_OWNER])
async def health_strip(_: User = Depends(get_active_user)) -> HealthStrip:
    """At-a-glance operational health for the Owner (today, UTC)."""
    from app.models.policy import Policy
    from app.models.quote_request import QuoteRequest
    from app.models.system_logs import EmailOutbox

    now = utcnow()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)

    errors = await ErrorLog.find({"created_at": {"$gte": midnight}}).count()
    emails_failed = await EmailOutbox.find(
        {"status": "failed", "created_at": {"$gte": midnight}}).count()
    calls = cost = 0
    async for c in ApiCallLog.find({"created_at": {"$gte": midnight}}):
        calls += 1
        cost += c.cost_paise
    # Quote requests waiting on a human, in place of the old pending-approval
    # count (policy approval was removed 2026-08-05).
    pending = await QuoteRequest.find(
        {"stage": {"$in": ["submitted", "info_needed"]}}).count()
    overdue = await Policy.find({
        "status": {"$in": ["active", "renewal_due"]},
        "expiry_date": {"$lt": now}}).count()

    return HealthStrip(
        errors_today=errors, emails_failed_today=emails_failed,
        api_calls_today=calls, api_cost_today_paise=cost,
        pending_approvals=pending, overdue_renewals=overdue)


class ServiceTotals(BaseModel):
    service: str
    calls: int = 0
    errors: int = 0
    units: int = 0
    bytes_transferred: int = 0
    cost_paise: int = 0
    avg_duration_ms: int = 0


class UsageDayPoint(BaseModel):
    day: str
    calls: int = 0
    cost_paise: int = 0


class ApiUsageSummary(BaseModel):
    date_from: datetime
    date_to: datetime
    total_calls: int = 0
    total_errors: int = 0
    total_cost_paise: int = 0
    by_service: list[ServiceTotals] = []
    daily: list[UsageDayPoint] = []


@router.get("/api-usage/summary", response_model=ApiUsageSummary,
            dependencies=[_OWNER])
async def api_usage_summary(
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    _: User = Depends(get_active_user),
) -> ApiUsageSummary:
    hi = _parse_dt(date_to) or utcnow()
    lo = _parse_dt(date_from) or (hi - timedelta(days=30))

    svc: dict[str, dict] = {}
    day: dict[str, dict] = {}
    total_calls = total_errors = total_cost = 0
    async for c in ApiCallLog.find({"created_at": {"$gte": lo, "$lte": hi}}):
        s = svc.setdefault(c.service, {"calls": 0, "errors": 0, "units": 0,
                                       "bytes": 0, "cost": 0, "dur": 0})
        s["calls"] += 1
        s["errors"] += 0 if c.success else 1
        s["units"] += c.units
        s["bytes"] += c.bytes_transferred
        s["cost"] += c.cost_paise
        s["dur"] += c.duration_ms
        dk = c.created_at.strftime("%Y-%m-%d")
        d = day.setdefault(dk, {"calls": 0, "cost": 0})
        d["calls"] += 1
        d["cost"] += c.cost_paise
        total_calls += 1
        total_errors += 0 if c.success else 1
        total_cost += c.cost_paise

    by_service = [
        ServiceTotals(
            service=k, calls=v["calls"], errors=v["errors"], units=v["units"],
            bytes_transferred=v["bytes"], cost_paise=v["cost"],
            avg_duration_ms=v["dur"] // v["calls"] if v["calls"] else 0)
        for k, v in sorted(svc.items(), key=lambda kv: -kv[1]["calls"])]
    daily = [UsageDayPoint(day=k, calls=v["calls"], cost_paise=v["cost"])
             for k, v in sorted(day.items())]
    return ApiUsageSummary(
        date_from=lo, date_to=hi, total_calls=total_calls,
        total_errors=total_errors, total_cost_paise=total_cost,
        by_service=by_service, daily=daily)


class ApiCallOut(BaseModel):
    id: str
    service: str
    operation: str
    success: bool
    units: int
    bytes_transferred: int
    cost_paise: int
    duration_ms: int
    error: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, c: ApiCallLog) -> "ApiCallOut":
        return cls(id=str(c.id), service=c.service, operation=c.operation,
                   success=c.success, units=c.units,
                   bytes_transferred=c.bytes_transferred, cost_paise=c.cost_paise,
                   duration_ms=c.duration_ms, error=c.error,
                   created_at=c.created_at)


@router.get("/api-usage", response_model=Page[ApiCallOut], dependencies=[_OWNER])
async def api_usage_list(
    service: str | None = Query(default=None),
    success: bool | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _: User = Depends(get_active_user),
) -> Page[ApiCallOut]:
    query: dict = {}
    if service:
        query["service"] = service
    if success is not None:
        query["success"] = success
    rng: dict = {}
    if (df := _parse_dt(date_from)):
        rng["$gte"] = df
    if (dt := _parse_dt(date_to)):
        rng["$lte"] = dt
    if rng:
        query["created_at"] = rng
    total = await ApiCallLog.find(query).count()
    items = (await ApiCallLog.find(query).sort("-created_at")
             .skip((page - 1) * page_size).limit(page_size).to_list())
    return Page[ApiCallOut](items=[ApiCallOut.from_model(c) for c in items],
                            total=total, page=page, page_size=page_size)


@router.get("/api-usage/export", dependencies=[_OWNER])
async def api_usage_export(
    fmt: str = Query(default="excel", pattern="^(excel|xlsx|csv)$"),
    service: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    _: User = Depends(get_active_user),
):
    query: dict = {}
    if service:
        query["service"] = service
    rng: dict = {}
    if (df := _parse_dt(date_from)):
        rng["$gte"] = df
    if (dt := _parse_dt(date_to)):
        rng["$lte"] = dt
    if rng:
        query["created_at"] = rng
    items = await ApiCallLog.find(query).sort("-created_at").limit(20000).to_list()
    headers = ["Time (UTC)", "Service", "Operation", "Success", "Units",
               "Bytes", "Cost (Rs)", "Duration (ms)", "Error"]
    rows = ([c.created_at.strftime("%Y-%m-%d %H:%M:%S"), c.service, c.operation,
             "yes" if c.success else "no", c.units, c.bytes_transferred,
             f"{c.cost_paise / 100:.2f}", c.duration_ms, c.error or ""]
            for c in items)
    return export_response(fmt, "api-usage", headers, rows,
                           sheet_title="API Usage")


class ErrorOut(BaseModel):
    id: str
    ref: str
    method: Optional[str] = None
    path: Optional[str] = None
    exc_type: Optional[str] = None
    message: str
    actor_id: Optional[str] = None
    ip_address: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, e: ErrorLog) -> "ErrorOut":
        return cls(id=str(e.id), ref=e.ref, method=e.method, path=e.path,
                   exc_type=e.exc_type, message=e.message, actor_id=e.actor_id,
                   ip_address=e.ip_address, created_at=e.created_at)


@router.get("/errors", response_model=Page[ErrorOut], dependencies=[_OWNER])
async def list_errors(
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _: User = Depends(get_active_user),
) -> Page[ErrorOut]:
    query: dict = {}
    if q:
        rx = search_regex(q)
        query["$or"] = [{"ref": rx}, {"path": rx}, {"message": rx},
                        {"exc_type": rx}]
    total = await ErrorLog.find(query).count()
    items = (await ErrorLog.find(query).sort("-created_at")
             .skip((page - 1) * page_size).limit(page_size).to_list())
    return Page[ErrorOut](items=[ErrorOut.from_model(e) for e in items],
                          total=total, page=page, page_size=page_size)
