"""High-level outbound messaging: policy documents, renewal reminders and
partner statements over WhatsApp (+ email), gated by the owner's settings.

All the "who gets what" policy lives here so routers and the renewal job share
one implementation. WhatsApp is priority; email is sent in addition whenever an
address is available (per owner requirement). Everything is best-effort and
designed to be called from a background task.
"""

from __future__ import annotations

import logging
from datetime import timezone

from app.core.enums import RecordOrigin
from app.models.customer import Customer
from app.models.document import DocumentRecord
from app.models.insurer import Insurer
from app.models.master import PolicyCategory
from app.models.policy import Policy
from app.models.user import User
from app.services import email as email_svc
from app.services import s3, settings_svc, whatsapp
from app.services.money import paise_to_rupees

logger = logging.getLogger("agastyacrm.messaging")

# Longer window for links Meta / email clients fetch after the request ends.
_LINK_TTL = 7 * 24 * 3600


def _rupees(paise: int | None) -> str:
    return f"Rs. {paise_to_rupees(paise or 0):,.2f}"


def _date(dt) -> str:
    if not dt:
        return "-"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.strftime("%d %b %Y")


async def send_statement_document(
    *, mobile: str | None, name: str, doc_url: str, filename: str,
    period_label: str, kind: str, related_id: str,
) -> dict:
    """WhatsApp a generated statement PDF to a customer / channel partner.

    Gated by the WhatsApp master toggle; no-ops with a clear reason until the
    master switch + an approved statement template are configured (same
    constraint as policy-document sending). Broker statements are internal and
    never sent to the party.
    """
    s = await settings_svc.get_settings()
    wa = s.whatsapp
    if not wa.enabled:
        return {"ok": False, "reason": "WhatsApp is turned off in settings."}
    if not doc_url:
        return {"ok": False, "reason": "Could not prepare the statement file."}
    template = wa.tpl_statement_partner or wa.tpl_policy_customer
    res = await whatsapp.send_template(
        mobile, template, language=wa.default_lang,
        body_params=[name, period_label],
        document_url=doc_url, document_filename=filename,
        operation=f"statement_{kind}", related_type="statement",
        related_id=related_id)
    return {"ok": res.ok, "reason": res.reason}


async def policy_doc_link(policy_id: str) -> tuple[str | None, str | None]:
    """Presigned URL + filename of the first document on a policy, or (None,None)."""
    doc = await DocumentRecord.find(
        DocumentRecord.entity_type == "policy",
        DocumentRecord.entity_id == policy_id,
    ).sort("+created_at").first_or_none()
    if not doc:
        return None, None
    try:
        url = s3.presigned_download(doc.s3_key, doc.filename, expires_in=_LINK_TTL)
        return url, doc.filename
    except Exception:  # noqa: BLE001
        logger.exception("Failed to presign policy document %s", policy_id)
        return None, None


def _customer_scope_allows(scope: str, origin) -> bool:
    origin_v = origin.value if hasattr(origin, "value") else origin
    if scope == "inhouse":
        return origin_v == RecordOrigin.INHOUSE.value
    if scope == "channel_partner":
        return origin_v == RecordOrigin.CHANNEL_PARTNER.value
    return True  # "all"


def _policy_email_html(*, name: str, policy_number: str, category: str,
                       insurer: str, premium: str, sum_insured: str,
                       expiry: str, doc_url: str | None) -> str:
    btn = ""
    if doc_url:
        btn = (f'<p style="margin:20px 0"><a href="{doc_url}" '
               'style="background:#2563EB;color:#fff;padding:10px 18px;'
               'border-radius:8px;text-decoration:none">Download Policy Document</a>'
               '</p><p style="color:#64748b;font-size:12px">This secure link is '
               'valid for 7 days.</p>')
    return f"""
    <div style="font-family:Arial,sans-serif;color:#0f172a">
      <p>Dear {name},</p>
      <p>Thank you for choosing <b>Agstya Associate</b>. Here are your policy
      details:</p>
      <table style="font-size:14px;border-collapse:collapse">
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Policy Number</td>
            <td><b>{policy_number}</b></td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Type</td>
            <td>{category}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Insurer</td>
            <td>{insurer}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Sum Insured</td>
            <td>{sum_insured}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Premium</td>
            <td>{premium}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#64748b">Valid till</td>
            <td>{expiry}</td></tr>
      </table>
      {btn}
      <p>For any assistance, simply reply to this message.</p>
      <p>Warm regards,<br/>Team Agstya Associate</p>
    </div>
    """


async def send_policy_document(
    policy: Policy,
    *,
    trigger: str = "manual",          # "manual" | "auto"
    to_customer: bool = True,
    to_partner: bool = True,
) -> dict:
    """Deliver a policy document to the customer and/or attributed partner.

    Applies the owner's WhatsApp toggles. Returns a per-recipient outcome dict.
    """
    s = await settings_svc.get_settings()
    wa = s.whatsapp
    out: dict = {"whatsapp": {}, "email": {}}

    customer = await Customer.get(policy.customer_id) if policy.customer_id else None
    insurer = await Insurer.get(policy.insurer_id) if policy.insurer_id else None
    cat = await PolicyCategory.find_one(PolicyCategory.key == policy.category_key)
    category_label = cat.label if cat else (policy.category_key or "policy")
    insurer_name = insurer.name if insurer else "-"
    policy_number = policy.policy_number or policy.code

    doc_url, doc_name = await policy_doc_link(str(policy.id))

    body = [policy_number, category_label, insurer_name,
            _rupees(policy.premium_amount), _date(policy.expiry_date)]

    # --- Customer ---
    if to_customer and customer:
        auto_ok = trigger == "manual" or wa.send_policy_on_create_customer
        scope_ok = _customer_scope_allows(wa.customer_send_scope, customer.origin)
        if wa.enabled and auto_ok and scope_ok and doc_url:
            res = await whatsapp.send_template(
                customer.mobile, wa.tpl_policy_customer,
                language=wa.default_lang,
                body_params=[customer.name, *body],
                document_url=doc_url, document_filename=doc_name,
                operation="policy_document_customer",
                related_type="policy", related_id=str(policy.id))
            out["whatsapp"]["customer"] = {"ok": res.ok, "reason": res.reason}
        elif wa.enabled and auto_ok and scope_ok and not doc_url:
            out["whatsapp"]["customer"] = {"ok": False,
                                           "reason": "No policy document to send."}
        if customer.email and s.email.enabled:
            html = _policy_email_html(
                name=customer.name, policy_number=policy_number,
                category=category_label, insurer=insurer_name,
                premium=_rupees(policy.premium_amount),
                sum_insured=_rupees(policy.sum_insured),
                expiry=_date(policy.expiry_date), doc_url=doc_url)
            await email_svc.enqueue(
                customer.email, f"Your Agstya Associate policy {policy_number}", html,
                kind="policy_document", related_type="policy",
                related_id=str(policy.id))
            out["email"]["customer"] = "queued"

    # --- Attributed partner ---
    if to_partner and policy.partner_id:
        partner = await User.get(policy.partner_id)
        if partner:
            auto_ok = trigger == "manual" or wa.send_policy_on_create_partner
            if wa.enabled and auto_ok and doc_url:
                res = await whatsapp.send_template(
                    partner.mobile, wa.tpl_policy_partner,
                    language=wa.default_lang,
                    body_params=[partner.full_name, *body],
                    document_url=doc_url, document_filename=doc_name,
                    operation="policy_document_partner",
                    related_type="policy", related_id=str(policy.id))
                out["whatsapp"]["partner"] = {"ok": res.ok, "reason": res.reason}
            if partner.email and s.email.enabled:
                html = _policy_email_html(
                    name=partner.full_name, policy_number=policy_number,
                    category=category_label, insurer=insurer_name,
                    premium=_rupees(policy.premium_amount),
                    sum_insured=_rupees(policy.sum_insured),
                    expiry=_date(policy.expiry_date), doc_url=doc_url)
                await email_svc.enqueue(
                    partner.email,
                    f"Policy {policy_number} — customer document", html,
                    kind="policy_document", related_type="policy",
                    related_id=str(policy.id))
                out["email"]["partner"] = "queued"
    return out


async def send_renewal_reminder(
    policy: Policy, customer: Customer, *, days_left: int,
) -> dict:
    """Send a renewal reminder to a customer over WhatsApp (if enabled + opted
    in) AND email (if an address exists). Returns an outcome dict."""
    s = await settings_svc.get_settings()
    wa = s.whatsapp
    out: dict = {}

    cat = await PolicyCategory.find_one(PolicyCategory.key == policy.category_key)
    category_label = cat.label if cat else (policy.category_key or "policy")
    policy_number = policy.policy_number or policy.code
    expiry = _date(policy.expiry_date)

    if (wa.enabled and wa.renewal_reminders_customers
            and customer.renewal_reminders_enabled
            and _customer_scope_allows(wa.customer_send_scope, customer.origin)):
        res = await whatsapp.send_template(
            customer.mobile, wa.tpl_renewal_customer, language=wa.default_lang,
            body_params=[customer.name, policy_number, category_label, expiry,
                         str(days_left)],
            operation="renewal_reminder", related_type="policy",
            related_id=str(policy.id))
        out["whatsapp"] = {"ok": res.ok, "reason": res.reason}

    if customer.email and s.email.enabled:
        await email_svc.send_renewal_reminder_email(
            customer.email, customer.name, policy_number, category_label,
            expiry, days_left)
        out["email"] = "queued"
    return out
