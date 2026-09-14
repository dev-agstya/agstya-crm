"""Document records (S3 objects) and public document-request links."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import DocumentStatus
from app.models.base import utcnow


class DocumentRecord(Document):
    """Metadata for a file stored in S3. The bucket stays private; access is via
    short-lived presigned URLs generated on demand."""

    # What this document belongs to.
    entity_type: str                   # "policy" | "customer"
    entity_id: Indexed(str)
    doc_key: Optional[str] = None      # matches RequiredDocSpec.key, if any
    label: str

    s3_key: str                        # object key in the bucket
    filename: str
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None

    status: DocumentStatus = DocumentStatus.UPLOADED
    # If uploaded via a public request link rather than an internal user.
    uploaded_via_request: Optional[str] = None

    uploaded_by: Optional[str] = None  # user id, or None for customer upload
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "documents"
        indexes = [
            [("entity_type", pymongo.ASCENDING), ("entity_id", pymongo.ASCENDING)],
        ]


class DocumentRequest(Document):
    """A tokenised link emailed to a customer to collect documents without login."""

    token: Indexed(str, unique=True)   # random URL-safe token
    customer_id: str
    policy_id: Optional[str] = None
    # Which documents we're asking for (doc_key + label pairs).
    requested_docs: list[dict] = Field(default_factory=list)
    message: Optional[str] = None

    expires_at: datetime
    completed: bool = False
    completed_at: Optional[datetime] = None

    created_by: str
    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "document_requests"
        indexes = [
            pymongo.IndexModel(
                [("expires_at", pymongo.ASCENDING)],
                expireAfterSeconds=0,
                name="docreq_ttl",
            ),
        ]

    @property
    def is_expired(self) -> bool:
        exp = self.expires_at
        if exp.tzinfo is None:
            from datetime import timezone
            exp = exp.replace(tzinfo=timezone.utc)
        return utcnow() >= exp
