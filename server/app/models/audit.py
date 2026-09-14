"""Audit log — every state-changing action on the portal."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

import pymongo
from beanie import Document
from pydantic import Field

from app.config import settings
from app.core.enums import AuditAction
from app.models.base import utcnow

_AUDIT_TTL_SECONDS = settings.audit_retention_days * 24 * 3600


class AuditLog(Document):
    action: AuditAction
    # Actor (may be None for anonymous failed logins).
    actor_id: Optional[str] = None
    actor_name: Optional[str] = None
    actor_role: Optional[str] = None

    # Target entity affected, if any.
    entity_type: Optional[str] = None          # "user", "policy", ...
    entity_id: Optional[str] = None
    entity_code: Optional[str] = None

    summary: str = ""                          # human-readable one-liner
    # Structured before/after or extra context.
    meta: dict[str, Any] = Field(default_factory=dict)

    ip_address: Optional[str] = None
    user_agent: Optional[str] = None

    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "audit_logs"
        indexes = [
            [("created_at", pymongo.DESCENDING)],
            [("actor_id", pymongo.ASCENDING)],
            [("action", pymongo.ASCENDING)],
            [("entity_type", pymongo.ASCENDING), ("entity_id", pymongo.ASCENDING)],
            # TTL: audit rows self-delete after the retention window (owner Q-D3).
            # The fastest-growing collection on M0 — must not grow unbounded.
            pymongo.IndexModel(
                [("created_at", pymongo.ASCENDING)],
                expireAfterSeconds=_AUDIT_TTL_SECONDS, name="audit_ttl"),
        ]
