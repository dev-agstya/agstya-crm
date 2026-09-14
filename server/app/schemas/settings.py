"""Schemas for the owner-editable Third Party Services settings."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from app.models.settings import (
    EmailSettings, HrSettings, PartnerPortalSettings, WhatsAppSettings,
)


class WhatsAppSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    send_policy_on_create_customer: Optional[bool] = None
    send_policy_on_create_partner: Optional[bool] = None
    renewal_reminders_customers: Optional[bool] = None
    renewal_reminders_partners: Optional[bool] = None
    customer_send_scope: Optional[str] = None
    tpl_policy_customer: Optional[str] = None
    tpl_policy_partner: Optional[str] = None
    tpl_statement_partner: Optional[str] = None
    tpl_renewal_customer: Optional[str] = None
    tpl_renewal_partner: Optional[str] = None
    tpl_announcement_partner: Optional[str] = None
    default_lang: Optional[str] = None


class EmailSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None


class PartnerPortalSettingsUpdate(BaseModel):
    """The portal master switch and what a signed-in partner may do.

    `enabled: false` locks every channel partner out immediately — it is
    checked on every request, not just at login, so it is the one-click kill
    switch the owner asked for.
    """

    enabled: Optional[bool] = None
    can_request_quotes: Optional[bool] = None
    can_raise_claims: Optional[bool] = None
    can_view_earnings: Optional[bool] = None
    can_download_policy_pdf: Optional[bool] = None
    can_view_renewals: Optional[bool] = None
    can_upload_kyc: Optional[bool] = None
    quote_validity_days: Optional[int] = Field(default=None, ge=1, le=90)


class SettingsUpdate(BaseModel):
    whatsapp: Optional[WhatsAppSettingsUpdate] = None
    email: Optional[EmailSettingsUpdate] = None
    partner_portal: Optional[PartnerPortalSettingsUpdate] = None
    # Attendance & leave policy (2026-08-20). Its own owner-only page at
    # /settings/attendance; it rides this endpoint because SystemSettings is
    # one document and a second settings router would be a second place for
    # the cache invalidation to be forgotten.
    hr: Optional["HrSettingsUpdate"] = None


class ServiceStatus(BaseModel):
    """Read-only health/config status of a third-party integration."""
    key: str
    label: str
    configured: bool
    detail: str = ""


class SettingsOut(BaseModel):
    whatsapp: WhatsAppSettings
    email: EmailSettings
    partner_portal: PartnerPortalSettings
    hr: HrSettings = Field(default_factory=HrSettings)
    # Whether Meta credentials exist in the environment (drives the UI hint).
    whatsapp_credentials_ready: bool = False
    services: list[ServiceStatus] = []


# Imported at the BOTTOM and rebuilt, not at the top: schemas/hr imports from
# core/enums and nothing from here, but keeping the import local to its use
# documents that this is the only thing settings needs from the HR module.
from app.schemas.hr import HrSettingsUpdate  # noqa: E402

SettingsUpdate.model_rebuild()
