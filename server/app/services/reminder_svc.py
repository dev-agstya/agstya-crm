"""Follow-up reminders: due-date maths, the bell, and the daily email digest.

Kept separate from services/reminders.py (which sends policy RENEWAL emails to
customers) because these two things are only related by the word "reminder": one
chases a customer about an expiring policy, the other tells a staff member to
call a lead back.

Timing rule: a reminder is DUE when its due_at has passed in IST. "Today" means
the Indian calendar day, so a 9 pm reminder set on the 3rd is due on the 3rd, not
the 4th — the same storage-UTC / boundaries-IST split the finance code uses.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from app.models.reminder import (
    REMINDER_CANCELLED,
    REMINDER_DONE,
    REMINDER_OPEN,
    Reminder,
)
from app.models.base import utcnow
from app.models.user import User
from app.services import notifications
from app.services.finance_reports import IST, to_ist

log = logging.getLogger("agastyacrm.reminders")


def end_of_day_ist(now: Optional[datetime] = None) -> datetime:
    """The last instant of `now`'s IST day, as a tz-aware datetime.

    This is the cut-off for "due today": everything at or before it is owed.
    """
    d = to_ist(now or utcnow())
    return datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=IST)


def start_of_day_ist(now: Optional[datetime] = None) -> datetime:
    d = to_ist(now or utcnow())
    return datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=IST)


def is_overdue(reminder: Reminder, now: Optional[datetime] = None) -> bool:
    """Past its due time AND still open. A reminder due later today is not
    overdue — it is simply due."""
    if reminder.status != REMINDER_OPEN:
        return False
    return to_ist(reminder.due_at) < to_ist(now or utcnow())


def is_due_today(reminder: Reminder, now: Optional[datetime] = None) -> bool:
    if reminder.status != REMINDER_OPEN:
        return False
    return start_of_day_ist(now) <= to_ist(reminder.due_at) <= end_of_day_ist(now)


async def open_for_entity(entity_type: str, entity_id: str) -> list[Reminder]:
    return await Reminder.find(
        Reminder.entity_type == entity_type,
        Reminder.entity_id == entity_id,
        Reminder.status == REMINDER_OPEN).sort("+due_at").to_list()


async def next_open_by_entity(entity_type: str, entity_ids: list[str]
                              ) -> dict[str, tuple[Reminder, int]]:
    """{entity_id: (soonest open reminder, how many open in total)}.

    ONE indexed query for a whole page of rows, not one per row. The Leads list
    shows a countdown per lead, and doing that naively would turn a 15-row page
    into 15 extra round-trips — the reason reminders live in their own
    collection is that this kind of lookup has to stay a single indexed read.

    Sorted by due date so the first hit per entity IS the soonest; the count is
    accumulated in the same pass rather than a second query.
    """
    if not entity_ids:
        return {}
    out: dict[str, tuple[Reminder, int]] = {}
    async for r in Reminder.find(
            {"entity_type": entity_type,
             "entity_id": {"$in": list(entity_ids)},
             "status": REMINDER_OPEN}).sort("+due_at"):
        existing = out.get(r.entity_id)
        if existing is None:
            out[r.entity_id] = (r, 1)
        else:
            out[r.entity_id] = (existing[0], existing[1] + 1)
    return out


async def close_for_entity(entity_type: str, entity_id: str, *,
                           reason: str = "closed") -> int:
    """Cancel every open reminder on a record that is going away.

    Called when a lead is finished — moved to `converted` or `lost` — or
    deleted (owner A2.5 / Q2.3: chasing a finished lead is noise). Since the
    convert endpoint was removed the lead now STAYS in the list, so this is the
    only thing stopping its reminders nagging forever. Returns how many closed.
    """
    count = 0
    async for r in Reminder.find(
            Reminder.entity_type == entity_type,
            Reminder.entity_id == entity_id,
            Reminder.status == REMINDER_OPEN):
        r.status = REMINDER_CANCELLED
        r.completed_at = utcnow()
        r.note = f"{r.note}\n({reason})" if r.note else f"({reason})"
        r.updated_at = utcnow()
        await r.save()
        count += 1
    return count


async def hand_over_on_deactivation(
    leaving_user_id: str, *, to_user: User,
) -> int:
    """Take a deactivated person off their open reminders, and rescue the ones
    that would be left with nobody on them. Returns how many were re-assigned.

    THE BUG: a reminder is SHARED — `assignee_ids` is a list and the query that
    finds "what is due for me" is `{"assignee_ids": <id>}`. Nothing ever removed
    a deactivated account from that list, so their open follow-ups kept the
    switched-off person's name on them. Where they were the ONLY name, the task
    stopped appearing in anybody's bell and anybody's 08:00 digest — the lead
    was not dropped, it was invisibly dropped, which is worse. This is exactly
    the reasoning behind the existing rule that an employee holding channel
    partners cannot be deactivated (owner T5.2), applied to the other thing they
    hold.

    Two cases, deliberately different:
      * the reminder has OTHER assignees -> just drop the leaver. It is still
        somebody's job, and adding a name nobody asked for would be noise.
      * the leaver was the only one -> hand it to `to_user`, who is the person
        performing the deactivation. A real, present human who has just made a
        decision about this account is a far better owner than a rule that picks
        somebody by hierarchy — and the alternative, leaving it unassigned, is
        the orphan this function exists to prevent.

    Never raises: switching an account off must not fail because a reminder
    could not be moved. A caller that swallows this gets the old behaviour, not
    a broken deactivation.
    """
    moved = 0
    try:
        rows = await Reminder.find({
            "assignee_ids": leaving_user_id,
            "status": REMINDER_OPEN,
        }).to_list()
    except Exception:  # noqa: BLE001
        log.exception("Could not load reminders for %s", leaving_user_id)
        return 0

    for r in rows:
        try:
            keep = [(uid, name) for uid, name
                    in zip(r.assignee_ids, _padded_names(r))
                    if uid != leaving_user_id]
            if keep:
                r.assignee_ids = [uid for uid, _ in keep]
                r.assignee_names = [name for _, name in keep]
            else:
                r.assignee_ids = [str(to_user.id)]
                r.assignee_names = [to_user.full_name]
                # They have not been told about this one, so let the bell ring
                # for them — the same reason adding somebody to an existing
                # reminder clears this stamp.
                r.notified_at = None
                moved += 1
            r.updated_at = utcnow()
            await r.save()
        except Exception:  # noqa: BLE001
            log.exception("Could not hand over reminder %s", r.id)

    if moved:
        await notifications.create_notification(
            str(to_user.id),
            f"{moved} follow-up{'s' if moved != 1 else ''} moved to you",
            body="They were the only person on them, and that account has "
                 "just been deactivated.",
            category="reminder", link="/leads")
    return moved


def _padded_names(r: Reminder) -> list[str]:
    """`assignee_names` alongside `assignee_ids`, padded when they disagree.

    The two lists are written together everywhere, but they are two lists — a
    row written by an older version, or a partially-applied edit, can be short.
    Zipping them raw would silently DROP the trailing assignees, which on this
    path means dropping people off a reminder while claiming to have tidied it.
    """
    names = list(r.assignee_names)
    while len(names) < len(r.assignee_ids):
        names.append("")
    return names


async def due_for_user(user_id: str, *, now: Optional[datetime] = None,
                       horizon_days: int = 0) -> list[Reminder]:
    """One person's open reminders due by the end of today IST (+ horizon).

    "Theirs" includes every shared reminder they are named on, not only ones
    where they are the sole assignee — equality against the array matches any
    element and still uses the multikey index.
    """
    cutoff = end_of_day_ist(now) + timedelta(days=horizon_days)
    return await Reminder.find(
        {"assignee_ids": user_id},
        Reminder.status == REMINDER_OPEN,
        {"due_at": {"$lte": cutoff}}).sort("+due_at").to_list()


async def ring_bells(now: Optional[datetime] = None) -> int:
    """Raise an in-app notification for every reminder that has come due and
    has not been announced yet.

    `notified_at` is what makes this exactly-once: the daily digest keeps
    listing an overdue reminder until it is done (owner A2.6), but the bell
    rings for it only the first time.

    A shared reminder rings for EVERY person named on it (owner Q3.4) — one
    notification each, one `notified_at` on the reminder. Returns the number of
    notifications raised, not the number of reminders, because that is what
    "how much did the run tell people" means.
    """
    cutoff = end_of_day_ist(now)
    rung = 0
    async for r in Reminder.find(
            Reminder.status == REMINDER_OPEN,
            {"due_at": {"$lte": cutoff}, "notified_at": None}):
        label = r.entity_label or r.entity_code or "a record"
        shared = len(r.assignee_ids) > 1
        for user_id in r.assignee_ids:
            await notifications.create_notification(
                user_id, f"Reminder: {r.title}",
                body=f"Follow up on {label}."
                     + (f" {r.note}" if r.note else "")
                     # Say it is shared, so nobody assumes a colleague has it
                     # and nobody duplicates the call.
                     + (f" (shared with {len(r.assignee_ids) - 1} other"
                        f"{'s' if len(r.assignee_ids) > 2 else ''})"
                        if shared else ""),
                category="reminder",
                link="/leads" if r.entity_type == "lead" else None)
            rung += 1
        # Stamped once per reminder, after everyone has been told. A crash
        # part-way re-rings the whole reminder on the next run — a duplicate
        # bell is a far smaller problem than a follow-up nobody hears about.
        r.notified_at = utcnow()
        await r.save()
    return rung


async def send_daily_digest(now: Optional[datetime] = None) -> dict:
    """Email each person one list of what they owe today plus anything overdue.

    One email per person per run — not one per reminder, which is how a
    reminder feature turns into a thing people filter out of their inbox.
    Runs from the existing 08:00 IST cron (server/send_reminders.py).

    A shared reminder appears in the digest of every person named on it (owner
    Q3.6) — that is the point of sharing it — so one reminder can contribute a
    row to several emails.
    """
    from app.services import email as email_svc

    now = now or utcnow()
    cutoff = end_of_day_ist(now)
    by_user: dict[str, list[Reminder]] = {}
    async for r in Reminder.find(Reminder.status == REMINDER_OPEN,
                                 {"due_at": {"$lte": cutoff}}):
        for user_id in r.assignee_ids:
            by_user.setdefault(user_id, []).append(r)

    sent = failed = 0
    for user_id, items in by_user.items():
        user = None
        try:
            from beanie import PydanticObjectId
            user = await User.get(PydanticObjectId(user_id))
        except Exception:  # noqa: BLE001 — a deleted assignee just gets skipped
            user = None
        if user is None or not user.email or user.is_deleted:
            continue
        items.sort(key=lambda r: r.due_at)
        rows = [{
            "title": r.title,
            "entity": r.entity_label or r.entity_code or "",
            "due": to_ist(r.due_at).strftime("%d %b %Y, %I:%M %p"),
            "overdue": is_overdue(r, now),
            "note": r.note or "",
            # Everyone else on a shared reminder, so the reader knows whether
            # this is theirs alone or a task the desk shares.
            "shared_with": [n for i, n in enumerate(r.assignee_names)
                            if i < len(r.assignee_ids)
                            and r.assignee_ids[i] != user_id],
        } for r in items]
        try:
            await email_svc.send_reminder_digest_email(
                user.email, user.full_name, rows)
            sent += 1
        except Exception:  # noqa: BLE001 — one bad address must not stop the run
            failed += 1
            log.exception("Reminder digest failed for %s", user_id)

    summary = {"recipients": len(by_user), "sent": sent, "failed": failed}
    log.info("Reminder digest run: %s", summary)
    return summary


async def run_daily(now: Optional[datetime] = None) -> dict:
    """Everything the daily cron does for follow-up reminders."""
    rung = await ring_bells(now)
    digest = await send_daily_digest(now)
    return {"bells": rung, **digest}


__all__ = [
    "REMINDER_OPEN", "REMINDER_DONE", "REMINDER_CANCELLED",
    "close_for_entity", "due_for_user", "end_of_day_ist", "is_due_today",
    "is_overdue", "next_open_by_entity", "open_for_entity", "ring_bells",
    "run_daily", "send_daily_digest", "start_of_day_ist",
]
