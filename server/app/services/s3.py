"""AWS S3 storage: private bucket, presigned upload/download URLs."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.config import settings

logger = logging.getLogger("agastyacrm.s3")

_client = None


def get_s3_client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            aws_access_key_id=settings.aws_access_key_id,
            aws_secret_access_key=settings.aws_secret_access_key,
            region_name=settings.aws_region,
            config=Config(signature_version="s3v4"),
        )
    return _client


def build_key(entity_type: str, entity_id: str, filename: str) -> str:
    """Namespaced, collision-resistant object key."""
    stamp = datetime.now(timezone.utc).strftime("%Y/%m")
    unique = uuid.uuid4().hex[:12]
    safe = filename.replace("/", "_").replace("\\", "_").strip()
    return f"{entity_type}/{entity_id}/{stamp}/{unique}-{safe}"


def presigned_upload(key: str, content_type: str | None = None) -> dict:
    """Presigned PUT URL the client uses to upload directly to S3."""
    params: dict = {"Bucket": settings.aws_bucket_name, "Key": key}
    if content_type:
        params["ContentType"] = content_type
    url = get_s3_client().generate_presigned_url(
        "put_object",
        Params=params,
        ExpiresIn=settings.s3_presign_expire_seconds,
    )
    return {"url": url, "key": key, "expires_in": settings.s3_presign_expire_seconds}


def presigned_post(key: str, content_type: str, max_bytes: int) -> dict:
    """Presigned POST the client uses to upload straight to S3, with the limits
    signed into the policy.

    Unlike a presigned PUT, the POST form carries CONDITIONS that S3 itself
    enforces: the object's content-type must equal what we signed, and its size
    must fall inside the range. That matters for the unauthenticated
    customer-upload link — a size cap checked in our own /confirm handler is
    only a cap on what the client chooses to TELL us, and does nothing about
    what actually landed in the bucket.

    Returns {"url", "fields", "key", "expires_in"}; the browser posts multipart
    form-data with `fields` followed by the file.
    """
    result = get_s3_client().generate_presigned_post(
        Bucket=settings.aws_bucket_name,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, max_bytes],
        ],
        ExpiresIn=settings.s3_presign_expire_seconds,
    )
    return {"url": result["url"], "fields": result["fields"], "key": key,
            "expires_in": settings.s3_presign_expire_seconds}


def presigned_download(key: str, filename: str | None = None,
                       expires_in: int | None = None) -> str:
    """Presigned GET URL for temporary download.

    `expires_in` overrides the default (e.g. a longer window for links emailed
    to customers, or WhatsApp document links Meta fetches shortly after send)."""
    params: dict = {"Bucket": settings.aws_bucket_name, "Key": key}
    if filename:
        params["ResponseContentDisposition"] = f'attachment; filename="{filename}"'
    return get_s3_client().generate_presigned_url(
        "get_object",
        Params=params,
        ExpiresIn=expires_in or settings.s3_presign_expire_seconds,
    )


def delete_object(key: str) -> bool:
    try:
        get_s3_client().delete_object(Bucket=settings.aws_bucket_name, Key=key)
        return True
    except (ClientError, BotoCoreError):
        logger.exception("Failed to delete S3 object %s", key)
        return False


def copy_object(source_key: str, dest_key: str) -> bool:
    """Duplicate an object inside the bucket. False if it could not be done.

    Used when a renewal carries last year's supporting documents forward. The
    file is COPIED rather than the two records sharing one key, because deleting
    a policy purges its S3 objects (routers/policies.delete_policy) — a shared
    key would mean deleting last year's policy silently emptied this year's KYC.
    A server-side copy never streams the bytes through this process.
    """
    try:
        get_s3_client().copy_object(
            Bucket=settings.aws_bucket_name,
            CopySource={"Bucket": settings.aws_bucket_name, "Key": source_key},
            Key=dest_key)
        return True
    except (ClientError, BotoCoreError):
        logger.exception("Failed to copy S3 object %s -> %s",
                         source_key, dest_key)
        return False


def object_exists(key: str) -> bool:
    return head_object(key) is not None


def head_object(key: str) -> dict | None:
    """The object's metadata (ContentLength, ContentType, ...), or None if it
    isn't there. Used to record what a client ACTUALLY uploaded instead of what
    it claimed in the confirm call."""
    try:
        return get_s3_client().head_object(
            Bucket=settings.aws_bucket_name, Key=key)
    except (ClientError, BotoCoreError):
        return None
