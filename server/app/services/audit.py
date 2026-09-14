"""Helper to record audit-log entries consistently, incl. before/after diffs."""

from __future__ import annotations

import logging
from typing import Any, Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import Request

from app.core.enums import AuditAction
from app.models.audit import AuditLog

logger = logging.getLogger("agastyacrm.audit")

# Never write these to the audit trail, even though the owner opted out of
# masking PII — secrets/credentials must not be logged at all.
_NEVER_LOG = {
    "password", "new_password", "current_password", "hashed_password",
    "temp_password", "otp", "token", "refresh_token", "secret",
}

# Log that these CHANGED, but never their VALUES: sensitive financial/identity
# PII must not sit in the (long-lived) audit trail in cleartext (owner Q-S2).
_REDACT_VALUES = {
    "pan", "aadhaar", "aadhaar_last4", "gstin",
    "bank_account", "account_number", "ifsc", "upi_id",
}
_REDACTED = "•••"


def _plain(value: Any) -> Any:
    """Make a value JSON/BSON-friendly for storage in the audit meta."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "value"):          # enum
        return value.value
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return str(value)


def diff_dict(before: dict[str, Any], after: dict[str, Any],
              *, fields: Optional[list[str]] = None) -> dict[str, dict]:
    """{field: {"from": old, "to": new}} for every changed field. Secrets are
    skipped entirely; nested dicts are compared shallowly per top-level key."""
    keys = fields if fields is not None else sorted(set(before) | set(after))
    changes: dict[str, dict] = {}
    for k in keys:
        if k in _NEVER_LOG:
            continue
        b, a = before.get(k), after.get(k)
        if b != a:
            if k in _REDACT_VALUES:
                # Keep the "this field changed" signal without the values.
                changes[k] = {"from": _REDACTED, "to": _REDACTED}
            else:
                changes[k] = {"from": _plain(b), "to": _plain(a)}
    return changes


# ---------------------------------------------------------------------------
# Reference fields: a field holding another record's ObjectId as a string.
#
# The audit trail used to embed the raw id verbatim — "relationship manager id
# 6a6657e6... -> 6a87f0bd..." — which is unreadable to anyone but the database.
# This is the ONE place that knowledge lives: a field name here is resolved to
# a human label everywhere an audit summary or diff is built (`diff_dict_async`
# below), for every router, present and future. Adding a new id-holding field
# to any model means adding one line here, not re-deriving this fix per call
# site — the same "one shared definition" reasoning as `lib/tone.ts` or
# `services/policy_scope`.
# ---------------------------------------------------------------------------

_REF_FIELDS: dict[str, str] = {
    "relationship_manager_id": "user",
    "manager_id": "user",
    "owner_user_id": "user",
    "partner_id": "user",
    "broker_id": "broker",
    "insurer_id": "insurer",
    "category_id": "policy_category",
    "policy_type_id": "policy_category",
    "customer_id": "customer",
    "bank_account_id": "bank_account",
    "paid_to_employee_id": "user",
}


async def _resolve_ref(kind: str, raw: Any) -> Optional[str]:
    """"Name (CODE)" for a reference id, or None if it doesn't resolve (never
    existed, or since deleted) — the caller decides what to show for that."""
    if not raw or not isinstance(raw, str):
        return None
    try:
        oid = ObjectId(raw)
    except (InvalidId, TypeError):
        return None

    if kind == "user":
        from app.models.user import User
        doc = await User.get(oid)
        return f"{doc.full_name} ({doc.code})" if doc else None
    if kind == "broker":
        from app.models.broker import Broker
        doc = await Broker.get(oid)
        return f"{doc.name} ({doc.code})" if doc else None
    if kind == "insurer":
        from app.models.insurer import Insurer
        doc = await Insurer.get(oid)
        return f"{doc.name} ({doc.code})" if doc else None
    if kind == "policy_category":
        from app.models.master import PolicyCategory
        doc = await PolicyCategory.get(oid)
        return doc.label if doc else None
    if kind == "customer":
        from app.models.customer import Customer
        doc = await Customer.get(oid)
        return f"{doc.full_name} ({doc.code})" if doc else None
    if kind == "bank_account":
        from app.models.bank import BankAccount
        doc = await BankAccount.get(oid)
        return doc.name if doc else None
    return None


async def resolve_ref_changes(changes: dict[str, dict]) -> dict[str, dict]:
    """Replace a raw ObjectId in a known reference field's from/to with a
    human label, in place. A value that no longer resolves (the record was
    since deleted) reads "Deleted record" — never the bare id, and never
    silently blank, which would look like nothing changed."""
    for field, c in changes.items():
        kind = _REF_FIELDS.get(field)
        if not kind:
            continue
        for side in ("from", "to"):
            raw = c.get(side)
            if raw in (None, "", _REDACTED):
                continue
            name = await _resolve_ref(kind, raw)
            c[side] = name or "Deleted record"
    return changes


async def diff_dict_async(before: dict[str, Any], after: dict[str, Any],
                          *, fields: Optional[list[str]] = None,
                          ) -> dict[str, dict]:
    """`diff_dict`, then resolve any reference-id field to a name. This is
    the version every router should call — plain `diff_dict` stays available
    for the (rare) case a caller already has display strings, not ids, in the
    snapshot it's diffing."""
    return await resolve_ref_changes(diff_dict(before, after, fields=fields))


def _fmt(v: Any) -> str:
    if v is None or v == "":
        return "—"
    if isinstance(v, (dict, list)):
        return "…"
    return str(v)


def describe_changes(changes: dict[str, dict], *, limit: int = 6) -> str:
    """Turn a diff into a readable clause: 'phone 111 → 222, email a → b'."""
    parts = [f"{k.replace('_', ' ')} {_fmt(c['from'])} → {_fmt(c['to'])}"
             for k, c in list(changes.items())[:limit]]
    extra = len(changes) - limit
    if extra > 0:
        parts.append(f"+{extra} more")
    return ", ".join(parts)


async def log_action(
    action: AuditAction,
    *,
    actor_id: Optional[str] = None,
    actor_name: Optional[str] = None,
    actor_role: Optional[str] = None,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    entity_code: Optional[str] = None,
    summary: str = "",
    meta: Optional[dict[str, Any]] = None,
    request: Optional[Request] = None,
) -> None:
    """Persist an audit entry. Never raises — auditing must not break a request."""
    ip = None
    ua = None
    if request is not None:
        # Trusted-proxy-aware: reading X-Forwarded-For left-to-right would let a
        # caller write any IP they liked into the trail (core.rate_limit.client_ip).
        from app.core.rate_limit import client_ip
        ip = client_ip(request)
        ua = request.headers.get("user-agent")

    try:
        await AuditLog(
            action=action,
            actor_id=actor_id,
            actor_name=actor_name,
            actor_role=actor_role,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_code=entity_code,
            summary=summary,
            meta=meta or {},
            ip_address=ip,
            user_agent=ua,
        ).insert()
    except Exception:  # noqa: BLE001 - auditing is best-effort
        logger.exception("Failed to write audit log for action %s", action)
