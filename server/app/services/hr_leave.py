"""Leave: the balance, the accrual, and what a request actually costs.

THE BALANCE IS A SUM, NOT A FIELD
---------------------------------
`balance_for()` adds up `LeaveLedgerRow` for one person inside one leave year.
There is no cached total anywhere — not on the user, not on a summary document.
The row count is about fifteen a year (twelve accruals and a handful of leaves),
so the sum is cheap, and a total that does not exist cannot go stale. This is
the same reasoning behind `PartyAccount` being healable from the ledger, taken
one step further because the volumes here are three orders of magnitude smaller.

WHAT A LEAVE COSTS
-------------------
WORKING days only (owner E9). Sundays and declared holidays inside the range are
skipped, so Friday-to-Monday over a Sunday is three days, not four — nobody
spends leave on a day the office was shut. `hr_calendar.working_days_between` is
the one definition, shared with the attendance month, so the register and the
leave form can never disagree about which days were open.

The cost is computed at SUBMIT (so the form can say "this is 3 days" before you
send it) and RECOMPUTED at APPROVAL — because a holiday declared in between
would otherwise charge somebody for a day that became a holiday while they
waited.

PAID vs UNPAID IS DECIDED ONCE, AT APPROVAL, AND THEN FROZEN
-------------------------------------------------------------
Approving 3 days against a balance of 0.5 books 0.5 paid and 2.5 unpaid, and
those two numbers never move again. Recomputing them later against a balance
that has since changed would make an August leave read differently in November,
which is the kind of drift that ends in an argument nobody can settle.

Going short is ALLOWED and never blocked (owner E17): people genuinely need
unpaid leave, and the form says what it will cost before you send it. Blocking
it would only mean the day is recorded as an absence instead, which is worse
for everybody.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Optional

from pymongo.errors import DuplicateKeyError

from app.core.enums import (
    HrRequestStatus, LeaveDayPart, LeaveLedgerEntry,
)
from app.models.base import utcnow
from app.models.leave import LeaveLedgerRow, LeaveRequest
from app.models.settings import HrSettings
from app.models.user import User
from app.services import hr_calendar as cal

log = logging.getLogger("agastyacrm.hr")

# Leave is counted in halves and nothing finer. A quarter day is not a thing
# anybody asks for, and allowing arbitrary floats would let rounding noise into
# a balance people check by hand.
STEP = 0.5


def _round_half(value: float) -> float:
    """Snap to the nearest 0.5, and normalise -0.0 to 0.0."""
    return round(round(value / STEP) * STEP, 2) + 0.0


# =============================================================================
# The balance
# =============================================================================


def accrual_for(user: User, hr: HrSettings) -> float:
    """Days this employee earns per month. Their override, else the agency's."""
    override = getattr(getattr(user, "employee_profile", None),
                       "monthly_leave_accrual", None)
    return float(override if override is not None else hr.monthly_leave_accrual)


async def ledger_rows(user_id: str, leave_year: int) -> list[LeaveLedgerRow]:
    return await LeaveLedgerRow.find({
        "user_id": user_id, "leave_year": leave_year,
    }).sort("created_at").to_list()


async def balance_for(user_id: str, hr: HrSettings, *,
                      leave_year: Optional[int] = None,
                      now: Optional[datetime] = None) -> dict:
    """One person's leave position, broken into the parts they will ask about.

    Returns days, never rupees. "How many do I have left" is the whole question
    this module answers about leave.
    """
    now = now or utcnow()
    year = (leave_year if leave_year is not None
            else cal.leave_year_of(cal.day_key(now), hr.leave_year_start_month))
    rows = await ledger_rows(user_id, year)

    accrued = used = refunded = adjusted = lapsed = opening = 0.0
    for r in rows:
        if r.entry_type == LeaveLedgerEntry.ACCRUAL.value:
            accrued += r.days
        elif r.entry_type == LeaveLedgerEntry.USAGE.value:
            used += -r.days              # stored negative; report positive
        elif r.entry_type == LeaveLedgerEntry.REFUND.value:
            refunded += r.days
        elif r.entry_type == LeaveLedgerEntry.ADJUSTMENT.value:
            adjusted += r.days
        elif r.entry_type == LeaveLedgerEntry.LAPSE.value:
            lapsed += -r.days
        elif r.entry_type == LeaveLedgerEntry.OPENING.value:
            opening += r.days

    available = sum(r.days for r in rows)
    first, last = cal.leave_year_bounds(year, hr.leave_year_start_month)
    return {
        "leave_year": year,
        "leave_year_label": f"{first.strftime('%b %Y')} – "
                            f"{last.strftime('%b %Y')}",
        "opening": _round_half(opening),
        "accrued": _round_half(accrued),
        "used": _round_half(used),
        "refunded": _round_half(refunded),
        "adjusted": _round_half(adjusted),
        "lapsed": _round_half(lapsed),
        "available": _round_half(available),
        "monthly_accrual": 0.0,          # filled by the router, which has the user
        "max_balance": hr.max_leave_balance,
    }


async def post(user_id: str, entry_type: str, days: float, *,
               leave_year: int, period_key: str = "", note: str = "",
               ref_id: Optional[str] = None,
               actor: Optional[User] = None) -> Optional[LeaveLedgerRow]:
    """Append one balance movement. Returns None when a job row already existed.

    The `DuplicateKeyError` swallow is the accrual's idempotency, and it is the
    REAL guard rather than a convenience: the daily job runs from a cron AND at
    boot, so the same month is genuinely attempted more than once, and two
    concurrent runs could both read "not accrued yet" before either wrote. The
    unique index cannot be raced; a read-then-write check can.
    """
    row = LeaveLedgerRow(
        user_id=user_id, entry_type=entry_type, days=_round_half(days),
        leave_year=leave_year, period_key=period_key, note=note, ref_id=ref_id,
        created_by=str(actor.id) if actor else None,
        created_by_name=actor.full_name if actor else None)
    try:
        await row.insert()
        return row
    except DuplicateKeyError:
        # Already posted for this period. Not an error and not worth a log line
        # above debug — it is the expected outcome of the second run.
        log.debug("Leave %s for %s in %s already posted",
                  entry_type, user_id, period_key)
        return None


# =============================================================================
# What a request costs
# =============================================================================


async def count_days(start: str, end: str, day_part: str, hr: HrSettings
                     ) -> tuple[float, list[str]]:
    """(working days the request costs, the day keys it covers).

    A half-day part only applies to a single-day request; the schema refuses it
    on a range, so this can trust the pair.
    """
    holidays = await cal.holiday_map(start, end)
    days = cal.working_days_between(start, end,
                                    week_off_days=hr.week_off_days,
                                    holidays=holidays)
    keys = [d.isoformat() for d in days]
    if not keys:
        return 0.0, []
    if day_part != LeaveDayPart.FULL.value and len(keys) == 1:
        return STEP, keys
    return float(len(keys)), keys


# =============================================================================
# Applying the balance at approval
# =============================================================================


def split_paid_unpaid(cost: float, available: float) -> tuple[float, float]:
    """How much of a leave the balance covers, and how much it does not.

    Never blocks (owner E17). A negative available balance — which an adjustment
    can produce — covers nothing rather than making the unpaid part larger than
    the leave itself.
    """
    usable = max(0.0, min(available, cost))
    return _round_half(usable), _round_half(cost - usable)


async def spend(request: LeaveRequest, hr: HrSettings, actor: User) -> None:
    """Book the balance movement for a leave being APPROVED.

    Only the PAID part touches the ledger — unpaid days cost no balance by
    definition, and posting a zero row for them would fill the statement with
    rows that say nothing.
    """
    if request.paid_days <= 0:
        return
    year = cal.leave_year_of(request.start_date, hr.leave_year_start_month)
    await post(request.user_id, LeaveLedgerEntry.USAGE.value,
               -request.paid_days, leave_year=year, ref_id=str(request.id),
               note=f"{request.code} · {request.start_date} to "
                    f"{request.end_date}", actor=actor)


async def refund(request: LeaveRequest, hr: HrSettings, actor: Optional[User],
                 *, days: Optional[float] = None, note: str = "") -> None:
    """Give balance back — a cancelled leave, or a leave day that was worked.

    A REFUND ROW, never a deletion of the usage row. Two rows that cancel out
    are a story somebody can read; a missing row is a number nobody can explain.
    """
    amount = request.paid_days if days is None else days
    if amount <= 0:
        return
    year = cal.leave_year_of(request.start_date, hr.leave_year_start_month)
    await post(request.user_id, LeaveLedgerEntry.REFUND.value, amount,
               leave_year=year, ref_id=str(request.id),
               note=note or f"{request.code} cancelled", actor=actor)


# =============================================================================
# The jobs
# =============================================================================


async def accrue_month(hr: HrSettings, *, month: Optional[str] = None,
                       now: Optional[datetime] = None) -> dict:
    """Credit every active employee their monthly leave for `month`.

    PRO-RATA IN THE JOINING MONTH (owner E5): somebody who started on the 16th
    of a 30-day month gets half, rounded to the nearest 0.5. Nothing at all
    before they joined.

    CAPPED at `max_leave_balance` — the credit is trimmed so the balance lands
    exactly on the cap rather than being refused, because refusing it would mean
    a month of service silently earned nothing.

    Idempotent by unique index, not by a flag: see `post`.
    """
    now = now or utcnow()
    month = month or cal.month_key_of(cal.day_key(now))
    first, last = cal.month_bounds(month)

    from app.services import hr_attendance  # local: avoids an import cycle
    employees = await hr_attendance.hr_employees()

    credited = skipped = 0
    for user in employees:
        doj = getattr(getattr(user, "employee_profile", None),
                      "date_of_joining", None)
        if doj and doj > last:
            skipped += 1                 # had not joined yet
            continue

        full = accrual_for(user, hr)
        days = full
        if doj and doj > first:
            # Pro-rata on the days they were actually employed.
            employed = (last - doj).days + 1
            days = _round_half(full * employed / ((last - first).days + 1))
        if days <= 0:
            skipped += 1
            continue

        year = cal.leave_year_of(first, hr.leave_year_start_month)
        current = (await balance_for(str(user.id), hr,
                                     leave_year=year))["available"]
        room = hr.max_leave_balance - current
        if room <= 0:
            skipped += 1
            continue
        days = min(days, _round_half(room))
        if days <= 0:
            skipped += 1
            continue

        row = await post(str(user.id), LeaveLedgerEntry.ACCRUAL.value, days,
                         leave_year=year, period_key=month,
                         note=f"Monthly leave for {month}")
        if row is not None:
            credited += 1
        else:
            skipped += 1
    return {"month": month, "credited": credited, "skipped": skipped}


async def lapse_year(hr: HrSettings, *, leave_year: Optional[int] = None,
                     now: Optional[datetime] = None) -> dict:
    """Clear what everybody was carrying at the end of a leave year (owner E3).

    Posts a LAPSE row for exactly the remaining balance, so the year closes at
    zero and the statement says why. No encashment — unused leave is not paid
    out, which the owner did not ask for and which is a real cash cost.

    Only ever run for a year that has ENDED. Called with the year that just
    finished; running it for the current year would wipe a live balance.
    """
    now = now or utcnow()
    today = cal.parse_day(cal.day_key(now))
    year = (leave_year if leave_year is not None
            else cal.leave_year_of(today, hr.leave_year_start_month) - 1)
    _, last = cal.leave_year_bounds(year, hr.leave_year_start_month)
    if today <= last:
        return {"leave_year": year, "lapsed": 0,
                "skipped_reason": "that leave year has not ended yet"}

    from app.services import hr_attendance
    employees = await hr_attendance.hr_employees(include_inactive=True)
    period = f"{year}-{hr.leave_year_start_month:02d}"

    lapsed = 0
    for user in employees:
        bal = await balance_for(str(user.id), hr, leave_year=year)
        remaining = bal["available"]
        if remaining <= 0:
            continue
        row = await post(str(user.id), LeaveLedgerEntry.LAPSE.value, -remaining,
                         leave_year=year, period_key=period,
                         note=f"Unused leave lapsed at the end of "
                              f"{last.strftime('%b %Y')}")
        if row is not None:
            lapsed += 1
    return {"leave_year": year, "lapsed": lapsed}


# =============================================================================
# Overlap
# =============================================================================


async def overlapping(user_id: str, start: str, end: str, *,
                      exclude_id: Optional[str] = None) -> Optional[LeaveRequest]:
    """An existing pending/approved leave that covers any of these days.

    Two leaves on one day is always a mistake — either a double submission or
    somebody editing when they meant to withdraw — and letting both through
    would debit the balance twice for one absence.
    """
    rows = await LeaveRequest.find({
        "user_id": user_id,
        "status": {"$in": [HrRequestStatus.PENDING.value,
                           HrRequestStatus.APPROVED.value]},
        "start_date": {"$lte": end},
        "end_date": {"$gte": start},
    }).to_list()
    for r in rows:
        if exclude_id and str(r.id) == exclude_id:
            continue
        return r
    return None
