"""Holidays API — the yearly list an admin enters once and everybody reads.

READING IS OPEN TO EVERY EMPLOYEE, with no flag. A holiday list is not sensitive
and everybody needs it to plan; hiding it behind a permission would mean a new
employee cannot find out whether the office is open on the 15th. `view_holidays`
exists so `manage_holidays` — who may declare a day off for the whole agency —
is grantable on its own, which is the part that actually matters.

DECLARING ONE CHANGES THE PAST, AND THAT IS THE FEATURE
--------------------------------------------------------
Attendance days are DERIVED, never pre-stamped (see models/attendance), so
adding 15 August in September fixes every affected month view at once with no
backfill. It also means a holiday added late can change a month somebody has
already read — so the delete endpoint says how many approved leaves overlap
before it removes one, rather than discovering it afterwards.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction, HrRequestStatus
from app.core.permissions import MANAGE_HOLIDAYS
from app.models.base import utcnow
from app.models.holiday import Holiday
from app.models.leave import LeaveRequest
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message
from app.schemas.hr import (
    CopyYearIn, HolidayIn, HolidayOut, HolidayUpdate, HolidayYearOut,
)
from app.services import hr_calendar as cal, settings_svc
from app.services.audit import log_action

# Staff-only at the ROUTER level — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/hr/holidays", tags=["holidays"],
                   dependencies=[Depends(get_inhouse_user)])


def _year_or_now(year: Optional[int]) -> int:
    if year and 2000 <= year <= 2100:
        return year
    return cal.parse_day(cal.day_key(utcnow())).year


@router.get("", response_model=HolidayYearOut)
async def list_holidays(year: Optional[int] = Query(default=None),
                        actor: User = Depends(get_active_user)
                        ) -> HolidayYearOut:
    """One year's holidays. Open to every employee — see the module docstring."""
    y = _year_or_now(year)
    hr = (await settings_svc.get_settings()).hr
    today = cal.day_key(utcnow())
    rows = await Holiday.find({"year": y}).sort("date").to_list()

    # Suggestions ONLY on an empty year (owner D4). Offering them beside a list
    # somebody has already curated would be nagging them about three dates they
    # deliberately left out.
    suggestions: list[HolidayIn] = []
    if not rows:
        suggestions = [HolidayIn(**h) for h in cal.national_holidays_for(y)]

    return HolidayYearOut(
        year=y,
        holidays=[HolidayOut.from_model(h, today=today,
                                        week_off_days=hr.week_off_days)
                  for h in rows],
        suggestions=suggestions,
        week_off_days=list(hr.week_off_days or []))


@router.post("", response_model=HolidayOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_HOLIDAYS))])
async def add_holiday(payload: HolidayIn, request: Request,
                      actor: User = Depends(get_active_user)) -> HolidayOut:
    existing = await Holiday.find_one({"date": payload.date})
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{payload.date} is already declared as {existing.name}.")

    d = cal.parse_day(payload.date)
    row = Holiday(date=payload.date, year=d.year, name=payload.name,
                  note=payload.note, created_by=str(actor.id),
                  created_by_name=actor.full_name)
    await row.insert()
    await log_action(
        AuditAction.HOLIDAY_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="holiday", entity_id=str(row.id), request=request,
        summary=f"Declared {payload.date} as {payload.name}")

    hr = (await settings_svc.get_settings()).hr
    return HolidayOut.from_model(row, today=cal.day_key(utcnow()),
                                 week_off_days=hr.week_off_days)


@router.patch("/{holiday_id}", response_model=HolidayOut,
              dependencies=[Depends(require_permission(MANAGE_HOLIDAYS))])
async def edit_holiday(holiday_id: str, payload: HolidayUpdate,
                       request: Request,
                       actor: User = Depends(get_active_user)) -> HolidayOut:
    row = await Holiday.get(await parse_object_id(holiday_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Holiday not found.")

    data = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "date" in data and data["date"] != row.date:
        clash = await Holiday.find_one({"date": data["date"]})
        if clash is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{data['date']} is already declared as {clash.name}.")
        row.date = data["date"]
        row.year = cal.parse_day(row.date).year
    if "name" in data:
        row.name = data["name"]
    if "note" in data:
        row.note = data["note"] or None
    row.updated_at = utcnow()
    await row.save()

    await log_action(
        AuditAction.HOLIDAY_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="holiday", entity_id=str(row.id), request=request,
        summary=f"Updated the holiday on {row.date}")
    hr = (await settings_svc.get_settings()).hr
    return HolidayOut.from_model(row, today=cal.day_key(utcnow()),
                                 week_off_days=hr.week_off_days)


@router.delete("/{holiday_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_HOLIDAYS))])
async def delete_holiday(holiday_id: str, request: Request,
                         actor: User = Depends(get_active_user)) -> Message:
    """Remove a declared holiday.

    Says what it is about to change rather than doing it quietly: a day that
    stops being a holiday becomes a working day, which can turn somebody's
    attendance from HOLIDAY into ABSENT and can make an approved leave cost a
    day it did not cost when it was approved. The count is reported in the
    response so the screen can say so.
    """
    row = await Holiday.get(await parse_object_id(holiday_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Holiday not found.")

    overlapping = await LeaveRequest.find({
        "status": HrRequestStatus.APPROVED.value,
        "start_date": {"$lte": row.date}, "end_date": {"$gte": row.date},
    }).count()

    date_str, name = row.date, row.name
    await row.delete()
    await log_action(
        AuditAction.HOLIDAY_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="holiday", entity_id=holiday_id, request=request,
        summary=f"Removed the holiday on {date_str} ({name})",
        meta={"approved_leaves_spanning": overlapping})

    note = (f" {overlapping} approved leave request"
            f"{'' if overlapping == 1 else 's'} span that date and now count "
            f"it as a working day." if overlapping else "")
    return Message(detail=f"{name} on {date_str} was removed.{note}")


@router.post("/copy-year", response_model=HolidayYearOut,
             dependencies=[Depends(require_permission(MANAGE_HOLIDAYS))])
async def copy_year(payload: CopyYearIn, request: Request,
                    actor: User = Depends(get_active_user)) -> HolidayYearOut:
    """Copy one year's list into another (owner D3).

    80% of the list repeats, and re-typing fifteen rows every January is how the
    list stops being maintained. Dates shift by whole years, so a holiday that
    moves with the lunar calendar lands roughly right and gets corrected by
    hand — still far less work than starting from nothing.

    SKIPS rather than overwrites anything already declared in the target year.
    Copying is an additive convenience; silently replacing a date somebody
    deliberately set would be the opposite of one.
    """
    source = await Holiday.find({"year": payload.from_year}).sort("date") \
        .to_list()
    if not source:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"There are no holidays in {payload.from_year} to copy.")

    taken = {h.date for h in
             await Holiday.find({"year": payload.to_year}).to_list()}
    shift = payload.to_year - payload.from_year
    added = 0
    for h in source:
        d = cal.parse_day(h.date)
        try:
            moved = d.replace(year=d.year + shift)
        except ValueError:
            # 29 February into a non-leap year. Dropped rather than nudged to
            # the 28th: a date the software invented is worse than a row the
            # owner adds themselves.
            continue
        key = moved.isoformat()
        if key in taken:
            continue
        await Holiday(date=key, year=moved.year, name=h.name, note=h.note,
                      created_by=str(actor.id),
                      created_by_name=actor.full_name).insert()
        added += 1

    await log_action(
        AuditAction.HOLIDAY_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="holiday", request=request,
        summary=f"Copied {added} holiday(s) from {payload.from_year} into "
                f"{payload.to_year}")
    return await list_holidays(year=payload.to_year, actor=actor)
