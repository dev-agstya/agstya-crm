"""Owner-only runtime settings: third-party services, the partner portal, and
the attendance & leave policy.

ONE ENDPOINT FOR ONE DOCUMENT. `SystemSettings` is a singleton cached in process
(services/settings_svc), and every block of it is read and written through here
so there is exactly one place the cache is invalidated. Three pages sit on top
of it — Third Party Services, Partner portal, and Attendance & leave — and each
PATCHes only its own block; `settings_svc.update` merges field by field, so one
page saving cannot reset another page's switches.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.config import settings as app_settings
from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_account_type,
)
from app.core.enums import AccountType, AuditAction
from app.models.user import User

require_owner = require_account_type(AccountType.OWNER)
from app.schemas.settings import ServiceStatus, SettingsOut, SettingsUpdate
from app.services import settings_svc, whatsapp
from app.services.audit import log_action

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/admin/services", tags=["settings"],
                   dependencies=[Depends(get_inhouse_user)])


def _service_statuses() -> list[ServiceStatus]:
    return [
        ServiceStatus(
            key="whatsapp", label="WhatsApp (Meta Cloud API)",
            configured=whatsapp.credentials_ready(),
            detail=("Sender + access token configured."
                    if whatsapp.credentials_ready()
                    else "Set WHATSAPP_* values in the server environment.")),
        ServiceStatus(
            key="email", label="Email (Gmail SMTP)",
            configured=bool(app_settings.gmail_username
                            and app_settings.gmail_app_pwd),
            detail="Transactional email via Gmail SMTP."),
        ServiceStatus(
            key="s3", label="Document Storage (AWS S3)",
            configured=bool(app_settings.aws_access_key_id
                            and app_settings.aws_bucket_name),
            detail=f"Bucket: {app_settings.aws_bucket_name or '—'}"),
        ServiceStatus(
            key="turnstile", label="CAPTCHA (Cloudflare Turnstile)",
            configured=bool(app_settings.turnstile_secret_key
                            and app_settings.turnstile_site_key),
            detail="Protects the login form after repeated failures."),
    ]


async def _out() -> SettingsOut:
    s = await settings_svc.get_settings()
    return SettingsOut(
        whatsapp=s.whatsapp, email=s.email,
        partner_portal=s.partner_portal,
        # Attendance & leave policy. Served here because SystemSettings is one
        # document — a second settings router would be a second place for the
        # in-process cache invalidation to be forgotten. The page that edits it
        # is /settings/attendance, which is owner-only like this router.
        hr=s.hr,
        whatsapp_credentials_ready=whatsapp.credentials_ready(),
        services=_service_statuses())


@router.get("", response_model=SettingsOut,
            dependencies=[Depends(require_owner)])
async def get_services(_: User = Depends(get_active_user)) -> SettingsOut:
    return await _out()


@router.patch("", response_model=SettingsOut,
              dependencies=[Depends(require_owner)])
async def update_services(payload: SettingsUpdate, request: Request,
                          actor: User = Depends(get_active_user)) -> SettingsOut:
    data = payload.model_dump(exclude_unset=True)
    await settings_svc.update(data, actor_id=str(actor.id))
    await log_action(
        AuditAction.SETTINGS_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        request=request, summary="Updated third-party service settings",
        meta={"changed": list(data.keys())})
    return await _out()
