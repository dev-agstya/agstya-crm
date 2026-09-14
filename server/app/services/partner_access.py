"""Opening the Channel Partner portal to the partners already on file.

Partners created before the portal shipped carry `portal_access=False`, because
that was the default at the time. Creation grants it now, but those older rows
would still be locked out — so this runs ONCE, on the boot that ships the
portal, and lets them in.

Why a one-time backfill rather than "treat False as not-yet-decided":
`portal_access=False` means two different things depending on WHEN it was
written. Before the portal existed nobody could be let in, so nobody could
meaningfully be shut out — a False from that period is an absence of a decision.
After launch it is a revocation somebody made on purpose, and it has to stick.
The `access_backfilled_at` stamp on SystemSettings is the line between the two,
which is why the marker lives in the database and not in code.
"""

from __future__ import annotations

import logging

from app.core.enums import AccountType
from app.models.base import utcnow
from app.models.user import User
from app.services import settings_svc

logger = logging.getLogger("agastyacrm.partner_access")


async def open_portal_to_existing_partners() -> int:
    """Grant portal access to every channel partner created before launch.

    A no-op once it has run. Returns the number of accounts granted (0 when it
    did nothing), so the caller can log something meaningful.
    """
    doc = await settings_svc.get_settings()
    if doc.partner_portal.access_backfilled_at is not None:
        return 0

    result = await User.get_motor_collection().update_many(
        {"account_type": AccountType.CHANNEL_PARTNER.value,
         "portal_access": {"$ne": True}},
        {"$set": {"portal_access": True, "updated_at": utcnow()}},
    )
    granted = int(getattr(result, "modified_count", 0) or 0)

    # Stamp AFTER the grant. If the process dies between the two the backfill
    # simply runs again on the next boot and grants the rest — the update is
    # idempotent. Stamping first would strand whoever was missed.
    doc.partner_portal.access_backfilled_at = utcnow()
    await doc.save()
    settings_svc.invalidate()

    logger.info(
        "Partner portal: granted access to %d existing channel partner(s).",
        granted)
    return granted
