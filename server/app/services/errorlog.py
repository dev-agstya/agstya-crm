"""Record unhandled server errors to the DB with a user-facing reference code,
and alert the developer email. Never raises — logging must not mask the error."""

from __future__ import annotations

import html as html_lib
import logging
import secrets
import traceback as _tb
from typing import Optional

from fastapi import Request

from app.config import settings
from app.core.rate_limit import client_ip
from app.core.security import decode_token
from app.models.system_logs import ErrorLog
from app.services import email as email_svc

logger = logging.getLogger("agastyacrm.errorlog")


def new_ref() -> str:
    """Short, user-quotable reference, e.g. ERR-3F9A2C."""
    return "ERR-" + secrets.token_hex(3).upper()


def _actor_id(request: Request) -> Optional[str]:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        data = decode_token(auth[7:].strip())
        if data:
            return data.get("sub")
    return None


# Query parameters whose VALUE must never reach a 180-day log.
_SENSITIVE_PARAMS = {"token", "otp", "password", "secret", "key",
                     "access_token", "refresh_token", "captcha_token"}


def _safe_query(request: Request) -> Optional[str]:
    """The failing request's query string, with sensitive values masked."""
    if not request.url.query:
        return None
    parts = []
    for pair in request.url.query.split("&"):
        name, sep, _value = pair.partition("=")
        if sep and name.lower() in _SENSITIVE_PARAMS:
            parts.append(f"{name}=***")
        else:
            parts.append(pair)
    return "&".join(parts)


async def record(request: Request, exc: BaseException,
                 *, ref: Optional[str] = None) -> str:
    ref = ref or new_ref()
    trace = "".join(_tb.format_exception(
        type(exc), exc, exc.__traceback__))[-8000:]
    try:
        await ErrorLog(
            ref=ref, method=request.method, path=request.url.path,
            query=_safe_query(request),
            actor_id=_actor_id(request),
            ip_address=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            exc_type=type(exc).__name__, message=str(exc)[:1000],
            traceback=trace,
        ).insert()
    except Exception:  # noqa: BLE001
        logger.exception("Failed to write ErrorLog %s", ref)

    if settings.alerts_enabled and settings.dev_alert_email:
        try:
            await _alert_developer(ref, request, exc)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to enqueue error alert for %s", ref)

    # Surface it in-app to the Owner(s) so problems don't stay buried.
    try:
        from app.core.permissions import VIEW_AUDIT_LOGS
        from app.services import notifications
        await notifications.notify_permission(
            VIEW_AUDIT_LOGS, f"Server error {ref}",
            body=f"{request.method} {request.url.path} — "
                 f"{type(exc).__name__}",
            category="error", link="/system")
    except Exception:  # noqa: BLE001
        logger.exception("Failed to notify owner of error %s", ref)
    return ref


async def _alert_developer(ref: str, request: Request,
                           exc: BaseException) -> None:
    body = (
        f"<h2>Server error {html_lib.escape(ref)}</h2>"
        f"<p><b>When:</b> just now<br>"
        f"<b>Where:</b> {html_lib.escape(request.method)} "
        f"{html_lib.escape(request.url.path)}<br>"
        f"<b>Type:</b> {html_lib.escape(type(exc).__name__)}<br>"
        f"<b>Message:</b> {html_lib.escape(str(exc)[:500])}</p>"
        f"<p>Full traceback is stored in the error_logs collection "
        f"(ref {html_lib.escape(ref)}).</p>"
    )
    await email_svc.enqueue(
        settings.dev_alert_email,
        f"[{settings.app_name}] Server error {ref}",
        body, kind="error_alert")
