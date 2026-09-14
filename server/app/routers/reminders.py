"""Follow-up reminders on leads (and, later, customers and policies).

Permissions follow the record the reminder hangs off, not a flag of their own: if
you can see the Leads page (view_policies) you can see and set reminders on a
lead. A reminder is a note-to-self, not a new class of data — giving it its own
permission would mean an executive who can work the pipeline cannot remind
themselves to call someone back.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction, is_inhouse
from app.core.permissions import VIEW_LEADS
from app.models.base import utcnow
from app.models.customer import Customer
from app.models.lead import Lead
from app.models.policy import Policy
from app.models.reminder import (
    REMINDER_CANCELLED,
    REMINDER_DONE,
    REMINDER_ENTITIES,
    REMINDER_OPEN,
    REMINDER_STATUSES,
    Reminder,
)
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message
from app.schemas.reminder import (
    ReminderCounts,
    ReminderCreate,
    ReminderOut,
    ReminderUpdate,
)
from app.services import reminder_svc
from app.services.audit import log_action

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/reminders", tags=["reminders"],
                   dependencies=[Depends(get_inhouse_user)])


# A form can sit open for a moment between "now" being read in the browser and
# the request landing. Rejecting to the exact second would fail a reminder set
# for "in one minute" purely on network latency, so a minute of slack is allowed
# on the boundary — small enough that nobody can schedule anything meaningful in
# the past through it.
DUE_GRACE = timedelta(seconds=60)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _ensure_future(due: datetime) -> datetime:
    """A reminder is a promise about the future (owner 2026-08-04).

    A due date already gone would be born overdue: `ring_bells` only ever looks
    forward from the moment it runs, so the bell for it has no moment left to
    ring in, and the 08:00 digest would carry it as "late" the first morning
    anyone saw it. Refusing it at the door is the only place the rule holds —
    the browser check is a courtesy, not the guard.
    """
    aware = _aware(due)
    if aware < utcnow() - DUE_GRACE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A reminder has to be set for a future date and time.")
    return aware


async def _describe(entity_type: str, entity_id: str) -> tuple[str, str]:
    """(label, code) for the record a reminder hangs off.

    Denormalised onto the reminder so the digest email and the "my reminders"
    list can name what needs chasing without loading every linked record.
    """
    try:
        oid = await parse_object_id(entity_id)
    except HTTPException:
        raise
    if entity_type == "lead":
        lead = await Lead.get(oid)
        if lead is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Lead not found.")
        return lead.name, lead.code
    if entity_type == "customer":
        cust = await Customer.get(oid)
        if cust is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found.")
        return cust.name, cust.code
    if entity_type == "policy":
        pol = await Policy.get(oid)
        if pol is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")
        return pol.code, pol.code
    if entity_type == "channel_partner":
        from app.core.enums import AccountType
        from app.models.user import User

        partner = await User.get(oid)
        if partner is None                 or partner.account_type != AccountType.CHANNEL_PARTNER:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                "Channel partner not found.")
        return partner.full_name, partner.code
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        "Reminders can only be set on a lead, customer, policy or channel "
        "partner.")


async def _load(reminder_id: str) -> Reminder:
    reminder = await Reminder.get(await parse_object_id(reminder_id))
    if reminder is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reminder not found.")
    return reminder


async def _resolve_assignees(ids: list[str], *, fallback: User
                             ) -> tuple[list[str], list[str]]:
    """Turn requested assignee ids into (ids, names), or raise.

    An empty list means "me" — creating a reminder with nobody on it would be a
    task nobody is ever told about, and that is never what was meant. Order is
    preserved (the picker's order is the order they were chosen) and duplicates
    are dropped, so the same person named twice does not get two bells.
    """
    if not ids:
        return [str(fallback.id)], [fallback.full_name]

    seen: list[str] = []
    for uid in ids:
        if uid not in seen:
            seen.append(uid)

    resolved_ids: list[str] = []
    names: list[str] = []
    for uid in seen:
        if uid == str(fallback.id):
            resolved_ids.append(uid)
            names.append(fallback.full_name)
            continue
        target = await User.get(await parse_object_id(uid))
        # Staff only (owner Q3.3). A channel partner cannot reach this router at
        # all, and must not be given work through it either.
        if target is None or not is_inhouse(target.account_type):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Reminders can only be assigned to a colleague.")
        resolved_ids.append(str(target.id))
        names.append(target.full_name)
    return resolved_ids, names


@router.get("", response_model=list[ReminderOut],
            dependencies=[Depends(require_permission(VIEW_LEADS))])
async def list_reminders(
    actor: User = Depends(get_active_user),
    entity_type: str | None = Query(default=None),
    entity_id: str | None = Query(default=None),
    assigned_to: str | None = Query(default=None),
    scope: str = Query(default="mine", pattern="^(mine|all|entity)$"),
    status_filter: str | None = Query(default=None, alias="status"),
    due: str | None = Query(default=None, pattern="^(today|overdue|week)$"),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[ReminderOut]:
    """Reminders, filtered.

    `scope=mine` (the default) is what the dashboard tile and the bell use;
    `scope=entity` lists one record's timeline; `scope=all` is the team view.
    """
    query: dict = {}
    if scope == "entity" or entity_id:
        if not entity_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "entity_id is required for this scope.")
        query["entity_id"] = entity_id
        if entity_type:
            query["entity_type"] = entity_type
    elif scope == "mine":
        # Equality against an array field matches if ANY element matches, so
        # this is "reminders I am one of the people on" and it still uses the
        # multikey index.
        query["assignee_ids"] = str(actor.id)
    elif assigned_to:
        query["assignee_ids"] = assigned_to

    query["status"] = status_filter if status_filter in REMINDER_STATUSES \
        else REMINDER_OPEN
    now = utcnow()
    if due == "today":
        query["due_at"] = {"$lte": reminder_svc.end_of_day_ist(now)}
    elif due == "overdue":
        query["due_at"] = {"$lt": now}
    elif due == "week":
        query["due_at"] = {"$lte": reminder_svc.end_of_day_ist(now)
                           + timedelta(days=7)}

    rows = await Reminder.find(query).sort("+due_at").limit(limit).to_list()
    return [ReminderOut.from_model(r) for r in rows]


@router.get("/counts", response_model=ReminderCounts,
            dependencies=[Depends(require_permission(VIEW_LEADS))])
async def reminder_counts(
    actor: User = Depends(get_active_user),
    scope: str = Query(default="mine", pattern="^(mine|all)$"),
) -> ReminderCounts:
    """Badge numbers. Three counts, three indexed queries — never a scan."""
    base: dict = {"status": REMINDER_OPEN}
    if scope == "mine":
        base["assignee_ids"] = str(actor.id)
    now = utcnow()
    return ReminderCounts(
        open=await Reminder.find(base).count(),
        due_today=await Reminder.find({
            **base, "due_at": {"$lte": reminder_svc.end_of_day_ist(now)}}).count(),
        overdue=await Reminder.find({**base, "due_at": {"$lt": now}}).count(),
    )


@router.post("", response_model=ReminderOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(VIEW_LEADS))])
async def create_reminder(payload: ReminderCreate,
                          actor: User = Depends(get_active_user)) -> ReminderOut:
    if payload.entity_type not in REMINDER_ENTITIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Reminders can only be set on a lead, customer or "
                            "policy.")
    label, code = await _describe(payload.entity_type, payload.entity_id)
    ids, names = await _resolve_assignees(payload.assignee_ids, fallback=actor)

    reminder = Reminder(
        entity_type=payload.entity_type, entity_id=payload.entity_id,
        entity_label=label, entity_code=code,
        title=payload.title.strip(), note=payload.note,
        due_at=_ensure_future(payload.due_at),
        assignee_ids=ids, assignee_names=names,
        created_by=str(actor.id), created_by_name=actor.full_name,
    )
    await reminder.insert()
    await log_action(
        AuditAction.REMINDER_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="reminder", entity_id=str(reminder.id), entity_code=code,
        summary=f"Set a reminder on {label} for {', '.join(names)}: "
                f"{reminder.title}")
    return ReminderOut.from_model(reminder)


@router.patch("/{reminder_id}", response_model=ReminderOut,
              dependencies=[Depends(require_permission(VIEW_LEADS))])
async def update_reminder(reminder_id: str, payload: ReminderUpdate,
                          actor: User = Depends(get_active_user)) -> ReminderOut:
    reminder = await _load(reminder_id)
    data = payload.model_dump(exclude_unset=True)

    if "title" in data and data["title"]:
        reminder.title = data["title"].strip()
    if "note" in data:
        reminder.note = data["note"]
    if data.get("due_at"):
        wanted = _aware(data["due_at"])
        # Only a CHANGED date has to be in the future. Re-saving an already
        # overdue reminder — fixing a typo in its title, adding a colleague —
        # sends the stored date back unchanged, and refusing that would make an
        # overdue reminder uneditable until it was rescheduled.
        if wanted != _aware(reminder.due_at):
            reminder.due_at = _ensure_future(wanted)
            # A new date is a new promise: let the bell ring again for it.
            reminder.notified_at = None
    if "assignee_ids" in data:
        if not data["assignee_ids"]:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "A reminder needs at least one person on it.")
        ids, names = await _resolve_assignees(data["assignee_ids"],
                                              fallback=actor)
        # Someone added to an existing reminder has not been told about it yet,
        # so let the bell ring again rather than treating the whole reminder as
        # already announced.
        if set(ids) - set(reminder.assignee_ids):
            reminder.notified_at = None
        reminder.assignee_ids = ids
        reminder.assignee_names = names
    if data.get("status"):
        if data["status"] not in REMINDER_STATUSES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown status.")
        reminder.status = data["status"]
        if reminder.status in (REMINDER_DONE, REMINDER_CANCELLED):
            # Shared reminder: whoever gets there first closes it for everyone
            # (owner Q3.2a), so record who that was.
            reminder.completed_at = utcnow()
            reminder.completed_by = str(actor.id)
            reminder.completed_by_name = actor.full_name
        else:
            reminder.completed_at = None
            reminder.completed_by = None
            reminder.completed_by_name = None
    reminder.updated_at = utcnow()
    await reminder.save()

    await log_action(
        AuditAction.REMINDER_COMPLETED if reminder.status == REMINDER_DONE
        else AuditAction.REMINDER_UPDATED,
        actor_id=str(actor.id), actor_name=actor.full_name,
        actor_role=actor.account_type.value, entity_type="reminder",
        entity_id=reminder_id, entity_code=reminder.entity_code,
        summary=f"{'Completed' if reminder.status == REMINDER_DONE else 'Updated'}"
                f" reminder: {reminder.title}")
    return ReminderOut.from_model(reminder)


@router.post("/{reminder_id}/done", response_model=ReminderOut,
             dependencies=[Depends(require_permission(VIEW_LEADS))])
async def complete_reminder(reminder_id: str,
                            actor: User = Depends(get_active_user)
                            ) -> ReminderOut:
    """One-click "done" — the action almost every reminder ends with."""
    return await update_reminder(reminder_id, ReminderUpdate(status=REMINDER_DONE),
                                 actor)


@router.post("/{reminder_id}/snooze", response_model=ReminderOut,
             dependencies=[Depends(require_permission(VIEW_LEADS))])
async def snooze_reminder(reminder_id: str,
                          days: int = Query(default=1, ge=1, le=90),
                          actor: User = Depends(get_active_user)) -> ReminderOut:
    """Push a reminder out by `days`. Owner A2.4: this plus "create the next
    one" is what people actually want, rather than recurring reminders."""
    reminder = await _load(reminder_id)
    reminder.due_at = _aware(reminder.due_at) + timedelta(days=days)
    reminder.status = REMINDER_OPEN
    reminder.notified_at = None
    reminder.updated_at = utcnow()
    await reminder.save()
    return ReminderOut.from_model(reminder)


@router.delete("/{reminder_id}", response_model=Message,
               dependencies=[Depends(require_permission(VIEW_LEADS))])
async def delete_reminder(reminder_id: str,
                          actor: User = Depends(get_active_user)) -> Message:
    reminder = await _load(reminder_id)
    title = reminder.title
    await reminder.delete()
    await log_action(
        AuditAction.REMINDER_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="reminder", entity_id=reminder_id,
        summary=f"Deleted reminder: {title}")
    return Message(detail="Reminder deleted.")
