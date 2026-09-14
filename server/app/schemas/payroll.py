"""Payslip request/response shapes.

Its own module rather than a section of `schemas/hr.py`, and that is not
tidiness. `tests/test_hr_module` sweeps every model in `schemas/hr` and fails on
a field whose name looks like money -- a rule the owner asked for on 2026-08-20
and which is still exactly right for attendance and leave. Payroll is the one
part of Workplace HR that carries rupees (owner 2026-08-24), so it lives beside
that sweep instead of inside it, and the sweep goes on protecting the register.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.models.payslip import Payslip, PayslipStatus


class PayslipLineOut(BaseModel):
    label: str
    detail: str = ""
    amount_paise: int = 0
    days: float = 0.0


class PayslipOut(BaseModel):
    """One payslip, in full. The employee's copy and the pay desk's copy are the
    SAME serialisation -- a payslip that says something different to the person
    it is about is the one bug this feature cannot afford."""

    id: str
    code: str
    user_id: str
    user_name: str
    user_code: str
    designation: Optional[str] = None
    month: str

    monthly_salary_paise: int
    per_day_paise: int
    days_divisor: int

    calendar_days: int
    present_days: int
    wfh_days: int
    half_days: int
    absent_days: int
    paid_leave_days: int
    unpaid_leave_days: int
    week_off_days: int
    holiday_days: int
    not_marked_days: int
    late_marks: int
    late_penalty_days: float
    pre_joining_days: float
    worked_minutes: int
    payable_days: float
    unresolved_days: int

    lop_days: float
    deduction_paise: int
    adjustment_paise: int
    adjustment_note: Optional[str] = None
    net_payable_paise: int
    lines: list[PayslipLineOut] = Field(default_factory=list)

    status: str
    generated_at: datetime
    generated_by_name: Optional[str] = None
    finalised_at: Optional[datetime] = None
    finalised_by_name: Optional[str] = None
    # Locked by the scheduled job rather than by a person. The screen says
    # "Locked automatically on 3 Sep" instead of naming nobody, because
    # "who decided this?" is the first question an employee asks about a figure.
    auto_finalised: bool = False
    # Why this one will NOT lock itself when the window closes, in words a
    # person can act on. Empty for a payslip that is ready (or already locked).
    blockers: list[str] = Field(default_factory=list)
    # The IST date this DRAFT locks itself on. Carried on the payslip rather
    # than only on the pay run, because it is the EMPLOYEE'S deadline too: it is
    # the last day raising a correction can still change what they are paid, and
    # they never open the pay run. None once it is locked, or when automatic
    # locking is off.
    lock_on: Optional[str] = None
    paid_at: Optional[datetime] = None
    paid_by_name: Optional[str] = None
    payment_txn_id: Optional[str] = None
    payment_reference: Optional[str] = None
    paid_amount_paise: Optional[int] = None
    note: Optional[str] = None
    updated_at: datetime

    @classmethod
    def from_model(cls, p: Payslip,
                   disputed: Optional[set[str]] = None,
                   windows: Optional[dict[str, str]] = None) -> "PayslipOut":
        """One payslip. `disputed` is the set of employees with an open
        correction request for the month and `windows` maps a month to the date
        it locks itself -- BOTH resolved by the caller, once for a whole list
        rather than once per row.

        Blockers and the lock date are only meaningful on a DRAFT: a finalised
        payslip has already cleared them, and re-listing them beside a locked
        figure would read as "this is wrong" rather than "this is not ready".
        """
        from app.services import payroll as _payroll

        draft = p.status == PayslipStatus.DRAFT
        blockers = (_payroll.blockers_for(p, disputed=disputed or set())
                    if draft else [])
        return cls(
            id=str(p.id), blockers=blockers,
            lock_on=(windows or {}).get(p.month) if draft else None,
            lines=[PayslipLineOut(**line.model_dump()) for line in p.lines],
            **{k: getattr(p, k) for k in (
                "code", "user_id", "user_name", "user_code", "designation",
                "month", "monthly_salary_paise", "per_day_paise",
                "days_divisor", "calendar_days", "present_days", "wfh_days",
                "half_days", "absent_days", "paid_leave_days",
                "unpaid_leave_days", "week_off_days", "holiday_days",
                "not_marked_days", "late_marks", "late_penalty_days",
                "pre_joining_days", "worked_minutes", "payable_days",
                "unresolved_days", "lop_days", "deduction_paise",
                "adjustment_paise", "adjustment_note", "net_payable_paise",
                "status", "generated_at", "generated_by_name", "finalised_at",
                "finalised_by_name", "auto_finalised", "paid_at",
                "paid_by_name", "payment_txn_id", "payment_reference",
                "paid_amount_paise", "note", "updated_at")})


class PayRunBlocker(BaseModel):
    """One person the month is waiting on, and why.

    A NAME AND A REASON, never a count. "3 employees are blocked" sends somebody
    hunting through thirty rows; "Asha (no salary on record)" is a to-do item.
    The reasons are the same strings the automatic job refuses to lock on, so
    the screen cannot promise something the job will not do.
    """

    payslip_id: str
    user_id: str
    name: str
    reasons: list[str] = Field(default_factory=list)


class PayRunTotals(BaseModel):
    """What a month costs, and what is still in the way of paying it.

    `blocked` is the part that earns this object. A pay run is a screen somebody
    opens once a month under time pressure, and the things that ruin it -- an
    employee with no salary on record, a register with unresolved days, a
    correction request nobody has decided -- are all invisible unless named
    here.
    """

    month: str
    employees: int = 0
    payslips: int = 0
    draft: int = 0
    finalised: int = 0
    paid: int = 0
    gross_paise: int = 0
    deduction_paise: int = 0
    net_paise: int = 0
    # Still owed to people: finalised but not yet paid.
    outstanding_paise: int = 0
    missing_salary: list[str] = Field(default_factory=list)
    unresolved_people: list[str] = Field(default_factory=list)

    # --- The correction window (owner 2026-09-06) ---
    #
    # The date this month's drafts lock themselves, and the buffer that produced
    # it. `None` means automatic locking is switched off and the month waits for
    # somebody to press Finalise -- which is a real configuration, not an error,
    # so the screen says so rather than showing a blank where a date goes.
    auto_finalise_days: int = 0
    auto_finalise_on: Optional[str] = None
    # Drafts that WILL lock when the window closes, and the ones that will not.
    ready: int = 0
    blocked: list[PayRunBlocker] = Field(default_factory=list)


class PayRunOut(BaseModel):
    totals: PayRunTotals
    rows: list[PayslipOut] = Field(default_factory=list)


class GenerateIn(BaseModel):
    month: Optional[str] = None
    # Recompute an existing DRAFT from the register. Never touches a finalised
    # or paid payslip -- see services/payroll.generate_for.
    regenerate: bool = False
    # One person, or the whole agency when absent.
    user_id: Optional[str] = None


class AdjustIn(BaseModel):
    """A manual correction to one payslip, with its reason.

    The reason is MANDATORY and that is the point of the object. A computed
    deduction can be traced to a day on the register; a hand-typed adjustment
    can be traced to nothing at all unless somebody wrote down why, and this is
    the number an employee will ask about first.
    """

    amount_paise: int
    note: str = Field(min_length=3, max_length=300)

    @field_validator("note")
    @classmethod
    def _real_reason(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Say why this payslip is being adjusted.")
        return v.strip()


class FinaliseIn(BaseModel):
    month: str
    # Finalise everybody, or a named few. The pay desk usually does the month;
    # the list exists for the person whose correction landed late.
    payslip_ids: list[str] = Field(default_factory=list)


class MarkPaidIn(BaseModel):
    """Record that a payslip has actually been paid.

    `bank_account_id` and `idempotency_key` are here because paying a payslip
    POSTS A REAL EXPENSE through `finance._post_expense` -- the same function
    every other expense goes through. Nothing in the payroll module writes a
    ledger row itself; it fills in that function's payload and calls it.
    """

    bank_account_id: Optional[str] = None
    reference: Optional[str] = None
    occurred_at: Optional[datetime] = None
    # Defaults to the payslip's own net. Overridable for the genuine part
    # payment, which is why the payslip stores what was actually paid rather
    # than assuming it equals the net.
    amount_paise: Optional[int] = Field(default=None, gt=0)
    idempotency_key: Optional[str] = None
    # Tell the employee. On by default: the owner's own words were "when the
    # salary is processed and the owner adds it in the transactions, at that
    # time we can notify the employee that yes, so-and-so salary is received".
    notify: bool = True


class MyPayslipSummary(BaseModel):
    """The strip on an employee's own dashboard / HR tab.

    Deliberately the LAST payslip and the count, not a list. Somebody checking
    their own pay wants one number and a way in; the history is one click away
    and does not belong on a dashboard tile.
    """

    latest: Optional[PayslipOut] = None
    total: int = 0
    unpaid: int = 0


class PayslipStatusValues(BaseModel):
    """Served so the client's filter and the server's states cannot drift."""

    values: list[str] = Field(default_factory=lambda: [
        PayslipStatus.DRAFT, PayslipStatus.FINALISED, PayslipStatus.PAID,
        PayslipStatus.CANCELLED])
