"""Quote requests — a channel partner asking the agency to price a case.

This is the partner's ONLY way to bring business into the app (2026-08-05).
They used to be able to submit a finished policy, which never worked: a policy
number, an insurer, a premium and a reward rate are all OUTPUTS of the quoting
process the partner is not part of. What a partner actually holds, standing next
to a customer, is a request — "Prakash wants to insure his Swift, here is the RC
book, what can you do".

So: the partner asks, staff quote, the customer accepts, and STAFF book the
policy through the normal form with the broker and the rate card. The policy
then points back here via `Policy.quote_request_id`.

The partner never sees the agency's side of any of it — the quote they are shown
carries the premium and THEIR OWN earning in rupees, and nothing else.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.core.enums import QuoteStage
from app.models.base import utcnow

# How long a quote is good for, unless the quoting staff member says otherwise.
# Premiums move; a quote with no expiry becomes a promise the agency did not
# make (owner B3).
DEFAULT_QUOTE_VALIDITY_DAYS = 3


def option_expired(option: "QuoteOption",
                   now: Optional[datetime] = None) -> bool:
    """Has this quotation run out?

    ONE definition, because three screens ask the question and they must agree:
    the partner's own card (which offers Accept only while it is live), the
    partner's "ask for a fresh one" action, and the staff queue's Expired flag.
    Two of those were written inline and the third did not exist, which is how a
    partner could be told a quote had expired on a request staff still saw as
    live and workable.

    An ACCEPTED option never expires. The customer said yes inside the window;
    the clock stops there, and a policy that takes four days to issue must not
    retroactively invalidate the acceptance it was booked on.
    """
    if option.accepted_at is not None:
        return False
    valid = option.valid_until
    if valid is None:
        return False
    when = now or datetime.now(tz=timezone.utc)
    # Older rows predate the tz-aware convention; treat a naive stamp as UTC,
    # which is what everything in this app stores.
    if valid.tzinfo is None:
        valid = valid.replace(tzinfo=timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return valid < when


class QuoteEvent(BaseModel):
    """One entry in the request's timeline, visible to the partner.

    Internal chatter does NOT go here — see `QuoteRequest.internal_notes`. This
    is the record the partner reads, so everything in it is written knowing they
    will read it.
    """

    at: datetime = Field(default_factory=utcnow)
    stage: Optional[str] = None            # stage this moved it to, if any
    by_id: Optional[str] = None
    by_name: Optional[str] = None
    # "agency" or "partner" — who is talking. Not the account type: a partner
    # must never have to work out whether "Rahul" is one of us.
    by_side: str = "agency"
    message: Optional[str] = None


class QuoteOption(BaseModel):
    """What the agency can place, and what the partner earns on it.

    Owner B1: in practice one option per request. The model still holds a list
    so a second can be added without a migration, and the UI shows one panel
    when there is one.

    `partner_earning` is a RUPEE AMOUNT, never a rate (owner E1). It is quoted
    by the staff member from the same rate card the policy will be booked on,
    and the whole point of showing it is that the partner can decide whether the
    case is worth pushing.
    """

    id: str                                   # short uid, unique in the request
    insurer_id: Optional[str] = None
    insurer_name: Optional[str] = None
    premium_amount: int = 0                   # paise, gross incl. GST
    sum_insured: int = 0                      # paise
    cover_from: Optional[datetime] = None
    cover_to: Optional[datetime] = None
    # Free text: add-ons, deductibles, what is and is not covered. Structured
    # add-ons are a motor-only feature and can come later (owner B2).
    inclusions: Optional[str] = None
    partner_earning: int = 0                  # paise the partner earns
    valid_until: Optional[datetime] = None

    quoted_by: Optional[str] = None
    quoted_by_name: Optional[str] = None
    quoted_at: datetime = Field(default_factory=utcnow)

    # Set when the partner accepts or declines THIS option.
    accepted_at: Optional[datetime] = None
    declined_at: Optional[datetime] = None
    decline_reason: Optional[str] = None


class QuoteRequest(Document):
    code: Indexed(str, unique=True)           # QR-...

    # --- Who is asking ---
    partner_id: Indexed(str)
    partner_name: Optional[str] = None        # denormalised for the staff queue
    # Frozen at submission, like the policy's manager stamp: reassigning the
    # partner later must not move an old enquiry onto somebody else's desk.
    manager_id: Optional[str] = None
    manager_name: Optional[str] = None

    # --- Who it is for ---
    # Plain fields, NOT a Customer record (owner A5). A real customer is created
    # by staff at booking time, matched on mobile so a repeat customer is not
    # duplicated (owner A4).
    customer_name: str
    customer_mobile: str
    customer_email: Optional[str] = None

    # --- What is being asked for ---
    category_key: str                         # PolicyCategory.key
    subcategory_path: list[str] = Field(default_factory=list)
    # The type's own configured fields, same keys as Policy.details. Collected
    # from the partner but NOT validated as required — a request is an enquiry,
    # not a booking, and refusing it for a missing field is how a partner stops
    # sending them (owner B6).
    details: dict[str, Any] = Field(default_factory=dict)
    is_renewal: bool = False
    # The expiring policy, when the partner asked from the Renewals screen.
    renewal_of_policy_id: Optional[str] = None
    note: Optional[str] = None

    # --- Where it has got to ---
    stage: QuoteStage = QuoteStage.SUBMITTED
    options: list[QuoteOption] = Field(default_factory=list)
    timeline: list[QuoteEvent] = Field(default_factory=list)

    # Assigned to a named person (defaults to the partner's relationship
    # manager) AND workable by anyone with the permission — owner B4.1 wanted
    # both: a name so it is somebody's job, a pool so it is never stuck.
    assigned_to_id: Optional[str] = None
    assigned_to_name: Optional[str] = None

    # Staff-only. Never serialised to the partner: `PortalQuoteRequest` has no
    # field for it, which is the safeguard.
    internal_notes: Optional[str] = None

    # Set when staff book the policy off the back of this.
    policy_id: Optional[str] = None
    closed_reason: Optional[str] = None       # lost / declined / cancelled

    # First response clock, for the ageing flags on the staff queue (owner
    # B4.2). Stamped the first time anybody moves it off SUBMITTED.
    first_response_at: Optional[datetime] = None

    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "quote_requests"
        indexes = [
            # The partner's own list — the portal's hottest query here.
            [("partner_id", pymongo.ASCENDING),
             ("created_at", pymongo.DESCENDING)],
            [("stage", pymongo.ASCENDING)],
            [("assigned_to_id", pymongo.ASCENDING)],
            [("created_at", pymongo.DESCENDING)],
        ]
