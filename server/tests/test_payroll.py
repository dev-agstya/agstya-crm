"""The pay calculation, and the rules that decide what a month costs.

The whole module builds towards one number — `net_payable_paise` — and that
number is what the agency actually transfers. So these tests pin the ARITHMETIC
rather than the plumbing, and they do it against the owner's own worked example
so a future change that "simplifies" the divisor fails loudly:

    "if the salary of an employee is 15,000 rupees, that means per day cost is
    500 rupees. So now if it is a month of 31 days and he takes two days off,
    then we are going to deduct 1,000 rupees. And if it is a month of 28 days
    and still he takes two leaves, then we will deduct 1,000 only. So it should
    be based on per day salary only. And if he has leave balance, then we will
    not deduct this."

Four claims live in that paragraph, and each one is a test below:
  1. Rs 15,000 -> Rs 500 a day.
  2. Two absences cost Rs 1,000 in a 31-day month.
  3. Two absences cost Rs 1,000 in a 28-day month TOO — the divisor is a
     constant, not the month's length.
  4. Leave the balance covered costs NOTHING.

Everything is a pure function over data, which is why it is testable without a
database: `payroll.compute()` takes the day list and the summary
`hr_attendance` already produces and returns plain figures.
"""

from __future__ import annotations

import inspect
from datetime import date

import pytest

from app.core.enums import AttendanceStatus
from app.models.payslip import PAYROLL_DAYS_PER_MONTH, PayslipStatus
from app.models.settings import HrSettings
from app.models.user import User, EmployeeProfile
from app.services import hr_attendance, hr_calendar as cal, payroll


RS = 100  # paise in a rupee, so the numbers below read as the owner said them


def hr(**kw) -> HrSettings:
    return HrSettings(**kw)


def employee(salary_rs: int = 15_000, joined: date | None = None) -> User:
    """An employee with a salary and nothing else that matters here.

    `model_construct` because a Beanie Document's __init__ reaches for its motor
    collection and none of these tests want a database — the same approach
    test_hr_attendance takes with AttendanceDay.
    """
    return User.model_construct(
        full_name="Asha", code="USR-1",
        employee_profile=EmployeeProfile(
            monthly_salary_paise=salary_rs * RS, date_of_joining=joined))


def views(month: str, statuses: dict[int, str], *,
          week_off_days=(6,)) -> list:
    """A month of `DayView`s: every day PRESENT unless `statuses` says otherwise.

    Built through the real `DayView` so `summarise()` — the function payroll
    actually reads — is the one under test rather than a dict shaped like its
    output.
    """
    import calendar

    year, mon = (int(x) for x in month.split("-"))
    last = calendar.monthrange(year, mon)[1]
    out = []
    for n in range(1, last + 1):
        d = date(year, mon, n)
        status = statuses.get(n)
        if status is None:
            status = (AttendanceStatus.WEEK_OFF.value
                      if d.weekday() in week_off_days
                      else AttendanceStatus.PRESENT.value)
        out.append(hr_attendance.DayView(
            day=d.isoformat(), weekday=d.weekday(), status=status,
            worked_minutes=480 if status == AttendanceStatus.PRESENT.value
            else 0,
            break_minutes=0, is_late=False, late_minutes=0,
            is_early_out=False, early_out_minutes=0, missed_punch_out=False,
            is_future=False, leave_worked=False))
    return out


def run(user: User, month: str, statuses: dict[int, str], *,
        settings: HrSettings | None = None) -> dict:
    settings = settings or hr()
    days = views(month, statuses)
    summary = hr_attendance.summarise(days, settings)
    return payroll.compute(user, days, summary, settings)


# =============================================================================
# 1. The per-day rate
# =============================================================================


def test_the_owners_worked_example():
    """Rs 15,000 a month is Rs 500 a day. Stated by the owner, in those words."""
    assert payroll.per_day_paise(15_000 * RS) == 500 * RS


def test_the_divisor_is_a_constant_thirty():
    """NOT the month's length, and this is the load-bearing decision.

    15,000/28 is 535.71 and 15,000/31 is 483.87. Either would make the same
    absence cost a different amount depending on which month it fell in, which
    is exactly what the owner's example rules out.
    """
    assert PAYROLL_DAYS_PER_MONTH == 30


def test_the_rate_rounds_half_up_not_bankers():
    """`Decimal.quantize` defaults to ROUND_HALF_EVEN, under which exactly half
    a paisa goes DOWN on an even boundary and UP on an odd one. Right for
    statistics, wrong for money."""
    # 15 paise / 30 would be 0.5 exactly -> 1 under half-up, 0 under bankers'.
    assert payroll.per_day_paise(15, divisor=30) == 1


def test_no_salary_on_record_is_a_zero_rate_not_a_crash():
    """An employee whose salary nobody has entered still has a month. The
    payslip comes out at zero and SAYS so; refusing to produce one would read
    as "we forgot you"."""
    assert payroll.per_day_paise(0) == 0
    assert payroll.salary_of(User.model_construct(employee_profile=None)) == 0


# =============================================================================
# 2 + 3. The same absence costs the same in every month
# =============================================================================


def test_two_absences_cost_one_thousand_in_a_31_day_month():
    out = run(employee(), "2026-08", {
        3: AttendanceStatus.ABSENT.value,
        4: AttendanceStatus.ABSENT.value,
    })
    assert out["lop_days"] == 2
    assert out["deduction_paise"] == 1_000 * RS
    assert out["net_payable_paise"] == 14_000 * RS


def test_two_absences_cost_one_thousand_in_a_28_day_month_too():
    """The owner's second sentence, and the reason the divisor is fixed. If this
    ever fails, somebody has divided by the month's length."""
    out = run(employee(), "2027-02", {
        3: AttendanceStatus.ABSENT.value,
        4: AttendanceStatus.ABSENT.value,
    })
    assert out["deduction_paise"] == 1_000 * RS
    assert out["net_payable_paise"] == 14_000 * RS


def test_a_perfect_month_pays_the_full_salary_whatever_its_length():
    """The other half of the fixed divisor, and the easier one to get wrong.

    The divisor prices the DEDUCTION; it does not rebuild the salary. A perfect
    31-day month is 15,000, not 31 x 500 = 15,500, and a perfect February is
    15,000, not 28 x 500 = 14,000.
    """
    for month in ("2026-08", "2027-02", "2026-09"):
        out = run(employee(), month, {})
        assert out["deduction_paise"] == 0, month
        assert out["net_payable_paise"] == 15_000 * RS, month


# =============================================================================
# 4. Paid leave costs nothing; unpaid leave does
# =============================================================================


def test_leave_covered_by_the_balance_is_not_deducted():
    """"If he has leave balance, then we will not deduct this" (owner).

    ON_LEAVE is what `build_month` produces when the approved leave's
    `paid_days` covered it — the split was decided at approval and frozen there,
    so a payslip can never re-decide it against a balance that has since moved.
    """
    out = run(employee(), "2026-08", {
        5: AttendanceStatus.ON_LEAVE.value,
        6: AttendanceStatus.ON_LEAVE.value,
    })
    assert out["paid_leave_days"] == 2
    assert out["lop_days"] == 0
    assert out["net_payable_paise"] == 15_000 * RS


def test_leave_beyond_the_balance_is_deducted():
    out = run(employee(), "2026-08", {
        5: AttendanceStatus.LEAVE_UNPAID.value,
        6: AttendanceStatus.LEAVE_UNPAID.value,
    })
    assert out["unpaid_leave_days"] == 2
    assert out["deduction_paise"] == 1_000 * RS


def test_a_half_day_costs_half_a_day():
    out = run(employee(), "2026-08", {7: AttendanceStatus.HALF_DAY.value})
    assert out["lop_days"] == 0.5
    assert out["deduction_paise"] == 250 * RS


def test_week_offs_and_holidays_cost_nothing():
    """They are inside the monthly salary by definition. If a Sunday ever
    deducted, a month with five of them would pay less than one with four —
    which nobody has ever agreed to in any employment contract."""
    out = run(employee(), "2026-08", {
        15: AttendanceStatus.HOLIDAY.value,
        16: AttendanceStatus.HOLIDAY.value,
    })
    assert out["lop_days"] == 0
    assert out["net_payable_paise"] == 15_000 * RS


# =============================================================================
# What is deliberately NOT deducted
# =============================================================================


def test_an_unresolved_day_is_counted_but_never_deducted():
    """NOT_MARKED is "we have not been told", not "they did not come".

    A missed punch-out waiting for a correction must not cost somebody a day
    that a week later comes back — a pay figure that quietly reverses itself is
    the one thing this feature cannot do. It is REPORTED instead, so the pay run
    can say "look at this before you finalise".
    """
    out = run(employee(), "2026-08", {
        10: AttendanceStatus.NOT_MARKED.value,
        11: AttendanceStatus.NOT_MARKED.value,
    })
    assert out["not_marked_days"] == 2
    assert out["unresolved_days"] == 2
    assert out["lop_days"] == 0
    assert out["net_payable_paise"] == 15_000 * RS


def test_days_before_joining_are_deducted_as_their_own_line():
    """Somebody who started on the 25th is not paid for the whole month.

    Deducted, but NEVER folded into "absent": being new is not an absence, and
    a payslip that read as though it were would be the first thing a new joiner
    ever saw from the agency.
    """
    out = run(employee(joined=date(2026, 8, 25)), "2026-08", {})
    assert out["absent_days"] == 0
    assert out["pre_joining_days"] > 0
    labels = {line.label for line in out["lines"]}
    assert "Before joining" in labels
    assert "Absent" not in labels
    assert out["net_payable_paise"] < 15_000 * RS


def test_a_sunday_before_joining_is_not_charged():
    """Only WORKING days before the joining date count. A Sunday was never going
    to be worked, and charging for it would deduct more than the month holds."""
    august = run(employee(joined=date(2026, 8, 25)), "2026-08", {})
    # 1-24 Aug 2026 holds three Sundays (2nd, 9th, 16th, 23rd -> four).
    assert august["pre_joining_days"] == 24 - 4


# =============================================================================
# Late marks
# =============================================================================


def test_late_marks_cost_what_the_settings_say_and_nothing_more():
    """Three lates cost half a day (the existing HR rule). Payroll multiplies
    the DAY COUNT the register already produced — it has no late rule of its
    own, which is why changing the policy changes both screens at once."""
    days = views("2026-08", {})
    for n in (0, 1, 2):        # three late marks
        days[n].is_late = True
    settings = hr()
    summary = hr_attendance.summarise(days, settings)
    out = payroll.compute(employee(), days, summary, settings)
    assert summary["late_penalty_days"] == 0.5
    assert out["deduction_paise"] == 250 * RS


# =============================================================================
# The shape of the payslip
# =============================================================================


def test_the_breakdown_explains_the_figure():
    """Every deduction is a NAMED LINE with a day count, because the owner asked
    for "a detailed payslip... total payable amount based on total attendance,
    attended days, total leaves taken". A net figure with no rows is a number an
    employee has to take on trust."""
    out = run(employee(), "2026-08", {
        3: AttendanceStatus.ABSENT.value,
        5: AttendanceStatus.LEAVE_UNPAID.value,
        7: AttendanceStatus.HALF_DAY.value,
    })
    labels = [line.label for line in out["lines"]]
    assert labels[0] == "Monthly salary"
    assert {"Absent", "Unpaid leave", "Half days"} <= set(labels)
    # The lines add up to the net, which is what makes them a breakdown rather
    # than a decoration.
    assert sum(line.amount_paise for line in out["lines"]) \
        == out["net_payable_paise"]


def test_nil_deductions_are_not_listed():
    """A payslip listing five kinds of deduction all reading nil is one nobody
    scans. The rows that are there are the ones that explain the figure."""
    out = run(employee(), "2026-08", {})
    assert [line.label for line in out["lines"]] == ["Monthly salary"]


def test_the_deduction_can_never_exceed_the_salary():
    """A register that somehow produced 40 loss-of-pay days in a 31-day month is
    a bug, and a NEGATIVE payslip would be that bug arriving as a demand for
    money from the employee."""
    out = run(employee(), "2026-08",
              {n: AttendanceStatus.ABSENT.value for n in range(1, 32)})
    assert out["deduction_paise"] <= 15_000 * RS
    assert out["net_payable_paise"] == 0


# =============================================================================
# Adjustments
# =============================================================================


def test_the_net_is_always_salary_minus_deduction_plus_adjustment():
    """One assembly point (`apply_adjustment`), so a call site that forgets a
    term cannot leave the headline saying something the parts do not."""
    from app.models.payslip import Payslip

    slip = Payslip.model_construct(
        monthly_salary_paise=15_000 * RS, deduction_paise=1_000 * RS,
        adjustment_paise=500 * RS, net_payable_paise=0)
    payroll.apply_adjustment(slip)
    assert slip.net_payable_paise == 14_500 * RS


def test_an_adjustment_cannot_drive_the_net_below_zero():
    from app.models.payslip import Payslip

    slip = Payslip.model_construct(
        monthly_salary_paise=15_000 * RS, deduction_paise=0,
        adjustment_paise=-20_000 * RS, net_payable_paise=0)
    payroll.apply_adjustment(slip)
    assert slip.net_payable_paise == 0


# =============================================================================
# The month the job runs for
# =============================================================================


def test_the_scheduled_run_generates_LAST_month():
    """"On first of each month, previous month's salary should be calculated"
    (owner). Generating the CURRENT month on the 1st would produce a payslip for
    a month that has not happened."""
    from datetime import datetime, timezone

    assert payroll.previous_month(
        datetime(2026, 9, 1, 3, 0, tzinfo=timezone.utc)) == "2026-08"
    # A January run rolls the year back, which is the case a naive
    # `month - 1` gets wrong.
    assert payroll.previous_month(
        datetime(2027, 1, 1, 6, 0, tzinfo=timezone.utc)) == "2026-12"


def test_the_month_boundary_is_IST():
    """0:30 IST on 1 September is 19:00 UTC on 31 August. Asking the UTC date
    would generate July's payslips instead of August's, in the half-hour after
    midnight when a cron on a UTC box is most likely to fire."""
    from datetime import datetime, timezone

    just_after_ist_midnight = datetime(2026, 8, 31, 19, 30, tzinfo=timezone.utc)
    assert payroll.previous_month(just_after_ist_midnight) == "2026-08"


# =============================================================================
# A payslip is a SNAPSHOT
# =============================================================================


def test_a_locked_payslip_is_never_recomputed():
    """Finalised means somebody read the figure and committed to it; paid means
    money moved. Regenerating either would rewrite the amount a payment was made
    against, and that payment would then reconcile against nothing."""
    from app.models.payslip import Payslip

    for status in (PayslipStatus.FINALISED, PayslipStatus.PAID):
        slip = Payslip.model_construct(status=status)
        assert slip.is_locked, status
    for status in (PayslipStatus.DRAFT, PayslipStatus.CANCELLED):
        assert not Payslip.model_construct(status=status).is_locked, status


def test_generate_for_refuses_to_touch_a_locked_payslip():
    """Asserted against the SOURCE rather than by running it, because the guard
    is the first thing in the function and running it needs a database. The
    point is that the branch exists and returns before any recompute."""
    source = inspect.getsource(payroll.generate_for)
    assert "is_locked" in source
    body = source[source.index("if existing is not None"):]
    assert body.index("is_locked") < body.index("build_for")


def test_the_snapshot_carries_the_attendance_that_produced_it():
    """Every count is copied onto the document. A payslip that re-derived itself
    would change when the register was corrected in November, and August's
    figure would silently stop matching the payment made against it."""
    from app.models.payslip import Payslip

    out = run(employee(), "2026-08", {3: AttendanceStatus.ABSENT.value})
    for field in ("calendar_days", "present_days", "absent_days",
                  "paid_leave_days", "unpaid_leave_days", "half_days",
                  "late_marks", "payable_days", "per_day_paise",
                  "monthly_salary_paise"):
        assert field in out, field
        assert field in Payslip.model_fields, field


# =============================================================================
# The API surface
# =============================================================================
#
# Payroll is the one part of Workplace HR that carries money, so where its
# boundaries sit matters more than usual. These pin the three that fail
# silently: who may read whose payslip, that paying goes through the shared
# expense path, and that the monthly job cannot double-pay.


def test_everybody_reaches_their_own_payslip_with_no_flag():
    """The rule attendance, leave and targets already follow — and the clearest
    case of it in the app. `view_payslips` opens somebody ELSE'S.

    `_target_user` is the ONLY place in the router a `user_id` parameter becomes
    a user. Reading a request parameter and trusting it is how "employees see
    their own" becomes "employees see everybody's salary" by way of a URL
    somebody edited.
    """
    import app.routers.payslips as r

    src = inspect.getsource(r._target_user)
    assert "user_id == str(actor.id)" in src
    assert "VIEW_PAYSLIPS" in src
    # And the read of somebody else's single payslip is a 404, not a 403 — a 403
    # confirms a payslip exists for that person in that month, which is itself a
    # fact about their employment.
    assert "HTTP_404_NOT_FOUND" in inspect.getsource(r._load)


def test_the_pay_run_is_the_only_thing_that_needs_the_flag():
    """`GET /` with no `user_id` and no `month` is MY OWN history — the safe
    answer a client that forgets a parameter should land on."""
    import app.routers.payslips as r

    src = inspect.getsource(r.list_payslips)
    assert "if user_id or not month" in src
    # Asking for a whole month across the agency narrows to the caller rather
    # than 403ing, because the same endpoint legitimately serves both.
    assert 'query["user_id"] = str(actor.id)' in src


def test_a_payslip_cannot_be_paid_before_it_is_finalised():
    """The figure being paid has to be the figure on record. Paying a DRAFT
    would post an expense against a number the next regeneration can move."""
    import app.routers.payslips as r

    src = inspect.getsource(r.mark_paid)
    assert "PayslipStatus.DRAFT" in src
    assert "Finalise this payslip before paying it" in src


def test_a_paid_payslip_cannot_be_reopened():
    """Money has moved; the payslip is now the record of what was paid. Editing
    it would make the ledger and the payslip disagree about the same transfer,
    and the fix for a wrong payment is a correcting transaction."""
    import app.routers.payslips as r

    assert "has been paid" in inspect.getsource(r.reopen)


def test_finalising_skips_an_employee_with_no_salary():
    """Locking a zero would publish "you are owed nothing" to somebody whose
    record simply has not been filled in."""
    import app.routers.payslips as r

    assert "monthly_salary_paise <= 0" in inspect.getsource(r.finalise)


def test_a_cancelled_payslip_is_not_deleted():
    """A payslip that existed and was withdrawn is a fact somebody will ask
    about. It also keeps the unique (user, month) index honest — deleting the
    document would let the monthly job silently generate a replacement the next
    morning, which is exactly what cancelling it was meant to prevent."""
    import app.routers.payslips as r

    src = inspect.getsource(r.cancel_payslip)
    assert "PayslipStatus.CANCELLED" in src
    assert ".delete()" not in src


def test_the_monthly_job_never_regenerates_on_its_own():
    """A draft sitting there since the 1st has possibly been adjusted by a
    person. Overwriting it every morning would undo that quietly — so the
    scheduled run creates and never rebuilds, and regeneration is an explicit
    action on the pay-run screen."""
    assert "regenerate=False" in inspect.getsource(payroll.run_monthly)


def test_the_daily_job_generates_payslips_last():
    """It reads the register that step 1 has just finished closing, so running
    it before the auto-close would compute a month whose final day was still
    open. Being last also means a failure here cannot stop the leave accrual."""
    import app.services.hr_daily as hr_daily

    src = inspect.getsource(hr_daily.run_daily)
    assert src.index("auto_close_open_days") < src.index("payroll.run_monthly")
    assert src.index("accrue_month") < src.index("payroll.run_monthly")
    # Wrapped on its own, like every other step.
    tail = src[src.index("payroll.run_monthly"):]
    assert "except Exception" in tail


def test_the_cron_registers_the_payslip_model():
    """`send_reminders.py` runs `hr_daily` outside the app, with its OWN beanie
    init. A model missing from that list raises on the first read — and the step
    is wrapped, so the failure is caught and logged and it looks like "payroll
    simply never runs" with no error anybody sees.

    This is the same trap the HR module already hit once: `SystemSettings` had
    to be added to that list for the accrual to work at all.
    """
    import pathlib

    cron = pathlib.Path(__file__).resolve().parents[1] / "send_reminders.py"
    text = cron.read_text(encoding="utf-8")
    assert "from app.models.payslip import Payslip" in text
    # And in the document_models list, not merely imported.
    assert "Payslip," in text.split("document_models=[")[1].split("]")[0]


# =============================================================================
# The correction window (owner 2026-09-06)
# =============================================================================
#
# "We will also give one two days buffer for the admin or the owner or the
# managers to check the attendance or make any corrections if required, so that
# their salaries are calculated automatically and correctly."
#
# The window has to do two things or it is theatre: hold the lock open, AND
# re-read the register when it closes. The second is the one a reader is likely
# to drop as an optimisation, so it is pinned hardest.


@pytest.fixture
def no_holidays(monkeypatch):
    """A calendar with no declared holidays, so the window maths is only about
    week offs. Holidays get their own test below."""
    async def _none(start, end):
        return {}
    monkeypatch.setattr(cal, "holiday_map", _none)


@pytest.mark.asyncio
async def test_the_window_is_working_days_after_the_month_ends(no_holidays):
    """August 2026 ends on Monday the 31st. With a 2-day window the register
    stays open Tue 1 and Wed 2 September, and the drafts lock on Thu 3.

    The buffer is a promise that somebody gets a chance to look, so it is
    counted in days the office is actually open.
    """
    due = await payroll.auto_finalise_on("2026-08",
                                         hr(payroll_auto_finalise_days=2))
    assert due == date(2026, 9, 3)


@pytest.mark.asyncio
async def test_a_week_off_does_not_burn_a_day_of_the_window(no_holidays):
    """May 2026 ends on a Sunday, so June opens Mon 1. With Sunday off, a
    2-day window runs Mon 1 and Tue 2 and locks on Wed 3.

    And the case that decides working-vs-calendar: a month ending on a FRIDAY.
    October 2026 ends Sat 31; a two-CALENDAR-day buffer would lock on Monday
    having spent Sunday offering nobody anything.
    """
    two = hr(payroll_auto_finalise_days=2)
    assert await payroll.auto_finalise_on("2026-05", two) == date(2026, 6, 3)

    # January 2027 starts on a Friday. Window = Fri 1, Sat 2 (a working day
    # here — the agency works Monday to Saturday); Sunday 3 is skipped
    # entirely, so the lock lands on Monday 4 rather than on the Sunday.
    assert await payroll.auto_finalise_on("2026-12", two) == date(2027, 1, 4)


@pytest.mark.asyncio
async def test_a_declared_holiday_pushes_the_lock_out(monkeypatch):
    """A holiday is not a chance to check the register either. Declaring one
    inside the window moves the lock, with no backfill and nothing to re-run —
    the date is derived, exactly like every attendance status."""
    async def _diwali(start, end):
        return {"2026-09-02": "Diwali"}
    monkeypatch.setattr(cal, "holiday_map", _diwali)

    due = await payroll.auto_finalise_on("2026-08",
                                         hr(payroll_auto_finalise_days=2))
    # Window = Tue 1 and Thu 3 (Wed 2 is the holiday), so the lock is Fri 4.
    assert due == date(2026, 9, 4)


@pytest.mark.asyncio
async def test_zero_switches_automatic_locking_off(no_holidays):
    """The owner's escape hatch. A month somebody wants to go through by hand
    is a real configuration, not a failure — so it returns None rather than a
    date in the past, and every caller reads that as "nothing locks itself"."""
    assert await payroll.auto_finalise_on(
        "2026-08", hr(payroll_auto_finalise_days=0)) is None


@pytest.mark.asyncio
async def test_the_job_waits_until_the_window_closes(monkeypatch, no_holidays):
    """On the 2nd, with the lock due on the 3rd, the job must write nothing.

    Asserted by watching for the QUERY rather than by mocking a result: a job
    that "did nothing" because it crashed and one that did nothing because it
    was not due yet look identical from the outside otherwise.
    """
    from datetime import datetime, timezone

    called = []
    monkeypatch.setattr(payroll.Payslip, "find",
                        lambda *a, **k: called.append(a) or _never())

    out = await payroll.run_auto_finalise(
        hr(payroll_auto_finalise_days=2),
        now=datetime(2026, 9, 2, 3, 0, tzinfo=timezone.utc))

    assert out["status"] == "waiting"
    assert out["due"] == "2026-09-03"
    assert called == [], "it looked for drafts before the window had closed"


def _never():  # pragma: no cover -- the assertion above is the point
    raise AssertionError("Payslip.find must not run before the window closes")


# --- What it refuses to lock -----------------------------------------------------


def test_no_salary_on_record_blocks_the_automatic_lock():
    """Locking a zero would publish "you are owed nothing" to somebody whose
    record simply has not been filled in. The manual `finalise` already skips
    these; the job refuses them for the same reason."""
    from app.models.payslip import Payslip

    slip = Payslip.model_construct(monthly_salary_paise=0, unresolved_days=0,
                                   user_id="u1")
    assert payroll.blockers_for(slip, disputed=set()) == ["no salary on record"]


def test_an_unsettled_register_blocks_the_automatic_lock():
    """The figure will MOVE once the missing days are explained, and a payslip
    that changes after somebody was told it was final is the one thing a pay
    figure must never do."""
    from app.models.payslip import Payslip

    slip = Payslip.model_construct(monthly_salary_paise=1_500_000,
                                   unresolved_days=2, user_id="u1")
    reasons = payroll.blockers_for(slip, disputed=set())
    assert reasons == ["2 unresolved days on the register"]

    one = Payslip.model_construct(monthly_salary_paise=1_500_000,
                                  unresolved_days=1, user_id="u1")
    # Reads as a sentence at 1 as well as at 2 — these are shown to a person.
    assert payroll.blockers_for(one, disputed=set()) == [
        "1 unresolved day on the register"]


def test_a_pending_correction_blocks_the_automatic_lock():
    """THE BLOCKER `unresolved_days` CANNOT SEE, and the reason this check
    exists at all: a day marked ABSENT that somebody has filed "I was actually
    here" against is not unresolved — it has a definite status, and that status
    is exactly what is being argued about. Locking pay over a dispute already
    raised is the scenario the window exists to prevent."""
    from app.models.payslip import Payslip

    slip = Payslip.model_construct(monthly_salary_paise=1_500_000,
                                   unresolved_days=0, user_id="u1")
    assert payroll.blockers_for(slip, disputed=set()) == []
    assert payroll.blockers_for(slip, disputed={"u1"}) == [
        "a correction request is waiting"]


def test_a_clean_month_locks_itself():
    """The whole point. A salary on record, a settled register and nothing
    disputed means nobody has to press anything."""
    from app.models.payslip import Payslip

    slip = Payslip.model_construct(monthly_salary_paise=1_500_000,
                                   unresolved_days=0, user_id="u1")
    assert payroll.blockers_for(slip, disputed=set()) == []


def test_a_blocked_payslip_is_left_as_a_draft_never_forced():
    """`continue`, never a lock. An unfinished payslip is late; a wrongly
    locked one is a payment made against a figure nobody checked — and since
    NOT_MARKED days are never deducted, leaving it as a draft cannot produce a
    wrong number."""
    source = inspect.getsource(payroll.run_auto_finalise)
    blocked = source[source.index("if reasons:"):]
    assert "continue" in blocked
    assert blocked.index("continue") < blocked.index("await lock(")


# --- The half that makes the window mean anything --------------------------------


def test_the_register_is_RE_READ_before_anything_locks():
    """THE LOAD-BEARING ONE.

    `generate_for` deliberately does not recompute an existing draft, so a
    correction approved on the 2nd is saved, visible on the Attendance page, and
    ABSENT from the payslip that locks on the 3rd. Without this regenerate the
    buffer would be pure theatre: the corrections it exists to collect would not
    reach the figure.
    """
    source = inspect.getsource(payroll.run_auto_finalise)
    assert "regenerate=True" in source
    # And BEFORE the lock, not after it — the order is the whole claim.
    assert source.index("regenerate=True") < source.index("await lock(")


def test_a_manual_adjustment_survives_the_windows_regenerate():
    """The one number on a payslip a human put there. The automatic re-read
    runs through `generate_for`, which re-applies it — so automation cannot
    silently overrule a person's decision on the way past."""
    source = inspect.getsource(payroll.generate_for)
    assert "apply_adjustment" in source


def test_locking_goes_through_ONE_function():
    """The pay desk's button and the scheduled job must tell an employee the
    same thing about the same event — the notification names a FIGURE, and a
    payslip announced as one amount and paid as another is the worst bug this
    feature can have. So the router sets no status of its own."""
    import app.routers.payslips as r

    finalise = inspect.getsource(r.finalise)
    assert "payroll.lock(" in finalise
    assert "PayslipStatus.FINALISED" not in finalise.split("query")[1]

    locker = inspect.getsource(payroll.lock)
    assert "PayslipStatus.FINALISED" in locker
    assert "create_notification" in locker


def test_an_automatic_lock_says_it_was_automatic():
    """"Who decided this?" is the first thing anybody asks about a pay figure,
    and after this feature most payslips are locked by a job. `auto_finalised`
    is its own field rather than being inferred from a missing name, because
    "nobody finalised this" and "the window closed" are different answers."""
    source = inspect.getsource(payroll.lock)
    assert "auto_finalised = automatic" in source
    assert "run_auto_finalise" and "automatic=True" in inspect.getsource(
        payroll.run_auto_finalise)


# --- Running it, and running it again --------------------------------------------


def test_the_daily_job_locks_AFTER_it_generates():
    """It locks the drafts step 5 has just written, and on the morning a window
    closes both run in the same pass. Wrapped on its own like every other step,
    so a failure here cannot stop the leave accrual."""
    import app.services.hr_daily as hr_daily

    src = inspect.getsource(hr_daily.run_daily)
    assert src.index("payroll.run_monthly") < src.index(
        "payroll.run_auto_finalise")
    tail = src[src.index("payroll.run_auto_finalise"):]
    assert "except Exception" in tail


def test_one_bad_payslip_cannot_stop_the_other_twenty_nine():
    """A pay run that half-ran and stopped is worse than one that reported what
    it could not do: the people after the failure would silently not be paid."""
    source = inspect.getsource(payroll.run_auto_finalise)
    assert "except Exception" in source
    assert "log.exception" in source


def test_the_stuck_month_notice_is_sent_ONCE_not_every_morning():
    """A payslip left blocked stays a DRAFT for ever, and this job retries it
    every morning. Without a guard, one unfilled salary would send the same bell
    thirty times and the category would stop being read — the same reasoning as
    the "you have not clocked in" nudge, and the same mechanism: ask the
    notification rows rather than keep a flag."""
    source = inspect.getsource(payroll._announce_window_closed)
    assert "already" in source
    assert "return 0" in source.split("if already")[1][:80]


def test_the_window_opening_is_announced_once_when_it_is_built():
    """A correction window nobody has been told about is a delay, not a window.
    `written` is what makes it once: every later run of the same month writes
    nothing, so no second bell can be sent and there is no flag to keep."""
    source = inspect.getsource(payroll.run_monthly)
    assert 'summary.get("written")' in source
    assert "_announce_window_open" in source

    notice = inspect.getsource(payroll._announce_window_open)
    # It says the DATE. "In two days" is read on Monday and acted on Wednesday.
    assert "due.strftime" in notice
    assert "MANAGE_PAYSLIPS" in notice


def test_the_pay_desk_is_told_and_not_the_owner_alone():
    """Every pay-desk person, not just the owner — the same rule the rest of
    the module notifies by. `notify_permission` resolves through
    `core.permissions.can` rather than the stored snapshot, which is what makes
    a NEW flag reach anybody at all."""
    for fn in (payroll._announce_window_open, payroll._announce_window_closed):
        assert "notify_permission" in inspect.getsource(fn)


def test_the_setting_can_actually_be_saved():
    """A field on `HrSettings` that `HrSettingsUpdate` does not declare is
    dropped silently: the PATCH returns 200, the body comes back full, and
    nothing changed. That exact failure has shipped twice in this module (the
    whole `partner_portal` block, then the geofence fields), so the pairing is
    asserted by name here as well as by the sweep in test_hr_module."""
    from app.schemas.hr import HrSettingsUpdate

    assert "payroll_auto_finalise_days" in HrSettings.model_fields
    assert "payroll_auto_finalise_days" in HrSettingsUpdate.model_fields
