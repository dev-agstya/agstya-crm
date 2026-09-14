"""Attendance: one document per employee per calendar day, plus the correction
queue that fixes the days somebody got wrong.

ONE ROW PER DAY, AND ONLY WHERE SOMETHING HAPPENED
--------------------------------------------------
Nothing pre-creates a row for every employee on every working day. A document
exists because somebody punched, a manager edited the day, or a correction was
approved — and the month view DERIVES the rest (week off, holiday, approved
leave, absent) from the calendar and the leave book. See
`services/hr_attendance.build_month`.

That is a deliberate choice against the obvious alternative, which is a nightly
sweep that stamps everybody ABSENT and lets the punch overwrite it. The sweep
shape has three problems this one does not: it needs a job that cannot be missed
(a skipped night silently loses a day for everybody), it writes ~30 rows per
employee per month whether or not anything happened, and it makes "absent" a
STORED fact that can disagree with the calendar the moment a holiday is declared
after the fact. Deriving it means declaring a holiday retroactively fixes every
affected day at once, with no migration.

`day` IS THE KEY, AND IT IS AN IST DATE STRING
----------------------------------------------
Punch INSTANTS are stored as tz-aware UTC datetimes like everything else in this
app. The DAY they belong to is "YYYY-MM-DD" in Indian time, stored as a string,
because that is the thing every query in this module actually asks for — "August
for this person", "the 14th for everybody" — and deriving it from a UTC instant
at query time would put a 19:30 IST punch-out into the previous day for anyone
comparing raw instants. Storing the answer is both faster and the only way the
uniqueness constraint below can exist.

`month` is denormalised off `day` for the same reason: the month view is the
hottest read in the module and "give me one person's August" must be one indexed
lookup, not a range scan over string dates.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.core.enums import (
    AttendanceSource, AttendanceStatus, HrRequestStatus, WorkLocation,
)
from app.models.base import utcnow


class BreakInterval(BaseModel):
    """One break. `end` is None while it is running.

    A LIST of these rather than a single running total, because "how long was
    your lunch" and "how many times did you step out" are different questions
    and a total can only answer the first. The list is also what makes the
    running break on screen possible — an open interval is a break in progress.
    """

    start: datetime
    end: Optional[datetime] = None
    # Set when the nightly job closed a break nobody ended. Kept as its own flag
    # rather than inferred, so a genuine long break and a forgotten one are
    # distinguishable on the day.
    auto_closed: bool = False


class PunchLocation(BaseModel):
    """Where one punch was reported from, and what the server made of it.

    The VERDICT and the EVIDENCE are stored together on purpose. A day that says
    only "remote" is unarguable in the wrong direction — a manager looking at it
    a week later cannot tell a genuine work-from-home morning from a phone that
    put somebody 300m out with 800m of uncertainty. Keeping the reading next to
    the conclusion is what makes the conclusion reviewable.

    `resolved` holds the RAW answer, including `unknown`. What an unknown counts
    as for the day's status is a settings question answered at read time
    (services/hr_geo.status_location), never baked in here — otherwise flipping
    that setting would silently reinterpret history.
    """

    lat: float
    lng: float
    # As reported by the browser: the radius in metres of the 95% confidence
    # circle. None when the client did not say.
    accuracy_m: Optional[float] = None
    # Metres from the configured office. None when there was nothing to measure
    # against — NOT 0, which would place an unlocated punch at the exact centre
    # of the office.
    distance_m: Optional[int] = None
    resolved: str = WorkLocation.UNKNOWN.value
    at: datetime = Field(default_factory=utcnow)


class AttendanceDay(Document):
    # --- Identity ---
    user_id: Indexed(str)
    user_name: str = ""              # denormalised for the team board + export
    day: str                          # "YYYY-MM-DD", IST
    month: Indexed(str)               # "YYYY-MM", IST — the month view's key

    # --- What actually happened ---
    clock_in: Optional[datetime] = None
    clock_out: Optional[datetime] = None
    breaks: list[BreakInterval] = Field(default_factory=list)

    # --- Derived, recomputed by services/hr_attendance.recompute ---
    #
    # Stored rather than computed on read because the team board reads a day for
    # every employee at once and the month export reads thirty days for every
    # employee at once; recomputing minutes in Python across that is the
    # `find_all()` pattern CLAUDE.md asks new reads not to widen.
    worked_minutes: int = 0
    break_minutes: int = 0
    status: str = AttendanceStatus.NOT_MARKED.value
    is_late: bool = False
    late_minutes: int = 0
    is_early_out: bool = False
    early_out_minutes: int = 0

    # --- Provenance ---
    source: str = AttendanceSource.PUNCH.value
    # The nightly job closed a day nobody clocked out of. NOT the same as
    # `auto_closed` meaning "fine": a day closed this way is flagged amber on
    # the employee's own month and in the manager's queue precisely so it gets
    # looked at, because the alternative — silently paying a full day, or
    # silently paying none — is a decision the software should not be making.
    missed_punch_out: bool = False

    # --- A manager's override ---
    #
    # A status a human FORCED, which beats the punch. Kept as its own field
    # rather than written over `status` so the recompute can run again (a
    # settings change, a corrected punch) without erasing somebody's decision.
    manual_status: Optional[str] = None
    edit_reason: Optional[str] = None
    edited_by: Optional[str] = None
    edited_by_name: Optional[str] = None
    edited_at: Optional[datetime] = None

    note: Optional[str] = None
    # Recorded since the module shipped (owner C7), against the day office-only
    # punching was switched on. That day was 2026-08-21 — and the control that
    # arrived is GEOGRAPHIC rather than network-based, because an IP identifies
    # the office wifi at best and says nothing at all about somebody on mobile
    # data. The field stays: it is a second, independent trace of where a punch
    # came from, and it costs nothing.
    ip_address: Optional[str] = None

    # --- Where the day was worked (owner 2026-08-21) ---
    #
    # `work_location` is the CLOCK-IN's verdict and is what the day's status is
    # derived from. Clock-out coordinates are recorded for evidence and never
    # change it: stepping out to a customer at 6pm must not rewrite the morning.
    #
    # A separate field from `status`, not folded into it. Status answers "how
    # many hours" and location answers "from where" — two questions, and a
    # two-hour day worked at home is genuinely both a half day and remote.
    work_location: Optional[str] = None      # WorkLocation, set at clock-in
    punch_in_location: Optional[PunchLocation] = None
    punch_out_location: Optional[PunchLocation] = None

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "attendance_days"
        indexes = [
            # ONE ROW PER PERSON PER DAY, enforced. Two rows for the same day
            # would double a month's counts, and the punch endpoints are exactly
            # the kind of thing a double-tap on a phone races.
            pymongo.IndexModel(
                [("user_id", pymongo.ASCENDING), ("day", pymongo.ASCENDING)],
                unique=True, name="attendance_user_day_unique"),
            # "One person's August" — the month view.
            [("user_id", pymongo.ASCENDING), ("month", pymongo.ASCENDING)],
            # "Everybody, on the 14th" — the team board.
            [("day", pymongo.ASCENDING)],
            # "Everybody's August" — the team grid and the register export.
            [("month", pymongo.ASCENDING)],
        ]

    @property
    def open_break(self) -> Optional[BreakInterval]:
        for b in self.breaks:
            if b.end is None:
                return b
        return None

    @property
    def is_clocked_in(self) -> bool:
        return self.clock_in is not None and self.clock_out is None

    @property
    def effective_status(self) -> str:
        """What the day COUNTS as: a manager's decision, else what was punched."""
        return self.manual_status or self.status


class AttendanceCorrection(Document):
    """"I forgot to clock out on the 12th, I left at 19:10."

    The single most valuable thing in this module after the punch itself (owner
    C4). Without it every forgotten punch is a WhatsApp message and a manual
    edit, which means the manager is doing data entry and the employee has no
    record that they asked.

    Deliberately NOT the same collection as LeaveRequest even though the social
    shape is identical (someone asks, someone decides). The fields do not
    overlap at all — one carries times, the other carries dates and a balance
    cost — and a single collection with two disjoint halves is a document where
    half the fields are always null.
    """

    user_id: Indexed(str)
    user_name: str = ""
    day: str                          # "YYYY-MM-DD", IST

    # What they say the day should be. Either may be None — "I clocked in fine,
    # I just forgot to clock out" is the common case and should not force
    # somebody to re-type a time that is already correct.
    requested_clock_in: Optional[datetime] = None
    requested_clock_out: Optional[datetime] = None
    reason: str = ""

    status: str = HrRequestStatus.PENDING.value
    decided_by: Optional[str] = None
    decided_by_name: Optional[str] = None
    decided_at: Optional[datetime] = None
    decision_note: Optional[str] = None

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "attendance_corrections"
        indexes = [
            # "my requests", and "the queue" — both start from the status.
            [("user_id", pymongo.ASCENDING), ("status", pymongo.ASCENDING)],
            [("status", pymongo.ASCENDING), ("created_at", pymongo.DESCENDING)],
            [("day", pymongo.ASCENDING)],
        ]
