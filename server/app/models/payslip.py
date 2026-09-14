"""Payslips: one document per employee per month, and the figure the agency pays.

WHY THIS EXISTS NOW, HAVING BEEN DROPPED ONCE
----------------------------------------------
Payroll was designed and cancelled in the same conversation on 2026-08-20 —
"remove the salary and the amount being calculated here... at the end it will be
calculated manually. No money anywhere in it." The owner reversed that on
2026-08-24: "based on the attendance of the employee and the salary which is set
of an employee, at the end of month, a salary should be calculated... so that the
owner knows how much to pay each employee."

So the Workplace HR module now carries money, in exactly ONE place: here. The
attendance and leave services are untouched and still compute nothing but days
and hours -- `services/payroll` reads their output and multiplies. That
separation is the whole design. If a rupee ever appears in `hr_attendance`,
`hr_leave` or `hr_calendar`, somebody has put the arithmetic back inside the
register the figure is supposed to be arguable from.

THE PER-DAY RATE IS THE SALARY OVER A FIXED 30, NOT OVER THE MONTH'S LENGTH
---------------------------------------------------------------------------
The owner's rule, stated with its own worked example: "if the salary of an
employee is 15,000 rupees, that means per day cost is 500 rupees. So now if it
is a month of 31 days and he takes two days off, then we are going to deduct
1,000 rupees. And if it is a month of 28 days and still he takes two leaves,
then we will deduct 1,000 only."

Two days off costs the same in February as in March. That is only true if the
divisor is a CONSTANT -- 15,000/28 is 535.71 and 15,000/31 is 483.87, and either
would make the same absence cost a different amount depending on the month. So
`PAYROLL_DAYS_PER_MONTH = 30`, which is also the ordinary Indian convention.

The BASE is still the full monthly salary. A perfect 31-day month pays 15,000,
not 31 x 500 -- the fixed divisor prices the DEDUCTION, it does not rebuild the
salary. Getting that backwards is how a payslip for a flawless February comes
out short.

A PAYSLIP IS A SNAPSHOT, AND THAT IS THE POINT
-----------------------------------------------
Every figure is COPIED onto the document at generation: the salary, the per-day
rate, the day counts, the deduction, the net. Nothing here is recomputed on
read. A payslip that re-derived itself would change when somebody's salary was
raised in November, and August's payslip would silently stop matching the
payment that was made against it.

It is regenerable while it is a DRAFT (a late correction, an approved
correction request, a holiday declared after the fact) and frozen the moment it
is finalised.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.models.base import utcnow

# The divisor for the per-day rate. A CONSTANT, not the month's length -- see the
# module docstring. Changing this changes what every future absence costs.
PAYROLL_DAYS_PER_MONTH = 30


class PayslipStatus:
    """Where a payslip has got to.

    A plain constant holder rather than an Enum because it is stored as a string
    and compared as one, and this module never needs the enum's ordering or
    iteration. The values are deliberately the same shape as every other status
    string in the app.
    """

    DRAFT = "draft"            # generated, still regenerable
    FINALISED = "finalised"    # locked -- this is the figure being paid
    PAID = "paid"              # a salary expense was recorded against it
    CANCELLED = "cancelled"    # written off (a duplicate, a wrong month)


PAYSLIP_OPEN = (PayslipStatus.DRAFT, PayslipStatus.FINALISED)
PAYSLIP_LOCKED = (PayslipStatus.FINALISED, PayslipStatus.PAID)


class PayslipLine(BaseModel):
    """One row of the breakdown a person reads.

    Stored as a LIST rather than as named fields because the interesting thing
    about a deduction is that it can be EXPLAINED, and an explanation is
    naturally a label plus a count plus an amount. Named fields would need a
    schema change every time a new kind of deduction is described; this does
    not, and the payslip screen and its PDF render the same rows from the same
    place.
    """

    label: str
    # What produced this line, e.g. "2 days" or "3 late marks". Empty for a line
    # that is only an amount.
    detail: str = ""
    # Signed paise. Positive = added to pay, negative = taken off. The sign is
    # the row's own, so nothing downstream has to know which lines are which.
    amount_paise: int = 0
    # Days behind the amount, when there are any. Kept because the owner's ask
    # is "total payable amount based on total attendance, attended days, total
    # leaves taken" -- the day count is half of what makes a figure checkable by
    # hand.
    days: float = 0.0


class Payslip(Document):
    code: Indexed(str, unique=True)          # PSL-...

    # --- Who and when ---
    user_id: Indexed(str)
    user_name: str = ""
    user_code: str = ""
    designation: Optional[str] = None
    month: Indexed(str)                       # "YYYY-MM", IST

    # --- The inputs, frozen ---
    #
    # `monthly_salary_paise` is a COPY of what was on the employee's profile at
    # generation. A raise in November must not rewrite August.
    monthly_salary_paise: int = 0
    per_day_paise: int = 0
    days_divisor: int = PAYROLL_DAYS_PER_MONTH

    # --- The attendance behind it, frozen ---
    #
    # Every one of these comes off `hr_attendance.summarise` for the same month.
    # Copied rather than joined, so opening a payslip is one read and so the
    # figures on it can never drift from the amount underneath them.
    calendar_days: int = 0
    present_days: int = 0
    wfh_days: int = 0
    half_days: int = 0
    absent_days: int = 0
    paid_leave_days: int = 0
    unpaid_leave_days: int = 0
    week_off_days: int = 0
    holiday_days: int = 0
    not_marked_days: int = 0
    late_marks: int = 0
    late_penalty_days: float = 0.0
    # Days before the person joined the agency, inside this month. Deducted, or
    # somebody who started on the 25th is paid for the whole month.
    pre_joining_days: float = 0.0
    worked_minutes: int = 0
    payable_days: float = 0.0
    # Days the register has not resolved: a missed punch-out, or a past working
    # day with nothing on it. NOT deducted (see services/payroll) but surfaced,
    # because a payslip generated over an unresolved register is one somebody
    # should look at before finalising.
    unresolved_days: int = 0

    # --- The money ---
    lop_days: float = 0.0                     # loss of pay, in days
    deduction_paise: int = 0                  # lop_days x per_day, >= 0
    # Anything a human added or took off by hand, with a reason. Kept apart from
    # the computed deduction so "what the rules said" and "what somebody
    # decided" are never the same number.
    adjustment_paise: int = 0
    adjustment_note: Optional[str] = None
    net_payable_paise: int = 0

    lines: list[PayslipLine] = Field(default_factory=list)

    # --- State ---
    status: str = PayslipStatus.DRAFT
    generated_at: datetime = Field(default_factory=utcnow)
    # Who ran the generation. None for the scheduled monthly run -- a payslip
    # nobody asked for is the normal case and should say so.
    generated_by: Optional[str] = None
    generated_by_name: Optional[str] = None
    finalised_at: Optional[datetime] = None
    finalised_by: Optional[str] = None
    finalised_by_name: Optional[str] = None
    # Locked by the scheduled job rather than by a person pressing the button
    # (owner 2026-09-06). Worth its own field rather than being inferred from
    # `finalised_by is None`: "nobody finalised this" and "the correction window
    # closed and it locked itself" are different sentences, and the second is
    # the one an employee asking "who decided this?" needs to be told. It is
    # also what the pay-run screen reads to say WHEN a month locked itself.
    auto_finalised: bool = False

    # --- Payment ---
    #
    # The LINK to the money, never a second copy of it. The payment itself is an
    # ordinary EXPENSE row on the ledger, posted through the same
    # `finance._post_expense` every other expense uses -- see routers/payslips.
    # Recording the amount here as the source of truth would be a second ledger,
    # and two ledgers disagree.
    paid_at: Optional[datetime] = None
    paid_by: Optional[str] = None
    paid_by_name: Optional[str] = None
    payment_txn_id: Optional[str] = None
    payment_reference: Optional[str] = None
    paid_amount_paise: Optional[int] = None

    note: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "payslips"
        indexes = [
            # ONE PAYSLIP PER PERSON PER MONTH, enforced by the database.
            #
            # This is what makes the monthly generation safe to re-run, and it
            # has to be: the job rides the daily cron AND runs at boot, so on
            # the 1st of a month it genuinely fires more than once. A
            # read-then-write "has this month been generated yet" check would be
            # raced by two runs and produce two payslips. Same mechanism the
            # leave accrual uses, for the same reason.
            pymongo.IndexModel(
                [("user_id", pymongo.ASCENDING), ("month", pymongo.ASCENDING)],
                unique=True, name="payslip_user_month_unique"),
            # "Everybody's August" -- the pay run.
            [("month", pymongo.ASCENDING), ("status", pymongo.ASCENDING)],
            # "My payslips", newest first.
            [("user_id", pymongo.ASCENDING), ("month", pymongo.DESCENDING)],
            [("status", pymongo.ASCENDING)],
        ]

    @property
    def is_locked(self) -> bool:
        """Finalised or paid -- the figures may not be recomputed."""
        return self.status in PAYSLIP_LOCKED
