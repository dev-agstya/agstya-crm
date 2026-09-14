"""Time-limited access to a policy that is not yours ("JIT access").

WHY THIS OBJECT EXISTS
-----------------------
From 2026-08-24 an employee reads their OWN book: the policies they booked, plus
the policies booked by the channel partners on their roster right now
(services/policy_scope). That is the owner's rule and it is the right default in
an agency where three people work three sets of customers.

It is also, on its own, a wall. The owner's own example: "if I search for a
policy number which is 102, and I am employee A, and employee B has this policy,
so I will be shown that this policy exists, but I do not have the permission to
view this. If I want to see this, there should be one request like button... so
it should send one request to the owner or the one who has this role of JIT
approval, then he can approve my request so that I can view this policy for like
12 hours."

The shape is taken directly from support tooling: you do not get a permanent
grant, you get a WINDOW. Somebody covering a colleague's leave for an afternoon
needs to read four policies today and none of them next week, and a permanent
grant for that is how a scoped system quietly becomes an unscoped one over a
year of small favours.

THE GRANT IS THE REQUEST, NOT A SECOND DOCUMENT
------------------------------------------------
One document carries the ask, the decision and the window. Splitting them into a
`Request` and a `Grant` would need the two kept in step, and the interesting
questions ("has anybody asked for this before", "who approved it, and why") are
all answered by the same row.

EXPIRY IS READ-TIME, NOT SWEEP-TIME
------------------------------------
`is_live` compares `expires_at` to now on every check. There IS a sweep, and it
only exists to make the LIST readable -- a queue full of rows that say "approved"
when they lapsed a week ago is a queue nobody trusts. Nothing depends on the
sweep having run: a missed cron must never leave access open, which is exactly
what a stored `status == "approved"` would do.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.models.base import utcnow

# How long an approved request lets somebody in for, unless the approver says
# otherwise. The owner's number: "so give like 12 hours JIT request kind of
# thing."
DEFAULT_GRANT_HOURS = 12
# The approver may shorten or lengthen it, within reason. A week is not
# "just-in-time" any more; anybody who needs that much needs `view_all_policies`.
MAX_GRANT_HOURS = 72


class PolicyAccessStatus:
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    # The approver changed their mind before the window ran out. Distinct from
    # EXPIRED, which nobody decided.
    REVOKED = "revoked"
    # The window ran out on its own. Stamped by the sweep for readability only
    # -- `is_live` never trusts it.
    EXPIRED = "expired"
    # Withdrawn by whoever asked.
    CANCELLED = "cancelled"


ACCESS_OPEN = (PolicyAccessStatus.PENDING,)
ACCESS_DECIDED = (PolicyAccessStatus.APPROVED, PolicyAccessStatus.REJECTED,
                  PolicyAccessStatus.REVOKED, PolicyAccessStatus.EXPIRED,
                  PolicyAccessStatus.CANCELLED)


class PolicyAccessRequest(Document):
    code: Indexed(str, unique=True)          # JIT-...

    # --- What is being asked for ---
    policy_id: Indexed(str)
    # Denormalised so the queue reads without loading every policy, and so a
    # decided request still says what it was about after the policy is deleted.
    policy_code: str = ""
    policy_number: Optional[str] = None

    # --- Who is asking ---
    requester_id: Indexed(str)
    requester_name: str = ""
    # MANDATORY at the schema. A request with no reason is one an approver has
    # to chase before they can decide, which means it sits in the queue, which
    # means the feature is slower than walking over and asking.
    reason: str = ""

    # --- The decision ---
    status: str = PolicyAccessStatus.PENDING
    decided_by: Optional[str] = None
    decided_by_name: Optional[str] = None
    decided_at: Optional[datetime] = None
    decision_note: Optional[str] = None

    # --- The window ---
    hours: int = DEFAULT_GRANT_HOURS
    # Set at APPROVAL, from that moment plus `hours`. Not at request time: a
    # window that starts ticking while the request waits in a queue is a window
    # that can be entirely spent before anybody says yes.
    expires_at: Optional[datetime] = None

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "policy_access_requests"
        indexes = [
            # THE HOT QUERY: "which policies may this person see right now",
            # asked on every policy list, every policy read and every export.
            # Status first because it is the most selective, then the person.
            [("requester_id", pymongo.ASCENDING),
             ("status", pymongo.ASCENDING),
             ("expires_at", pymongo.ASCENDING)],
            # The approval queue.
            [("status", pymongo.ASCENDING), ("created_at", pymongo.DESCENDING)],
            # "Who has been given access to this policy" -- shown on the policy.
            [("policy_id", pymongo.ASCENDING)],
        ]

    def is_live(self, now: Optional[datetime] = None) -> bool:
        """Does this grant let the requester in AT THIS MOMENT?

        The only question any access check asks. Deliberately not a stored
        boolean and deliberately not `status == APPROVED`: an approved row whose
        window has closed must read as closed the instant it closes, with no job
        having to run first.
        """
        if self.status != PolicyAccessStatus.APPROVED:
            return False
        if self.expires_at is None:
            return False
        return self.expires_at > (now or utcnow())
