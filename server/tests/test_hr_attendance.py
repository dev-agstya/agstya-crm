"""The attendance day's arithmetic, and the precedence rule that decides it.

These pin the two things that decide what a month says about a person: how long
they worked, and — when several facts could be true of the same Tuesday — which
one wins. Both are pure functions over data, which is why they are testable at
all; the whole reason `recompute` and `_view_for` exist as separate, callable
pieces is so the rules can be asserted without a database.

WHAT MUST NOT COME BACK, and is asserted below:
  * a day still running reading as ABSENT (it is NOT_MARKED — "we have not been
    told" and "they did not come" are different facts, and the second one costs
    somebody money)
  * a punch losing to approved leave (owner C10 — somebody who came in and
    worked was present, and the leave day goes back)
  * an unclosed break crediting time instead of costing it
  * a day before somebody joined counting as an absence
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app.core.enums import AttendanceStatus
from app.models.attendance import AttendanceDay, BreakInterval
from app.models.settings import HrSettings
from app.services import hr_attendance as svc
from app.services.finance_reports import IST


def ist(y, m, d, hh, mm=0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=IST)


def hr(**kw) -> HrSettings:
    return HrSettings(**kw)


def policy(settings: HrSettings | None = None) -> svc.DayPolicy:
    return svc.DayPolicy(settings or hr(), None)


def day(day_str="2026-08-13", **kw) -> AttendanceDay:
    """A Thursday, deliberately — never a Sunday, so the week-off rule is not
    silently doing the work in a test that is about something else.

    `model_construct` because a Beanie Document's __init__ reaches for its motor
    collection, and none of these tests want a database: the arithmetic under
    test is a pure function over the document's fields. Same approach
    test_team_targets already takes with Policy.
    """
    fields = dict(user_id="u1", user_name="", day=day_str, month=day_str[:7],
                  clock_in=None, clock_out=None, breaks=[], worked_minutes=0,
                  break_minutes=0, status=AttendanceStatus.NOT_MARKED.value,
                  is_late=False, late_minutes=0, is_early_out=False,
                  early_out_minutes=0, source="punch", missed_punch_out=False,
                  manual_status=None, note=None)
    fields.update(kw)
    return AttendanceDay.model_construct(**fields)


# =============================================================================
# recompute — the ONE definition of a day's minutes and status
# =============================================================================


def test_worked_time_is_out_minus_in_minus_breaks():
    d = day(clock_in=ist(2026, 8, 13, 10), clock_out=ist(2026, 8, 13, 19),
            breaks=[BreakInterval(start=ist(2026, 8, 13, 13),
                                  end=ist(2026, 8, 13, 14))])
    svc.recompute(d, policy())
    assert d.break_minutes == 60
    # Nine hours in the building, one hour of lunch, eight hours of work.
    assert d.worked_minutes == 480
    assert d.status == AttendanceStatus.PRESENT.value


def test_a_long_lunch_turns_a_full_day_into_a_half_day():
    """Owner B6: break time is subtracted and that is consequence enough — there
    is no separate punishment for a long break, because the day it produces is
    already the punishment."""
    d = day(clock_in=ist(2026, 8, 13, 10), clock_out=ist(2026, 8, 13, 19),
            breaks=[BreakInterval(start=ist(2026, 8, 13, 12),
                                  end=ist(2026, 8, 13, 17))])
    svc.recompute(d, policy())
    assert d.worked_minutes == 240
    assert d.status == AttendanceStatus.HALF_DAY.value


def test_a_short_day_is_absent_not_half():
    d = day(clock_in=ist(2026, 8, 13, 10), clock_out=ist(2026, 8, 13, 12))
    svc.recompute(d, policy())
    assert d.worked_minutes == 120
    assert d.status == AttendanceStatus.ABSENT.value


def test_a_day_still_running_is_never_absent():
    """THE ONE THAT WOULD BE ALARMING. At 11am a day has two hours on it, which
    is below every threshold — reading that as ABSENT would tell somebody they
    had failed to come to work while they were sitting at their desk."""
    d = day(clock_in=ist(2026, 8, 13, 10))
    svc.recompute(d, policy(), now=ist(2026, 8, 13, 11))
    assert d.clock_out is None
    assert d.status == AttendanceStatus.NOT_MARKED.value
    assert d.worked_minutes == 60


def test_an_open_break_counts_up_to_now():
    """So the figure on screen moves while somebody is actually on their break.
    The alternative — measuring only closed breaks — would show the break time
    jumping when they came back."""
    d = day(clock_in=ist(2026, 8, 13, 10),
            breaks=[BreakInterval(start=ist(2026, 8, 13, 13))])
    svc.recompute(d, policy(), now=ist(2026, 8, 13, 13, 30))
    assert d.break_minutes == 30
    assert d.worked_minutes == 180        # 10:00-13:30 minus 30 of break


def test_recompute_is_idempotent():
    d = day(clock_in=ist(2026, 8, 13, 10), clock_out=ist(2026, 8, 13, 19))
    svc.recompute(d, policy())
    first = (d.worked_minutes, d.status, d.break_minutes)
    svc.recompute(d, policy())
    svc.recompute(d, policy())
    assert (d.worked_minutes, d.status, d.break_minutes) == first


def test_recompute_never_overwrites_a_managers_decision():
    """An override is a decision a person made, and a recompute — triggered by a
    settings change, or by a corrected punch — is not entitled to overturn it."""
    d = day(clock_in=ist(2026, 8, 13, 10), clock_out=ist(2026, 8, 13, 11),
            manual_status=AttendanceStatus.PRESENT.value)
    svc.recompute(d, policy())
    assert d.status == AttendanceStatus.ABSENT.value       # what was punched
    assert d.manual_status == AttendanceStatus.PRESENT.value
    assert d.effective_status == AttendanceStatus.PRESENT.value


# =============================================================================
# Late marks and early outs
# =============================================================================


def test_the_grace_period_is_inclusive():
    on_time = day(clock_in=ist(2026, 8, 13, 10, 15),
                  clock_out=ist(2026, 8, 13, 19))
    svc.recompute(on_time, policy())
    assert on_time.is_late is False

    late = day(clock_in=ist(2026, 8, 13, 10, 16),
               clock_out=ist(2026, 8, 13, 19))
    svc.recompute(late, policy())
    assert late.is_late is True
    assert late.late_minutes == 16      # measured from the shift, not the grace


def test_arriving_early_is_never_negative_lateness():
    d = day(clock_in=ist(2026, 8, 13, 9), clock_out=ist(2026, 8, 13, 19))
    svc.recompute(d, policy())
    assert d.late_minutes == 0
    assert d.is_late is False


def test_leaving_early_is_flagged_but_the_day_can_still_be_full():
    """Owner B7: an early out costs nothing on its own. If leaving early made the
    day short, the half-day rule has already handled it — charging twice for one
    act is unfair."""
    d = day(clock_in=ist(2026, 8, 13, 8), clock_out=ist(2026, 8, 13, 17))
    svc.recompute(d, policy())
    assert d.is_early_out is True
    assert d.early_out_minutes == 120
    assert d.status == AttendanceStatus.PRESENT.value


def test_an_employees_own_shift_beats_the_agency_default():
    """Owner B8. The one part-timer who starts at 11 must not be marked late
    every single day."""
    class _Profile:
        shift_start, shift_end, monthly_leave_accrual = "11:00", "20:00", None

    p = svc.DayPolicy(hr(), _Profile())
    d = day(clock_in=ist(2026, 8, 13, 11), clock_out=ist(2026, 8, 13, 20))
    svc.recompute(d, p)
    assert d.is_late is False
    assert d.status == AttendanceStatus.PRESENT.value


# =============================================================================
# Precedence — which fact wins on one day
# =============================================================================


def view(d: date, rec=None, leave=None, holidays=None, *,
         today="2026-08-31", joined=None, settings=None):
    return svc._view_for(d, d.isoformat(), rec, leave, holidays or {},
                         policy(settings), today=today, joined=joined)


class _Leave:
    """The two fields `_view_for` reads off a leave. A real LeaveRequest needs a
    code and a database; the precedence rule only cares about these."""

    def __init__(self, paid=1.0, unpaid=0.0):
        self.id, self.code, self.reason_type = "L1", "LV-26AAAA", "sick"
        self.paid_days, self.unpaid_days = paid, unpaid


def test_a_holiday_beats_everything_including_a_punch():
    """A fact about the OFFICE outranks a fact about the person. Somebody who
    came in on Independence Day was not 'present' in the sense the register
    counts — the day was never deductible in the first place."""
    rec = day("2026-08-15", clock_in=ist(2026, 8, 15, 10),
              clock_out=ist(2026, 8, 15, 19))
    svc.recompute(rec, policy())
    v = view(date(2026, 8, 15), rec, None, {"2026-08-15": "Independence Day"})
    assert v.status == AttendanceStatus.HOLIDAY.value
    assert v.holiday_name == "Independence Day"


def test_a_sunday_is_a_week_off_with_no_record_at_all():
    v = view(date(2026, 8, 16))            # a Sunday
    assert v.status == AttendanceStatus.WEEK_OFF.value


def test_saturday_is_a_working_day():
    """The agency works Monday to Saturday (owner). A Saturday with nothing on
    it is an absence, not a week off — which is exactly the thing a default
    Mon-Fri calendar would get silently wrong."""
    v = view(date(2026, 8, 15 + 7))        # Saturday 22 Aug 2026
    assert date(2026, 8, 22).weekday() == 5
    assert v.status == AttendanceStatus.ABSENT.value


def test_a_managers_override_beats_a_punch():
    rec = day(clock_in=ist(2026, 8, 13, 10), clock_out=ist(2026, 8, 13, 11),
              manual_status=AttendanceStatus.WFH.value)
    svc.recompute(rec, policy())
    v = view(date(2026, 8, 13), rec)
    assert v.status == AttendanceStatus.WFH.value


def test_a_punch_beats_approved_leave_and_flags_the_refund():
    """OWNER C10, and the rule most likely to be 'simplified' away. Someone who
    came in and worked was present; the leave day goes back to their balance,
    and `leave_worked` is what says so on screen and drives the refund."""
    rec = day(clock_in=ist(2026, 8, 13, 10), clock_out=ist(2026, 8, 13, 19))
    svc.recompute(rec, policy())
    v = view(date(2026, 8, 13), rec, _Leave())
    assert v.status == AttendanceStatus.PRESENT.value
    assert v.leave_worked is True


def test_approved_leave_with_no_punch_is_on_leave():
    v = view(date(2026, 8, 13), None, _Leave(paid=1.0, unpaid=0.0))
    assert v.status == AttendanceStatus.ON_LEAVE.value


def test_leave_the_balance_did_not_cover_is_unpaid():
    v = view(date(2026, 8, 13), None, _Leave(paid=0.0, unpaid=1.0))
    assert v.status == AttendanceStatus.LEAVE_UNPAID.value


def test_a_working_day_with_nothing_on_it_is_absent():
    v = view(date(2026, 8, 13), None, None, today="2026-08-31")
    assert v.status == AttendanceStatus.ABSENT.value


def test_today_and_the_future_are_never_absent():
    """Deducting for a day that has not finished would make a mid-month figure a
    lie that corrects itself later — the one thing an attendance figure must
    never do."""
    assert view(date(2026, 8, 13), today="2026-08-13").status \
        == AttendanceStatus.NOT_MARKED.value
    assert view(date(2026, 8, 20), today="2026-08-13").status \
        == AttendanceStatus.NOT_MARKED.value


def test_days_before_somebody_joined_are_not_absences():
    """Owner A6. Somebody who joined on the 18th did not fail to come in on the
    4th, and a register that says they did is one nobody will trust."""
    v = view(date(2026, 8, 4), today="2026-08-31", joined="2026-08-18")
    assert v.status == AttendanceStatus.NOT_MARKED.value
    after = view(date(2026, 8, 19), today="2026-08-31", joined="2026-08-18")
    assert after.status == AttendanceStatus.ABSENT.value


# =============================================================================
# The month summary — the numbers a manager works pay out from
# =============================================================================


def make(status, **kw):
    fields = dict(day="2026-08-01", status=status, worked_minutes=0,
                  is_late=False, is_future=False, missed_punch_out=False)
    fields.update(kw)
    return svc.DayView(**fields)


def test_a_perfect_month_is_payable_in_full():
    """THE ANCHOR. Thirty-one days with nothing missed has to come out at 31, or
    the manager's multiplication does not reconcile with the salary — week offs
    and holidays are inside the monthly figure by definition (owner A4)."""
    days = ([make(AttendanceStatus.PRESENT.value)] * 26
            + [make(AttendanceStatus.WEEK_OFF.value)] * 4
            + [make(AttendanceStatus.HOLIDAY.value)])
    s = svc.summarise(days, hr())
    assert s["total_days"] == 31
    assert s["payable_days"] == 31


def test_absence_and_unpaid_leave_come_off_paid_leave_does_not():
    days = ([make(AttendanceStatus.PRESENT.value)] * 27
            + [make(AttendanceStatus.ABSENT.value)]
            + [make(AttendanceStatus.LEAVE_UNPAID.value)]
            + [make(AttendanceStatus.ON_LEAVE.value)]
            + [make(AttendanceStatus.WEEK_OFF.value)])
    s = svc.summarise(days, hr())
    assert s["payable_days"] == 29        # 31 − 1 absent − 1 unpaid
    assert s["on_leave"] == 1


def test_a_half_day_costs_exactly_half():
    days = [make(AttendanceStatus.PRESENT.value)] * 29 \
        + [make(AttendanceStatus.HALF_DAY.value)]
    s = svc.summarise(days, hr())
    assert s["half_days"] == 1
    assert s["payable_days"] == 29.5


def test_three_late_marks_cost_half_a_day_and_two_cost_nothing():
    """Owner B3. Per COMPLETED set, not pro-rata — 'you were late 2.7 times' is
    not a sentence anybody says."""
    two = [make(AttendanceStatus.PRESENT.value, is_late=True)] * 2 \
        + [make(AttendanceStatus.PRESENT.value)] * 28
    assert svc.summarise(two, hr())["late_penalty_days"] == 0
    assert svc.summarise(two, hr())["payable_days"] == 30

    three = [make(AttendanceStatus.PRESENT.value, is_late=True)] * 3 \
        + [make(AttendanceStatus.PRESENT.value)] * 27
    s = svc.summarise(three, hr())
    assert s["late_marks"] == 3
    assert s["late_penalty_days"] == 0.5
    assert s["payable_days"] == 29.5


def test_a_month_still_running_does_not_deduct_for_the_days_left():
    """A mid-month figure has to be honest about what it does not know yet.
    Deducting for the remaining days would show a deduction that shrinks as the
    month goes on, which reads as the software being wrong."""
    days = [make(AttendanceStatus.PRESENT.value)] * 10 \
        + [make(AttendanceStatus.NOT_MARKED.value, is_future=True)] * 20
    s = svc.summarise(days, hr())
    assert s["not_marked"] == 20
    assert s["payable_days"] == 10


def test_the_summary_reports_what_still_needs_a_decision():
    days = [make(AttendanceStatus.PRESENT.value, missed_punch_out=True)] \
        + [make(AttendanceStatus.NOT_MARKED.value, is_future=False)] \
        + [make(AttendanceStatus.NOT_MARKED.value, is_future=True)] \
        + [make(AttendanceStatus.PRESENT.value)] * 5
    s = svc.summarise(days, hr())
    # The missed punch-out and the past unresolved day. NOT the future one.
    assert s["unresolved_days"] == 2


def test_the_summary_never_reports_a_negative_payable_figure():
    days = [make(AttendanceStatus.ABSENT.value)] * 30
    assert svc.summarise(days, hr())["payable_days"] == 0


def test_nothing_in_the_summary_is_money():
    """Owner 2026-08-20: payslips were dropped, and the module must not grow a
    rupee back. Every key here is a count, a day or a minute."""
    s = svc.summarise([make(AttendanceStatus.PRESENT.value)], hr())
    banned = ("salary", "amount", "paise", "rupee", "pay_", "deduction",
              "net", "gross")
    for key in s:
        assert not any(b in key for b in banned), key
