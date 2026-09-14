"""Operational logs kept in the DB (separate from the user-facing audit trail):

  - ErrorLog   — every unhandled server error, with a reference code shown to
                 the user so support can look it up.
  - EmailOutbox — one row per outbound email (queued/sent/failed) so a silently
                 failed email is visible and retryable.

Both auto-expire via a TTL index after `settings.log_retention_days` days.
ApiCallLog (third-party usage / cost tracking) lands here in Phase 2.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from beanie import Document
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from app.config import settings
from app.models.base import utcnow

_TTL_SECONDS = settings.log_retention_days * 24 * 3600


class ErrorLog(Document):
    ref: str                                   # ERR-XXXXXX shown to the user
    method: Optional[str] = None
    path: Optional[str] = None
    query: Optional[str] = None
    status_code: int = 500

    actor_id: Optional[str] = None
    actor_email: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None

    exc_type: Optional[str] = None
    message: str = ""
    traceback: Optional[str] = None
    context: dict[str, Any] = Field(default_factory=dict)

    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "error_logs"
        indexes = [
            IndexModel([("created_at", DESCENDING)]),
            IndexModel([("ref", ASCENDING)]),
            # TTL: rows self-delete after the retention window.
            IndexModel([("created_at", ASCENDING)], expireAfterSeconds=_TTL_SECONDS),
        ]


class ApiCallLog(Document):
    """One row per outbound third-party API call, for cost/usage tracking.

    Provider-agnostic on purpose: `service` + `operation` + `units` + `cost_paise`
    let free services (s3, gmail) and future PAID ones (whatsapp, sms, payment
    gateway, KYC) share the same shape. Roll-ups group by service + day.
    """

    service: str                               # s3 | gmail_smtp | whatsapp | ...
    operation: str                             # put_object | send_email | ...
    success: bool = True
    status_code: Optional[int] = None
    error: Optional[str] = None

    duration_ms: int = 0
    units: int = 1                             # emails sent, messages, requests
    bytes_transferred: int = 0
    cost_paise: int = 0                        # estimated cost (0 for free tiers)

    actor_id: Optional[str] = None
    related_type: Optional[str] = None
    related_id: Optional[str] = None
    meta: dict[str, Any] = Field(default_factory=dict)

    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "api_call_logs"
        indexes = [
            IndexModel([("created_at", DESCENDING)]),
            IndexModel([("service", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("created_at", ASCENDING)], expireAfterSeconds=_TTL_SECONDS),
        ]


class EmailOutbox(Document):
    to: str                                    # comma-joined recipients
    subject: str = ""
    kind: str = "generic"                      # otp | welcome | policy | ...
    status: str = "queued"                     # queued | sent | failed
    attempts: int = 0
    error: Optional[str] = None
    related_type: Optional[str] = None         # user | policy | withdrawal | ...
    related_id: Optional[str] = None

    created_at: datetime = Field(default_factory=utcnow)
    sent_at: Optional[datetime] = None

    class Settings:
        name = "email_outbox"
        indexes = [
            IndexModel([("created_at", DESCENDING)]),
            IndexModel([("status", ASCENDING)]),
            IndexModel([("created_at", ASCENDING)], expireAfterSeconds=_TTL_SECONDS),
        ]
