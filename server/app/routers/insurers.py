"""Insurer master data with default commission slabs."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction
from app.core.permissions import MANAGE_INSURERS, VIEW_INSURERS
from app.models.base import utcnow
from app.models.insurer import Insurer
from app.models.user import User
from app.routers._helpers import parse_object_id, search_regex
from app.schemas.common import Message, Page
from app.schemas.insurer import (
    InsurerCreate, InsurerOut, InsurerUpdate, ShortNameAvailability,
)
from app.services.audit import log_action
from app.services.codes import next_code
from app.services import references

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/insurers", tags=["insurers"],
                   dependencies=[Depends(get_inhouse_user)])


async def _name_taken(name: str, exclude_id: str | None = None) -> bool:
    """Case-insensitive: "HDFC Life" and "hdfc life" are the same company."""
    existing = await Insurer.find_one(
        {"name": {"$regex": f"^{re.escape(name.strip())}$", "$options": "i"}})
    return existing is not None and str(existing.id) != (exclude_id or "")


async def _short_name_taken(short_name: str,
                            exclude_id: str | None = None) -> bool:
    """Short name is unique too (owner 2026-07-26). Checked here as well as by
    the partial unique index on the model, so a clash comes back as a readable
    409 rather than a duplicate-key 500 — and case-insensitively, which the
    index alone cannot do."""
    existing = await Insurer.find_one(
        {"short_name": {"$regex": f"^{re.escape(short_name.strip())}$",
                        "$options": "i"}})
    return existing is not None and str(existing.id) != (exclude_id or "")



@router.get("", response_model=Page[InsurerOut],
            dependencies=[Depends(require_permission(VIEW_INSURERS))])
async def list_insurers(
    q: str | None = Query(default=None),
    active_only: bool = Query(default=True),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _: User = Depends(get_active_user),
) -> Page[InsurerOut]:
    query: dict = {}
    if active_only:
        query["active"] = True
    if q:
        query["name"] = search_regex(q)
    total = await Insurer.find(query).count()
    items = (await Insurer.find(query).sort("+name")
             .skip((page - 1) * page_size).limit(page_size).to_list())
    # Which of these are referenced anywhere — the UI shows Delete only where it
    # would actually succeed, instead of offering a button that always 409s.
    used = await references.insurers_in_use(str(i.id) for i in items)
    return Page[InsurerOut](
        items=[InsurerOut.from_model(i, in_use=str(i.id) in used)
               for i in items],
        total=total, page=page, page_size=page_size,
    )


@router.get("/short-name-available", response_model=ShortNameAvailability,
            dependencies=[Depends(require_permission(MANAGE_INSURERS))])
async def short_name_available(
    short_name: str = Query(min_length=1, max_length=140),
    exclude_id: str | None = Query(default=None),
    _: User = Depends(get_active_user),
) -> ShortNameAvailability:
    """Live check for the Add/Edit Insurer form, mirroring the broker short
    code: the clash is shown under the field while you type instead of coming
    back as a 409 after Save (owner 2026-07-26).

    Must stay ABOVE /{insurer_id} or the dynamic route swallows it.
    """
    normalized = short_name.strip()
    if not normalized:
        # Blank is allowed — the field is optional — so nothing to clash with.
        return ShortNameAvailability(short_name="", available=True)
    return ShortNameAvailability(
        short_name=normalized,
        available=not await _short_name_taken(normalized, exclude_id))


@router.get("/{insurer_id}", response_model=InsurerOut,
            dependencies=[Depends(require_permission(VIEW_INSURERS))])
async def get_insurer(insurer_id: str,
                      _: User = Depends(get_active_user)) -> InsurerOut:
    ins = await Insurer.get(await parse_object_id(insurer_id))
    if ins is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Insurer not found.")
    return InsurerOut.from_model(
        ins, in_use=references.in_use(await references.insurer_refs(insurer_id)))


@router.post("", response_model=InsurerOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_INSURERS))])
async def create_insurer(payload: InsurerCreate,
                         actor: User = Depends(get_active_user)) -> InsurerOut:
    if await _name_taken(payload.name):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "An insurer with this name already exists.")
    if payload.short_name and await _short_name_taken(payload.short_name):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Short name '{payload.short_name}' is already used by another "
            f"insurer.")
    ins = Insurer(code=await next_code("insurer"), created_by=str(actor.id),
                  **payload.model_dump())
    await ins.insert()
    await log_action(
        AuditAction.INSURER_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="insurer", entity_id=str(ins.id), entity_code=ins.code,
        summary=f"Created insurer {ins.name}",
    )
    # Brand new: nothing can point at it yet.
    return InsurerOut.from_model(ins, in_use=False)


@router.patch("/{insurer_id}", response_model=InsurerOut,
              dependencies=[Depends(require_permission(MANAGE_INSURERS))])
async def update_insurer(insurer_id: str, payload: InsurerUpdate,
                         actor: User = Depends(get_active_user)) -> InsurerOut:
    ins = await Insurer.get(await parse_object_id(insurer_id))
    if ins is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Insurer not found.")
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes and await _name_taken(changes["name"], insurer_id):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "An insurer with this name already exists.")
    if changes.get("short_name") and await _short_name_taken(
            changes["short_name"], insurer_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Short name '{changes['short_name']}' is already used by another "
            f"insurer.")
    for field, value in changes.items():
        setattr(ins, field, value)
    ins.updated_at = utcnow()
    await ins.save()
    await log_action(
        AuditAction.INSURER_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="insurer", entity_id=str(ins.id), entity_code=ins.code,
        summary=f"Updated insurer {ins.name}",
    )
    return InsurerOut.from_model(
        ins, in_use=references.in_use(await references.insurer_refs(insurer_id)))


@router.delete("/{insurer_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_INSURERS))])
async def delete_insurer(insurer_id: str,
                         actor: User = Depends(get_active_user)) -> Message:
    """Permanently remove an insurer that nothing points at.

    Whether this is allowed is decided by the LINKS, not by who is asking
    (owner 2026-07-26): an insurer nothing points at is a typo someone should be
    able to clear up, while one that is in use must be deactivated instead. A
    policy stores the insurer's ID and resolves the NAME at read time, so
    deleting one that is in use would blank the insurer column on every historic
    policy — the reference check below is what makes that impossible, and it
    covers rate cards as well as policies.
    """
    ins = await Insurer.get(await parse_object_id(insurer_id))
    if ins is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Insurer not found.")
    refs = await references.insurer_refs(insurer_id)
    if references.in_use(refs):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            references.blocked_message("insurer", refs))
    name, code = ins.name, ins.code
    await ins.delete()
    await log_action(
        AuditAction.INSURER_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="insurer", entity_id=insurer_id, entity_code=code,
        summary=f"Permanently deleted unused insurer {name}",
    )
    return Message(detail="Insurer deleted.")
