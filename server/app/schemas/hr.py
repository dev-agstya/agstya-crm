"""Schemas for Workplace HR — attendance, leave and holidays.

NO SCHEMA IN THIS FILE HAS A MONEY FIELD, and that is a rule rather than an
accident (owner 2026-08-20). Payslips were designed and dropped in the same
conversation: the module records days and hours, and the salary is worked out by
hand from `MonthSummary`. The omission is the safeguard, exactly as it is on the
partner portal — a schema with no field for a figure cannot leak the figure, and
cannot quietly grow logic that computes one.

Validators write COMPLETE SENTENCES. `core/validation_errors.friendly_message`
turns a pydantic error into one plain line for the user, and a validator whose
message is already a sentence has it used verbatim — so these messages name
their own field, because they ARE the message the person reads.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.enums import (
    AttendanceStatus, HrRequestStatus, LeaveDayPart, LeaveReason,
)

# Statuses a MANAGER may force onto a day. Deliberately a subset of
# AttendanceStatus: NOT_MARKED is what a day is when nothing has happened (you
# clear an override rather than setting it), and HOLIDAY / WEEK_OFF belong to
# the calendar — declaring one for a single person would leave that day looking
# like a holiday nobody else got.
MANUAL_STATUSES = (
    AttendanceStatus.PRESENT.value,
    AttendanceStatus.HALF_DAY.value,
    AttendanceStatus.ABSENT.value,
    AttendanceStatus.WFH.value,
    AttendanceStatus.ON_LEAVE.value,
)

_DAY_RE = r"^\d{4}-\d{2}-\d{2}$"
_MONTH_RE = r"^\d{4}-\d{2}$"
_TIME_RE = r"^([01]\d|2[0-3]):[0-5]\d$"


def _valid_day(value: str, field: str) -> str:
    try:
        date.fromisoformat(value)
    except (ValueError, TypeError):
        raise ValueError(f"{field} must be a real date.")
    return value


# =============================================================================
# Attendance
# =============================================================================


class BreakOut(BaseModel):
    start: datetime
    end: Optional[datetime] = None
    auto_closed: bool = False


class PunchIn(BaseModel):
    """What the browser reports when somebody clocks in or out.

    A POSITION, never a verdict. The client says where it thinks it is; the
    server decides what that means (services/hr_geo). Everything here is
    optional because a punch must never fail on a browser that refused the
    location permission — see `require_location` for the owner's opt-in to the
    stricter behaviour.
    """

    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    # The browser's own 95% confidence radius in metres. Kept because a reading
    # vaguer than the geofence cannot place anybody inside it, and pretending
    # otherwise is how somebody at their desk gets recorded as working from home.
    accuracy_m: Optional[float] = Field(default=None, ge=0)


class GeofenceInfo(BaseModel):
    """What the punch tile needs to explain itself before anyone presses it.

    Carries no more than the UI has to draw: whether to ask the browser for a
    location at all, what to call the office, and how big the circle is. The
    coordinates ARE included — they are on a public map and the employee is
    standing in the building — but nothing here lets a client decide its own
    status.
    """

    enabled: bool = False
    office_label: str = ""
    office_lat: Optional[float] = None
    office_lng: Optional[float] = None
    radius_m: int = 0
    required: bool = False


class PunchState(BaseModel):
    """What the punch panel needs to draw itself, and nothing more.

    `server_now` is here deliberately: the running counter on screen is drawn
    from the server's clock, not the browser's. A laptop whose clock is eleven
    minutes fast would otherwise show eleven minutes of work that the register
    does not have, and the first person to notice would be right to distrust the
    whole screen.
    """

    day: str
    server_now: datetime
    clock_in: Optional[datetime] = None
    clock_out: Optional[datetime] = None
    on_break: bool = False
    break_started_at: Optional[datetime] = None
    breaks: list[BreakOut] = Field(default_factory=list)
    worked_minutes: int = 0
    break_minutes: int = 0
    status: str = AttendanceStatus.NOT_MARKED.value
    is_late: bool = False
    late_minutes: int = 0
    # What the day IS before anyone punches — so the panel can say "today is a
    # holiday" instead of offering a button nobody should press.
    is_week_off: bool = False
    holiday_name: Optional[str] = None
    on_leave: bool = False
    leave_code: Optional[str] = None
    shift_start: str = "10:00"
    shift_end: str = "19:00"
    # False for the owner and for channel partners — they do not clock in
    # (owner A10), and the panel renders an explanation rather than a button.
    can_punch: bool = True

    # --- Where (owner 2026-08-21) ---
    # What the clock-in resolved to, so the tile can say "at Head office" or
    # "working from home" rather than leaving somebody to guess which one the
    # day was recorded as.
    work_location: Optional[str] = None
    distance_m: Optional[int] = None
    geofence: GeofenceInfo = Field(default_factory=GeofenceInfo)


class AttendanceDayOut(BaseModel):
    """One row of the month register."""

    day: str
    weekday: int                        # Monday=0 ... Sunday=6
    status: str
    clock_in: Optional[datetime] = None
    clock_out: Optional[datetime] = None
    worked_minutes: int = 0
    break_minutes: int = 0
    is_late: bool = False
    late_minutes: int = 0
    is_early_out: bool = False
    early_out_minutes: int = 0
    missed_punch_out: bool = False
    holiday_name: Optional[str] = None
    leave_id: Optional[str] = None
    leave_code: Optional[str] = None
    leave_reason: Optional[str] = None
    # The employee came in on a day they had approved leave for. The balance is
    # given back automatically (owner C10); this is what says so on screen.
    leave_worked: bool = False
    note: Optional[str] = None
    source: Optional[str] = None
    edited_by_name: Optional[str] = None
    edit_reason: Optional[str] = None
    record_id: Optional[str] = None
    is_future: bool = False


class MonthSummary(BaseModel):
    """THE deliverable of this module — the month in days and hours.

    A manager opens this at month end, reads `payable_days`, and multiplies by
    the salary themselves. Every figure is one they can verify by counting rows
    on the register above it, which is the property that makes a hand
    calculation worth trusting.
    """

    total_days: int = 0
    present: int = 0
    wfh: int = 0
    half_days: int = 0
    absent: int = 0
    on_leave: int = 0
    leave_unpaid: int = 0
    week_offs: int = 0
    holidays: int = 0
    not_marked: int = 0
    late_marks: int = 0
    late_penalty_days: float = 0.0
    worked_minutes: int = 0
    worked_hours: float = 0.0
    payable_days: float = 0.0
    # Days the register still owes an answer on — a missed punch-out, or a past
    # working day that never resolved. Clear these before doing the month's
    # arithmetic.
    unresolved_days: int = 0


class AttendanceMonthOut(BaseModel):
    month: str
    user_id: str
    user_name: str
    days: list[AttendanceDayOut] = Field(default_factory=list)
    summary: MonthSummary = Field(default_factory=MonthSummary)


class TeamMemberDay(BaseModel):
    """One person on the team board for one day."""

    user_id: str
    name: str
    code: str = ""
    designation: Optional[str] = None
    status: str
    clock_in: Optional[datetime] = None
    clock_out: Optional[datetime] = None
    worked_minutes: int = 0
    is_late: bool = False
    late_minutes: int = 0
    on_break: bool = False
    missed_punch_out: bool = False
    leave_code: Optional[str] = None


class TeamDayOut(BaseModel):
    day: str
    is_week_off: bool = False
    holiday_name: Optional[str] = None
    members: list[TeamMemberDay] = Field(default_factory=list)
    # Counts for the tiles, so the page does not re-derive them in the browser
    # and disagree with the rows underneath.
    in_count: int = 0
    late_count: int = 0
    leave_count: int = 0
    absent_count: int = 0
    not_in_count: int = 0


class TeamMonthRow(BaseModel):
    user_id: str
    name: str
    code: str = ""
    designation: Optional[str] = None
    days: list[AttendanceDayOut] = Field(default_factory=list)
    summary: MonthSummary = Field(default_factory=MonthSummary)


class TeamMonthOut(BaseModel):
    month: str
    rows: list[TeamMonthRow] = Field(default_factory=list)


class AttendanceDayEdit(BaseModel):
    """A manager correcting one day (owner C5).

    THE REASON IS MANDATORY. An attendance edit is one person making a claim
    about another person's working hours, and at month end it is what the pay is
    worked out from — the audit row and this sentence are the only evidence of
    why the register says what it says.
    """

    user_id: str
    day: str = Field(pattern=_DAY_RE)
    # "HH:MM" IST, or "" to clear. Not full datetimes: a manager types a time
    # against a day they already picked, and asking for an instant invites a
    # timezone mistake at the one place in this module that cannot afford one.
    clock_in: Optional[str] = None
    clock_out: Optional[str] = None
    # One of MANUAL_STATUSES to force it, or "" to clear the override and let
    # the punches decide again.
    status: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=500)
    reason: str = Field(min_length=3, max_length=300)

    @field_validator("day")
    @classmethod
    def _day(cls, v):
        return _valid_day(v, "The date")

    @field_validator("clock_in", "clock_out")
    @classmethod
    def _time(cls, v):
        import re
        if v in (None, ""):
            return v
        if not re.match(_TIME_RE, v):
            raise ValueError("Times must be entered as HH:MM, "
                             "for example 10:00.")
        return v

    @field_validator("status")
    @classmethod
    def _status(cls, v):
        if v in (None, ""):
            return v
        if v not in MANUAL_STATUSES:
            raise ValueError("That is not a status a day can be set to.")
        return v

    @model_validator(mode="after")
    def _order(self):
        if self.clock_in and self.clock_out and self.clock_out <= self.clock_in:
            raise ValueError("Clock out has to be later than clock in.")
        return self


class CorrectionCreate(BaseModel):
    """"I forgot to clock out on the 12th, I left at 19:10." (owner C4)"""

    day: str = Field(pattern=_DAY_RE)
    clock_in: Optional[str] = None
    clock_out: Optional[str] = None
    reason: str = Field(min_length=3, max_length=300)

    @field_validator("day")
    @classmethod
    def _day(cls, v):
        return _valid_day(v, "The date")

    @field_validator("clock_in", "clock_out")
    @classmethod
    def _time(cls, v):
        import re
        if v in (None, ""):
            return v
        if not re.match(_TIME_RE, v):
            raise ValueError("Times must be entered as HH:MM, "
                             "for example 10:00.")
        return v

    @model_validator(mode="after")
    def _something(self):
        if not self.clock_in and not self.clock_out:
            raise ValueError("Enter the clock-in time, the clock-out time, "
                             "or both.")
        if self.clock_in and self.clock_out and self.clock_out <= self.clock_in:
            raise ValueError("Clock out has to be later than clock in.")
        return self


class CorrectionOut(BaseModel):
    id: str
    user_id: str
    user_name: str
    day: str
    requested_clock_in: Optional[datetime] = None
    requested_clock_out: Optional[datetime] = None
    reason: str = ""
    status: str
    decided_by_name: Optional[str] = None
    decided_at: Optional[datetime] = None
    decision_note: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, c) -> "CorrectionOut":
        data = c.model_dump()
        data["id"] = str(c.id)
        return cls(**data)


class DecisionIn(BaseModel):
    """Approve or reject — one shape for leave and for corrections.

    A rejection without a note is allowed but discouraged in the UI: the person
    who raised it has to be told something, and "rejected" on its own is how a
    manager gets asked in person anyway.
    """

    approve: bool
    note: Optional[str] = Field(default=None, max_length=300)


# =============================================================================
# Leave
# =============================================================================


class LeaveCreate(BaseModel):
    start_date: str = Field(pattern=_DAY_RE)
    end_date: str = Field(pattern=_DAY_RE)
    day_part: str = LeaveDayPart.FULL.value
    reason_type: str = LeaveReason.OTHER.value
    reason: str = Field(min_length=3, max_length=500)
    # Admins only (owner E16) — someone rings in sick and you record it. The
    # router refuses this without manage_leave rather than trusting the client.
    user_id: Optional[str] = None

    @field_validator("start_date", "end_date")
    @classmethod
    def _day(cls, v):
        return _valid_day(v, "The date")

    @field_validator("day_part")
    @classmethod
    def _part(cls, v):
        if v not in [p.value for p in LeaveDayPart]:
            raise ValueError("Choose a full day, the first half or the "
                             "second half.")
        return v

    @field_validator("reason_type")
    @classmethod
    def _reason_type(cls, v):
        if v not in [r.value for r in LeaveReason]:
            raise ValueError("That is not a reason this form offers.")
        return v

    @model_validator(mode="after")
    def _range(self):
        if self.end_date < self.start_date:
            raise ValueError("The last day of leave cannot be before the "
                             "first day.")
        # A half day is a claim about ONE day. Accepting it on a range and
        # silently counting full days is the kind of quiet wrongness that only
        # surfaces when somebody checks their balance.
        if (self.day_part != LeaveDayPart.FULL.value
                and self.start_date != self.end_date):
            raise ValueError("A half day can only be applied for on a single "
                             "date.")
        return self


class LeaveUpdate(BaseModel):
    """Editing a request that is still PENDING (owner E13)."""

    start_date: Optional[str] = Field(default=None, pattern=_DAY_RE)
    end_date: Optional[str] = Field(default=None, pattern=_DAY_RE)
    day_part: Optional[str] = None
    reason_type: Optional[str] = None
    reason: Optional[str] = Field(default=None, min_length=3, max_length=500)


class LeaveOut(BaseModel):
    id: str
    code: str
    user_id: str
    user_name: str
    start_date: str
    end_date: str
    day_part: str
    reason_type: str
    reason: str = ""
    days: float = 0.0
    paid_days: float = 0.0
    unpaid_days: float = 0.0
    status: str
    on_behalf: bool = False
    applied_by_name: Optional[str] = None
    decided_by_name: Optional[str] = None
    decided_at: Optional[datetime] = None
    decision_note: Optional[str] = None
    is_backdated: bool = False
    created_at: datetime
    # Derived for the caller, so three screens cannot disagree about whether a
    # request is still theirs to withdraw.
    can_cancel: bool = False
    can_edit: bool = False

    @classmethod
    def from_model(cls, r, *, can_cancel: bool = False,
                   can_edit: bool = False) -> "LeaveOut":
        data = r.model_dump()
        data["id"] = str(r.id)
        data["can_cancel"] = can_cancel
        data["can_edit"] = can_edit
        return cls(**data)


class LeaveBalanceOut(BaseModel):
    """Days, and only days. See the module docstring."""

    user_id: str
    user_name: str = ""
    leave_year: int
    leave_year_label: str = ""
    opening: float = 0.0
    accrued: float = 0.0
    used: float = 0.0
    refunded: float = 0.0
    adjusted: float = 0.0
    lapsed: float = 0.0
    available: float = 0.0
    monthly_accrual: float = 0.0
    max_balance: float = 0.0
    pending_days: float = 0.0        # asked for and not yet decided


class LeaveLedgerOut(BaseModel):
    id: str
    entry_type: str
    days: float
    note: str = ""
    ref_id: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, r) -> "LeaveLedgerOut":
        data = r.model_dump()
        data["id"] = str(r.id)
        return cls(**data)


class LeaveCostPreview(BaseModel):
    """What the form shows BEFORE you submit (owner E17).

    Going short on balance is allowed and never blocked — but it is never a
    surprise either, because this says "0.5 paid, 2.5 unpaid" while the form is
    still open. A deduction discovered later is how an argument starts.
    """

    days: float = 0.0
    working_days: list[str] = Field(default_factory=list)
    skipped_days: list[str] = Field(default_factory=list)   # week offs/holidays
    available: float = 0.0
    paid_days: float = 0.0
    unpaid_days: float = 0.0
    is_backdated: bool = False
    conflict: Optional[str] = None   # an overlapping request, named


class BalanceAdjust(BaseModel):
    """A human moving somebody's balance, with a reason (owner E6).

    Needed on day one to set opening balances for people already working here,
    and afterwards for the honest one-offs. Signed: negative takes days away.
    """

    user_id: str
    days: float = Field(gt=-100, lt=100)
    reason: str = Field(min_length=3, max_length=300)
    # OPENING for "this is what they were carrying when we switched this on",
    # ADJUSTMENT for everything else. Two words for the same movement, but the
    # statement reads very differently for each.
    is_opening: bool = False

    @field_validator("days")
    @classmethod
    def _step(cls, v):
        if round(v * 2) != v * 2:
            raise ValueError("Leave is counted in halves — use 0.5, 1, 1.5 "
                             "and so on.")
        if v == 0:
            raise ValueError("Enter how many days to add or take away.")
        return v


class WhoIsOffEntry(BaseModel):
    """Names and dates only — never the reason (owner G5).

    Everybody needs this to plan work, and it is not sensitive. Why somebody is
    off stays between them and whoever approves it.
    """

    user_id: str
    name: str
    start_date: str
    end_date: str
    day_part: str = LeaveDayPart.FULL.value


# =============================================================================
# Holidays
# =============================================================================


class HolidayIn(BaseModel):
    date: str = Field(pattern=_DAY_RE)
    name: str = Field(min_length=2, max_length=80)
    note: Optional[str] = Field(default=None, max_length=300)

    @field_validator("date")
    @classmethod
    def _day(cls, v):
        return _valid_day(v, "The holiday date")


class HolidayUpdate(BaseModel):
    date: Optional[str] = Field(default=None, pattern=_DAY_RE)
    name: Optional[str] = Field(default=None, min_length=2, max_length=80)
    note: Optional[str] = Field(default=None, max_length=300)


class HolidayOut(BaseModel):
    id: str
    date: str
    year: int
    name: str
    note: Optional[str] = None
    # Derived so the list can grey out what has already happened without every
    # screen re-deriving "is this past" from a string.
    is_past: bool = False
    weekday: int = 0
    # A holiday declared on a Sunday changes nothing (owner D6) — saying so on
    # the row stops somebody adding it twice wondering why it had no effect.
    falls_on_week_off: bool = False

    @classmethod
    def from_model(cls, h, *, today: str, week_off_days) -> "HolidayOut":
        from datetime import date as _date
        d = _date.fromisoformat(h.date)
        return cls(
            id=str(h.id), date=h.date, year=h.year, name=h.name, note=h.note,
            is_past=h.date < today, weekday=d.weekday(),
            falls_on_week_off=d.weekday() in set(week_off_days or []))


class HolidayYearOut(BaseModel):
    year: int
    holidays: list[HolidayOut] = Field(default_factory=list)
    # Offered when the year is empty (owner D4). Suggestions the owner accepts,
    # never rows that appeared by themselves — nothing in this app is seeded.
    suggestions: list[HolidayIn] = Field(default_factory=list)
    week_off_days: list[int] = Field(default_factory=list)


class CopyYearIn(BaseModel):
    """"Copy last year's list" (owner D3).

    80% of the list repeats, and re-typing fifteen rows every January is how the
    list stops being maintained. Dates are shifted by whole years, so a holiday
    that moves with the lunar calendar lands roughly right and gets corrected —
    which is still far less work than starting from nothing.
    """

    from_year: int = Field(ge=2000, le=2100)
    to_year: int = Field(ge=2000, le=2100)

    @model_validator(mode="after")
    def _different(self):
        if self.from_year == self.to_year:
            raise ValueError("Choose a different year to copy into.")
        return self


# =============================================================================
# Settings
# =============================================================================


class HrSettingsUpdate(BaseModel):
    week_off_days: Optional[list[int]] = None
    shift_start: Optional[str] = Field(default=None, pattern=_TIME_RE)
    shift_end: Optional[str] = Field(default=None, pattern=_TIME_RE)
    late_grace_minutes: Optional[int] = Field(default=None, ge=0, le=240)
    early_out_grace_minutes: Optional[int] = Field(default=None, ge=0, le=240)
    full_day_minutes: Optional[int] = Field(default=None, ge=30, le=960)
    half_day_minutes: Optional[int] = Field(default=None, ge=15, le=960)
    max_break_minutes: Optional[int] = Field(default=None, ge=0, le=480)
    late_marks_per_penalty: Optional[int] = Field(default=None, ge=1, le=31)
    late_penalty_days: Optional[float] = Field(default=None, ge=0, le=5)
    monthly_leave_accrual: Optional[float] = Field(default=None, ge=0, le=10)
    max_leave_balance: Optional[float] = Field(default=None, ge=0, le=120)
    leave_year_start_month: Optional[int] = Field(default=None, ge=1, le=12)
    missing_punch_nudge_minutes: Optional[int] = Field(default=None, ge=0,
                                                       le=600)

    # --- Where the punch came from (owner 2026-08-21) ---
    #
    # DECLARED HERE OR IT CANNOT BE SAVED. `settings_svc.update` merges each
    # block with `model_copy(update=...)` off THIS schema, so a field the model
    # has and this class does not is silently dropped on the way through — the
    # PATCH returns 200 and changes nothing. That exact failure shipped once
    # already (the whole `partner_portal` block, 2026-08-20), so every field
    # added to `HrSettings` gets a line here.
    geofence_enabled: Optional[bool] = None
    office_label: Optional[str] = Field(default=None, max_length=80)
    office_lat: Optional[float] = Field(default=None, ge=-90, le=90)
    office_lng: Optional[float] = Field(default=None, ge=-180, le=180)
    # Floor of 20m: a fence tighter than a good GPS fix marks people who ARE at
    # their desk as working from home. Ceiling of 5km so a slipped keystroke
    # cannot quietly turn the whole district into the office.
    office_radius_m: Optional[int] = Field(default=None, ge=20, le=5000)
    max_accuracy_m: Optional[int] = Field(default=None, ge=0, le=10000)
    unknown_counts_as_office: Optional[bool] = None
    require_location: Optional[bool] = None

    # --- The correction window before pay locks (owner 2026-09-06) ---
    #
    # Same rule as the geofence block above: declared here or it cannot be
    # saved. 0 means "never lock by itself". The ceiling is 15 because a buffer
    # longer than half a month is not a buffer — it is a pay run nobody has
    # done, and the honest way to have that is to switch the automation off.
    payroll_auto_finalise_days: Optional[int] = Field(default=None, ge=0, le=15)

    @model_validator(mode="after")
    def _geofence(self):
        """Refuse to switch the fence on while EXPLICITLY clearing its centre.

        Deliberately narrow. A payload of just `{"geofence_enabled": true}` is
        the normal way somebody flips the switch, and the stored coordinates it
        relies on are already set — so "lat is None" here usually means "not
        mentioned", not "there isn't one". Rejecting that would make the switch
        unusable from any client that sends one field at a time.

        `model_fields_set` is what separates the two: it lists what the SENDER
        actually wrote. Enabling the fence in the same breath as nulling the
        office is a genuine contradiction, and that is all this catches.

        The real defence against a centreless fence is `hr_geo.is_configured()`,
        which is checked on every punch: with no coordinates the feature stays
        inert rather than classifying the whole planet as remote.
        """
        sent = self.model_fields_set
        cleared = (("office_lat" in sent and self.office_lat is None)
                   or ("office_lng" in sent and self.office_lng is None))
        if self.geofence_enabled and cleared:
            raise ValueError(
                "Set the office location before switching on location-based "
                "attendance.")
        return self

    @field_validator("week_off_days")
    @classmethod
    def _week(cls, v):
        if v is None:
            return v
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("A weekly off has to be a day of the week.")
        if len(set(v)) == 7:
            raise ValueError("The office cannot be closed every day of the "
                             "week.")
        return sorted(set(v))

    @model_validator(mode="after")
    def _thresholds(self):
        # Checked here rather than clamped silently: a half day longer than a
        # full day would make every day a half day, which the person typing it
        # would only discover at month end.
        if (self.full_day_minutes is not None
                and self.half_day_minutes is not None
                and self.half_day_minutes > self.full_day_minutes):
            raise ValueError("A half day cannot be longer than a full day.")
        return self
