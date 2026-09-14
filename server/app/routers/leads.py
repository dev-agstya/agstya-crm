"""Lead pipeline: CRUD, stage moves, comments, and bulk import.

A lead carries a TYPE (customer / channel partner / business — owner 2026-08-03)
because the agency tracks all three kinds of prospect in one pipeline. The type
is what the tabs at the top of the page filter on; it does not change any rule
in here.

There is deliberately NO conversion endpoint. Converting used to create a
Customer and then DELETE the lead, which only ever made sense for one of the
three types and lost the pipeline record. A won lead is now simply moved to the
`converted` stage and stays in the list; the customer or channel partner is
created from its own page (owner Q2.1a).

Visibility & edit rules (per business spec):
  - In-house users (owner/manager/employee) see ALL leads — in-house and agent.
  - Agents see ONLY the leads they created (never other agents' or in-house leads).
  - An agent-created lead can be edited ONLY by that agent (in-house can view, not
    edit). An in-house lead can be edited by any in-house user with manage_leads.
  - Comments an in-house user leaves on an agent's lead are "internal" and hidden
    from the agent; the agent sees only their own comments. In-house sees all.
"""

from __future__ import annotations

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import (
    AuditAction,
    LeadStage,
    LeadType,
    RecordOrigin,
    is_inhouse,
)
from app.core.permissions import can, MANAGE_LEADS, VIEW_LEADS
from app.models.base import utcnow
from app.models.lead import Lead, LeadComment
from app.models.master import PolicyCategory
from app.models.user import User
from app.routers._helpers import (
    parse_object_id, read_upload, search_regex,
)
from app.schemas.common import Message, Page
from app.schemas.lead import (
    LeadCommentCreate,
    LeadCounts,
    LeadCreate,
    LeadImportFailure,
    LeadImportResult,
    LeadOut,
    LeadReminderSummary,
    LeadStageUpdate,
    LeadTypeCount,
    LeadUpdate,
)
from app.services import lead_activity, lead_import, reminder_svc
from app.services.audit import log_action
from app.services.codes import next_code
from app.services.exporters import export_response

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/leads", tags=["leads"],
                   dependencies=[Depends(get_inhouse_user)])

# Bulk-import limits. The file is read against the byte cap (read_upload) and
# the parsed row count is checked before any writing starts — an import does a
# few DB round-trips per row inside the 30s request timeout, so an unbounded
# file times out half-applied.
MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_ROWS = 5000


# --- Visibility / permission helpers -------------------------------------------


def _origin_value(lead: Lead) -> str:
    return lead.origin.value if hasattr(lead.origin, "value") else lead.origin


def _scope_query(actor: User) -> dict:
    if is_inhouse(actor.account_type):
        return {}
    return {"owner_user_id": str(actor.id), "origin": RecordOrigin.CHANNEL_PARTNER.value}


def _can_view(actor: User, lead: Lead) -> bool:
    if is_inhouse(actor.account_type):
        return True
    return (_origin_value(lead) == RecordOrigin.CHANNEL_PARTNER.value
            and lead.owner_user_id == str(actor.id))


def _can_edit(actor: User, lead: Lead) -> bool:
    if not can(actor, MANAGE_LEADS):
        return False
    if _origin_value(lead) == RecordOrigin.CHANNEL_PARTNER.value:
        # Only the agent who created it.
        return lead.owner_user_id == str(actor.id)
    # In-house lead: any in-house user.
    return is_inhouse(actor.account_type)


def _reminder_summary(upcoming: dict, lead: Lead
                      ) -> LeadReminderSummary | None:
    """Turn one entry from reminder_svc.next_open_by_entity into the list cell."""
    found = upcoming.get(str(lead.id))
    if not found:
        return None
    reminder, open_count = found
    return LeadReminderSummary(
        id=str(reminder.id),
        title=reminder.title,
        due_at=reminder.due_at,
        is_overdue=reminder_svc.is_overdue(reminder),
        is_due_today=reminder_svc.is_due_today(reminder),
        open_count=open_count,
    )


def _out(actor: User, lead: Lead, *,
         next_reminder: LeadReminderSummary | None = None) -> LeadOut:
    return LeadOut.from_model(
        lead,
        hide_internal=not is_inhouse(actor.account_type),
        can_edit=_can_edit(actor, lead),
        next_reminder=next_reminder,
    )


async def _load_viewable(actor: User, lead_id: str) -> Lead:
    lead = await Lead.get(await parse_object_id(lead_id))
    if lead is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lead not found.")
    if not _can_view(actor, lead):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "This lead is outside your access.")
    return lead


async def _load_editable(actor: User, lead_id: str) -> Lead:
    lead = await _load_viewable(actor, lead_id)
    if not _can_edit(actor, lead):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You can't edit this lead. Agent-created leads can only be edited by "
            "the agent who created them.",
        )
    return lead


# --- List -----------------------------------------------------------------------

_SORTS = {
    "recent": "-created_at",
    "oldest": "+created_at",
    "name_asc": "+name",
    "name_desc": "-name",
}

# Stages that mean the lead is finished. Reaching one closes its open reminders.
_CLOSING_STAGES = (LeadStage.CONVERTED, LeadStage.LOST)


def _list_query(actor: User, *, stage: LeadStage | None = None,
                lead_type: LeadType | None = None,
                origin: RecordOrigin | None = None,
                q: str | None = None) -> dict:
    """The one filter definition the list, the tab counts and the export share.

    Three endpoints building this by hand is how the "All" tab stops matching
    the sum of the other tabs.
    """
    filters: list[dict] = [_scope_query(actor)]
    if stage:
        filters.append({"stage": stage.value})
    if lead_type:
        filters.append({"type": lead_type.value})
    if origin and is_inhouse(actor.account_type):
        # Origin filter only meaningful for in-house (agents see one origin).
        filters.append({"origin": origin.value})
    if q:
        rx = search_regex(q)
        filters.append({"$or": [
            {"name": rx}, {"mobile": rx}, {"email": rx}, {"code": rx},
        ]})
    return {"$and": filters} if len(filters) > 1 else filters[0]


@router.get("", response_model=Page[LeadOut],
            dependencies=[Depends(require_permission(VIEW_LEADS))])
async def list_leads(
    actor: User = Depends(get_active_user),
    stage: LeadStage | None = Query(default=None),
    type: LeadType | None = Query(default=None),
    origin: RecordOrigin | None = Query(default=None),
    q: str | None = Query(default=None),
    sort: str = Query(default="recent"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[LeadOut]:
    query = _list_query(actor, stage=stage, lead_type=type, origin=origin, q=q)
    sort_expr = _SORTS.get(sort, "-created_at")

    total = await Lead.find(query).count()
    items = (await Lead.find(query).sort(sort_expr)
             .skip((page - 1) * page_size).limit(page_size).to_list())

    # The Reminders column, in ONE extra query for the whole page rather than
    # one per row (services/reminder_svc.next_open_by_entity).
    upcoming = await reminder_svc.next_open_by_entity(
        "lead", [str(l.id) for l in items])

    return Page[LeadOut](
        items=[_out(actor, l, next_reminder=_reminder_summary(upcoming, l))
               for l in items],
        total=total, page=page, page_size=page_size,
    )


@router.get("/counts", response_model=LeadCounts,
            dependencies=[Depends(require_permission(VIEW_LEADS))])
async def lead_counts(
    actor: User = Depends(get_active_user),
    stage: LeadStage | None = Query(default=None),
    origin: RecordOrigin | None = Query(default=None),
    q: str | None = Query(default=None),
) -> LeadCounts:
    """Numbers on the type tabs.

    Deliberately takes every filter EXCEPT `type` — the tabs have to show what
    each type would give you under the search and stage you already have, so a
    count of zero means "nothing matches here", not "you have none of these".

    One $group over the filtered set rather than four counts: the tab bar must
    not cost a query per tab.
    """
    query = _list_query(actor, stage=stage, origin=origin, q=q)
    rows = await Lead.get_motor_collection().aggregate([
        {"$match": query},
        {"$group": {"_id": "$type", "n": {"$sum": 1}}},
    ]).to_list(None)

    # The aggregation reads raw documents, so it sees a missing or unrecognised
    # `type` as its own bucket where the model would have defaulted it. Fold
    # those into Customer — the model's default — or the tabs stop summing to
    # All, which is exactly the disagreement this endpoint exists to prevent.
    known = {t.value for t in LeadType}
    tally: dict[str, int] = {t: 0 for t in known}
    for row in rows:
        key = row["_id"] if row["_id"] in known else LeadType.CUSTOMER.value
        tally[key] += row["n"]

    return LeadCounts(
        total=sum(tally.values()),
        by_type=[LeadTypeCount(type=t.value, count=tally[t.value])
                 for t in LeadType],
    )


# NOTE: GET /{lead_id} is registered LOWER DOWN (after /export and
# /activity/summary) — a dynamic single-segment route must come after the static
# ones or it shadows them (a plain "/export" would resolve to lead_id="export").


# --- Create ---------------------------------------------------------------------


def _origin_for(actor: User) -> RecordOrigin:
    return RecordOrigin.INHOUSE if is_inhouse(actor.account_type) else RecordOrigin.CHANNEL_PARTNER


@router.post("", response_model=LeadOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_LEADS))])
async def create_lead(payload: LeadCreate,
                      actor: User = Depends(get_active_user)) -> LeadOut:
    lead = Lead(
        code=await next_code("lead"),
        origin=_origin_for(actor),
        owner_user_id=str(actor.id),
        created_by=str(actor.id),
        created_by_name=actor.full_name,
        **payload.model_dump(),
    )
    await lead.insert()
    await lead_activity.record(actor, kind="created", lead_id=str(lead.id))
    await log_action(
        AuditAction.LEAD_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="lead", entity_id=str(lead.id), entity_code=lead.code,
        summary=f"Created lead {lead.name} ({lead.code})",
    )
    return _out(actor, lead)


@router.patch("/{lead_id}", response_model=LeadOut,
              dependencies=[Depends(require_permission(MANAGE_LEADS))])
async def update_lead(lead_id: str, payload: LeadUpdate,
                      actor: User = Depends(get_active_user)) -> LeadOut:
    lead = await _load_editable(actor, lead_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(lead, field, value)
    lead.updated_at = utcnow()
    await lead.save()
    await lead_activity.record(actor, kind="updated", lead_id=str(lead.id))
    await log_action(
        AuditAction.LEAD_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="lead", entity_id=str(lead.id), entity_code=lead.code,
        summary=f"Updated lead {lead.code}",
    )
    return _out(actor, lead)


@router.patch("/{lead_id}/stage", response_model=LeadOut,
              dependencies=[Depends(require_permission(MANAGE_LEADS))])
async def change_stage(lead_id: str, payload: LeadStageUpdate,
                       actor: User = Depends(get_active_user)) -> LeadOut:
    lead = await _load_editable(actor, lead_id)
    previous = lead.stage
    lead.stage = payload.stage
    if payload.stage == LeadStage.LOST:
        lead.lost_reason = payload.lost_reason
    lead.updated_at = utcnow()
    await lead.save()

    # A lead that is won or lost is finished, so its open follow-ups are closed
    # rather than left chasing it (owner Q2.3). This used to happen only on
    # conversion, which deleted the lead; now the lead stays and the reminders
    # are the only thing that would keep nagging.
    if payload.stage in _CLOSING_STAGES and previous not in _CLOSING_STAGES:
        await reminder_svc.close_for_entity(
            "lead", str(lead.id),
            reason=f"lead marked {payload.stage.value}")

    # Reaching `converted` IS the conversion now that the dedicated endpoint is
    # gone, so this is where the activity counter has to be bumped — otherwise
    # "leads converted" on the activity summary silently reads zero forever.
    if payload.stage == LeadStage.CONVERTED and previous != LeadStage.CONVERTED:
        await lead_activity.record(actor, kind="converted", lead_id=str(lead.id))

    await log_action(
        AuditAction.LEAD_STAGE_CHANGED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="lead", entity_id=str(lead.id), entity_code=lead.code,
        summary=f"Lead {lead.code}: {previous.value} -> {payload.stage.value}",
    )
    return _out(actor, lead)


@router.post("/{lead_id}/comments", response_model=LeadOut,
             dependencies=[Depends(require_permission(VIEW_LEADS))])
async def add_comment(lead_id: str, payload: LeadCommentCreate,
                      actor: User = Depends(get_active_user)) -> LeadOut:
    lead = await _load_viewable(actor, lead_id)
    # In-house comments on any lead are internal (hidden from the agent).
    internal = is_inhouse(actor.account_type)
    lead.comments.append(LeadComment(
        author_id=str(actor.id), author_name=actor.full_name,
        author_role=actor.account_type.value, body=payload.body, internal=internal,
    ))
    lead.updated_at = utcnow()
    await lead.save()
    await log_action(
        AuditAction.LEAD_COMMENTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="lead", entity_id=str(lead.id), entity_code=lead.code,
        summary=f"Commented on lead {lead.code}",
    )
    return _out(actor, lead)


# REMOVED 2026-08-03 (owner Q2.1a): POST /{lead_id}/convert.
#
# It created a Customer from the lead and then DELETED the lead. That only ever
# made sense for one of the three lead types, and it lost the pipeline record —
# a won lead vanished with nothing left to report on. A lead is now moved to the
# `converted` stage like any other stage move (which closes its reminders) and
# stays in the list; the customer or channel partner is created from its own
# page. `Lead.converted_customer_id` survives on the model as history for
# anything converted before this date.


@router.delete("/{lead_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_LEADS))])
async def delete_lead(lead_id: str,
                      actor: User = Depends(get_active_user)) -> Message:
    # Same rule as editing: agents may delete their own leads; in-house may
    # delete in-house leads only (not agent leads).
    lead = await _load_editable(actor, lead_id)
    code = lead.code
    await reminder_svc.close_for_entity("lead", lead_id, reason="lead deleted")
    await lead.delete()
    await log_action(
        AuditAction.LEAD_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="lead", entity_id=lead_id, entity_code=code,
        summary=f"Deleted lead {code}",
    )
    return Message(detail="Lead deleted.")


# --- Export ---------------------------------------------------------------------


@router.get("/export",
            dependencies=[Depends(require_permission(VIEW_LEADS))])
async def export_leads(
    actor: User = Depends(get_active_user),
    stage: LeadStage | None = Query(default=None),
    type: LeadType | None = Query(default=None),
    q: str | None = Query(default=None),
    fmt: str = Query(default="excel", pattern="^(excel|xlsx|csv)$"),
):
    # Same query builder as the list, so what you download is what you were
    # looking at — including the type tab you had selected.
    query = _list_query(actor, stage=stage, lead_type=type, q=q)
    items = await Lead.find(query).sort("-created_at").limit(20000).to_list()

    headers = ["Code", "Name", "Type", "Mobile", "Email", "Interested In",
               "Stage", "Last Comment", "Created"]
    rows = ([l.code, l.name,
             lead_import.label_for_type(l.type),
             l.mobile or "", l.email or "",
             l.interested_in or l.category_key or "",
             l.stage.value if hasattr(l.stage, "value") else l.stage,
             (l.comments[-1].body if l.comments else ""),
             l.created_at.strftime("%Y-%m-%d")] for l in items)
    await log_action(
        AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="lead", summary=f"Exported {len(items)} leads ({fmt})")
    return export_response(fmt, "leads", headers, rows, sheet_title="Leads")


# Registered here (after /export) so the dynamic segment doesn't shadow static
# routes like /export.
@router.get("/{lead_id}", response_model=LeadOut,
            dependencies=[Depends(require_permission(VIEW_LEADS))])
async def get_lead(lead_id: str,
                   actor: User = Depends(get_active_user)) -> LeadOut:
    lead = await _load_viewable(actor, lead_id)
    return _out(actor, lead)


@router.get("/activity/summary")
async def lead_activity_summary(
    actor: User = Depends(get_active_user),
    days: int = Query(default=30, ge=1, le=365),
) -> list[dict]:
    """Per-staff lead activity over a window. Managers/owners see the whole team;
    an employee sees only their own row."""
    from app.core.permissions import VIEW_EMPLOYEES, VIEW_REPORTS
    can_see_team = (actor.is_owner or can(actor, VIEW_EMPLOYEES)
                    or can(actor, VIEW_REPORTS))
    user_ids = None if can_see_team else [str(actor.id)]
    return await lead_activity.summary(days=days, user_ids=user_ids)


# --- Bulk import ----------------------------------------------------------------


@router.get("/import/template",
            dependencies=[Depends(require_permission(MANAGE_LEADS))])
async def download_template(_: User = Depends(get_active_user)):
    """Download an Excel template with dropdowns for Type and Interested In."""
    cats = await PolicyCategory.find(PolicyCategory.active == True).to_list()  # noqa: E712
    labels = [c.label for c in cats]
    try:
        data = lead_import.build_template_xlsx(labels)
        return StreamingResponse(
            iter([data]),
            media_type=("application/vnd.openxmlformats-officedocument."
                        "spreadsheetml.sheet"),
            headers={"Content-Disposition":
                     "attachment; filename=lead_import_template.xlsx"},
        )
    except Exception:  # noqa: BLE001 - fall back to CSV if openpyxl unavailable
        return StreamingResponse(
            iter([lead_import.build_template_csv()]), media_type="text/csv",
            headers={"Content-Disposition":
                     "attachment; filename=lead_import_template.csv"},
        )


@router.post("/import", response_model=LeadImportResult,
             dependencies=[Depends(require_permission(MANAGE_LEADS))])
async def import_leads(
    file: UploadFile = File(...),
    actor: User = Depends(get_active_user),
) -> LeadImportResult:
    content = await read_upload(file, MAX_IMPORT_BYTES, label="The file")
    try:
        rows = lead_import.parse_file(file.filename or "", content)
    except lead_import.ImportFormatError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))

    if not rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "No data rows found in the file.")
    if len(rows) > MAX_IMPORT_ROWS:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"That file has {len(rows):,} rows. Please split it into files of "
            f"{MAX_IMPORT_ROWS:,} rows or fewer.")

    # Category lookup (by key or label, case-insensitive).
    cats = await PolicyCategory.find(PolicyCategory.active == True).to_list()  # noqa: E712
    cat_lookup: dict[str, str] = {}
    for c in cats:
        cat_lookup[c.key.lower()] = c.key
        cat_lookup[c.label.lower()] = c.key

    origin = _origin_for(actor)
    created = 0
    failures: list[LeadImportFailure] = []

    for idx, row in enumerate(rows):
        # Spreadsheet row number: +2 (1 header + 1-based).
        rownum = idx + 2
        name = (row.get("full name") or "").strip()
        if len(name) < 2:
            failures.append(LeadImportFailure(
                row=rownum, reason="Full Name is required."))
            continue

        mobile = "".join(ch for ch in (row.get("mobile") or "") if ch.isdigit())
        if len(mobile) != 10:
            failures.append(LeadImportFailure(
                row=rownum, reason="A valid 10-digit mobile number is required."))
            continue

        # "Interested In" is now free text (owner 2026-07-17). If it happens to
        # match a known category label we also set category_key for continuity.
        interested = (row.get("interested in") or "").strip()[:40] or None
        category_key = cat_lookup.get(interested.lower()) if interested else None

        try:
            lead = Lead(
                code=await next_code("lead"),
                origin=origin,
                name=name,
                type=lead_import.parse_lead_type(row.get("type")),
                mobile=mobile,
                email=(row.get("email") or "").strip() or None,
                # No address: it is not collected on a lead any more, so an
                # Address column in an older file is accepted and ignored
                # rather than filing data nothing can show or edit.
                interested_in=interested,
                category_key=category_key,
                note=(row.get("note") or "").strip() or None,
                owner_user_id=str(actor.id),
                created_by=str(actor.id),
                created_by_name=actor.full_name,
            )
            await lead.insert()
            await lead_activity.record(actor, kind="created",
                                       lead_id=str(lead.id))
            created += 1
        except Exception:  # noqa: BLE001
            failures.append(LeadImportFailure(
                row=rownum, reason="Could not be saved."))

    await log_action(
        AuditAction.LEAD_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="lead",
        summary=f"Imported {created} leads ({len(failures)} failed)",
        meta={"created": created, "failed": len(failures)},
    )

    total = len(rows)
    if failures:
        rows_txt = ", ".join(str(f.row) for f in failures[:20])
        detail = (f"Imported {created} of {total} leads. "
                  f"{len(failures)} failed (rows: {rows_txt}"
                  f"{'…' if len(failures) > 20 else ''}).")
    else:
        detail = f"Successfully imported all {created} leads."
    return LeadImportResult(total=total, created=created, failed=failures,
                            detail=detail)
