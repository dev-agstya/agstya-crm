"""Document schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class PresignUploadRequest(BaseModel):
    entity_type: str = Field(pattern="^(policy|customer)$")
    entity_id: str
    filename: str
    content_type: Optional[str] = None
    doc_key: Optional[str] = None
    label: Optional[str] = None


class PresignUploadResponse(BaseModel):
    upload_url: str
    s3_key: str
    expires_in: int


class ConfirmUploadRequest(BaseModel):
    """Called after the client PUTs the file to S3, to register metadata."""

    entity_type: str = Field(pattern="^(policy|customer)$")
    entity_id: str
    s3_key: str
    filename: str
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None
    doc_key: Optional[str] = None
    label: str


class DocumentOut(BaseModel):
    id: str
    entity_type: str
    entity_id: str
    doc_key: Optional[str] = None
    label: str
    filename: str
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None
    status: str
    uploaded_by: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, d) -> "DocumentOut":
        return cls(
            id=str(d.id),
            entity_type=d.entity_type,
            entity_id=d.entity_id,
            doc_key=d.doc_key,
            label=d.label,
            filename=d.filename,
            content_type=d.content_type,
            size_bytes=d.size_bytes,
            status=d.status.value if hasattr(d.status, "value") else d.status,
            uploaded_by=d.uploaded_by,
            created_at=d.created_at,
        )


class DocumentRequestCreate(BaseModel):
    customer_id: str
    policy_id: Optional[str] = None
    requested_docs: list[dict] = Field(default_factory=list)  # {key,label}
    message: Optional[str] = None
    send_email: bool = True
    recipient_email: Optional[EmailStr] = None  # override customer email


class DownloadUrlResponse(BaseModel):
    url: str
    expires_in: int
