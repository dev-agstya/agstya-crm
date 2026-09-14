"""Stamping the relationship manager onto policies booked before the field existed.

Policies used to carry a frozen copy of the booking user's TEAM. Teams were
removed on 2026-08-05 in favour of a single hierarchy — a channel partner sits
under exactly one employee, their relationship manager — and policies now carry
a frozen `manager_id` / `manager_name` instead (services/policy_ops.stamp_manager).

Every policy booked before that change has no manager stamp, so without this
they would all pile into "Unassigned" on the Relationship Managers page and the
history the frozen stamp exists to protect would be lost on day one.

This resolves each one the same way `stamp_manager` does — partner's manager for
partner-sourced business, the booking employee for an in-house sale — and writes
it once.

It does NOT touch the old `team_id` / `team_name` values. They are simply no
longer on the model, so Beanie stops reading and writing them, and the data stays
in Mongo. Un-setting a field across every policy in the collection to tidy up is
not worth being unable to check the old attribution against the new one.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.core.enums import AccountType
from app.models.base import utcnow
from app.models.policy import Policy
from app.models.user import User
from app.services import settings_svc

logger = logging.getLogger("agastyacrm.manager_backfill")


async def backfill_policy_managers() -> int:
    """Stamp the relationship manager on every policy that has none.

    Idempotent and marked, like services/partner_access: it runs on the boot
    that ships the change and is a cheap no-op afterwards. Returns the number of
    policies stamped.

    The marker is checked BEFORE the query so an established deployment pays one
    settings read rather than a collection scan on every boot.
    """
    doc = await settings_svc.get_settings()
    if getattr(doc, "manager_backfilled_at", None) is not None:
        return 0

    # Everyone who could be the answer, in one read. The whole user collection
    # is a few hundred documents at most — a per-policy lookup would be
    # thousands of round trips for the same information.
    users: dict[str, User] = {}
    async for u in User.find_all():
        users[str(u.id)] = u

    def resolve(policy: Policy) -> Optional[User]:
        """Mirror of stamp_manager, against the pre-loaded users."""
        credited = policy.partner_id or policy.owner_user_id
        user = users.get(credited or "")
        if user is None:
            return None
        if user.account_type != AccountType.CHANNEL_PARTNER:
            return user
        return users.get(user.relationship_manager_id or "")

    stamped = 0
    collection = Policy.get_motor_collection()
    async for policy in Policy.find({"manager_id": None}):
        manager = resolve(policy)
        if manager is None:
            # A partner with no manager, or a deleted user. Left unstamped on
            # purpose: "Unassigned" is the honest answer, and guessing here
            # would put someone else's business on a manager's record.
            continue
        await collection.update_one(
            {"_id": policy.id},
            {"$set": {"manager_id": str(manager.id),
                      "manager_name": manager.full_name}},
        )
        stamped += 1

    # Stamp the marker AFTER the work. A crash in the middle simply resumes on
    # the next boot — every policy already done is skipped by the `manager_id:
    # None` filter, so re-running is free and cannot double-count.
    doc.manager_backfilled_at = utcnow()
    await doc.save()
    settings_svc.invalidate()

    logger.info("Relationship-manager backfill: stamped %d policy(ies).",
                stamped)
    return stamped
