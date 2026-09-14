"""Leave API — applying, approving, and the balance.

WHOSE LEAVE YOU MAY READ, AND WHO MAY DECIDE
----------------------------------------------
Every employee always reaches their OWN leave and their own balance with no flag
(owner G2). `view_leave` opens somebody else's; `manage_leave` is the right to
APPROVE — there is no separate "approve" flag, because splitting by verb is the
failure mode this permission catalogue was rebuilt to escape.

"The manager" is whoever holds `manage_leave` (owner E11, option a). This app has
no employee-to-employee hierarchy: `reports_to_id` was deleted on 2026-08-05 for
being a structure nothing read, and `relationship_manager_id` is about channel
partners. The people trusted to approve leave are exactly the people you would
give the flag to.

NOBODY APPROVES THEIR OWN (owner E12)
--------------------------------------
Enforced server-side in `_assert_may_decide`, exactly like the existing rule
that you may not set your own target. A `manage_leave` holder applying for leave
has it decided by somebody else — the owner, in practice.

THE BALANCE ONLY MOVES AT APPROVAL
-----------------------------------
Submitting reserves nothing. A pending request shows on the balance screen as
"asked for" and is subtracted nowhere, because a request that is refused must
leave no trace on the balance — and a reservation that has to be released is a
second thing to get wrong. `paid_days` / `unpaid_days` are decided once, at
approval, and frozen; see the note in services/hr_leave.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import (
    APIRouter, Depends, HTTPException, Query, Request, status,
)

from app.core.enums import (
    AuditAction, HrRequestStatus, LeaveDayPart, LeaveLedgerEntry,
)
from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.permissions import MANAGE_LEAVE, VIEW_LEAVE, can
from app.models.base import utcnow
from app.models.leave import LeaveLedgerRow, LeaveRequest
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message, Page
from app.schemas.hr import (
    BalanceAdjust,
    DecisionIn,
    LeaveBalanceOut,
    LeaveCostPreview,
    LeaveCreate,
    LeaveLedgerOut,
    LeaveOut,
    LeaveUpdate,
    WhoIsOffEntry,
)
from app.services import codes, hr_attendance, hr_calendar as cal, hr_leave
from app.services import notifications, settings_svc
from app.services.audit import log_action

# Staff-only at the ROUTER level — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/hr/leave", tags=["leave"],
                   dependencies=[Depends(get_inhouse_user)])


# --- Access ----------------------------------------------------------------------


async def _target_user(actor: User, user_id: Optional[str]) -> User:
    """THE ONE PLACE a `user_id` parameter becomes a user in this file."""
    if not user_id or user_id == str(actor.id) or user_id == "me":
        return actor
    if not can(actor, VIEW_LEAVE):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You can only see your own leave.")
    target = await User.get(await parse_object_id(user_id))
    if target is None or getattr(target, "is_deleted", False):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found.")
    return target


def _assert_may_decide(actor: User, req: LeaveRequest) -> None:
    if not can(actor, MANAGE_LEAVE):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You don't have permission to decide leave.")
    if req.user_id == str(actor.id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You cannot decide your own leave. Ask the owner to look at it.")


def _can_cancel(actor: User, req: LeaveRequest, today: str) -> bool:
    """May the CALLER withdraw this request? (owner E13)

    Pending: yes, it is theirs. Approved and still in the future: yes — nobody
    needs permission to come to work. Approved and in the past: only a
    `manage_leave` holder, because it has already been counted.
    """
    mine = req.user_id == str(actor.id)
    if req.status == HrRequestStatus.PENDING.value:
        return mine or can(actor, MANAGE_LEAVE)
    if req.status == HrRequestStatus.APPROVED.value:
        if req.start_date > today:
            return mine or can(actor, MANAGE_LEAVE)
        return can(actor, MANAGE_LEAVE)
    return False


def _out(actor: User, req: LeaveRequest, today: str) -> LeaveOut:
    return LeaveOut.from_model(
        req, can_cancel=_can_cancel(actor, req, today),
        can_edit=(req.status == HrRequestStatus.PENDING.value
                  and (req.user_id == str(actor.id) or can(actor, MANAGE_LEAVE))))


# --- The balance -----------------------------------------------------------------


@router.get("/balance", response_model=LeaveBalanceOut)
async def balance(user_id: Optional[str] = Query(default=None),
                  leave_year: Optional[int] = Query(default=None),
                  actor: User = Depends(get_active_user)) -> LeaveBalanceOut:
    target = await _target_user(actor, user_id)
    hr = (await settings_svc.get_settings()).hr
    data = await hr_leave.balance_for(str(target.id), hr, leave_year=leave_year)
    data["monthly_accrual"] = hr_leave.accrual_for(target, hr)

    # What they have ASKED for and not been told about yet. Shown beside the
    # balance rather than subtracted from it: a pending request reserves
    # nothing, and showing a smaller balance than they actually hold would be a
    # different lie from the one this avoids.
    pending = await LeaveRequest.find({
        "user_id": str(target.id),
        "status": HrRequestStatus.PENDING.value}).to_list()
    return LeaveBalanceOut(
        user_id=str(target.id), user_name=target.full_name,
        pending_days=round(sum(r.days for r in pending), 2), **data)


@router.get("/ledger", response_model=Page[LeaveLedgerOut])
async def ledger(user_id: Optional[str] = Query(default=None),
                 leave_year: Optional[int] = Query(default=None),
                 page: int = Query(default=1, ge=1),
                 page_size: int = Query(default=25, ge=1, le=200),
                 actor: User = Depends(get_active_user)) -> Page[LeaveLedgerOut]:
    """Every movement of one person's balance — "why do I have 4.5 days?".

    The balance is a sum of these rows and nothing else, so this IS the
    explanation rather than a report about it.

    Paginated (owner 2026-09-12): monthly accrual plus every usage/refund row
    for a whole leave year can pass 25 for somebody who has been here a
    while. `hr_leave.ledger_rows` still reads the whole year (that IS the sum
    the balance is built from) — only the response is sliced, newest first.
    """
    target = await _target_user(actor, user_id)
    hr = (await settings_svc.get_settings()).hr
    year = (leave_year if leave_year is not None
            else cal.leave_year_of(cal.day_key(utcnow()),
                                   hr.leave_year_start_month))
    rows = list(reversed(await hr_leave.ledger_rows(str(target.id), year)))
    total = len(rows)
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]
    return Page[LeaveLedgerOut](
        items=[LeaveLedgerOut.from_model(r) for r in page_rows],
        total=total, page=page, page_size=page_size)


@router.post("/balance/adjust", response_model=LeaveBalanceOut,
             dependencies=[Depends(require_permission(MANAGE_LEAVE))])
async def adjust_balance(payload: BalanceAdjust, request: Request,
                         actor: User = Depends(get_active_user)
                         ) -> LeaveBalanceOut:
    """Move somebody's balance by hand, with a reason (owner E6).

    Needed on day one to set opening balances for the people already working
    here — this system starts everybody at zero, which is correct and is not
    what anybody has actually earned.
    """
    target = await User.get(await parse_object_id(payload.user_id))
    if target is None or not hr_attendance.is_hr_subject(target):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found.")
    hr = (await settings_svc.get_settings()).hr
    year = cal.leave_year_of(cal.day_key(utcnow()), hr.leave_year_start_month)

    await hr_leave.post(
        str(target.id),
        (LeaveLedgerEntry.OPENING.value if payload.is_opening
         else LeaveLedgerEntry.ADJUSTMENT.value),
        payload.days, leave_year=year, note=payload.reason, actor=actor)

    await log_action(
        AuditAction.LEAVE_BALANCE_ADJUSTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="leave_balance", entity_id=str(target.id), request=request,
        summary=f"Adjusted {target.full_name}'s leave balance by "
                f"{payload.days:+g} days",
        meta={"reason": payload.reason})
    await notifications.create_notification(
        str(target.id), "Your leave balance was adjusted",
        body=f"{payload.days:+g} days — {payload.reason}",
        category="leave", link="/hr/leave")

    data = await hr_leave.balance_for(str(target.id), hr, leave_year=year)
    data["monthly_accrual"] = hr_leave.accrual_for(target, hr)
    return LeaveBalanceOut(user_id=str(target.id),
                           user_name=target.full_name, **data)


# --- Reading requests ------------------------------------------------------------


@router.get("/requests", response_model=Page[LeaveOut])
async def list_requests(
    mine: bool = Query(default=True),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    user_id: Optional[str] = Query(default=None),
    month: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    actor: User = Depends(get_active_user),
) -> Page[LeaveOut]:
    """`mine=true` is my requests; `mine=false` is everybody's (needs view_leave).

    Defaults to `mine`, so a client that forgets the parameter gets the SAFE
    answer rather than the whole agency's leave.

    Paginated (owner 2026-09-12) — the approval queue across every employee's
    history easily passes 25. A plain Mongo query, so count/sort/page all run
    at the database rather than pulling every row into memory first.
    """
    today = cal.day_key(utcnow())
    query: dict = {}
    if user_id:
        query["user_id"] = str((await _target_user(actor, user_id)).id)
    elif mine or not can(actor, VIEW_LEAVE):
        query["user_id"] = str(actor.id)
    if status_filter:
        query["status"] = status_filter
    if month:
        try:
            first, last = cal.month_bounds(month)
            query["start_date"] = {"$lte": last.isoformat()}
            query["end_date"] = {"$gte": first.isoformat()}
        except (ValueError, IndexError):
            pass
    total = await LeaveRequest.find(query).count()
    rows = await LeaveRequest.find(query).sort("-created_at") \
        .skip((page - 1) * page_size).limit(page_size).to_list()
    return Page[LeaveOut](
        items=[_out(actor, r, today) for r in rows],
        total=total, page=page, page_size=page_size)


@router.get("/who-is-off", response_model=list[WhoIsOffEntry])
async def who_is_off(days: int = Query(default=7, ge=1, le=60),
                     actor: User = Depends(get_active_user)
                     ) -> list[WhoIsOffEntry]:
    """Who is off between today and `days` ahead. NO FLAG REQUIRED.

    Names and dates ONLY — never the reason (owner G5). Everybody needs this to
    plan work and it is not sensitive; why somebody is off stays between them
    and whoever approved it, which is why this schema has no field for it.
    """
    from datetime import date as _date
    today = cal.parse_day(cal.day_key(utcnow()))
    lo = today.isoformat()
    hi = _date.fromordinal(today.toordinal() + days).isoformat()
    rows = await LeaveRequest.find({
        "status": HrRequestStatus.APPROVED.value,
        "start_date": {"$lte": hi}, "end_date": {"$gte": lo},
    }).sort("start_date").to_list()
    return [WhoIsOffEntry(user_id=r.user_id, name=r.user_name,
                          start_date=r.start_date, end_date=r.end_date,
                          day_part=r.day_part) for r in rows]


@router.get("/preview", response_model=LeaveCostPreview)
async def preview(start_date: str = Query(...), end_date: str = Query(...),
                  day_part: str = Query(default=LeaveDayPart.FULL.value),
                  user_id: Optional[str] = Query(default=None),
                  actor: User = Depends(get_active_user)) -> LeaveCostPreview:
    """What this request will cost, BEFORE it is submitted (owner E17).

    The form calls this as the dates change, so "0.5 paid, 2.5 unpaid" is on
    screen while there is still time to change your mind. Going short is never
    blocked; it is just never a surprise.
    """
    target = await _target_user(actor, user_id)
    hr = (await settings_svc.get_settings()).hr
    try:
        cal.parse_day(start_date), cal.parse_day(end_date)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Those are not real dates.")
    if end_date < start_date:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The last day of leave cannot be before the first day.")

    cost, keys = await hr_leave.count_days(start_date, end_date, day_part, hr)
    all_days = [d.isoformat() for d in cal.day_span(start_date, end_date)]
    bal = await hr_leave.balance_for(str(target.id), hr)
    paid, unpaid = hr_leave.split_paid_unpaid(cost, bal["available"])
    clash = await hr_leave.overlapping(str(target.id), start_date, end_date)

    return LeaveCostPreview(
        days=cost, working_days=keys,
        skipped_days=[d for d in all_days if d not in set(keys)],
        available=bal["available"], paid_days=paid, unpaid_days=unpaid,
        is_backdated=start_date < cal.day_key(utcnow()),
        conflict=(f"{clash.code} already covers {clash.start_date} to "
                  f"{clash.end_date}") if clash else None)


# --- Applying --------------------------------------------------------------------


@router.post("/requests", response_model=LeaveOut,
             status_code=status.HTTP_201_CREATED)
async def apply(payload: LeaveCreate, request: Request,
                actor: User = Depends(get_active_user)) -> LeaveOut:
    """Apply for leave. `user_id` (applying on somebody's behalf) needs
    manage_leave and is auto-approved (owner E16)."""
    hr = (await settings_svc.get_settings()).hr
    today = cal.day_key(utcnow())

    subject = actor
    on_behalf = False
    if payload.user_id and payload.user_id != str(actor.id):
        if not can(actor, MANAGE_LEAVE):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "You can only apply for your own leave.")
        found = await User.get(await parse_object_id(payload.user_id))
        if found is None or not hr_attendance.is_hr_subject(found):
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                "Employee not found.")
        subject, on_behalf = found, True
    elif not hr_attendance.is_hr_subject(actor):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Leave is recorded for employees. Your account does not apply "
            "for leave.")

    clash = await hr_leave.overlapping(str(subject.id), payload.start_date,
                                       payload.end_date)
    if clash is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{clash.code} already covers {clash.start_date} to "
            f"{clash.end_date}. Cancel it first, or pick other dates.")

    cost, _ = await hr_leave.count_days(payload.start_date, payload.end_date,
                                        payload.day_part, hr)
    if cost <= 0:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Every day in that range is a week off or a holiday, so there is "
            "no leave to apply for.")

    req = LeaveRequest(
        code=await codes.next_code("leave"),
        user_id=str(subject.id), user_name=subject.full_name,
        applied_by=str(actor.id), applied_by_name=actor.full_name,
        on_behalf=on_behalf,
        start_date=payload.start_date, end_date=payload.end_date,
        day_part=payload.day_part, reason_type=payload.reason_type,
        reason=payload.reason, days=cost,
        is_backdated=payload.start_date < today)
    await req.insert()

    # Applied on somebody's behalf by a manage_leave holder: already decided, by
    # definition. Making them approve what they just typed is a queue entry that
    # exists only to be cleared by the person who created it.
    if on_behalf:
        await _approve(req, actor, hr, note="Recorded by "
                                            f"{actor.full_name}")
    else:
        await notifications.notify_permission(
            MANAGE_LEAVE, "Leave request to review",
            body=f"{subject.full_name} asked for {cost:g} day"
                 f"{'' if cost == 1 else 's'} "
                 f"({payload.start_date} to {payload.end_date}).",
            category="leave", link="/hr/leave?view=requests",
            exclude_user_id=str(actor.id))

    await log_action(
        AuditAction.LEAVE_REQUESTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="leave", entity_id=str(req.id), entity_code=req.code,
        request=request,
        summary=f"Applied for {cost:g} day(s) leave for {subject.full_name}")
    return _out(actor, req, today)


@router.patch("/requests/{request_id}", response_model=LeaveOut)
async def edit(request_id: str, payload: LeaveUpdate, request: Request,
               actor: User = Depends(get_active_user)) -> LeaveOut:
    """Edit a request that is still PENDING (owner E13)."""
    req = await LeaveRequest.get(await parse_object_id(request_id))
    if req is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave request not found.")
    if req.user_id != str(actor.id) and not can(actor, MANAGE_LEAVE):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "That is not your leave request.")
    if req.status != HrRequestStatus.PENDING.value:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Only a request that is still waiting can be edited. Cancel it "
            "and apply again.")

    hr = (await settings_svc.get_settings()).hr
    data = payload.model_dump(exclude_unset=True, exclude_none=True)
    for field in ("start_date", "end_date", "day_part", "reason_type",
                  "reason"):
        if field in data:
            setattr(req, field, data[field])
    if req.end_date < req.start_date:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The last day of leave cannot be before the first day.")
    if req.day_part != LeaveDayPart.FULL.value and not req.is_single_day:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A half day can only be applied for on a single date.")

    clash = await hr_leave.overlapping(req.user_id, req.start_date,
                                       req.end_date, exclude_id=str(req.id))
    if clash is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{clash.code} already covers {clash.start_date} to "
            f"{clash.end_date}.")

    # Recount: the dates may have moved, and a holiday may have been declared
    # since the request was raised.
    req.days, _ = await hr_leave.count_days(req.start_date, req.end_date,
                                            req.day_part, hr)
    req.updated_at = utcnow()
    await req.save()

    await log_action(
        AuditAction.LEAVE_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="leave", entity_id=str(req.id), entity_code=req.code,
        request=request, summary=f"Edited leave request {req.code}")
    return _out(actor, req, cal.day_key(utcnow()))


# --- Deciding --------------------------------------------------------------------


async def _approve(req: LeaveRequest, actor: User, hr, *,
                   note: Optional[str] = None) -> None:
    """Approve a request and spend the balance. Shared by the decide endpoint
    and the apply-on-behalf path, so the two cannot drift.

    The cost is RECOMPUTED here: a holiday declared while the request waited
    would otherwise charge somebody for a day the office was shut.
    """
    req.days, _ = await hr_leave.count_days(req.start_date, req.end_date,
                                            req.day_part, hr)
    bal = await hr_leave.balance_for(req.user_id, hr)
    req.paid_days, req.unpaid_days = hr_leave.split_paid_unpaid(
        req.days, bal["available"])
    req.status = HrRequestStatus.APPROVED.value
    req.decided_by = str(actor.id)
    req.decided_by_name = actor.full_name
    req.decided_at = utcnow()
    req.decision_note = note
    req.updated_at = utcnow()
    await req.save()
    await hr_leave.spend(req, hr, actor)


@router.post("/requests/{request_id}/decide", response_model=LeaveOut)
async def decide(request_id: str, payload: DecisionIn, request: Request,
                 actor: User = Depends(get_active_user)) -> LeaveOut:
    req = await LeaveRequest.get(await parse_object_id(request_id))
    if req is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave request not found.")
    _assert_may_decide(actor, req)
    if req.status != HrRequestStatus.PENDING.value:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "That request has already been decided.")

    hr = (await settings_svc.get_settings()).hr
    if payload.approve:
        await _approve(req, actor, hr, note=payload.note)
        body = (f"{req.start_date} to {req.end_date} — {req.days:g} day"
                f"{'' if req.days == 1 else 's'}"
                + (f", of which {req.unpaid_days:g} unpaid."
                   if req.unpaid_days > 0 else "."))
    else:
        req.status = HrRequestStatus.REJECTED.value
        req.decided_by = str(actor.id)
        req.decided_by_name = actor.full_name
        req.decided_at = utcnow()
        req.decision_note = payload.note
        req.updated_at = utcnow()
        await req.save()
        body = payload.note or "Your leave request was not approved."

    await log_action(
        AuditAction.LEAVE_DECIDED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="leave", entity_id=str(req.id), entity_code=req.code,
        request=request,
        summary=f"{'Approved' if payload.approve else 'Rejected'} "
                f"{req.user_name}'s leave {req.code}")
    await notifications.create_notification(
        req.user_id,
        f"Leave {'approved' if payload.approve else 'not approved'}",
        body=body, category="leave", link="/hr/leave")
    return _out(actor, req, cal.day_key(utcnow()))


@router.post("/requests/{request_id}/cancel", response_model=LeaveOut)
async def cancel(request_id: str, request: Request,
                 actor: User = Depends(get_active_user)) -> LeaveOut:
    """Withdraw a request. An approved one gives the balance back.

    The refund is a ROW, not a deletion of the usage row (see
    services/hr_leave.refund): two entries that cancel out are a story somebody
    can read, and a vanished entry is a number nobody can explain.
    """
    req = await LeaveRequest.get(await parse_object_id(request_id))
    if req is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave request not found.")
    today = cal.day_key(utcnow())
    if not _can_cancel(actor, req, today):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Leave that has already started can only be cancelled by "
            "somebody who manages leave.")

    hr = (await settings_svc.get_settings()).hr
    was_approved = req.is_approved
    req.status = HrRequestStatus.CANCELLED.value
    req.cancelled_at = utcnow()
    req.cancelled_by = str(actor.id)
    req.cancelled_by_name = actor.full_name
    req.updated_at = utcnow()
    await req.save()
    if was_approved:
        await hr_leave.refund(req, hr, actor)

    await log_action(
        AuditAction.LEAVE_CANCELLED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="leave", entity_id=str(req.id), entity_code=req.code,
        request=request, summary=f"Cancelled leave {req.code}")
    if req.user_id != str(actor.id):
        await notifications.create_notification(
            req.user_id, "Your leave was cancelled",
            body=f"{actor.full_name} cancelled {req.code} "
                 f"({req.start_date} to {req.end_date}).",
            category="leave", link="/hr/leave")
    return _out(actor, req, today)
