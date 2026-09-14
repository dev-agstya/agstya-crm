"""Public (unauthenticated) endpoints — token-based customer document upload."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from app.core.enums import AuditAction, DocumentStatus
from app.core.rate_limit import _hit
from app.models.customer import Customer
from app.models.document import DocumentRecord, DocumentRequest
from app.services import s3
from app.services.audit import log_action

router = APIRouter(prefix="/api/public/upload", tags=["public"])

# Public (unauthenticated, token-gated) uploads are deliberately narrow: only
# document/image types, a hard size cap, and a per-link count cap so a leaked
# link can't be used to dump arbitrary or huge objects into the bucket (Q-S1).
_ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
}
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024        # 20 MB
_MAX_DOCS_PER_LINK = 25                       # per document-request token


def _check_content_type(content_type: str | None) -> str:
    """Return the normalised content type, or refuse.

    A MISSING type is refused just like a disallowed one. The old check read
    `if content_type and ...`, so sending null skipped the allow-list entirely
    AND left ContentType out of the signed URL — which made the presigned
    upload accept absolutely anything.
    """
    normalised = (content_type or "").split(";")[0].strip().lower()
    if normalised not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Only PDF or image files can be uploaded here.")
    return normalised


class RequestInfo(BaseModel):
    customer_name: str
    requested_docs: list[dict]
    message: str | None = None
    completed: bool


class PublicPresignRequest(BaseModel):
    filename: str
    content_type: str | None = None
    doc_key: str | None = None
    label: str | None = None


class PublicConfirmRequest(BaseModel):
    s3_key: str
    filename: str
    content_type: str | None = None
    size_bytes: int | None = None
    doc_key: str | None = None
    label: str


async def _load_request(token: str) -> DocumentRequest:
    req = await DocumentRequest.find_one(DocumentRequest.token == token)
    if req is None or req.is_expired:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "This upload link is invalid or has expired.")
    return req


@router.get("/{token}", response_model=RequestInfo)
async def get_request(token: str) -> RequestInfo:
    req = await _load_request(token)
    cust = await Customer.get(req.customer_id)
    return RequestInfo(
        customer_name=cust.name if cust else "Customer",
        requested_docs=req.requested_docs,
        message=req.message,
        completed=req.completed,
    )


@router.post("/{token}/presign")
async def public_presign(token: str, payload: PublicPresignRequest,
                         request: Request) -> dict:
    req = await _load_request(token)
    # A presign hands out write access to the bucket, so it is capped per LINK
    # (not per IP — an IP-keyed limit resets the moment the caller changes
    # networks). The /confirm document cap does nothing about a client that
    # uploads and simply never confirms.
    retry = _hit(f"public_presign:{token}", _MAX_DOCS_PER_LINK, 3600)
    if retry:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "This upload link has been used too many times. Please try again "
            "later or ask for a fresh link.",
            headers={"Retry-After": str(retry)})
    content_type = _check_content_type(payload.content_type)
    key = s3.build_key("customer", req.customer_id, payload.filename)
    result = s3.presigned_post(key, content_type, _MAX_UPLOAD_BYTES)
    return {"upload_url": result["url"], "fields": result["fields"],
            "s3_key": key, "expires_in": result["expires_in"]}


@router.post("/{token}/confirm", response_model=RequestInfo)
async def public_confirm(token: str, payload: PublicConfirmRequest) -> RequestInfo:
    req = await _load_request(token)
    # Lock the object key to THIS customer's namespace — never trust an arbitrary
    # client-supplied key (Q-S1). `build_key` writes under "customer/<id>/...".
    expected_prefix = f"customer/{req.customer_id}/"
    if not payload.s3_key.startswith(expected_prefix):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Invalid upload key for this link.")
    content_type = _check_content_type(payload.content_type)
    # Cap how many documents a single link can register.
    existing = await DocumentRecord.find(
        DocumentRecord.uploaded_via_request == token).count()
    if existing >= _MAX_DOCS_PER_LINK:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This upload link has reached its document limit.")

    # Read the real size and type off the object rather than believing the
    # payload. The presigned POST policy already refuses anything oversized, so
    # this both records the truth and rejects a /confirm for a key that was
    # never actually uploaded.
    head = s3.head_object(payload.s3_key)
    if head is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That upload did not complete. Please try again.")
    size_bytes = head.get("ContentLength")
    if size_bytes is not None and size_bytes > _MAX_UPLOAD_BYTES:
        s3.delete_object(payload.s3_key)
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            "File too large (max 20 MB).")

    doc = DocumentRecord(
        entity_type="customer",
        entity_id=req.customer_id,
        doc_key=payload.doc_key,
        label=payload.label,
        s3_key=payload.s3_key,
        filename=payload.filename,
        content_type=head.get("ContentType") or content_type,
        size_bytes=size_bytes,
        status=DocumentStatus.UPLOADED,
        uploaded_via_request=token,
    )
    await doc.insert()
    await log_action(
        AuditAction.DOCUMENT_UPLOADED, entity_type="customer",
        entity_id=req.customer_id,
        summary=f"Customer uploaded '{payload.label}' via request link",
    )
    cust = await Customer.get(req.customer_id)
    return RequestInfo(
        customer_name=cust.name if cust else "Customer",
        requested_docs=req.requested_docs,
        message=req.message,
        completed=req.completed,
    )
