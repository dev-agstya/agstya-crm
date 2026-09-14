"""Which policies one person may read.

THE RULE, IN ONE SENTENCE
--------------------------
An in-house user sees the policies they BOOKED, plus the policies booked by the
channel partners on their roster RIGHT NOW, plus anything a live JIT grant
covers -- unless they hold `view_all_policies`, in which case they see the book.

    owner                       -> everything (by account type)
    holds view_all_policies     -> everything
    anybody else                -> owner_user_id == me
                                OR partner_id IN (my partners, resolved now)
                                OR policy_id IN (my live access grants)

THE ROSTER IS RESOLVED LIVE, AND THAT IS THE WHOLE FEATURE
------------------------------------------------------------
The owner's requirement, stated twice: "let's say that employee leaves the
company and we want to move this channel partner to some other employee. So at
that time what should happen is all the policies that are there with this
channel partner should now be visible to the other employee."

Doing that by REWRITING policies on reassignment would mean a migration on every
move, a partial-failure story, and a permanent divergence the moment one write
fails. Deriving it from `User.relationship_manager_id` at read time means the
move is ONE FIELD on ONE DOCUMENT and the entire history follows in the same
instant, with nothing to backfill and nothing that can half-succeed.

VISIBILITY IS LIVE; ATTRIBUTION STAYS FROZEN. `Policy.manager_id` is stamped at
booking and must not be touched (CLAUDE.md, "Relationship managers"): a manager
keeps credit for what their partners brought in while they held them, or every
target and every league table rewrites itself the day somebody is reassigned.
These are two different questions about the same policy and they get two
different answers on purpose:

    who does this policy COUNT for?   -> Policy.manager_id, frozen at booking
    who may READ this policy?          -> this module, resolved on every request

Do not "simplify" one into the other. They agreed on the day the policy was
booked and they are meant to diverge afterwards.

WHY THE BOOKER KEEPS SIGHT OF WHAT THEY BOOKED
------------------------------------------------
`owner_user_id == me` stays in the rule even after a partner moves away. The
person who keyed a policy in can still open it, because they are the one who
will be asked about it, and because taking a record away from somebody who
handled it reads as data loss rather than as a policy. In the owner's own
scenario the departing employee is deactivated and cannot sign in at all, so the
clause costs nothing where it matters.

APPLIED IN THE QUERY, NEVER IN THE SERIALISER
-----------------------------------------------
`visible_filter()` returns a Mongo clause. Every list, count, export and
aggregate merges it. A visibility rule enforced while rendering is a rule that
leaks through the total, through `?page_size=100`, and through the export --
this codebase has the scar (`view_renewals` was decorative until the window was
forced into `list_policies`'s own query).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from app.core.enums import AccountStatus, AccountType
from app.core.permissions import VIEW_ALL_POLICIES, can
from app.models.base import utcnow
from app.models.policy_access import PolicyAccessRequest, PolicyAccessStatus
from app.models.user import User


def sees_everything(actor: User) -> bool:
    """Is this account exempt from scoping altogether?

    The owner by account type, and anybody deliberately granted
    `view_all_policies`. Read through `can()` rather than off
    `actor.permissions`, because that list is a denormalised snapshot and the
    owner's goes stale -- the scar CLAUDE.md records under "Permission gotcha".
    """
    if actor.account_type == AccountType.OWNER:
        return True
    return can(actor, VIEW_ALL_POLICIES)


async def partner_ids_for(manager_id: str) -> list[str]:
    """The channel partners on one employee's roster, right now.

    ONE indexed query on `relationship_manager_id` (the index has existed since
    relationship managers replaced teams). Deactivated partners are INCLUDED
    deliberately: their policies are still live business the manager is
    answerable for, and a partner being switched off must not make last year's
    renewals invisible to the person who has to chase them.
    """
    if not manager_id:
        return []
    # Straight through the motor collection with an `_id`-only projection.
    # Hydrating thirty full User documents (permission lists, profiles, bank
    # details) to read thirty ids would be the `find_all()` shape CLAUDE.md asks
    # new reads not to widen, and this one runs on EVERY policy request.
    cursor = User.get_motor_collection().find({
        "account_type": AccountType.CHANNEL_PARTNER.value,
        "relationship_manager_id": manager_id,
        "is_deleted": {"$ne": True},
    }, {"_id": 1})
    return [str(doc["_id"]) async for doc in cursor]


async def granted_policy_ids(actor: User, *,
                             now: Optional[datetime] = None) -> list[str]:
    """Policies a LIVE JIT grant lets this person read.

    The window is compared in the QUERY (`expires_at > now`), so an approved
    grant that lapsed a minute ago is already out of the answer with no sweep
    having run. The sweep exists only to keep the queue readable -- see the note
    on `PolicyAccessRequest.is_live`.
    """
    rows = await PolicyAccessRequest.find({
        "requester_id": str(actor.id),
        "status": PolicyAccessStatus.APPROVED,
        "expires_at": {"$gt": now or utcnow()},
    }).to_list()
    return [r.policy_id for r in rows]


async def visible_filter(actor: User, *,
                         now: Optional[datetime] = None) -> Optional[dict]:
    """The Mongo clause limiting a query to what `actor` may read.

    `None` means "no limit" and callers must treat it as such rather than as an
    empty dict -- an empty `$or` is a query that matches nothing, which is the
    opposite failure and the kind that looks like "the page is broken" rather
    than "the page is leaking".
    """
    if sees_everything(actor):
        return None

    me = str(actor.id)
    clauses: list[dict] = [{"owner_user_id": me}]

    partners = await partner_ids_for(me)
    if partners:
        clauses.append({"partner_id": {"$in": partners}})

    granted = await granted_policy_ids(actor, now=now)
    if granted:
        # Matching on the STRING id would never hit -- `_id` is an ObjectId.
        from beanie import PydanticObjectId
        ids = []
        for pid in granted:
            try:
                ids.append(PydanticObjectId(pid))
            except Exception:  # noqa: BLE001 -- a grant on a deleted policy
                continue
        if ids:
            clauses.append({"_id": {"$in": ids}})

    return {"$or": clauses}


def merge(base: dict, scope: Optional[dict]) -> dict:
    """Add the scope to a query that may already carry its own `$or`.

    THE TRAP THIS FUNCTION EXISTS FOR: `list_policies` builds `base["$or"]` for
    the search box. Assigning the scope's `$or` on top would REPLACE it, and the
    two would silently become one -- a search for a customer name would match
    any policy whose customer matched OR which the caller owned, which is both
    the wrong results and a leak.

    Two `$or`s must be AND-ed, and `$and` is the only spelling of that Mongo
    accepts, so the merge is explicit rather than a dict update.
    """
    if scope is None:
        return base
    if not base:
        return dict(scope)
    return {"$and": [base, scope]}


async def can_see(actor: User, policy, *,
                  now: Optional[datetime] = None) -> bool:
    """May `actor` read this ALREADY-LOADED policy?

    The single-record counterpart of `visible_filter`, written against the same
    three clauses in the same order so the two cannot disagree about one policy.
    A record page that shows what a list hides is the classic way a scope is
    found to be decorative.
    """
    if sees_everything(actor):
        return True
    me = str(actor.id)
    if policy.owner_user_id == me:
        return True
    if policy.partner_id and policy.partner_id in await partner_ids_for(me):
        return True
    return str(policy.id) in await granted_policy_ids(actor, now=now)


async def assert_can_see(actor: User, policy, *,
                         now: Optional[datetime] = None) -> None:
    """404 when `actor` may not read this policy.

    A 404 AND NOT A 403, matching the rule the partner portal already follows: a
    403 confirms the record exists, which is exactly the fact being withheld.
    The one place that deliberately says "it exists and you cannot see it" is
    the restricted-search endpoint, where saying so IS the feature -- and that
    one returns a code and a holder's name and nothing else.
    """
    if await can_see(actor, policy, now=now):
        return
    from fastapi import HTTPException, status
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")


async def scope_note(actor: User) -> dict:
    """What the Policies page tells the person about what they are looking at.

    A scoped list that does not SAY it is scoped reads as a list with rows
    missing, and the first assumption is that the software lost them. This is
    the sentence under the heading, computed server-side so the page cannot
    invent a different one.
    """
    if sees_everything(actor):
        return {"scoped": False, "partner_count": 0,
                "label": "Every policy in the agency."}
    partners = await partner_ids_for(str(actor.id))
    n = len(partners)
    if n == 0:
        label = ("Policies you booked. Channel partners assigned to you will "
                 "appear here too.")
    else:
        label = (f"Policies you booked, and those from your "
                 f"{n} channel partner{'' if n == 1 else 's'}.")
    return {"scoped": True, "partner_count": n, "label": label}


# =============================================================================
# Reassignment
# =============================================================================


async def roster_move_summary(partner: User, new_manager_id: Optional[str]
                              ) -> dict:
    """What moving one partner is about to change, BEFORE it is done.

    The confirmation the reassignment dialog shows. Moving a partner silently
    moves an entire book of business between two people's screens, and the
    person doing it should see the number first -- "12 policies move to Rahul"
    is a sentence somebody can sanity-check; a toast saying "Saved" is not.

    Deliberately reports the POLICY COUNT and not a list. The count is the
    decision; the list is a report, and it belongs on the partner's own record
    where it already lives.
    """
    from app.models.policy import Policy

    partner_id = str(partner.id)
    count = await Policy.find({"partner_id": partner_id}).count()
    old_name = new_name = None
    if partner.relationship_manager_id:
        old = await User.get(partner.relationship_manager_id)
        old_name = old.full_name if old else None
    if new_manager_id:
        new = await User.get(new_manager_id)
        new_name = new.full_name if new else None
    return {
        "partner_id": partner_id,
        "partner_name": partner.full_name,
        "policy_count": count,
        "from_manager": old_name,
        "to_manager": new_name,
    }


async def assignable_manager_ids() -> set[str]:
    """Active employees a partner may be moved to.

    Used to refuse a reassignment onto a deactivated account before it happens.
    An orphaned partner is a partner nobody calls (owner T5.2) and moving one
    onto somebody who cannot sign in produces exactly that, with no error.
    """
    rows = await User.find({
        "account_type": {"$in": [AccountType.EMPLOYEE.value,
                                 AccountType.OWNER.value]},
        "status": AccountStatus.ACTIVE.value,
        "is_deleted": {"$ne": True},
    }).to_list()
    return {str(u.id) for u in rows}
