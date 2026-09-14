"""Compute and denormalise a user's effective permissions.

Effective permissions:
  owner    -> ALL_PERMISSIONS
  partner   -> PARTNER_PERMISSIONS
  employee -> the employee's own permission set (extra_permissions)

Roles are reusable permission *bundles* used only as a bulk-apply helper in the
UI — they are NOT stored on the employee as a designation. The owner/manager
picks one or more roles to tick their permissions, then adds/removes individual
flags; the resulting flat set is what's stored.

The results are stored on the User (permissions) so request-time checks are a
single in-memory lookup. Call recompute after anything that could change them:
account creation and permission edits.

(Record-level data scoping was removed in v1 — all in-house staff share the
whole book.)
"""

from __future__ import annotations

import logging

from app.core.enums import AccountType
from app.core.permissions import (
    ALL_PERMISSIONS,
    PARTNER_PERMISSIONS,
    PERMISSIONS_VERSION,
    expand_permissions,
    migrate_legacy_permissions,
)
from app.models.base import utcnow
from app.models.role import Role
from app.models.user import User

log = logging.getLogger(__name__)


async def _legacy_seed(user: User) -> set[str]:
    """One-off migration: an employee from the old single-role model has an
    empty direct set but a legacy role_id — seed the direct set from that role."""
    if user.extra_permissions or not user.role_id:
        return set(user.extra_permissions or [])
    try:
        role = await Role.get(user.role_id)
    except Exception:  # noqa: BLE001 - malformed id
        role = None
    return set(role.permissions) if role else set()


def owner_permissions_are_stale(user: User) -> bool:
    """True when this owner's stored flag set is not the current full set.

    An owner's permissions are DERIVED (always ALL_PERMISSIONS) but STORED, and
    the store is only written when the account is created or edited. Add a new
    flag to the model and every existing owner is silently missing it — which is
    exactly how `manage_bank_accounts` (added 2026-08-02) left the owner unable
    to add a bank account on a page their own nav still showed them.
    """
    return user.account_type == AccountType.OWNER \
        and set(user.permissions) != set(ALL_PERMISSIONS)


async def heal_owner_permissions(user: User) -> User:
    """Bring an owner's stored permissions up to the current full set.

    Called on every authenticated request (core/dependencies.get_current_user),
    so a newly added flag reaches every owner on their next request instead of
    waiting for someone to re-save the account. The write only happens on the
    one request where the sets actually differ; after that this is a set
    comparison and nothing more.

    Kept as a targeted $set on the collection rather than user.save() so it
    cannot clobber a concurrent write to an unrelated field.
    """
    if not owner_permissions_are_stale(user):
        return user

    perms = list(ALL_PERMISSIONS)
    user.permissions = perms          # correct for THIS request, whatever follows
    try:
        await User.get_motor_collection().update_one(
            {"_id": user.id},
            {"$set": {"permissions": perms, "updated_at": utcnow()}},
        )
    except Exception:  # noqa: BLE001 - a failed heal must never break the request
        log.warning("could not persist healed owner permissions for %s",
                    user.id, exc_info=True)
    return user


# Who still needs translating into the post-split vocabulary.
#
# The `$exists` clause is the whole query, not a belt-and-braces extra.
# `{"permissions_version": {"$lt": 2}}` does NOT match a document where the
# field is ABSENT — Mongo's comparison operators only match values that exist
# and are of a comparable BSON type. Every account written before the field was
# added has no such key, so the obvious query matched exactly ZERO of the users
# who needed migrating, silently, on every boot forever. Verified against a real
# collection (16 users, 0 matched); it is not something a unit test on a dict
# would have caught, and it is the same family of bug as the invalid
# `partialFilterExpression` in db.py.
NEEDS_MIGRATION = {
    "$or": [
        {"permissions_version": {"$exists": False}},
        {"permissions_version": {"$lt": PERMISSIONS_VERSION}},
    ]
}


async def migrate_user_permissions(user: User) -> bool:
    """Rewrite one employee's stored flags into the current vocabulary.

    Returns True if anything was written. Idempotent via permissions_version:
    the translation itself is NOT safe to run twice (`view_policies` survived
    the split with a narrower meaning and would re-expand into the whole book),
    so the version stamp is the guard, not a property of the data.
    """
    if getattr(user, "permissions_version", 1) >= PERMISSIONS_VERSION:
        return False

    if user.account_type == AccountType.OWNER:
        perms = list(ALL_PERMISSIONS)
    elif user.account_type == AccountType.CHANNEL_PARTNER:
        perms = list(PARTNER_PERMISSIONS)
    else:
        perms = migrate_legacy_permissions(user.permissions
                                           or user.extra_permissions)

    user.permissions = perms
    user.extra_permissions = (perms if user.account_type == AccountType.EMPLOYEE
                              else [])
    user.permissions_version = PERMISSIONS_VERSION
    await User.get_motor_collection().update_one(
        {"_id": user.id},
        {"$set": {"permissions": perms,
                  "extra_permissions": user.extra_permissions,
                  "permissions_version": PERMISSIONS_VERSION,
                  "updated_at": utcnow()}},
    )
    return True


async def migrate_all_permissions() -> int:
    """Translate every account still on the pre-split vocabulary.

    Runs once at boot (app/main.py lifespan). Never fatal: `effective_permissions`
    applies the same translation at READ time for anyone this misses, so a failed
    or half-finished migration degrades to "correct but not yet persisted"
    rather than to "everyone lost their access". That read-time fallback is why
    this can be a plain loop rather than a transaction.
    """
    migrated = 0
    async for user in User.find(NEEDS_MIGRATION):
        try:
            if await migrate_user_permissions(user):
                migrated += 1
        except Exception:  # noqa: BLE001 - one bad document must not stop the rest
            log.warning("could not migrate permissions for %s", user.id,
                        exc_info=True)
    if migrated:
        log.info("migrated %s account(s) to permissions v%s",
                 migrated, PERMISSIONS_VERSION)
    return migrated


async def compute_effective(user: User) -> tuple[list[str], str | None]:
    """Return (permissions, role_name) for a user without saving."""
    if user.account_type == AccountType.OWNER:
        return list(ALL_PERMISSIONS), None
    if user.account_type == AccountType.CHANNEL_PARTNER:
        return list(PARTNER_PERMISSIONS), None

    # Employee: their own directly-managed permission set. expand_permissions
    # adds every implied flag (manage_x always carries view_x) and drops any key
    # that is no longer part of the model, so a stale flag can never survive.
    perms = await _legacy_seed(user)
    return expand_permissions(perms), None


async def recompute_permissions(user: User, *, save: bool = True) -> User:
    """Recompute and (by default) persist the user's effective RBAC fields."""
    perms, _ = await compute_effective(user)
    user.permissions = perms
    user.role_name = None
    if user.account_type == AccountType.EMPLOYEE:
        # Normalise the stored direct set and detach any legacy role link.
        user.extra_permissions = perms
        user.role_id = None
    # Anything written through here came from the current editor, so it is in the
    # current vocabulary by definition. Stamping it is what stops the legacy
    # translation running over a set somebody just deliberately chose — without
    # this, saving "policies only" would be re-read as the whole old book.
    user.permissions_version = PERMISSIONS_VERSION
    if save:
        await user.save()
    return user


async def cascade_role_change(role: Role) -> int:
    """No-op: roles are snapshots (bulk-apply templates), so editing a role does
    not retroactively change employees who were given its permissions."""
    return 0
