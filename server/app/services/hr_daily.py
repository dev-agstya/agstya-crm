"""The HR module's one scheduled job.

Rides the EXISTING 08:00 IST daily run (server/send_reminders.py) rather than
adding a second schedule. One cron entry is one thing to forget to configure;
two is two, and the second one is always the one nobody notices has been failing
for a month.

SIX THINGS, IN THIS ORDER, EACH INDEPENDENTLY WRAPPED
------------------------------------------------------
  1. CLOSE yesterday's forgotten punch-outs, so the register does not carry
     days that are still running from last week.
  2. ACCRUE this month's leave. Idempotent by unique index, so running it every
     morning credits once and no-ops the other thirty times — which is exactly
     what makes a missed cron run self-healing rather than a lost month.
  3. LAPSE the previous leave year, once it has ended. Same idempotency.
  4. TELL anybody whose day was auto-closed, so they can correct it while they
     still remember what time they left.
  5. GENERATE last month's payslips (2026-08-24), as drafts. Near-last, because
     it reads the register step 1 has just finished closing.
  6. LOCK them once the correction window has closed (2026-09-06) — re-reading
     the register first, so the corrections the window existed for are actually
     in the figure that locks.

Each step is wrapped on its own. A failure in step four must not stop the
accrual; a failure in the accrual must not stop the close. This is the same
shape `send_reminders.py` already uses to keep a broken digest from stopping
renewal emails, and for the same reason.

THE ONE THING THAT IS **NOT** HERE is the "you have not clocked in" nudge, and
that is a timing decision rather than an oversight: this run fires at 08:00 IST
and the shift starts at 10:00, so a nudge from here would land two hours early.
It has its own entry point — `notify_not_clocked_in`, driven by
`server/send_hr_nudges.py` — and its own de-duplication, so wiring it to a
second cron needs no coordination with this one.

EVERY STEP IS SAFE TO RUN TWICE. That is not a nice-to-have — the job is called
from the cron AND at boot, so on a deploy morning it genuinely runs twice within
the hour.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from app.core.enums import HrRequestStatus
from app.models.attendance import AttendanceDay
from app.models.base import utcnow
from app.models.leave import LeaveRequest
from app.services import hr_attendance, hr_calendar as cal, hr_leave
from app.services import notifications, payroll, settings_svc

log = logging.getLogger("agastyacrm.hr")


async def run_daily(now: Optional[datetime] = None) -> dict:
    """Run every HR maintenance step. Never raises; returns what it managed."""
    now = now or utcnow()
    hr = (await settings_svc.get_settings()).hr
    out: dict = {}

    try:
        out["closed_open_days"] = await hr_attendance.auto_close_open_days(
            hr, now=now)
    except Exception as exc:  # noqa: BLE001
        log.exception("HR: closing open attendance days failed")
        out["closed_open_days"] = f"failed: {type(exc).__name__}"

    try:
        out["accrual"] = await hr_leave.accrue_month(hr, now=now)
    except Exception as exc:  # noqa: BLE001
        log.exception("HR: monthly leave accrual failed")
        out["accrual"] = f"failed: {type(exc).__name__}"

    try:
        out["lapse"] = await hr_leave.lapse_year(hr, now=now)
    except Exception as exc:  # noqa: BLE001
        log.exception("HR: leave-year lapse failed")
        out["lapse"] = f"failed: {type(exc).__name__}"

    try:
        out["missed_punch_notices"] = await notify_missed_punch_outs(now=now)
    except Exception as exc:  # noqa: BLE001
        log.exception("HR: missed punch-out notices failed")
        out["missed_punch_notices"] = f"failed: {type(exc).__name__}"

    # 5. LAST MONTH'S PAYSLIPS (owner 2026-08-24: "on first of each month,
    #    previous month's salary should be calculated").
    #
    # Last, deliberately. It reads the register that step 1 has just finished
    # closing, so running it before the auto-close would compute a month whose
    # final day was still open. And being last means a failure here cannot stop
    # the accrual or the close — the same independent-step shape as the four
    # above.
    #
    # It runs EVERY morning, not only on the 1st, and is a no-op on the other
    # thirty: the (user, month) unique index makes the second attempt find what
    # the first wrote. A job whose one chance to work is the morning the
    # instance happens to be redeploying is a job that silently misses a month.
    try:
        out["payroll"] = await payroll.run_monthly(hr, now=now)
    except Exception as exc:  # noqa: BLE001
        log.exception("HR: monthly payslip generation failed")
        out["payroll"] = f"failed: {type(exc).__name__}"

    # 6. LOCK LAST MONTH once the correction window has closed (owner
    #    2026-09-06: "we will also give one two days buffer for the admin or the
    #    owner or the managers to check the attendance or make any corrections
    #    if required, so that their salaries are calculated automatically and
    #    correctly").
    #
    #    AFTER step 5, necessarily: it locks the drafts that step generated, and
    #    on the morning the window closes both run in the same pass. It is a
    #    no-op on every day before the deadline and on every day after the month
    #    has been locked, so like the four steps above it is safe to run daily
    #    and self-healing when a morning is missed.
    try:
        out["payroll_auto_finalise"] = await payroll.run_auto_finalise(
            hr, now=now)
    except Exception as exc:  # noqa: BLE001
        log.exception("HR: automatic payslip finalisation failed")
        out["payroll_auto_finalise"] = f"failed: {type(exc).__name__}"

    return out


async def notify_missed_punch_outs(*, now: Optional[datetime] = None) -> int:
    """Tell people the morning after that they left a day open.

    Fires on the day the auto-close stamped, so it goes out once, the next
    morning, while they can still remember what time they actually left. It
    names the day and points at the correction form rather than merely saying
    something is wrong — a notification that does not say what to do next is a
    notification people learn to dismiss.
    """
    now = now or utcnow()
    # Yesterday in IST — the day the auto-close above just finished with.
    yesterday = cal.parse_day(cal.day_key(now)).toordinal() - 1
    from datetime import date as _date
    key = _date.fromordinal(yesterday).isoformat()

    rows = await AttendanceDay.find({"day": key,
                                     "missed_punch_out": True}).to_list()
    sent = 0
    for row in rows:
        ok = await notifications.create_notification(
            row.user_id,
            "You did not clock out yesterday",
            body=f"Your {key} was closed automatically at the end of your "
                 f"shift. If that is wrong, raise a correction so the register "
                 f"is right before month end.",
            category="attendance",
            link=f"/hr/attendance?month={cal.month_key_of(key)}")
        if ok:
            sent += 1
    return sent


# The category on a nudge, which is ALSO its de-duplication key: the "have I
# already nudged this person today" question is answered by asking the
# notification collection rather than by keeping a flag anywhere. Notifications
# are already written for this exact purpose and already carry a TTL, so this
# costs one indexed query and no new state.
NUDGE_CATEGORY = "attendance_nudge"


async def notify_not_clocked_in(*, now: Optional[datetime] = None) -> int:
    """A bell for anybody who has not clocked in this morning (owner I2).

    WHY THIS IS NOT IN `run_daily`: the shared daily run fires at 08:00 IST and
    the shift starts at 10:00, so a nudge from there would land two hours before
    anybody was due — which is noise, and noise is how a prompt stops being
    read. It is its own entry point (`server/send_hr_nudges.py`) for a cron at
    roughly 30 minutes past shift start.

    IT IS STILL SAFE TO CALL FROM ANYWHERE, as often as you like: the guard is
    "has this person already been nudged today", asked of the notification rows
    themselves, so a second run sends nothing rather than sending twice. That
    property is what lets it be wired to a second cron without needing to be
    coordinated with the first.

    Skips week offs, holidays, approved leave, anyone already clocked in, and
    anyone who had not joined yet. A bell, deliberately not an email: it is a
    small prompt thirty times a month, and email would train people to filter
    the sender.
    """
    now = now or utcnow()
    hr = (await settings_svc.get_settings()).hr
    today = cal.day_key(now)
    day = cal.parse_day(today)

    if cal.is_week_off(day, hr.week_off_days):
        return 0
    if today in (await cal.holiday_map(today, today)):
        return 0

    employees = await hr_attendance.hr_employees()
    if not employees:
        return 0

    punched = {r.user_id for r in await AttendanceDay.find(
        {"day": today, "clock_in": {"$ne": None}}).to_list()}
    on_leave = {r.user_id for r in await LeaveRequest.find({
        "status": HrRequestStatus.APPROVED.value,
        "start_date": {"$lte": today}, "end_date": {"$gte": today},
    }).to_list()}

    # Everybody already nudged today, in ONE query. The IST day boundary is
    # what "today" means here, exactly as it does everywhere else in this
    # module — comparing against UTC midnight would re-nudge the whole agency
    # between 00:00 and 05:30 IST.
    since = cal.combine_ist(day, "00:00")
    already = {n.user_id for n in await notifications.Notification.find({
        "category": NUDGE_CATEGORY, "created_at": {"$gte": since},
    }).to_list()}

    sent = 0
    for user in employees:
        uid = str(user.id)
        if uid in punched or uid in on_leave or uid in already:
            continue
        doj = getattr(getattr(user, "employee_profile", None),
                      "date_of_joining", None)
        if doj and doj.isoformat() > today:
            continue
        if await notifications.create_notification(
                uid, "You have not clocked in today",
                body="Open Attendance and clock in so today is recorded.",
                category=NUDGE_CATEGORY, link="/hr/attendance"):
            sent += 1
    return sent
