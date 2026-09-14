"""WhatsApp Cloud API sender (Meta Graph API).

All sends are BUSINESS-INITIATED, so Meta requires pre-approved message
templates — free text is not allowed outside a customer-opened 24h window, which
we never have. Each message type therefore needs a template name configured in
SystemSettings; when the name is empty (or the master switch / credentials are
missing) the send NO-OPS with a clear, logged reason instead of raising.

Every attempt is recorded as an ApiCallLog(service="whatsapp") for usage
tracking, mirroring the email service.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import httpx

from app.config import settings
from app.services import apilog

logger = logging.getLogger("agastyacrm.whatsapp")


@dataclass
class SendResult:
    ok: bool
    reason: str = ""          # why it didn't send (for no-ops / failures)
    message_id: str | None = None


def credentials_ready() -> bool:
    return bool(settings.whatsapp_phone_number_id
                and settings.whatsapp_access_token)


def normalize_msisdn(mobile: str | None) -> str | None:
    """Return a wa_id (country code + number, digits only) or None."""
    if not mobile:
        return None
    digits = "".join(ch for ch in str(mobile) if ch.isdigit())
    if not digits:
        return None
    # A bare 10-digit number gets the default country code prefixed.
    if len(digits) == 10:
        digits = settings.whatsapp_default_country_code + digits
    return digits


def _api_url() -> str:
    return (f"https://graph.facebook.com/{settings.whatsapp_api_version}"
            f"/{settings.whatsapp_phone_number_id}/messages")


async def _post(payload: dict, *, operation: str,
                related_type: str | None = None,
                related_id: str | None = None) -> SendResult:
    start = time.perf_counter()
    ok = False
    err: str | None = None
    status_code: int | None = None
    message_id: str | None = None
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                _api_url(),
                headers={
                    "Authorization": f"Bearer {settings.whatsapp_access_token}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        status_code = resp.status_code
        data = resp.json() if resp.content else {}
        if resp.status_code < 300:
            ok = True
            msgs = data.get("messages") or []
            message_id = msgs[0].get("id") if msgs else None
        else:
            err = str(data.get("error", data))[:500]
            logger.warning("WhatsApp send failed (%s): %s",
                           resp.status_code, err)
    except Exception as exc:  # noqa: BLE001
        err = repr(exc)
        logger.exception("WhatsApp send raised")
    await apilog.record(
        "whatsapp", operation, success=ok, status_code=status_code,
        duration_ms=int((time.perf_counter() - start) * 1000), error=err,
        related_type=related_type, related_id=related_id)
    return SendResult(ok=ok, reason=err or "", message_id=message_id)


async def send_template(
    to_mobile: str | None,
    template_name: str,
    *,
    language: str = "en",
    body_params: list[str] | None = None,
    document_url: str | None = None,
    document_filename: str | None = None,
    operation: str = "send_template",
    related_type: str | None = None,
    related_id: str | None = None,
) -> SendResult:
    """Send an approved template, optionally with a document header + body vars.

    Returns a SendResult; a no-op (missing creds / template) is ok=False with a
    reason and is NOT logged as an API call (nothing was attempted).
    """
    if not credentials_ready():
        return SendResult(False, "WhatsApp credentials not configured.")
    wa_id = normalize_msisdn(to_mobile)
    if not wa_id:
        return SendResult(False, "No valid mobile number.")
    if not template_name:
        return SendResult(False, "No approved template configured for this "
                                 "message type.")

    components: list[dict] = []
    if document_url:
        components.append({
            "type": "header",
            "parameters": [{
                "type": "document",
                "document": {
                    "link": document_url,
                    **({"filename": document_filename}
                       if document_filename else {}),
                },
            }],
        })
    if body_params:
        components.append({
            "type": "body",
            "parameters": [{"type": "text", "text": str(p)}
                           for p in body_params],
        })

    payload = {
        "messaging_product": "whatsapp",
        "to": wa_id,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": language or "en"},
            **({"components": components} if components else {}),
        },
    }
    return await _post(payload, operation=operation,
                       related_type=related_type, related_id=related_id)


async def send_announcement(to_mobile: str | None, title: str,
                            body: str) -> SendResult:
    """Push a broadcast to a partner's WhatsApp.

    Meta only allows APPROVED templates for business-initiated messages, so this
    is a no-op with a logged reason until `tpl_announcement_partner` names one —
    exactly like every other message type here. That is the honest failure mode:
    the notice still reaches the portal and the inbox.
    """
    from app.services import settings_svc

    settings_doc = await settings_svc.get_settings()
    wa = settings_doc.whatsapp
    if not wa.enabled:
        return SendResult(False, "WhatsApp is switched off.")
    return await send_template(
        to_mobile, wa.tpl_announcement_partner,
        language=wa.default_lang or "en",
        body_params=[title, body[:600]],
        operation="send_announcement", related_type="announcement")
