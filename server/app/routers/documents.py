"""Document handling: presigned S3 upload/download, and public request links."""

from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.config import settings
from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction, DocumentStatus
from app.core.permissions import MANAGE_POLICIES, VIEW_POLICIES  # noqa: F401
from app.models.base import utcnow
from app.models.customer import Customer
from app.models.document import DocumentRecord, DocumentRequest
from app.models.policy import Policy
from app.models.user import User
from app.routers._helpers import ensure_can_access, parse_object_id
from app.schemas.common import Message
from app.schemas.document import (
    ConfirmUploadRequest,
    DocumentOut,
    DocumentRequestCreate,
    DownloadUrlResponse,
    PresignUploadRequest,
    PresignUploadResponse,
)
from app.services import email as email_svc
from app.services import s3
from app.services.audit import log_action

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/documents", tags=["documents"],
                   dependencies=[Depends(get_inhouse_user)])


# Adding a type here is deliberate, never a loosening of the check:
# the `else` branch that used to treat ANY unknown type as a customer
# is why this list exists at all.
_ENTITY_TYPES = ("policy", "customer", "quote_request", "claim")


async def _load_entity_and_check(actor: User, entity_type: str, entity_id: str):
    # Validate the type here rather than at one call site: the old `else` branch
    # silently treated ANY unknown entity_type as a customer, so a presign or
    # confirm for "user"/"ledger_txn" landed in the wrong namespace instead of
    # being refused.
    if entity_type not in _ENTITY_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid entity type.")
    if entity_type == "policy":
        obj = await Policy.get(await parse_object_id(entity_id))
    else:
        obj = await Customer.get(await parse_object_id(entity_id))
    if obj is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Entity not found.")
    await ensure_can_access(actor, obj)
    return obj


@router.post("/presign-upload", response_model=PresignUploadResponse,
             dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def presign_upload(payload: PresignUploadRequest,
                         actor: User = Depends(get_active_user)
                         ) -> PresignUploadResponse:
    await _load_entity_and_check(actor, payload.entity_type, payload.entity_id)
    key = s3.build_key(payload.entity_type, payload.entity_id, payload.filename)
    result = s3.presigned_upload(key, payload.content_type)
    return PresignUploadResponse(
        upload_url=result["url"], s3_key=key, expires_in=result["expires_in"],
    )


@router.post("/confirm", response_model=DocumentOut,
             dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def confirm_upload(payload: ConfirmUploadRequest, request: Request,
                         actor: User = Depends(get_active_user)) -> DocumentOut:
    await _load_entity_and_check(actor, payload.entity_type, payload.entity_id)
    # Never register an arbitrary client-supplied key: it must sit under this
    # entity's namespace ("<entity_type>/<entity_id>/...", see s3.build_key).
    if not payload.s3_key.startswith(
            f"{payload.entity_type}/{payload.entity_id}/"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Upload key does not match the target record.")

    # Customer KYC is a fixed set of slots: re-uploading a slot REPLACES the old
    # file (delete-on-update). Policy documents carry no such rule and are kept
    # for the record (Q12). A slot is identified by (customer entity + doc_key).
    if payload.entity_type == "customer" and payload.doc_key:
        old_docs = await DocumentRecord.find(
            DocumentRecord.entity_type == "customer",
            DocumentRecord.entity_id == payload.entity_id,
            DocumentRecord.doc_key == payload.doc_key,
        ).to_list()
        for old in old_docs:
            s3.delete_object(old.s3_key)
            await old.delete()

    doc = DocumentRecord(
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        doc_key=payload.doc_key,
        label=payload.label,
        s3_key=payload.s3_key,
        filename=payload.filename,
        content_type=payload.content_type,
        size_bytes=payload.size_bytes,
        status=DocumentStatus.UPLOADED,
        uploaded_by=str(actor.id),
    )
    await doc.insert()
    await log_action(
        AuditAction.DOCUMENT_UPLOADED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type=payload.entity_type, entity_id=payload.entity_id,
        request=request, summary=f"Uploaded document '{payload.label}'",
    )
    return DocumentOut.from_model(doc)


@router.get("/for/{entity_type}/{entity_id}", response_model=list[DocumentOut],
            dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def list_documents(entity_type: str, entity_id: str,
                         actor: User = Depends(get_active_user)
                         ) -> list[DocumentOut]:
    if entity_type not in ("policy", "customer"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid entity type.")
    await _load_entity_and_check(actor, entity_type, entity_id)
    docs = await DocumentRecord.find(
        DocumentRecord.entity_type == entity_type,
        DocumentRecord.entity_id == entity_id,
    ).sort("-created_at").to_list()
    return [DocumentOut.from_model(d) for d in docs]


@router.get("/{document_id}/download", response_model=DownloadUrlResponse,
            dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def download_document(document_id: str, request: Request,
                            actor: User = Depends(get_active_user)
                            ) -> DownloadUrlResponse:
    doc = await DocumentRecord.get(await parse_object_id(document_id))
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    await _load_entity_and_check(actor, doc.entity_type, doc.entity_id)
    url = s3.presigned_download(doc.s3_key, doc.filename)
    await log_action(
        AuditAction.DOCUMENT_DOWNLOADED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type=doc.entity_type, entity_id=doc.entity_id, request=request,
        summary=f"Downloaded document '{doc.label}'",
    )
    return DownloadUrlResponse(url=url,
                               expires_in=settings.s3_presign_expire_seconds)


@router.delete("/{document_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def delete_document(document_id: str, request: Request,
                          actor: User = Depends(get_active_user)) -> Message:
    doc = await DocumentRecord.get(await parse_object_id(document_id))
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    await _load_entity_and_check(actor, doc.entity_type, doc.entity_id)
    s3.delete_object(doc.s3_key)
    await doc.delete()
    await log_action(
        AuditAction.DOCUMENT_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type=doc.entity_type, entity_id=doc.entity_id, request=request,
        summary=f"Deleted document '{doc.label}'",
    )
    return Message(detail="Document deleted.")


# --- Customer document-request links (no customer login) ------------------------


@router.post("/requests", response_model=Message,
             dependencies=[Depends(require_permission(MANAGE_POLICIES))])
async def create_document_request(payload: DocumentRequestCreate, request: Request,
                                  actor: User = Depends(get_active_user)) -> Message:
    cust = await Customer.get(await parse_object_id(payload.customer_id))
    if cust is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found.")
    await ensure_can_access(actor, cust)

    token = secrets.token_urlsafe(32)
    req = DocumentRequest(
        token=token,
        customer_id=payload.customer_id,
        policy_id=payload.policy_id,
        requested_docs=payload.requested_docs,
        message=payload.message,
        expires_at=utcnow() + timedelta(days=7),
        created_by=str(actor.id),
    )
    await req.insert()

    recipient = payload.recipient_email or cust.email
    if payload.send_email and recipient:
        upload_url = f"{settings.frontend_base_url}/upload/{token}"
        docs = [d.get("label", d.get("key", "Document"))
                for d in payload.requested_docs]
        await email_svc.send_document_request_email(
            recipient, cust.name, upload_url, docs, payload.message)
    await log_action(
        AuditAction.DOCUMENT_REQUESTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="customer", entity_id=payload.customer_id, request=request,
        summary=f"Requested documents from {cust.name}",
    )
    return Message(detail=f"Document request sent to {recipient or 'customer'}.")
