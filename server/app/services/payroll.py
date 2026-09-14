"""Turning a month of attendance into a rupee figure.

THE ONE PLACE IN WORKPLACE HR THAT MULTIPLIES
----------------------------------------------
`hr_attendance.summarise()` counts days. This file is the only thing in the
module that turns a day count into money, and it does so by reading that
summary rather than by re-deriving anything from the register. That boundary is
deliberate and it is the reason the register stays arguable: an employee who
disputes a payslip is disputing a DAY, and the day is on a screen they can open,
with the punch, the override and the reason that produced it.

Nothing here writes an attendance row, a leave row or a ledger row. Generating a
payslip is a read of the register plus a write of one document.

THE ARITHMETIC, IN FULL
------------------------
    per day        = monthly salary / 30            (a CONSTANT 30 -- see the
                                                     model's docstring)
    loss of pay    = absent
                   + unpaid leave
                   + half-day shortfall (0.5 each)
                   + late penalty (3 lates -> 0.5 day, from HrSettings)
                   + days before joining, inside this month
    deduction      = per day x loss of pay
    net payable    = monthly salary - deduction + any manual adjustment

PAID LEAVE COSTS NOTHING, and that is the owner's rule stated directly: "if he
has leave balance, then we will not deduct this." A leave the balance covered is
`ON_LEAVE`; one it did not is `LEAVE_UNPAID`, and only the second reaches the
loss-of-pay total. The split was decided at APPROVAL and frozen there
(services/hr_leave), so a payslip cannot re-decide it against a balance that has
since moved.

WEEK OFFS AND HOLIDAYS COST NOTHING EITHER. They are inside the monthly salary
by definition -- a full month with no leave must come out at exactly the salary,
which is the property that makes the figure checkable at a glance.

WHAT IS DELIBERATELY **NOT** DEDUCTED
--------------------------------------
NOT_MARKED days that are simply unresolved -- a missed punch-out waiting for a
correction, a past working day nobody has explained yet. The register's own rule
is that "we have not been told" and "they did not come" are different facts, and
only the second costs money. Deducting for the first would make a payslip a
claim that quietly reverses itself a week later when the correction is approved,
which is the one thing a pay figure must never do.

They are COUNTED instead, onto `unresolved_days`, and the payslip screen says so
before anybody finalises. The honest answer to an unresolved register is "look
at it", not "assume the worst".

PRE-JOINING DAYS **ARE** DEDUCTED, and this is the one rule the owner did not
state. Somebody who joined on the 25th has fourteen days in the month that are
NOT_MARKED because they were not employed yet (see `_view_for` in
hr_attendance), and paying a full month for six days' work is not a thing any
agency does. They are deducted as their own named line -- never folded into
"absent", because being new is not an absence and the payslip must not read as
though it were.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from pymongo.errors import DuplicateKeyError

from app.core.enums import AttendanceStatus, AuditAction, HrRequestStatus
from app.core.permissions import MANAGE_PAYSLIPS
from app.models.attendance import AttendanceCorrection
from app.models.base import utcnow
from app.models.payslip import (
    PAYROLL_DAYS_PER_MONTH, Payslip, PayslipLine, PayslipStatus,
)
from app.models.settings import HrSettings
from app.models.user import User
from app.services import hr_attendance, hr_calendar as cal
from app.services import notifications
from app.services.audit import log_action
from app.services.codes import next_code

log = logging.getLogger("agastyacrm.payroll")

# The category on every payslip bell, and — for the pay desk's monthly summary —
# also its de-duplication key. "Have I already reported this month's close?" is
# answered by asking the notification collection rather than by keeping a flag,
# which is the same trick `hr_daily.notify_not_clocked_in` uses and costs no new
# state. Notifications carry a TTL, which is fine: a window closes within days.
NOTIFY_CATEGORY = "payslip"


class PayrollError(ValueError):
    """Something about this month cannot be turned into a payslip, said in a
    sentence a person can act on."""


# =============================================================================
# The rate
# =============================================================================


def per_day_paise(monthly_salary_paise: int,
                  divisor: int = PAYROLL_DAYS_PER_MONTH) -> int:
    """The cost of one day, in paise.

    ROUND_HALF_UP stated explicitly, because Python's `round()` is
    banker's rounding and `Decimal.quantize` defaults to it too: exactly half a
    paisa would go DOWN on an even boundary and UP on an odd one. That is right
    for statistics and wrong for money, where every ledger in the country rounds
    half up. Same reasoning as `statement_import.to_paise`.

    Rs 15,000 -> 1,500,000 paise / 30 -> 50,000 paise -> Rs 500. The owner's own
    worked example, and the test pins it.
    """
    if monthly_salary_paise <= 0 or divisor <= 0:
        return 0
    return int((Decimal(monthly_salary_paise) / Decimal(divisor))
               .quantize(Decimal("1"), rounding=ROUND_HALF_UP))


# =============================================================================
# The month
# =============================================================================


def _pre_joining_days(days: list, joined: Optional[date]) -> float:
    """Days in this month that fall before the person started.

    Counted off the SAME day list the summary was built from, so the two cannot
    disagree about how many days the month had. Only WORKING days count: a
    Sunday before somebody joined was never going to be worked and charging them
    for it would deduct more than the month contains.
    """
    if joined is None:
        return 0.0
    key = joined.isoformat()
    return float(sum(
        1 for v in days
        if v.day < key
        and v.status not in (AttendanceStatus.WEEK_OFF.value,
                             AttendanceStatus.HOLIDAY.value)))


def _joining_date(user: User) -> Optional[date]:
    return getattr(getattr(user, "employee_profile", None),
                   "date_of_joining", None)


def salary_of(user: User) -> int:
    """The stored monthly salary in paise, or 0 when nobody has set one.

    Zero is a real answer and is NOT an error here: an employee whose salary has
    not been entered yet still has an attendance month, and the payslip that
    comes out says "no salary on record" rather than refusing to exist. The
    refusal belongs at generation time, where it can name the person.
    """
    return int(getattr(getattr(user, "employee_profile", None),
                       "monthly_salary_paise", None) or 0)


def compute(user: User, days: list, summary: dict, hr: HrSettings) -> dict:
    """The whole calculation, as plain data. Writes nothing, reads nothing.

    Split out from `generate_for` so the arithmetic can be tested against a
    fixture without a database, and so the "what would this month pay" preview
    on the pay-run screen is the SAME function that produces the document. Two
    implementations of a pay figure is the worst possible place for this app's
    most familiar bug.
    """
    salary = salary_of(user)
    rate = per_day_paise(salary)

    absent = float(summary["absent"])
    unpaid_leave = float(summary["leave_unpaid"])
    half_days = float(summary["half_days"])
    late_penalty = float(summary["late_penalty_days"])
    pre_joining = _pre_joining_days(days, _joining_date(user))

    half_day_shortfall = half_days * 0.5
    lop = round(absent + unpaid_leave + half_day_shortfall + late_penalty
                + pre_joining, 2)
    # Never deduct more than the month is worth. A register that somehow
    # produced 40 loss-of-pay days in a 31-day month is a bug, and a NEGATIVE
    # payslip would be that bug arriving as a demand for money.
    deduction = min(salary, rate * lop)
    deduction = int(Decimal(deduction).quantize(Decimal("1"),
                                                rounding=ROUND_HALF_UP))

    lines: list[PayslipLine] = [
        PayslipLine(label="Monthly salary",
                    detail=f"{summary['total_days']} calendar days",
                    amount_paise=salary),
    ]

    def deduct(label: str, count: float, detail: str) -> None:
        """One deduction row, only when it is not zero.

        A payslip listing five kinds of deduction all reading nil is a payslip
        nobody scans; the rows that ARE there are the ones that explain the
        figure.
        """
        if count <= 0:
            return
        lines.append(PayslipLine(label=label, detail=detail, days=count,
                                 amount_paise=-int(rate * count)))

    deduct("Absent", absent, _days(absent))
    deduct("Unpaid leave", unpaid_leave, _days(unpaid_leave))
    deduct("Half days", half_day_shortfall,
           f"{_days(half_days)} at half pay")
    deduct("Late marks", late_penalty,
           f"{summary['late_marks']} late marks, "
           f"{hr.late_marks_per_penalty} per penalty")
    deduct("Before joining", pre_joining,
           "not employed for these days")

    return {
        "monthly_salary_paise": salary,
        "per_day_paise": rate,
        "days_divisor": PAYROLL_DAYS_PER_MONTH,
        "calendar_days": summary["total_days"],
        "present_days": summary["present"],
        "wfh_days": summary["wfh"],
        "half_days": summary["half_days"],
        "absent_days": summary["absent"],
        "paid_leave_days": summary["on_leave"],
        "unpaid_leave_days": summary["leave_unpaid"],
        "week_off_days": summary["week_offs"],
        "holiday_days": summary["holidays"],
        "not_marked_days": summary["not_marked"],
        "late_marks": summary["late_marks"],
        "late_penalty_days": summary["late_penalty_days"],
        "pre_joining_days": pre_joining,
        "worked_minutes": summary["worked_minutes"],
        "payable_days": summary["payable_days"],
        "unresolved_days": summary["unresolved_days"],
        "lop_days": lop,
        "deduction_paise": deduction,
        "net_payable_paise": max(0, salary - deduction),
        "lines": lines,
    }


def _days(n: float) -> str:
    """"1 day" / "2.5 days" -- a whole number never renders as "2.0 days"."""
    whole = int(n)
    text = str(whole) if float(whole) == n else f"{n:g}"
    return f"{text} day" if n == 1 else f"{text} days"


def month_label(month: str) -> str:
    """"2026-08" -> "August 2026". Used in every message a person reads.

    Here rather than in the router because the AUTOMATIC path sends the same
    sentences as the manual one, and a month named two ways is how "your August
    payslip is ready" and "your 2026-08 payslip was paid" end up in the same
    notification list.
    """
    try:
        first, _ = cal.month_bounds(month)
        return first.strftime("%B %Y")
    except (ValueError, IndexError):
        return month


def apply_adjustment(slip: Payslip) -> None:
    """Re-derive the net from the parts. The ONE place the net is assembled.

    Called after any change to `adjustment_paise`, and by `generate_for`, so a
    payslip's headline is always exactly `salary - deduction + adjustment` and
    cannot be set to something else by a call site that forgot a term.
    """
    slip.net_payable_paise = max(
        0, slip.monthly_salary_paise - slip.deduction_paise
        + int(slip.adjustment_paise or 0))


# =============================================================================
# Generating
# =============================================================================


async def build_for(user: User, month: str, hr: HrSettings, *,
                    now: Optional[datetime] = None) -> dict:
    """What `month` would pay `user`, without writing anything.

    The preview behind the pay-run screen. Reads the register through the same
    `build_month` / `summarise` pair the Attendance page renders, so the number
    on the payslip and the days on the register are the same reading.
    """
    days = await hr_attendance.build_month(user, month, hr, now=now)
    summary = hr_attendance.summarise(days, hr)
    return compute(user, days, summary, hr)


async def generate_for(user: User, month: str, hr: HrSettings, *,
                       actor: Optional[User] = None,
                       regenerate: bool = False,
                       now: Optional[datetime] = None) -> tuple[Payslip, bool]:
    """Create or refresh one payslip. Returns (payslip, changed).

    IDEMPOTENT BY UNIQUE INDEX, not by a look-then-write. The monthly run fires
    from the cron and again at boot, so the same month is genuinely attempted
    twice on a deploy morning; the index is what makes the second attempt a
    no-op instead of a second payslip. `DuplicateKeyError` is caught and the
    existing row returned, exactly as the leave accrual does.

    A LOCKED payslip is never recomputed. Finalised means somebody has read the
    figure and committed to it; paid means money moved. Regenerating either
    would rewrite the amount a payment was made against, and that payment would
    then reconcile against nothing.
    """
    now = now or utcnow()
    existing = await Payslip.find_one({"user_id": str(user.id),
                                       "month": month})

    if existing is not None:
        if existing.is_locked or existing.status == PayslipStatus.CANCELLED:
            return existing, False
        if not regenerate:
            # A draft already exists and nobody asked for it to be redone. The
            # scheduled run takes this branch every morning after the 1st.
            return existing, False

    data = await build_for(user, month, hr, now=now)
    prof = getattr(user, "employee_profile", None)

    if existing is not None:
        for key, value in data.items():
            setattr(existing, key, value)
        # A manual adjustment SURVIVES a regeneration. It is the one number on
        # the payslip a human put there, and silently dropping it when the
        # register is re-read would be the software overruling a person.
        apply_adjustment(existing)
        existing.user_name = user.full_name
        existing.user_code = user.code
        existing.designation = getattr(prof, "designation", None)
        existing.generated_at = now
        existing.generated_by = str(actor.id) if actor else None
        existing.generated_by_name = actor.full_name if actor else None
        existing.updated_at = now
        await existing.save()
        return existing, True

    slip = Payslip(
        code=await next_code("payslip"),
        user_id=str(user.id), user_name=user.full_name, user_code=user.code,
        designation=getattr(prof, "designation", None),
        month=month,
        generated_at=now,
        generated_by=str(actor.id) if actor else None,
        generated_by_name=actor.full_name if actor else None,
        **data)
    apply_adjustment(slip)
    try:
        await slip.insert()
    except DuplicateKeyError:
        # Two runs raced. The other one won and its document is just as correct
        # as this one -- they read the same register a moment apart.
        found = await Payslip.find_one({"user_id": str(user.id),
                                        "month": month})
        if found is None:      # pragma: no cover -- the index says otherwise
            raise
        return found, False
    return slip, True


async def generate_month(month: str, hr: HrSettings, *,
                         actor: Optional[User] = None,
                         regenerate: bool = False,
                         now: Optional[datetime] = None) -> dict:
    """Payslips for every employee for `month`.

    Skips nobody quietly. An employee with no salary on record still gets a
    payslip -- with a zero figure and an explicit "no salary recorded" line --
    because a MISSING payslip reads as "we forgot you" and a zero one reads as
    "somebody has not filled this in", and only the second leads to it being
    fixed.
    """
    employees = await hr_attendance.hr_employees()
    written = failed = 0
    missing_salary: list[str] = []

    for user in employees:
        # Somebody who had not joined by the END of the month has no month to
        # be paid for. Their first payslip is the month they actually started
        # in, pro-rated by the pre-joining rule.
        joined = _joining_date(user)
        if joined is not None and cal.month_key_of(joined) > month:
            continue
        try:
            slip, changed = await generate_for(
                user, month, hr, actor=actor, regenerate=regenerate, now=now)
        except Exception:  # noqa: BLE001 -- one bad employee must not stop 29
            log.exception("Payroll: could not generate %s for %s",
                          month, user.full_name)
            failed += 1
            continue
        if changed:
            written += 1
        # A salary of zero is REPORTED, never silently paid. This is the list
        # the pay-run screen turns into "3 employees have no salary on record",
        # which is the only way somebody finds out before the payslip goes out.
        if slip.monthly_salary_paise <= 0:
            missing_salary.append(user.full_name)

    return {
        "month": month,
        "employees": len(employees),
        "payslips": await Payslip.find({"month": month}).count(),
        "written": written,
        "failed": failed,
        "missing_salary": missing_salary,
    }


# =============================================================================
# The scheduled run
# =============================================================================


def previous_month(now: Optional[datetime] = None) -> str:
    """The month that just ended, in IST. "2026-09-01" -> "2026-08"."""
    today = cal.parse_day(cal.day_key(now or utcnow()))
    first_of_this = date(today.year, today.month, 1)
    return cal.month_key_of(date.fromordinal(first_of_this.toordinal() - 1))


async def run_monthly(hr: HrSettings, *,
                      now: Optional[datetime] = None) -> dict:
    """Generate last month's payslips, on and after the 1st.

    "SO ON FIRST OF EACH MONTH, PREVIOUS MONTH'S SALARY SHOULD BE CALCULATED"
    (owner). It runs on every day of the month, not only the 1st, and that is
    deliberate: a cron that only fires on one date is a cron whose one chance to
    work is the morning the instance happens to be redeploying. Because the
    write is idempotent, running it on the 14th finds the month already
    generated and does nothing -- and if the 1st was missed, the 2nd fixes it.

    It never REGENERATES. A draft that has been sitting there since the 1st has
    possibly been adjusted by a person; overwriting it every morning would undo
    that quietly. Regeneration is an explicit action on the pay-run screen, and
    -- since 2026-09-06 -- the first thing `run_auto_finalise` does before it
    locks anything.

    THE PAY DESK IS TOLD, ONCE, ON THE RUN THAT ACTUALLY BUILDS THE MONTH. A
    correction window nobody has been told about is not a window, it is a delay;
    somebody has to know the register is open and until when. `written` is what
    makes it once: every later run of the same month writes nothing, so no
    second bell can be sent, with no flag to keep anywhere.
    """
    now = now or utcnow()
    month = previous_month(now)
    summary = await generate_month(month, hr, regenerate=False, now=now)

    if summary.get("written"):
        await _announce_window_open(month, hr, summary)
    return summary


async def _announce_window_open(month: str, hr: HrSettings,
                                summary: dict) -> int:
    """Tell the pay desk last month's drafts exist, and when they lock."""
    due = await auto_finalise_on(month, hr)
    label = month_label(month)
    if due is None:
        body = (f"{summary.get('payslips', 0)} draft payslips are ready to "
                f"check. They stay as drafts until somebody finalises them.")
    else:
        body = (f"{summary.get('payslips', 0)} draft payslips are ready to "
                f"check. Correct the attendance register before "
                f"{due.strftime('%a %d %b')}, when they finalise "
                f"automatically.")
    # Named people, never a count: "3 employees have no salary" sends somebody
    # hunting, three names is a to-do list.
    missing = summary.get("missing_salary") or []
    if missing:
        body += f" No salary on record for: {', '.join(missing)}."

    return await notifications.notify_permission(
        MANAGE_PAYSLIPS, f"{label} payslips are ready to check",
        body=body, category=NOTIFY_CATEGORY,
        link=f"/hr/payslips?view=run&month={month}")


# =============================================================================
# The correction window, and locking the month when it closes
# =============================================================================
#
# THE WHOLE FEATURE, IN ONE PARAGRAPH (owner 2026-09-06): "we will also give one
# two days buffer for the admin or the owner or the managers to check the
# attendance or make any corrections if required, so that their salaries are
# calculated automatically and correctly."
#
# Two behaviours, and the second is the one that makes the first worth having:
#
#   1. drafts are left alone while the window is open, and
#   2. the register is RE-READ at the moment it closes.
#
# Without (2) the buffer would be theatre. `generate_for` deliberately does not
# recompute an existing draft -- so a correction approved on the 2nd is saved,
# visible on the Attendance page, and absent from the payslip that locks on the
# 3rd. The job regenerates every draft immediately before locking it, which is
# also why a manual adjustment survives: `apply_adjustment` re-applies it.


async def auto_finalise_on(month: str, hr: HrSettings) -> Optional[date]:
    """The IST date `month`'s drafts lock themselves on, or None when off.

    WORKING days, counted from the day after the month ended. A month ending on
    a Friday with a two-CALENDAR-day buffer would lock on the Sunday, having
    given nobody a chance to use it -- so this walks the same
    `working_days_between` the leave cost and the absent-day rule already use,
    and the three cannot disagree about what an open day is.

    The window is the FIRST `n` working days; the lock is the one after them.
    August 2026 ends on Monday the 31st, so with n=2 the register stays open on
    Tuesday 1 and Wednesday 2 September and the drafts lock on Thursday the 3rd
    -- which is what "two days to check it" means to the person who asked for
    it. Pinned, with the weekend and holiday cases, in tests/test_payroll.
    """
    days = int(getattr(hr, "payroll_auto_finalise_days", 0) or 0)
    if days <= 0:                       # 0 = never; today's manual behaviour
        return None
    try:
        _, last = cal.month_bounds(month)
    except (ValueError, IndexError):
        return None

    start = date.fromordinal(last.toordinal() + 1)
    # Wide enough that a week off plus a run of declared holidays cannot leave
    # the window unresolved, and cheap: one indexed range query for the lot.
    horizon = date.fromordinal(last.toordinal() + 60)
    working = cal.working_days_between(
        start, horizon, week_off_days=hr.week_off_days,
        holidays=await cal.holiday_map(start, horizon))
    if len(working) <= days:            # pragma: no cover -- 60 days is plenty
        return None
    return working[days]


async def disputed_between(first: str, last: str) -> set[str]:
    """Employees with an OPEN correction request for any day in a range.

    ONE query however many months are on screen. A list of somebody's twelve
    payslips asking this per row would be twelve queries for an answer that is
    one indexed range scan -- the same reasoning behind `cal.holiday_map`.
    """
    rows = await AttendanceCorrection.find({
        "status": HrRequestStatus.PENDING.value,
        "day": {"$gte": first, "$lte": last},
    }).to_list()
    return {r.user_id for r in rows}


async def disputed_user_ids(month: str) -> set[str]:
    """Employees with an OPEN correction request against a day in `month`.

    THE BLOCKER `unresolved_days` CANNOT SEE. A day marked ABSENT that somebody
    has filed "I was actually here" against is not unresolved -- it has a
    definite status, and that status is exactly what is being argued about.
    Locking pay over a dispute somebody has already raised is the single
    scenario this whole window exists to prevent, so it is asked separately.
    """
    try:
        first, last = cal.month_bounds(month)
    except (ValueError, IndexError):
        return set()
    return await disputed_between(first.isoformat(), last.isoformat())


async def disputed_for_months(months) -> set[str]:
    """The same, spanning every month in `months`. One query, not one each."""
    keys = sorted({m for m in months if m})
    if not keys:
        return set()
    try:
        first, _ = cal.month_bounds(keys[0])
        _, last = cal.month_bounds(keys[-1])
    except (ValueError, IndexError):
        return set()
    return await disputed_between(first.isoformat(), last.isoformat())


def blockers_for(slip: Payslip, *, disputed: set[str]) -> list[str]:
    """Why this payslip may not lock itself yet. Empty list = ready.

    Each reason is a SENTENCE FRAGMENT a person can act on, because these are
    read out on the pay-run screen next to somebody's name. "Blocked" on its own
    tells the pay desk to go looking; "no salary on record" tells them where.

    Deliberately the same three checks the screen already showed as warnings
    before this job existed -- the automation refuses to lock exactly what a
    careful human would have refused to lock.
    """
    reasons: list[str] = []
    if slip.monthly_salary_paise <= 0:
        reasons.append("no salary on record")
    if slip.unresolved_days > 0:
        reasons.append(f"{slip.unresolved_days} unresolved "
                       f"{'day' if slip.unresolved_days == 1 else 'days'} "
                       f"on the register")
    if slip.user_id in disputed:
        reasons.append("a correction request is waiting")
    return reasons


async def lock(slip: Payslip, *, actor: Optional[User] = None,
               automatic: bool = False,
               now: Optional[datetime] = None) -> Payslip:
    """Finalise ONE payslip and tell the employee. The only path to FINALISED.

    Shared by the pay desk's button (`routers/payslips.finalise`) and the
    scheduled job, so the two cannot drift into telling an employee different
    things about the same event. That drift is not hypothetical here: the
    notification names a figure, and a payslip announced as one amount and paid
    as another is the worst bug this feature can have.

    Finalising is what makes a payslip real to the person it is about -- until
    then it is a draft the next correction can move -- and it is also what stops
    the register moving it (see `generate_for`).
    """
    now = now or utcnow()
    slip.status = PayslipStatus.FINALISED
    slip.finalised_at = now
    slip.finalised_by = str(actor.id) if actor else None
    slip.finalised_by_name = actor.full_name if actor else None
    slip.auto_finalised = automatic
    slip.updated_at = now
    await slip.save()

    label = month_label(slip.month)
    await notifications.create_notification(
        slip.user_id, f"Your {label} payslip is ready",
        body=f"Net payable Rs {slip.net_payable_paise / 100:,.2f} for "
             f"{slip.payable_days:g} payable days.",
        category=NOTIFY_CATEGORY, link=f"/hr/payslips?month={slip.month}")
    return slip


async def run_auto_finalise(hr: HrSettings, *,
                            now: Optional[datetime] = None) -> dict:
    """Lock last month's drafts once the correction window has closed.

    SAFE TO RUN EVERY MORNING, which is what lets it ride the daily job with no
    coordination: before the deadline it returns "waiting" and writes nothing;
    after it, every payslip it would touch is already FINALISED and the query
    finds nothing to do. A missed run is therefore self-healing -- the next
    morning's does the same work -- and that matters more here than usual,
    because the one day this job must not silently skip is a pay day.

    IT NEVER FORCES A BLOCKED PAYSLIP. One with no salary, an unresolved
    register or a live correction request stays exactly as it was: a DRAFT
    somebody has to look at. That is the only behaviour that cannot produce a
    wrong figure -- an unfinished payslip is late, a wrongly-locked one is a
    payment made against a number nobody checked.
    """
    now = now or utcnow()
    month = previous_month(now)
    due = await auto_finalise_on(month, hr)
    if due is None:
        return {"month": month, "status": "off"}

    today = cal.parse_day(cal.day_key(now))
    if today < due:
        return {"month": month, "status": "waiting", "due": due.isoformat()}

    drafts = await Payslip.find({"month": month,
                                 "status": PayslipStatus.DRAFT}).to_list()
    if not drafts:
        return {"month": month, "status": "nothing_to_do",
                "due": due.isoformat()}

    disputed = await disputed_user_ids(month)
    locked: list[str] = []
    blocked: dict[str, list[str]] = {}

    for slip in drafts:
        try:
            # RE-READ THE REGISTER FIRST. This is the half of the feature that
            # makes the window mean anything -- corrections made during it are
            # only in the figure because of this line. A manual adjustment
            # survives it (generate_for re-applies it), which is why the pay
            # desk's own typed number is not lost by automation.
            user = await User.get(slip.user_id)
            if user is not None:
                slip, _ = await generate_for(user, month, hr,
                                             regenerate=True, now=now)
            # A payslip whose employee is GONE still locks, on the figures it
            # was generated with. Somebody who left in August is owed August,
            # and refusing to finalise it would leave a payment nobody can make
            # from a screen that never clears. There is nothing to re-read: the
            # register is not going to change for an account that no longer
            # exists.

            reasons = blockers_for(slip, disputed=disputed)
            if reasons:
                blocked[slip.user_name or slip.user_code] = reasons
                continue
            await lock(slip, automatic=True, now=now)
            locked.append(slip.user_name or slip.user_code)
        except Exception:  # noqa: BLE001 -- one bad payslip must not stop 29
            log.exception("Payroll: auto-finalise failed for %s (%s)",
                          slip.user_name, month)
            blocked[slip.user_name or slip.user_code] = ["it could not be "
                                                         "worked out"]

    await _announce_window_closed(month, locked, blocked)
    if locked:
        await log_action(
            AuditAction.PAYSLIP_FINALISED,
            actor_name="Automatic", actor_role="system",
            entity_type="payslip",
            summary=f"Finalised {len(locked)} payslip"
                    f"{'s' if len(locked) != 1 else ''} for {month} "
                    f"automatically, the correction window having closed",
            meta={"month": month, "locked": ", ".join(locked),
                  "blocked": ", ".join(blocked)})

    return {"month": month, "status": "ran", "due": due.isoformat(),
            "locked": len(locked), "blocked": blocked}


async def _announce_window_closed(month: str, locked: list[str],
                                  blocked: dict[str, list[str]]) -> int:
    """Tell the pay desk what locked and what is stuck, ONCE per month.

    De-duplicated against the notification rows themselves rather than a stored
    flag, because a payslip left blocked stays a DRAFT for ever and this job
    retries it every morning -- without the guard, a single unfilled salary
    would send the same bell thirty times and the category would stop being
    read. Same mechanism, and the same reasoning, as the "you have not clocked
    in" nudge.
    """
    link = f"/hr/payslips?view=run&month={month}"
    try:
        already = await notifications.Notification.find({
            "category": NOTIFY_CATEGORY, "link": link,
            "title": {"$regex": "^Pay run"},
        }).count()
    except Exception:  # noqa: BLE001 -- a failed check must not stop the run
        log.exception("Payroll: could not check for an existing pay-run notice")
        already = 0
    if already:
        return 0

    label = month_label(month)
    parts = []
    if locked:
        parts.append(f"{len(locked)} payslip{'s' if len(locked) != 1 else ''} "
                     f"finalised automatically and everybody was told.")
    if blocked:
        # Every blocked person BY NAME, with the reason next to it. This is the
        # to-do list the month is waiting on, and it is the whole reason this
        # notification is worth sending at all.
        detail = "; ".join(f"{name} ({', '.join(why)})"
                           for name, why in blocked.items())
        parts.append(f"Still waiting: {detail}. These stay as drafts until "
                     f"you finalise them.")
    if not parts:                       # pragma: no cover -- caller guards
        return 0

    return await notifications.notify_permission(
        MANAGE_PAYSLIPS,
        f"Pay run: {label} " + ("is ready to pay" if not blocked
                                else "needs a look"),
        body=" ".join(parts), category=NOTIFY_CATEGORY, link=link)
