"""Policy-category master data (lines of business + required documents)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction
from app.core.permissions import MANAGE_POLICY_TYPES
from app.models.base import utcnow
from app.models.master import PolicyCategory
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message
from app.schemas.master import (
    PolicyCategoryCreate,
    PolicyCategoryOut,
    PolicyCategoryUpdate,
)
from app.models.master import COMMISSIONABLE_BASE
from app.services.audit import log_action
from app.services.categories import validate_tree
from app.services.custom_fields import validate_custom_field_specs
from app.services import references

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/policy-categories", tags=["master"],
                   dependencies=[Depends(get_inhouse_user)])


@router.get("", response_model=list[PolicyCategoryOut])
async def list_categories(
    include_inactive: bool = Query(default=False),
    _: User = Depends(get_active_user),
) -> list[PolicyCategoryOut]:
    query: dict = {} if include_inactive else {"active": True}
    cats = await PolicyCategory.find(query).sort("+sort_order").to_list()
    # Which types anything points at, so the page can ask the right question
    # when someone hits Delete instead of always round-tripping to a 409.
    used = await references.policy_types_in_use(c.key for c in cats)
    return [PolicyCategoryOut.from_model(c, in_use=c.key in used) for c in cats]


@router.post("", response_model=PolicyCategoryOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_POLICY_TYPES))])
async def create_category(payload: PolicyCategoryCreate,
                          actor: User = Depends(get_active_user)
                          ) -> PolicyCategoryOut:
    if await PolicyCategory.find_one(PolicyCategory.key == payload.key):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "A category with this key already exists.")
    try:
        validate_tree(payload.children)
        validate_custom_field_specs(payload.custom_fields,
                                    payload.reward_base_field)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    cat = PolicyCategory(**payload.model_dump())
    await cat.insert()
    await log_action(
        AuditAction.CATEGORY_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy_category", entity_id=str(cat.id),
        summary=f"Created policy category {cat.label}",
    )
    # Brand new: nothing can point at it yet.
    return PolicyCategoryOut.from_model(cat, in_use=False)


@router.patch("/{category_id}", response_model=PolicyCategoryOut,
              dependencies=[Depends(require_permission(MANAGE_POLICY_TYPES))])
async def update_category(category_id: str, payload: PolicyCategoryUpdate,
                          actor: User = Depends(get_active_user)
                          ) -> PolicyCategoryOut:
    cat = await PolicyCategory.get(await parse_object_id(category_id))
    if cat is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found.")
    data = payload.model_dump(exclude_unset=True)
    if "children" in data:
        try:
            validate_tree(payload.children or [])
        except ValueError as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    for field, value in data.items():
        setattr(cat, field, value)
    # Validate the resulting field config (custom fields + default reward base),
    # whether the change touched the fields, the base, or both.
    if {"custom_fields", "reward_base_field"} & set(data):
        try:
            validate_custom_field_specs(
                cat.custom_fields,
                getattr(cat, "reward_base_field", COMMISSIONABLE_BASE))
        except ValueError as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    cat.updated_at = utcnow()
    await cat.save()
    return PolicyCategoryOut.from_model(
        cat,
        in_use=references.in_use(await references.policy_type_refs(cat.key)))


@router.delete("/{category_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_POLICY_TYPES))])
async def delete_category(category_id: str,
                          actor: User = Depends(get_active_user)) -> Message:
    """Permanently remove a policy type that nothing points at.

    This route used to DEACTIVATE — a DELETE that quietly did something else,
    which is a trap for anyone reading the API. Deactivating is now what it
    looks like: PATCH {"active": false}. What is left here is a real delete,
    refused while any policy or rate-card rule still names this type — the LINKS
    decide, not who is asking (owner 2026-07-26).

    Policy types are referenced by KEY, not by id — a booked policy stores
    `category_key` — so that is what the reference check looks at.
    """
    cat = await PolicyCategory.get(await parse_object_id(category_id))
    if cat is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found.")
    refs = await references.policy_type_refs(cat.key)
    if references.in_use(refs):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            references.blocked_message("policy type", refs))
    label = cat.label
    await cat.delete()
    await log_action(
        AuditAction.CATEGORY_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy_category", entity_id=category_id,
        summary=f"Permanently deleted unused policy type {label}",
    )
    return Message(detail="Policy type deleted.")
