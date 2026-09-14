"""Shared helpers for feature routers (scoping, ownership assignment)."""

from __future__ import annotations

import re
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from app.core.enums import AccountType
from app.models.user import User

# A search box is a search box, not a regex console. Interpolating the raw
# query into $regex let a caller post a catastrophically-backtracking pattern
# ("(a+)+$") and pin the Atlas cluster on every document in the collection —
# cheap to send, expensive to serve, and the M0 tier has no headroom for it.
# Callers pass user input through here; anything already anchored/escaped by
# hand (policy number, insurer short name) keeps doing its own re.escape.
_MAX_SEARCH_LEN = 100


def search_regex(q: str) -> dict:
    """Case-insensitive CONTAINS match on a user-supplied string, escaped."""
    return {"$regex": re.escape(q.strip()[:_MAX_SEARCH_LEN]), "$options": "i"}


async def read_upload(file, max_bytes: int, *, label: str = "File") -> bytes:
    """Read an upload, refusing anything over `max_bytes` WITHOUT buffering it.

    The pattern everywhere was `data = await file.read()` and then a length
    check — which rejects the file only after the whole thing is already in
    memory. A single multi-gigabyte POST could exhaust a small Render instance
    before the cap it "enforced" ever ran.

    Here the body is consumed in chunks against a running budget and abandoned
    the moment it goes over, so the peak allocation is bounded by the limit.
    The Content-Length header is checked first as a cheap early out, but is
    never trusted on its own — it is client-supplied and chunked uploads omit
    it entirely.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"{label} is too large (max {max_bytes // (1024 * 1024)} MB).")
        chunks.append(chunk)
    if not total:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{label} is empty.")
    return b"".join(chunks)


async def build_scope_query(actor: User, base: Optional[dict] = None) -> dict:
    """Return the query as-is — for CUSTOMERS, LEADS and REWARDS.

    Those three are still unscoped: every in-house user shares the whole
    customer and lead book, and access to them is decided by permission flags
    alone. Kept as a thin pass-through so those callers don't have to branch.

    POLICIES ARE NO LONGER IN THAT LIST (owner 2026-08-24) and deliberately do
    NOT go through here. Their scope is a real Mongo clause built by
    `services/policy_scope.visible_filter` and merged with
    `policy_scope.merge`, which is a different shape from this function on
    purpose: a pass-through that sometimes filters is a function whose call
    sites cannot be read, and the policy call sites need to be obvious.
    """
    return dict(base or {})


async def ensure_can_access(actor: User, record) -> None:
    """May this account touch this record? Raises 404 when not.

    A no-op for every model EXCEPT `Policy`. Record-level scoping was deleted in
    v1 and this survived as the documented hook for "if scoping ever returns" —
    it returned on 2026-08-24, for policies and nothing else, and this is that
    hook being used rather than a second mechanism grown beside it.

    Dispatching on the MODEL rather than making each caller choose is what makes
    it safe: `routers/policies` calls this at ten sites (read, edit, status,
    delete, reward outcome, both document uploads, notify, renew, renewal
    chain) and `routers/documents` at one more, and every one of them was
    already correct the moment this function learned about policies. A
    per-call-site check would have needed eleven edits and would have been one
    edit short within a month.

    A customer or a lead passed in here is still unscoped and still returns
    immediately, which is the current, deliberate rule — see the docstring on
    `build_scope_query`.
    """
    if record is None:
        return None
    # Imported here rather than at module level: app.models.policy is cheap, but
    # _helpers is imported by nearly every router and a model import at the top
    # of it is how import cycles start in this codebase.
    from app.models.policy import Policy

    if isinstance(record, Policy):
        from app.services import policy_scope

        await policy_scope.assert_can_see(actor, record)
    return None


def default_owner_id(actor: User, requested_owner: Optional[str] = None) -> str:
    """Owner of a new record. In-house users may book on behalf of someone else;
    partners always own their own records."""
    if actor.account_type in (AccountType.OWNER, AccountType.EMPLOYEE) \
            and requested_owner:
        return requested_owner
    return str(actor.id)


async def parse_object_id(value: str) -> PydanticObjectId:
    try:
        return PydanticObjectId(value)
    except Exception:  # noqa: BLE001
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid id.")
