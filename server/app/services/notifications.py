"""Create + fan-out in-app notifications.

`create_notification` writes a single recipient row. `notify_permission` fans a
notification out to every active in-house user who holds a permission. All
helpers swallow their own errors so a notification never breaks the action that
triggered it.

WHY notify_permission DOES NOT JUST QUERY `permissions` (2026-08-19)
-------------------------------------------------------------------
It used to, and the docstring even claimed "owners always qualify — their
permission set is the full list". That claim is exactly what CLAUDE.md documents
as false: `User.permissions` is a DENORMALISED SNAPSHOT. The owner is written
once by scripts/create_owner.py and never re-saved, and an employee's list is
only rewritten on account edit. So the moment a new flag is added, a Mongo query
for `{"permissions": <new flag>}` matches NOBODY — and every notification that
fires on it is silently sent to an empty list. No error, no log line; the
feature simply never tells anyone anything.

The same two defences the rest of the app uses apply here:
  * the owner qualifies for every flag BY DEFINITION, resolved in code rather
    than read off a document that may predate the flag
  * an account still carrying the pre-split vocabulary is translated at read
    time, exactly as core.permissions.effective_permissions does

which is why this now filters in Python over in-house accounts instead of
pushing the predicate into the query. The candidate set is the STAFF LIST — tens
of rows, not the policy book — so this is not the `find_all()` pattern
CLAUDE.md asks new finance reads not to widen.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.core.enums import INHOUSE_ACCOUNTS
from app.core.permissions import can
from app.models.notification import Notification
from app.models.user import User

log = logging.getLogger(__name__)


async def create_notification(
    user_id: str, title: str, *, body: Optional[str] = None,
    category: Optional[str] = None, link: Optional[str] = None,
) -> Optional[Notification]:
    try:
        n = Notification(user_id=user_id, title=title, body=body,
                         category=category, link=link)
        await n.insert()
        return n
    except Exception:  # noqa: BLE001 — notifications are best-effort
        log.exception("Failed to create notification for %s", user_id)
        return None


async def notify_permission(
    permission: str, title: str, *, body: Optional[str] = None,
    category: Optional[str] = None, link: Optional[str] = None,
    exclude_user_id: Optional[str] = None,
) -> int:
    """Notify every active in-house user who holds `permission`. Returns the
    number of notifications created.

    "Holds" is decided by `core.permissions.can`, not by the stored list — see
    the module docstring for why that distinction is the whole point.
    """
    try:
        candidates = await User.find({
            "account_type": {"$in": list(INHOUSE_ACCOUNTS)},
            "is_deleted": {"$ne": True},
        }).to_list()
    except Exception:  # noqa: BLE001
        log.exception("Failed to resolve recipients for %s", permission)
        return 0

    count = 0
    for u in candidates:
        if exclude_user_id and str(u.id) == exclude_user_id:
            continue
        if not can(u, permission):
            continue
        if await create_notification(str(u.id), title, body=body,
                                     category=category, link=link):
            count += 1
    return count
