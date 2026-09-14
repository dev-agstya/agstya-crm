"""Custom roles ("My Organization" -> Roles): CRUD permission bundles."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AccountType, AuditAction
from app.core.permissions import (
    ASSIGNABLE_PERMISSIONS,
    MANAGE_ROLES_PERMISSIONS,
    PERMISSION_GROUPS,
    ROLE_TEMPLATES,
    effective_permissions,
    expand_permissions,
)
from app.models.base import utcnow
from app.models.role import Role
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message
from app.schemas.role import RoleCreate, RoleOut, RoleUpdate
from app.services.audit import log_action
from app.services.permissions_svc import cascade_role_change

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/roles", tags=["roles"],
                   dependencies=[Depends(get_inhouse_user)])


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return slug or "role"


async def _unique_key(name: str) -> str:
    base = _slugify(name)
    key = base
    i = 2
    while await Role.find_one(Role.key == key):
        key = f"{base}_{i}"
        i += 1
    return key


def _validate_perms(perms: list[str]) -> None:
    unknown = [p for p in perms if p not in ASSIGNABLE_PERMISSIONS]
    if unknown:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown permissions: {', '.join(unknown)}")


def _check_no_elevation(actor: User, perms: list[str]) -> None:
    """A role may not contain a permission its author doesn't hold.

    Roles are bulk-apply templates, so a role holding more than its author can
    grant is a role they can build and then never apply — the elevation check on
    PATCH /users/{id}/permissions refuses it with a 403 that looks like a bug.
    Catching it here says no at the point the mistake is made, and keeps the
    rule true if roles are ever attached to users directly again.
    """
    if actor.account_type == AccountType.OWNER:
        return
    held = set(effective_permissions(actor))
    beyond = [p for p in perms if p not in held]
    if beyond:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "A role can't include permissions you don't have yourself.")


async def _member_count(role_id: str) -> int:
    return await User.find(User.role_id == role_id,
                           {"is_deleted": {"$ne": True}}).count()


# NOTE: static paths must stay registered BEFORE /{role_id}.
@router.get("/catalog")
async def permission_catalog(_: User = Depends(get_active_user)) -> dict:
    """The permission model itself — groups, labels, help text and the starter
    templates. Served from the backend so the permission editor can never drift
    from core/permissions.py. Readable by any signed-in user (it describes the
    system, it grants nothing)."""
    return {"groups": PERMISSION_GROUPS, "templates": ROLE_TEMPLATES}


@router.get("", response_model=list[RoleOut],
            dependencies=[Depends(require_permission(MANAGE_ROLES_PERMISSIONS))])
async def list_roles(include_inactive: bool = Query(default=True),
                     _: User = Depends(get_active_user)) -> list[RoleOut]:
    query: dict = {} if include_inactive else {"active": True}
    roles = await Role.find(query).sort("+name").to_list()
    out: list[RoleOut] = []
    for r in roles:
        out.append(RoleOut.from_model(r, await _member_count(str(r.id))))
    return out


@router.post("", response_model=RoleOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_ROLES_PERMISSIONS))])
async def create_role(payload: RoleCreate,
                      actor: User = Depends(get_active_user)) -> RoleOut:
    _validate_perms(payload.permissions)
    _check_no_elevation(actor, payload.permissions)
    role = Role(
        key=await _unique_key(payload.name),
        name=payload.name,
        description=payload.description,
        permissions=expand_permissions(payload.permissions),
        created_by=str(actor.id),
    )
    await role.insert()
    await log_action(
        AuditAction.ORG_ROLE_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="role", entity_id=str(role.id), entity_code=role.key,
        summary=f"Created role {role.name}",
    )
    return RoleOut.from_model(role, 0)


@router.patch("/{role_id}", response_model=RoleOut,
              dependencies=[Depends(require_permission(MANAGE_ROLES_PERMISSIONS))])
async def update_role(role_id: str, payload: RoleUpdate,
                      actor: User = Depends(get_active_user)) -> RoleOut:
    role = await Role.get(await parse_object_id(role_id))
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Role not found.")
    data = payload.model_dump(exclude_unset=True)
    if "permissions" in data:
        _validate_perms(data["permissions"])
        _check_no_elevation(actor, data["permissions"])
        data["permissions"] = expand_permissions(data["permissions"])
    cascade = bool({"permissions"} & set(data.keys()))
    for field, value in data.items():
        setattr(role, field, value)
    role.updated_at = utcnow()
    await role.save()
    if cascade:
        await cascade_role_change(role)
    await log_action(
        AuditAction.ORG_ROLE_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="role", entity_id=str(role.id), entity_code=role.key,
        summary=f"Updated role {role.name}", meta={"fields": list(data.keys())},
    )
    return RoleOut.from_model(role, await _member_count(str(role.id)))


@router.delete("/{role_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_ROLES_PERMISSIONS))])
async def delete_role(role_id: str,
                      actor: User = Depends(get_active_user)) -> Message:
    role = await Role.get(await parse_object_id(role_id))
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Role not found.")
    if role.is_system:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "System roles can't be deleted.")
    members = await _member_count(str(role.id))
    if members:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{members} employee(s) still use this role. Reassign them first.")
    key = role.key
    await role.delete()
    await log_action(
        AuditAction.ORG_ROLE_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="role", entity_id=role_id, entity_code=key,
        summary=f"Deleted role {key}",
    )
    return Message(detail="Role deleted.")
