"""Attendance: the punch clock, the day's arithmetic, and the month view.

THE ONE RULE THIS FILE EXISTS TO KEEP
--------------------------------------
`recompute()` is the ONLY place a day's minutes and status are decided. The
punch endpoints, the manager's edit, an approved correction and the nightly
auto-close all mutate the raw facts (clock_in, clock_out, breaks) and then call
it. Nothing else writes `worked_minutes`, `status`, `is_late` or their
neighbours.

That matters because the same day is recomputed by four different callers at
four different times, and a status the punch decided one way and the correction
decided another is the bug that makes an employee and their manager read
different registers for the same Tuesday.

WORKING TIME = OUT - IN - BREAKS
--------------------------------
Breaks are subtracted (owner B5), so an 8-hour day means eight hours of WORK and
roughly nine in the building. A break left open when the day closes is closed
with it — an unclosed break would otherwise subtract nothing at all, which is
the wrong way round: forgetting to come back from lunch would CREDIT you.

PRECEDENCE, WHEN SEVERAL THINGS COULD BE TRUE OF ONE DAY
---------------------------------------------------------
    HOLIDAY > WEEK OFF > a manager's override > a punch > approved leave > ABSENT

Holiday and week off come first because they are facts about the OFFICE, not
about the person: an employee cannot be absent on a day nobody was open. The
manager's override beats the punch because that is what an override is for. And
a PUNCH BEATS APPROVED LEAVE (owner C10) — somebody who came in and worked was
present, and `build_month` reports the leave day as refundable so the balance
goes back. Punishing someone for turning up is indefensible.

ABSENT IS DERIVED, NEVER STORED IN ADVANCE
-------------------------------------------
There is no nightly sweep stamping everybody absent. A day with no row on a
working day IS absent, worked out at read time — which is why declaring a
holiday retroactively fixes every affected month at once, and why a missed cron
run cannot silently cost anybody a day. See the note in models/attendance.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Iterable, Optional

from app.core.enums import (
    ATTENDANCE_OFF_STATUSES, ATTENDANCE_WORKED_STATUSES, AccountStatus,
    AccountType, AttendanceSource, AttendanceStatus, HrRequestStatus,
    WorkLocation,
)
from app.models.attendance import AttendanceDay, BreakInterval, PunchLocation
from app.models.base import utcnow
from app.models.leave import LeaveRequest
from app.models.settings import HrSettings
from app.models.user import User
from app.services import hr_calendar as cal
from app.services import hr_geo as geo

log = logging.getLogger("agastyacrm.hr")


# =============================================================================
# Per-employee policy
# =============================================================================


class DayPolicy:
    """The rules that apply to ONE employee on ONE day.

    Resolved once and passed down rather than read out of `HrSettings` at each
    step, because an employee may override the shift (owner B8) and every
    threshold below has to agree about which shift it is talking about.
    """

    __slots__ = ("shift_start", "shift_end", "late_grace", "early_grace",
                 "full_day_minutes", "half_day_minutes", "week_off_days")

    def __init__(self, hr: HrSettings, profile=None):
        self.shift_start = (getattr(profile, "shift_start", None)
                            or hr.shift_start)
        self.shift_end = getattr(profile, "shift_end", None) or hr.shift_end
        self.late_grace = max(0, hr.late_grace_minutes)
        self.early_grace = max(0, hr.early_out_grace_minutes)
        # A half day that is not SMALLER than a full day is a configuration that
        # would make every day a half day. Clamped rather than validated away:
        # the settings form guards it, and this is the belt.
        self.full_day_minutes = max(1, hr.full_day_minutes)
        self.half_day_minutes = max(1, min(hr.half_day_minutes,
                                           self.full_day_minutes))
        self.week_off_days = set(hr.week_off_days or [])


def policy_for(hr: HrSettings, user: Optional[User]) -> DayPolicy:
    return DayPolicy(hr, getattr(user, "employee_profile", None))


# =============================================================================
# The day's arithmetic — the single definition
# =============================================================================


def break_minutes(breaks: Iterable[BreakInterval],
                  *, now: Optional[datetime] = None) -> int:
    """Total break time. An OPEN break counts up to `now`, so the figure on
    screen moves while somebody is actually on their break."""
    now = now or utcnow()
    total = 0.0
    for b in breaks:
        end = b.end or now
        if end > b.start:
            total += (end - b.start).total_seconds()
    return int(total // 60)


def recompute(day: AttendanceDay, policy: DayPolicy, *,
              now: Optional[datetime] = None) -> AttendanceDay:
    """Re-derive every computed field on a day from its raw punches.

    Idempotent, and safe to call on a day that is still running: an open day is
    measured up to `now` so the live counter on the Attendance page is the same
    arithmetic the closed day will use, rather than a second implementation in
    the browser.

    Does NOT touch `manual_status`. An override is a decision a person made and
    a recompute is not entitled to overturn it — `effective_status` on the model
    is what merges the two.
    """
    now = now or utcnow()
    day.break_minutes = break_minutes(day.breaks, now=now)

    if day.clock_in is None:
        day.worked_minutes = 0
        day.status = AttendanceStatus.NOT_MARKED.value
        day.is_late = day.is_early_out = False
        day.late_minutes = day.early_out_minutes = 0
        day.updated_at = utcnow()
        return day

    end = day.clock_out or now
    gross = max(0, int((end - day.clock_in).total_seconds() // 60))
    day.worked_minutes = max(0, gross - day.break_minutes)

    d = cal.parse_day(day.day)
    shift_in, shift_out = cal.shift_bounds(d, policy.shift_start,
                                           policy.shift_end)

    late_by = int((day.clock_in - shift_in).total_seconds() // 60)
    day.late_minutes = max(0, late_by)
    day.is_late = late_by > policy.late_grace

    if day.clock_out is not None:
        early_by = int((shift_out - day.clock_out).total_seconds() // 60)
        day.early_out_minutes = max(0, early_by)
        day.is_early_out = early_by > policy.early_grace
    else:
        day.early_out_minutes = 0
        day.is_early_out = False

    # A day still running is NOT_MARKED, not absent. It has not finished being
    # anything yet, and calling a morning "absent" because it is 11am is the
    # single most alarming thing an attendance screen can do.
    if day.clock_out is None:
        day.status = AttendanceStatus.NOT_MARKED.value
    elif day.worked_minutes >= policy.full_day_minutes:
        # A FULL day worked away from the office is work-from-home, not present
        # (owner 2026-08-21). Same paid day either way — `AttendanceStatus.WFH`
        # has always been "a full paid day" — the distinction is for the manager
        # reading the month, not for the count.
        #
        # ONLY the full-day branch is touched, and that is the careful bit. A
        # two-hour remote morning stays a HALF_DAY: the hours rules decide how
        # much of a day it was, and letting `remote` promote it to WFH would
        # quietly pay a full day for two hours' work. Where and how-much are
        # different questions and only one of them is answered here.
        day.status = (
            AttendanceStatus.WFH.value
            if day.work_location == WorkLocation.REMOTE.value
            else AttendanceStatus.PRESENT.value)
    elif day.worked_minutes >= policy.half_day_minutes:
        day.status = AttendanceStatus.HALF_DAY.value
    else:
        day.status = AttendanceStatus.ABSENT.value

    day.updated_at = utcnow()
    return day


# =============================================================================
# Punching
# =============================================================================


async def get_or_create_day(user: User, day_str: str) -> AttendanceDay:
    """The row for one person on one day, created empty if it does not exist.

    The unique index on (user_id, day) is the real guard against a double-tap
    creating two rows; this is the ordinary path.
    """
    existing = await AttendanceDay.find_one({"user_id": str(user.id),
                                             "day": day_str})
    if existing is not None:
        return existing
    return AttendanceDay(
        user_id=str(user.id), user_name=user.full_name,
        day=day_str, month=cal.month_key_of(day_str))


async def today_for(user: User, *, now: Optional[datetime] = None
                    ) -> Optional[AttendanceDay]:
    now = now or utcnow()
    return await AttendanceDay.find_one({"user_id": str(user.id),
                                         "day": cal.day_key(now)})


def _location_for(hr: HrSettings, lat, lng, accuracy,
                  at: datetime) -> Optional[PunchLocation]:
    """Turn a reported reading into a stored `PunchLocation`, or None.

    None means the client sent nothing usable, which is a different thing from
    a reading that could not be placed — that one is stored, with `unknown`, so
    the attempt is on the record.
    """
    if not geo.valid_coords(lat, lng):
        return None
    resolved, distance = geo.classify(hr, lat, lng, accuracy)
    return PunchLocation(lat=lat, lng=lng, accuracy_m=accuracy,
                         distance_m=distance, resolved=resolved, at=at)


async def punch_in(user: User, hr: HrSettings, *, ip: Optional[str] = None,
                   lat: Optional[float] = None, lng: Optional[float] = None,
                   accuracy_m: Optional[float] = None,
                   now: Optional[datetime] = None) -> AttendanceDay:
    """Start the day. Returns the day; raises ValueError with a sentence when
    the state does not allow it.

    ALWAYS TODAY, never a date the caller chose (owner C6). A backdated
    self-punch is an attendance system that records nothing, so the day key is
    read from the clock here and there is no parameter for it.

    WHERE FROM, since 2026-08-21. The coordinates arrive from the browser and
    are classified HERE — the client reports a position, it never reports a
    verdict. `work_location` is decided once, at clock-in, and is what the day's
    status is derived from.
    """
    now = now or utcnow()
    day_str = cal.day_key(now)
    day = await get_or_create_day(user, day_str)
    if day.clock_in is not None and day.clock_out is None:
        raise ValueError("You are already clocked in.")
    if day.clock_out is not None:
        raise ValueError(
            "You have already clocked out for today. Ask your manager to "
            "correct the day, or raise a correction request.")

    if geo.is_configured(hr) and hr.require_location             and not geo.valid_coords(lat, lng):
        # Only when the owner has explicitly asked for it — see the note on
        # `require_location`. Says what to DO, not just what went wrong.
        raise ValueError(
            "Location is required to clock in. Allow location access for this "
            "site in your browser and try again.")

    day.clock_in = now
    day.source = AttendanceSource.PUNCH.value
    day.ip_address = ip
    place = _location_for(hr, lat, lng, accuracy_m, now)
    day.punch_in_location = place
    if geo.is_configured(hr):
        # No reading at all is UNKNOWN, exactly like an unplaceable one — the
        # difference is visible in `punch_in_location` being absent, and both
        # fall the same way when the status is worked out.
        day.work_location = geo.status_location(
            place.resolved if place else WorkLocation.UNKNOWN.value, hr)
    recompute(day, policy_for(hr, user), now=now)
    await day.save()
    return day


async def punch_out(user: User, hr: HrSettings, *,
                    lat: Optional[float] = None, lng: Optional[float] = None,
                    accuracy_m: Optional[float] = None,
                    now: Optional[datetime] = None) -> AttendanceDay:
    """End the day, closing any break still running with it.

    The clock-out's coordinates are RECORDED and deliberately do not change
    `work_location`: the clock-in decided the day, and stepping out to see a
    customer at 6pm must not rewrite the morning that was worked at the desk.
    """
    now = now or utcnow()
    day = await today_for(user, now=now)
    if day is None or day.clock_in is None:
        raise ValueError("You have not clocked in today.")
    if day.clock_out is not None:
        raise ValueError("You have already clocked out today.")
    # An open break at clock-out is closed AT clock-out, not left running. Left
    # open it would be measured to "now" for ever on every later read, and the
    # day's worked minutes would shrink every time somebody looked at it.
    for b in day.breaks:
        if b.end is None:
            b.end = now
    day.clock_out = now
    day.punch_out_location = _location_for(hr, lat, lng, accuracy_m, now)
    recompute(day, policy_for(hr, user), now=now)
    await day.save()
    return day


async def break_start(user: User, hr: HrSettings, *,
                      now: Optional[datetime] = None) -> AttendanceDay:
    now = now or utcnow()
    day = await today_for(user, now=now)
    if day is None or day.clock_in is None:
        raise ValueError("Clock in before starting a break.")
    if day.clock_out is not None:
        raise ValueError("You have already clocked out today.")
    if day.open_break is not None:
        raise ValueError("You are already on a break.")
    day.breaks.append(BreakInterval(start=now))
    recompute(day, policy_for(hr, user), now=now)
    await day.save()
    return day


async def break_end(user: User, hr: HrSettings, *,
                    now: Optional[datetime] = None) -> AttendanceDay:
    now = now or utcnow()
    day = await today_for(user, now=now)
    if day is None:
        raise ValueError("You have not clocked in today.")
    running = day.open_break
    if running is None:
        raise ValueError("You are not on a break.")
    running.end = now
    recompute(day, policy_for(hr, user), now=now)
    await day.save()
    return day


# =============================================================================
# The month view
# =============================================================================


class DayView:
    """One row of the month: what the day WAS, whether or not a record exists.

    A plain object rather than a schema so the service stays free of a schemas
    import; the router maps it. Every field is either read off the stored day or
    derived from the calendar — nothing here is guessed.
    """

    __slots__ = ("day", "weekday", "status", "clock_in", "clock_out",
                 "worked_minutes", "break_minutes", "is_late", "late_minutes",
                 "is_early_out", "early_out_minutes", "missed_punch_out",
                 "holiday_name", "leave_id", "leave_code", "leave_reason",
                 "note", "source", "edited_by_name", "edit_reason",
                 "record_id", "is_future", "leave_worked")

    def __init__(self, **kw):
        for slot in self.__slots__:
            setattr(self, slot, kw.get(slot))

    def as_dict(self) -> dict:
        return {s: getattr(self, s) for s in self.__slots__}


async def _approved_leave_map(user_id: str, lo: str, hi: str
                              ) -> dict[str, LeaveRequest]:
    """{day key: the approved leave covering it} for one person in a range.

    A range query on the two date strings, then expanded in Python — a leave is
    a span and Mongo cannot expand one into its days. The row count is tiny (a
    person takes single-figure leaves in a month) so this is not the `find_all`
    pattern; it is bounded by the range, which is what matters.
    """
    rows = await LeaveRequest.find({
        "user_id": user_id,
        "status": HrRequestStatus.APPROVED.value,
        "start_date": {"$lte": hi},
        "end_date": {"$gte": lo},
    }).to_list()
    out: dict[str, LeaveRequest] = {}
    for r in rows:
        for d in cal.day_span(r.start_date, r.end_date):
            key = d.isoformat()
            if lo <= key <= hi:
                out[key] = r
    return out


async def build_month(user: User, month: str, hr: HrSettings, *,
                      now: Optional[datetime] = None) -> list[DayView]:
    """Every day of `month` for one employee, in order.

    THREE queries, whatever the month's length: the attendance rows, the
    holidays and the approved leaves. Never one per day.
    """
    now = now or utcnow()
    policy = policy_for(hr, user)
    first, last = cal.month_bounds(month)
    lo, hi = first.isoformat(), last.isoformat()
    today = cal.day_key(now)

    rows = await AttendanceDay.find({"user_id": str(user.id),
                                     "month": month}).to_list()
    by_day = {r.day: r for r in rows}
    holidays = await cal.holiday_map(lo, hi)
    leaves = await _approved_leave_map(str(user.id), lo, hi)

    joined = _joining_key(user)
    out: list[DayView] = []
    for d in cal.month_iter(month):
        key = d.isoformat()
        rec = by_day.get(key)
        leave = leaves.get(key)
        # An open day (today, mid-shift) is measured to `now` so the register
        # agrees with the live counter on the same screen.
        if rec is not None and rec.clock_in is not None and rec.clock_out is None:
            recompute(rec, policy, now=now)
        out.append(_view_for(d, key, rec, leave, holidays, policy,
                             today=today, joined=joined))
    return out


def _joining_key(user: User) -> Optional[str]:
    doj = getattr(getattr(user, "employee_profile", None),
                  "date_of_joining", None)
    return doj.isoformat() if doj else None


def _view_for(d: date, key: str, rec: Optional[AttendanceDay],
              leave: Optional[LeaveRequest], holidays: dict[str, str],
              policy: DayPolicy, *, today: str,
              joined: Optional[str]) -> DayView:
    """The precedence rule, in one place. See the module docstring."""
    base = dict(
        day=key, weekday=d.weekday(), holiday_name=holidays.get(key),
        clock_in=rec.clock_in if rec else None,
        clock_out=rec.clock_out if rec else None,
        worked_minutes=rec.worked_minutes if rec else 0,
        break_minutes=rec.break_minutes if rec else 0,
        is_late=bool(rec.is_late) if rec else False,
        late_minutes=rec.late_minutes if rec else 0,
        is_early_out=bool(rec.is_early_out) if rec else False,
        early_out_minutes=rec.early_out_minutes if rec else 0,
        missed_punch_out=bool(rec.missed_punch_out) if rec else False,
        note=rec.note if rec else None,
        source=rec.source if rec else None,
        edited_by_name=rec.edited_by_name if rec else None,
        edit_reason=rec.edit_reason if rec else None,
        record_id=str(rec.id) if rec and rec.id else None,
        leave_id=str(leave.id) if leave and leave.id else None,
        leave_code=leave.code if leave else None,
        leave_reason=leave.reason_type if leave else None,
        leave_worked=False,
        is_future=key > today,
    )

    # 1 + 2. Facts about the OFFICE outrank facts about the person. A holiday
    # wins over a week off only so the day can say WHICH holiday it was; both
    # are equally non-working.
    if key in holidays:
        return DayView(**base, status=AttendanceStatus.HOLIDAY.value)
    if cal.is_week_off(d, policy.week_off_days):
        return DayView(**base, status=AttendanceStatus.WEEK_OFF.value)

    # 3. A manager decided. That is what an override is.
    if rec is not None and rec.manual_status:
        return DayView(**base, status=rec.manual_status)

    # 4. Somebody punched. Beats approved leave (owner C10) — and when it does,
    # the leave day is flagged as refundable so the balance goes back.
    if rec is not None and rec.clock_in is not None:
        worked = rec.status != AttendanceStatus.NOT_MARKED.value
        base["leave_worked"] = bool(leave and worked)
        return DayView(**base, status=rec.status)

    # 5. Approved leave, paid or not depending on what the balance covered.
    if leave is not None:
        paid = leave.paid_days > 0 and leave.unpaid_days <= 0
        return DayView(**base, status=(AttendanceStatus.ON_LEAVE.value if paid
                                       else AttendanceStatus.LEAVE_UNPAID.value))

    # 6. Nothing at all. Absent — UNLESS the day is in the future, is today
    # (still running), or predates the person joining the agency (owner A6).
    if base["is_future"] or key == today or (joined and key < joined):
        return DayView(**base, status=AttendanceStatus.NOT_MARKED.value)
    return DayView(**base, status=AttendanceStatus.ABSENT.value)


# =============================================================================
# The month summary — the numbers a manager reads to work out pay by hand
# =============================================================================


def summarise(days: list[DayView], hr: HrSettings) -> dict:
    """Counts, in DAYS and HOURS. No money, ever (owner 2026-08-20).

    This is the deliverable the whole module builds towards: the manager opens
    it at month end, reads `payable_days`, and multiplies by hand. Every figure
    here is one a person can check by counting rows on the screen above it —
    which is the property that makes a hand calculation trustworthy.
    """
    counts: dict[str, int] = {}
    worked_minutes = 0
    late_marks = 0
    half_days = 0
    for v in days:
        counts[v.status] = counts.get(v.status, 0) + 1
        worked_minutes += v.worked_minutes or 0
        if v.is_late:
            late_marks += 1
        if v.status == AttendanceStatus.HALF_DAY.value:
            half_days += 1

    present = counts.get(AttendanceStatus.PRESENT.value, 0)
    wfh = counts.get(AttendanceStatus.WFH.value, 0)
    absent = counts.get(AttendanceStatus.ABSENT.value, 0)
    on_leave = counts.get(AttendanceStatus.ON_LEAVE.value, 0)
    leave_unpaid = counts.get(AttendanceStatus.LEAVE_UNPAID.value, 0)
    week_offs = counts.get(AttendanceStatus.WEEK_OFF.value, 0)
    holidays = counts.get(AttendanceStatus.HOLIDAY.value, 0)
    not_marked = counts.get(AttendanceStatus.NOT_MARKED.value, 0)

    # Three lates cost half a day (owner B3). Integer division, so two lates
    # cost nothing and four still cost one penalty — the penalty is per
    # completed set, not pro-rata, because "you were late 2.7 times" is not a
    # sentence anybody says.
    per = max(1, hr.late_marks_per_penalty)
    late_penalty_days = (late_marks // per) * hr.late_penalty_days

    # PAYABLE DAYS — the number the manual calculation starts from.
    #
    # Week offs and holidays are IN, because they are inside the monthly salary
    # by definition (owner A4): a full month with no leave has to come out at
    # the full number of calendar days, or the manager's multiplication does not
    # reconcile. Paid leave is IN for the same reason — that is what "paid"
    # means. Absences, unpaid leave, half days and late penalties come OUT.
    #
    # NOT_MARKED is deliberately NOT deducted: it is a day nobody has resolved
    # yet (today, the future, or a missed punch-out awaiting a correction), and
    # deducting for it would make a mid-month figure a lie that corrects itself
    # later — the one thing a payroll figure must never do.
    deductions = absent + leave_unpaid + (half_days * 0.5) + late_penalty_days
    total_days = len(days)
    payable_days = round(max(0.0, total_days - not_marked - deductions), 2)

    return {
        "total_days": total_days,
        "present": present,
        "wfh": wfh,
        "half_days": half_days,
        "absent": absent,
        "on_leave": on_leave,
        "leave_unpaid": leave_unpaid,
        "week_offs": week_offs,
        "holidays": holidays,
        "not_marked": not_marked,
        "late_marks": late_marks,
        "late_penalty_days": round(late_penalty_days, 2),
        "worked_minutes": worked_minutes,
        "worked_hours": round(worked_minutes / 60, 1),
        "payable_days": payable_days,
        # What the register still owes an answer on. The one number a manager
        # should clear before doing the month's arithmetic.
        "unresolved_days": sum(
            1 for v in days
            if v.missed_punch_out or (v.status == AttendanceStatus.NOT_MARKED.value
                                      and not v.is_future)),
    }


# =============================================================================
# Who this module applies to
# =============================================================================


async def hr_employees(*, include_inactive: bool = False) -> list[User]:
    """Every account the HR module covers: EMPLOYEES, and nobody else.

    The owner runs the agency and does not clock into it, and channel partners
    are external (owner A10). Both exclusions are here, once, so the roster, the
    accrual job, the team board and the export cannot disagree about who is on
    the list.
    """
    query: dict = {
        "account_type": AccountType.EMPLOYEE.value,
        "is_deleted": {"$ne": True},
    }
    if not include_inactive:
        query["status"] = AccountStatus.ACTIVE.value
    return await User.find(query).sort("full_name").to_list()


def is_hr_subject(user: User) -> bool:
    """Does this account punch, accrue leave and appear on the register?"""
    account_type = getattr(user.account_type, "value", user.account_type)
    return account_type == AccountType.EMPLOYEE.value


# =============================================================================
# Closing a day nobody closed
# =============================================================================


async def auto_close_open_days(hr: HrSettings, *,
                               now: Optional[datetime] = None) -> int:
    """Close yesterday-and-older days somebody forgot to clock out of.

    CLOSED AT THE SHIFT END, not at midnight (owner C2). Crediting somebody
    until 03:00 because they forgot is a worse error than the reverse, and a day
    that ends at its shift end is at least a defensible default. The day is
    stamped `missed_punch_out` so it reads amber on the employee's own month and
    in the manager's queue — the point is that somebody LOOKS at it, either
    accepting the default or correcting it.

    Only days STRICTLY BEFORE today are touched: closing today's open day would
    clock out everybody currently at work.
    """
    now = now or utcnow()
    today = cal.day_key(now)
    open_days = await AttendanceDay.find({
        "clock_in": {"$ne": None},
        "clock_out": None,
        "day": {"$lt": today},
    }).to_list()

    closed = 0
    for day in open_days:
        user = await User.get(day.user_id)
        policy = policy_for(hr, user)
        d = cal.parse_day(day.day)
        _, shift_out = cal.shift_bounds(d, policy.shift_start, policy.shift_end)
        # Never earlier than the clock-in: somebody who arrived after their
        # shift ended would otherwise get a negative day.
        end = max(shift_out, day.clock_in)
        for b in day.breaks:
            if b.end is None:
                b.end = min(end, b.start + timedelta(
                    minutes=max(0, hr.max_break_minutes)))
                b.auto_closed = True
        day.clock_out = end
        day.missed_punch_out = True
        day.source = AttendanceSource.SYSTEM.value
        recompute(day, policy, now=now)
        await day.save()
        closed += 1
    return closed
