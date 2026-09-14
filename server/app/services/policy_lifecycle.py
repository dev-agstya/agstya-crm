"""Move policies through the states TIME puts them in.

THE BUG THIS EXISTS FOR
-----------------------
`PolicyStatus.EXPIRED` was read in four places and WRITTEN in none. There was no
sweep, no scheduled job, and no read-time rule — so a policy booked in January
for twelve months was still `ACTIVE` in the following December, and in every
December after that.

That is not a cosmetic problem. The status drives:

  * the badge on the policy page, the customer's record and the partner portal
  * "active policies" on the Reports KPI tile and the Balance Sheet
  * `_LIVE_STATUSES` in routers/managers.py, which decides what counts as
    renewable on a relationship manager's roster
  * the Renewals page's own idea of what is still worth chasing

Every one of those was reporting dead cover as live business, and the error only
ever grows: nothing removes a policy from "active" once its cover has ended.

WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
------------------------------------------------
Two transitions, both driven purely by the calendar:

    ACTIVE        -> RENEWAL_DUE   inside the renewal window
    ACTIVE /      -> EXPIRED       past the expiry date
    RENEWAL_DUE

Nothing else. In particular a policy that a HUMAN has put in a state — RENEWED,
CANCELLED, LAPSED, DRAFT — is never touched, because those states mean something
happened, and a clock has no business overruling a person. `RENEWED` is the one
worth spelling out: a renewed policy's cover really has ended, but relabelling it
EXPIRED would lose the fact that the customer stayed, which is exactly what the
renewal-rate figure is counting.

BOUNDARIES ARE IST. A policy expiring "on 31 March" expires at the end of the
31st in Indian time, not at 05:30 IST because the stored instant is UTC — the
same rule every other date boundary in this app follows (services/finance_reports).

Idempotent by construction: it asks for the rows that are in the wrong state and
puts them in the right one, so running it twice, or half-way, changes nothing the
second time. It can be run from the daily cron, from a script, or at boot.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.core.enums import PolicyStatus
from app.models.base import utcnow
from app.models.policy import Policy
from app.services.finance_reports import IST

# How far ahead of expiry a live policy starts reading as "renewal due".
#
# This is the same 30 days the roster's renewal horizon uses. It is NOT the
# Policies router's RENEWAL_WINDOW_DAYS (90), and that difference is deliberate:
# 90 days is how far the RENEWALS PAGE looks — a work queue, where you want to
# see what is coming — while this is a claim about the policy itself, and a
# policy with three months left on it is simply active.
RENEWAL_DUE_WITHIN_DAYS = 30


def _end_of_ist_day(when: datetime) -> datetime:
    """The instant the IST calendar day containing `when` finishes.

    Cover bought "until 31 March" is good for the whole of the 31st. Comparing
    raw instants would expire it at midnight UTC, i.e. 05:30 on the 31st IST,
    taking half a working day of live cover off every policy in the book.
    """
    local = when.astimezone(IST)
    return local.replace(hour=23, minute=59, second=59, microsecond=999999)


async def sweep(now: datetime | None = None) -> dict[str, int]:
    """Apply both time-driven transitions. Returns what moved.

    Deliberately two plain updates rather than one clever pipeline: the two
    rules are independent, the second must run after the first (a policy can go
    ACTIVE -> RENEWAL_DUE -> EXPIRED in one sweep if it has been ignored long
    enough), and a partial run leaves the database in a state the next run
    finishes off.
    """
    now = now or utcnow()
    cutoff = _end_of_ist_day(now)
    horizon = _end_of_ist_day(now + timedelta(days=RENEWAL_DUE_WITHIN_DAYS))
    collection = Policy.get_motor_collection()

    # 1) Cover has ENDED. Both live states feed this one.
    expired = await collection.update_many(
        {"status": {"$in": [PolicyStatus.ACTIVE.value,
                            PolicyStatus.RENEWAL_DUE.value]},
         "expiry_date": {"$ne": None, "$lt": cutoff}},
        {"$set": {"status": PolicyStatus.EXPIRED.value, "updated_at": now}},
    )

    # 2) Cover ends SOON. Only from ACTIVE — walking a policy backwards out of
    #    EXPIRED would undo the rule above on the same run.
    due = await collection.update_many(
        {"status": PolicyStatus.ACTIVE.value,
         "expiry_date": {"$ne": None, "$gte": cutoff, "$lte": horizon}},
        {"$set": {"status": PolicyStatus.RENEWAL_DUE.value,
                  "updated_at": now}},
    )

    return {"expired": expired.modified_count,
            "renewal_due": due.modified_count}
