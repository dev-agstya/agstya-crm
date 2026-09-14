"""Automatic policy-renewal reminder emails.

Sends the expiry reminder to a policy's customer at fixed lead times before the
expiry date: 30, 15, 7 and 1 day before, and on the day of expiry. Each offset is
emailed at most once per policy (tracked in ``Policy.reminders_sent``).

Only ACTIVE / RENEWAL_DUE policies are considered, so a policy that has been
renewed (status -> RENEWED), cancelled, lapsed or expired is skipped automatically
— we never chase a customer about a policy they've already renewed.

Run daily via ``server/send_reminders.py`` (e.g. a Render Cron Job).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from app.core.enums import PolicyStatus
from app.models.customer import Customer
from app.models.policy import Policy
from app.services import messaging

logger = logging.getLogger("agastyacrm.reminders")

# Days-before-expiry at which to email (0 == on the day of expiry).
REMINDER_OFFSETS = [30, 15, 7, 1, 0]
_ELIGIBLE_STATUSES = [PolicyStatus.ACTIVE.value, PolicyStatus.RENEWAL_DUE.value]


def _day_bounds(target_date) -> tuple[datetime, datetime]:
    start = datetime(target_date.year, target_date.month, target_date.day,
                     tzinfo=timezone.utc)
    return start, start + timedelta(days=1)


async def send_due_reminders(now: datetime | None = None) -> dict:
    """Send all reminders due 'today'. Returns a summary dict.

    Idempotent within a day: an offset already recorded in reminders_sent is
    skipped, so re-running the job the same day won't double-send.
    """
    now = now or datetime.now(timezone.utc)
    today = now.date()

    sent = 0
    skipped_no_contact = 0
    failures = 0

    for offset in REMINDER_OFFSETS:
        target = today + timedelta(days=offset)
        start, end = _day_bounds(target)
        policies = await Policy.find({
            "status": {"$in": _ELIGIBLE_STATUSES},
            "expiry_date": {"$gte": start, "$lt": end},
            "reminders_sent": {"$ne": offset},
        }).to_list()

        for policy in policies:
            customer = await Customer.get(policy.customer_id)
            # A customer must have a mobile; email is an optional add-on. If we
            # have neither channel, nothing to do — record the offset so we don't
            # re-query it every day.
            if customer is None or not (customer.mobile or customer.email):
                skipped_no_contact += 1
                policy.reminders_sent.append(offset)
                await policy.save()
                continue

            try:
                result = await messaging.send_renewal_reminder(
                    policy, customer, days_left=offset)
                if result:
                    sent += 1
            except Exception:  # noqa: BLE001
                failures += 1
                logger.exception("Renewal reminder failed for %s", policy.code)
            # Mark as attempted regardless of delivery result to avoid retry storms.
            policy.reminders_sent.append(offset)
            await policy.save()

    summary = {"date": today.isoformat(), "sent": sent,
               "skipped_no_contact": skipped_no_contact, "failures": failures}
    logger.info("Renewal reminders run: %s", summary)
    return summary
