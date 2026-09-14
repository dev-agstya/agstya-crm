"""Leave: the request somebody raises, and the append-only ledger the balance
is a SUM of.

THE BALANCE IS NOT A NUMBER ON THE USER
---------------------------------------
It is `sum(LeaveLedgerRow.days)` for that person inside the current leave year.
That is the same shape `PartyAccount` and `BankAccount.balance_paise` reach for
and for the same reason: a stored total is a number that anything can overwrite,
and when it drifts there is no way to find out what it should have been. Here
every movement is a row saying who moved it and why, so "why do I have 4.5 days
when I had 6" is a question the screen can answer.

There is deliberately no cached total at all — not even a healable one. The row
count per person per year is ~15 (twelve accruals plus a handful of leaves), so
the sum is cheap, and a cache that is never wrong because it does not exist
beats a cache that is right until somebody forgets to invalidate it.

ACCRUAL IS IDEMPOTENT BY UNIQUE INDEX, NOT BY A FLAG
-----------------------------------------------------
The monthly credit runs from the daily job, which runs from a cron AND at boot,
so it WILL be invoked more than once for the same month — that is the design,
not a bug (it is what makes a missed cron run self-healing). `period_key` plus
the unique index below is what makes the second run a no-op: the insert fails,
the caller shrugs, and nobody gets 3 days in August. A boolean "already accrued"
flag on the user could be read by two runs before either wrote it.

The same mechanism covers the year-end LAPSE, whose period key is the leave
year's start month.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import (
    HrRequestStatus, LeaveDayPart, LeaveLedgerEntry, LeaveReason,
)
from app.models.base import utcnow


class LeaveRequest(Document):
    # Human-readable, like every other entity people talk about out loud.
    code: Indexed(str, unique=True)

    # Whose leave it is. NOT necessarily who filed it — an admin can apply on
    # somebody's behalf when they ring in sick (owner E16), and the two names
    # are both kept because "who said this person was off" is exactly the
    # question that gets asked three months later.
    user_id: Indexed(str)
    user_name: str = ""
    applied_by: Optional[str] = None
    applied_by_name: Optional[str] = None
    # True when applied_by is not the subject. Stored rather than derived so the
    # queue can filter on it without loading both users.
    on_behalf: bool = False

    # IST date strings, inclusive both ends. Same reasoning as AttendanceDay.day:
    # a leave is a claim about CALENDAR days, and the moment it becomes an
    # instant somebody's Friday becomes their Thursday.
    start_date: str
    end_date: str
    # Only meaningful when start_date == end_date; the schema refuses a half on
    # a range rather than accepting it and silently counting full days.
    day_part: str = LeaveDayPart.FULL.value

    reason_type: str = LeaveReason.OTHER.value
    reason: str = ""

    # WORKING days this costs — Sundays and declared holidays inside the range
    # are skipped and cost nothing (owner E9). Computed at submit and RECOMPUTED
    # at approval, because a holiday declared in between would otherwise charge
    # somebody for a day the office was shut.
    days: float = 0.0
    # How the days split once the balance was applied, decided at APPROVAL and
    # frozen. Not recomputed afterwards: the balance moves on, and a request
    # that said "1 paid, 1 unpaid" in August must still say that in November.
    paid_days: float = 0.0
    unpaid_days: float = 0.0

    status: str = HrRequestStatus.PENDING.value
    decided_by: Optional[str] = None
    decided_by_name: Optional[str] = None
    decided_at: Optional[datetime] = None
    decision_note: Optional[str] = None
    cancelled_at: Optional[datetime] = None
    cancelled_by: Optional[str] = None
    cancelled_by_name: Optional[str] = None

    # Applied for a day that has already gone. Sickness is ALWAYS retroactive
    # (owner E14), so this is allowed — but it is flagged so the approver gives
    # it the second look it deserves.
    is_backdated: bool = False

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "leave_requests"
        indexes = [
            # "my leave", and the approval queue.
            [("user_id", pymongo.ASCENDING), ("status", pymongo.ASCENDING)],
            [("status", pymongo.ASCENDING), ("start_date", pymongo.ASCENDING)],
            # "who is off between these dates" — the month view's overlay and
            # the who-is-off-this-week strip both range on this.
            [("start_date", pymongo.ASCENDING), ("end_date", pymongo.ASCENDING)],
        ]

    @property
    def is_open(self) -> bool:
        return self.status == HrRequestStatus.PENDING.value

    @property
    def is_approved(self) -> bool:
        return self.status == HrRequestStatus.APPROVED.value

    @property
    def is_single_day(self) -> bool:
        return self.start_date == self.end_date

    @property
    def is_half_day(self) -> bool:
        return self.day_part != LeaveDayPart.FULL.value


class LeaveLedgerRow(Document):
    """One movement of one person's leave balance. Append-only.

    Never updated and never deleted — a cancelled leave posts a REFUND row, it
    does not remove the USAGE row. Two rows that cancel out are a story; a
    missing row is a number nobody can explain.
    """

    user_id: Indexed(str)
    entry_type: str                   # LeaveLedgerEntry
    # Signed: +credit, -debit. Halves are real (a half-day leave costs 0.5), so
    # this is a float rather than the integer-tenths trick — the values here are
    # always multiples of 0.5 and never reach a magnitude where binary floating
    # point can misrepresent them.
    days: float

    # The leave YEAR this row belongs to, as the FY start year ("2026" for
    # 1 Apr 2026 - 31 Mar 2027). What the balance sums over.
    leave_year: Indexed(int)

    # Idempotency key for the rows a JOB writes: "2026-08" for an accrual,
    # "2026-04" for a lapse. Empty for the rows a HUMAN causes (usage, refund,
    # adjustment, opening), which are allowed to repeat — taking two leaves in
    # one month is not a duplicate.
    period_key: str = ""

    note: str = ""
    # The leave request that caused a usage or a refund.
    ref_id: Optional[str] = None
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "leave_ledger"
        indexes = [
            # The balance: every row for one person in one leave year.
            [("user_id", pymongo.ASCENDING), ("leave_year", pymongo.ASCENDING)],
            [("created_at", pymongo.DESCENDING)],
            # ONE accrual per person per month, and ONE lapse per person per
            # leave year — enforced, because the job that writes them is
            # deliberately re-runnable (see the module docstring).
            #
            # `"$gt": ""` is the documented safe spelling of "non-empty string"
            # in a partial filter. `"$ne": ""` compiles to $not, which Mongo
            # rejects outright — and db.py's index fallback is all-or-nothing,
            # so ONE bad spec means NO index on ANY model gets built.
            pymongo.IndexModel(
                [("user_id", pymongo.ASCENDING),
                 ("entry_type", pymongo.ASCENDING),
                 ("period_key", pymongo.ASCENDING)],
                unique=True, name="leave_ledger_period_unique",
                partialFilterExpression={
                    "period_key": {"$exists": True, "$type": "string",
                                   "$gt": ""}}),
        ]


# Entry types a job writes, and which therefore carry a period_key.
JOB_ENTRY_TYPES = (LeaveLedgerEntry.ACCRUAL.value, LeaveLedgerEntry.LAPSE.value)
