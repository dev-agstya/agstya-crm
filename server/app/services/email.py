"""Transactional email over Gmail SMTP with Jinja2 HTML templates.

Every template extends templates/email/base.html — black / white / grey, the
hosted wordmark in the header, and a footer carrying the agency's real contact
details plus the "this is automatically generated, do not reply" notice.

The identity in that footer comes from services/company.py through
`_company_context()`, so the address, phone or email is changed in ONE Python
file and every email follows. Nothing is hard-coded into the HTML.
"""

from __future__ import annotations

import asyncio
import logging
import re
from email.message import EmailMessage
from pathlib import Path

import aiosmtplib
from jinja2 import Environment, FileSystemLoader, select_autoescape

from app.config import settings
from app.models.base import utcnow
from app.services import company

logger = logging.getLogger("agastyacrm.email")

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates" / "email"

# The wordmark, served from the frontend's public/ folder on Vercel. Emails
# cannot reach the server's local assets/, so this has to be an absolute URL.
LOGO_URL = "https://agatya--test.vercel.app/agastya_hindi_full_logo.png"

_env = Environment(
    loader=FileSystemLoader(str(TEMPLATE_DIR)),
    autoescape=select_autoescape(["html", "xml"]),
    enable_async=False,
)


def _company_context() -> dict:
    """Agency identity for the header and footer of every email."""
    website = company.COMPANY_WEBSITE or ""
    return {
        "company_name": company.COMPANY_NAME,
        "company_address": company.COMPANY_ADDRESS,
        "company_email": company.COMPANY_EMAIL,
        "company_phone": company.COMPANY_PHONE,
        "company_website": website,
        # Shown as "www.example.in" rather than the raw href.
        "company_website_label": re.sub(r"^https?://|/$", "", website),
        "company_gstin": company.COMPANY_GSTIN,
        "logo_url": LOGO_URL,
    }


def render(template_name: str, **context) -> str:
    context.setdefault("app_name", settings.app_name)
    context.setdefault("frontend_url", settings.frontend_base_url)
    context.setdefault("year", __import__("datetime").datetime.now().year)
    for key, value in _company_context().items():
        context.setdefault(key, value)
    return _env.get_template(template_name).render(**context)


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\n\s*\n\s*\n+")


def to_text(html: str) -> str:
    """A readable plain-text alternative for the multipart email.

    Not a full HTML-to-text engine — it strips the markup, decodes the handful
    of entities the templates actually emit and collapses the blank lines the
    table layout leaves behind. Without it, a text-only client shows an empty
    message, which reads as a broken send.
    """
    text = re.sub(r"(?is)<(script|style|head).*?</\1>", "", html)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</tr>|</h1>|</div>", "\n", text)
    text = re.sub(r"(?i)</td>", "  ", text)
    text = _TAG_RE.sub("", text)
    for entity, char in (("&nbsp;", " "), ("&middot;", "-"), ("&amp;", "&"),
                         ("&copy;", "(c)"), ("&lt;", "<"), ("&gt;", ">"),
                         ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(entity, char)
    lines = [ln.strip() for ln in text.splitlines()]
    return _WS_RE.sub("\n\n", "\n".join(ln for ln in lines if ln)).strip()


_HEADER_BREAKS = re.compile(r"[\r\n]+")


def _header_safe(value: str) -> str:
    """Collapse CR/LF out of a value going into an email header.

    A newline inside a subject or recipient ends that header and starts a new
    one, which is how an extra Bcc: gets appended to someone else's mail. Most
    of our subjects are server-built, but they interpolate names, period labels
    and status words, so the rule is applied at the boundary rather than
    audited per call site.
    """
    return _HEADER_BREAKS.sub(" ", value or "").strip()


async def send_email(
    to: str | list[str],
    subject: str,
    html_body: str,
    text_body: str | None = None,
    attachments: list[tuple[str, bytes, str]] | None = None,
) -> bool:
    """Send an HTML email. Returns True on success, False on failure (logged).
    Every attempt is recorded as an ApiCallLog (gmail_smtp) for usage tracking.

    `attachments` is a list of (filename, content_bytes, mime_subtype) — e.g.
    ("statement.pdf", b"...", "pdf") for a PDF attachment."""
    import time

    from app.services import apilog

    recipients = [_header_safe(r) for r in
                  ([to] if isinstance(to, str) else to)]

    message = EmailMessage()
    message["From"] = settings.mail_from_resolved
    message["To"] = ", ".join(recipients)
    message["Subject"] = _header_safe(subject)
    # Always ship a real plain-text part: some clients (and most spam filters)
    # treat an HTML-only message with a stub text body as a bad signal.
    message.set_content(text_body or to_text(html_body)
                        or "This email requires an HTML-capable client.")
    message.add_alternative(html_body, subtype="html")
    for filename, content, subtype in (attachments or []):
        message.add_attachment(
            content, maintype="application", subtype=subtype,
            filename=filename)

    start = time.perf_counter()
    ok = False
    err: str | None = None
    try:
        await aiosmtplib.send(
            message,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.gmail_username,
            password=settings.gmail_app_pwd,
            start_tls=True,
            timeout=30,
        )
        ok = True
        logger.info("Email sent to %s: %s", recipients, subject)
    except Exception as exc:  # noqa: BLE001
        err = repr(exc)
        logger.exception("Failed to send email to %s", recipients)
    await apilog.record(
        "gmail_smtp", "send_email", success=ok,
        duration_ms=int((time.perf_counter() - start) * 1000),
        units=len(recipients), error=err, meta={"subject": subject[:120]})
    return ok


# --- Outbox: record + deliver off the request path ------------------------------

# Strong references to in-flight delivery tasks (see enqueue).
_pending_sends: set[asyncio.Task] = set()


async def enqueue(
    to: str | list[str], subject: str, html: str, *,
    kind: str = "generic", related_type: str | None = None,
    related_id: str | None = None,
) -> None:
    """Record the email in the outbox and deliver it in the background so no
    request ever waits on SMTP. A failed send is left as status='failed' with the
    error, so a silently-dropped email is always visible."""
    from app.models.system_logs import EmailOutbox  # local: avoid import cycle

    recipients = to if isinstance(to, str) else ", ".join(to)
    box_id: str | None = None
    try:
        box = EmailOutbox(to=recipients, subject=subject, kind=kind,
                          related_type=related_type, related_id=related_id)
        await box.insert()
        box_id = str(box.id)
    except Exception:  # noqa: BLE001 — never block the request on bookkeeping
        logger.exception("Failed to record email outbox row")
    # Hold a reference until the task finishes. asyncio keeps only a WEAK
    # reference to a running task, so a bare create_task() can be garbage
    # collected mid-flight: the email vanishes and its outbox row sits at
    # "queued" forever with no error to explain it.
    task = asyncio.create_task(_deliver(box_id, to, subject, html))
    _pending_sends.add(task)
    task.add_done_callback(_pending_sends.discard)


async def _deliver(box_id: str | None, to: str | list[str], subject: str,
                   html: str) -> None:
    from app.models.system_logs import EmailOutbox

    err: str | None = None
    ok = False
    try:
        ok = await send_email(to, subject, html, to_text(html))
    except Exception as exc:  # noqa: BLE001
        err = repr(exc)
        logger.exception("Email send raised for %s", to)
    if not box_id:
        return
    try:
        box = await EmailOutbox.get(box_id)
        if box:
            box.attempts += 1
            box.status = "sent" if ok else "failed"
            box.error = None if ok else (err or "send returned False")
            box.sent_at = utcnow() if ok else None
            await box.save()
    except Exception:  # noqa: BLE001
        logger.exception("Failed to update email outbox row %s", box_id)


# --- Convenience senders for specific templates ---------------------------------
# Each records the email in the outbox and returns immediately; delivery happens
# in the background.


async def send_otp_email(to: str, name: str, code: str, minutes: int) -> None:
    html = render("otp.html", name=name, code=code, minutes=minutes)
    await enqueue(to, f"{settings.app_name} password reset code", html,
                  kind="otp")


async def send_email_change_otp(to: str, name: str, code: str,
                                minutes: int) -> None:
    html = render("otp.html", name=name, code=code, minutes=minutes)
    await enqueue(to, f"{settings.app_name}: confirm your new email", html,
                  kind="email_change_otp")


async def send_delete_otp_email(
    to: str, name: str, code: str, minutes: int,
    target_name: str, target_code: str | None = None
) -> None:
    html = render(
        "delete_otp.html", name=name, code=code, minutes=minutes,
        target_name=target_name, target_code=target_code,
    )
    await enqueue(to, f"{settings.app_name}: confirm account deletion", html,
                  kind="delete_otp")


# How each account type is NAMED to the person receiving the invitation. The
# raw enum value went into the email unchanged, so a channel partner was
# welcomed as a "channel_partner" — the one word in the message that is
# obviously written by a machine.
_ROLE_LABELS = {
    "channel_partner": "Channel Partner",
    "employee": "Team member",
    "owner": "Owner",
}
# What the account is FOR, in one sentence, under the greeting. A partner is
# external and has never seen the app; they need to know what they are signing
# in to before they are asked for a password.
#
# It must describe the portal they will ACTUALLY land in. This sentence used to
# promise that they could "send a new policy over for the team to approve" —
# written for the old portal, and left behind when submission was removed on
# 2026-08-05. The first thing a new partner read was an instruction for a screen
# that no longer exists.
_ROLE_BLURBS = {
    "channel_partner":
        "Your partner portal shows the policies credited to you, what is coming "
        "up for renewal and what you have earned — and it is where you ask the "
        "team for a quote or report a claim.",
}


async def send_account_created_email(
    to: str, name: str, role: str, temp_password: str, login_url: str
) -> None:
    html = render(
        "account_created.html",
        name=name,
        role=_ROLE_LABELS.get(role, role.replace("_", " ").title()),
        role_blurb=_ROLE_BLURBS.get(role),
        email=to,
        temp_password=temp_password, login_url=login_url,
        # A channel partner's temporary password does not expire (see
        # routers/users._temp_password_expiry) — promising an expiry the app
        # does not enforce would be the email telling them a lie.
        expires_days=None if role == "channel_partner" else 7,
    )
    await enqueue(to, f"Your {settings.app_name} account is ready", html,
                  kind="welcome")


_ANNOUNCEMENT_LABELS = {
    "offer": "Offer",
    "rate_change": "Rate change",
    "notice": "Notice",
    "training": "Training",
}


async def send_announcement_email(to: str, name: str, title: str, body: str,
                                  category: str,
                                  valid_until: str | None = None) -> None:
    """A broadcast from the agency to one channel partner.

    `body` is PLAIN TEXT from a textarea — the template splits it into
    paragraphs and Jinja escapes it. It is never treated as markup: it arrives
    from a form and ends up in somebody's inbox.
    """
    html = render(
        "announcement.html", name=name, title=title, body=body,
        category_label=_ANNOUNCEMENT_LABELS.get(category, ""),
        valid_until=valid_until,
        preheader=title,
    )
    await enqueue(to, title, html, kind="announcement")


async def send_target_assigned_email(
    to: str, name: str, period_label: str, goals: list[dict]
) -> None:
    """Tell an employee their monthly target has been set/changed.

    `goals` is a list of {"label", "value"} already filtered for this recipient
    — the caller strips house profit, never this function."""
    html = render("target_assigned.html", name=name,
                  period_label=period_label, goals=goals,
                  preheader=f"Your {period_label} target is ready.")
    await enqueue(to, f"Your {period_label} target at {settings.app_name}",
                  html, kind="target_assigned")


async def send_target_milestone_email(
    to: str, name: str, period_label: str, attainment: int,
    headline: str, message: str, goals: list[dict], subject: str
) -> None:
    """Congratulate an employee on crossing 50 / 90 / 100% of their target."""
    html = render("target_milestone.html", name=name,
                  period_label=period_label, attainment=attainment,
                  headline=headline, message=message, goals=goals,
                  preheader=headline)
    await enqueue(to, subject, html, kind="target_milestone")


async def send_login_alert_email(
    to: str, name: str, attempts: int, ip: str | None, when: str
) -> None:
    html = render(
        "login_alert.html", name=name, attempts=attempts, ip=ip or "unknown",
        when=when,
    )
    await enqueue(
        to, f"Security alert: repeated login attempts on {settings.app_name}",
        html, kind="login_alert")


async def send_renewal_reminder_email(
    to: str, name: str, policy_code: str, category: str,
    expiry: str, days_left: int
) -> None:
    html = render(
        "renewal_reminder.html", name=name, policy_code=policy_code,
        category=category, expiry=expiry, days_left=days_left,
    )
    await enqueue(
        to,
        f"{company.COMPANY_NAME}: policy renewal reminder — {policy_code}",
        html, kind="renewal_reminder", related_type="policy")


async def send_partner_statement_email(
    to: str, name: str, period_label: str, pdf_bytes: bytes,
    filename: str, download_url: str | None = None,
) -> bool:
    """Email a channel partner their monthly statement with the PDF attached.

    Sent DIRECTLY (not via the outbox) because the outbox doesn't carry
    attachments; the caller is a background job, not a web request. Returns the
    send result so the job can log per-partner outcomes."""
    # Was hand-built HTML with a blue button and a hard-coded agency name; it
    # now goes through the same template and theme as everything else.
    html = render("partner_statement.html", name=name,
                  period_label=period_label, download_url=download_url)
    return await send_email(
        to, f"{company.COMPANY_NAME} statement — {period_label}", html,
        to_text(html), attachments=[(filename, pdf_bytes, "pdf")])


async def send_business_report_email(
    to: str, name: str, period_label: str,
    attachment: tuple[str, bytes] | None, *,
    policies: int = 0, transactions: int = 0, net_profit_paise: int = 0,
) -> bool:
    """Email the owner a closed period's business report.

    NOT WIRED UP YET — nothing calls this. It is kept because a "the month is
    closed" email is the obvious next step for the report, and it is written to
    be sent DIRECTLY rather than through the outbox: the outbox carries no
    attachments, and the caller would be a cron job rather than a web request.
    When the workbook is too large to attach, `attachment` is None and the email
    points at the Reports page instead of failing to send at all.
    """
    reports_url = f"{settings.frontend_base_url}/finance/reports"
    html = render("business_report.html", name=name, period_label=period_label,
                  policies=policies, transactions=transactions,
                  net_profit=f"{net_profit_paise / 100:,.2f}",
                  attached=attachment is not None, reports_url=reports_url)
    return await send_email(
        to, f"{company.COMPANY_NAME}: {period_label} business report", html,
        to_text(html),
        attachments=[(attachment[0], attachment[1],
                      "vnd.openxmlformats-officedocument.spreadsheetml.sheet")]
        if attachment else None)


async def send_reminder_digest_email(
    to: str, name: str, items: list[dict]
) -> None:
    """One email listing everything a staff member owes today, plus anything
    overdue. Deliberately a digest, not one email per reminder — a feature that
    sends five separate mails before 9am gets filtered within a week."""
    if not items:
        return
    html = render("reminder_digest.html", name=name, items=items)
    overdue = sum(1 for i in items if i.get("overdue"))
    subject = f"{settings.app_name}: {len(items)} follow-up" \
              f"{'s' if len(items) != 1 else ''} today"
    if overdue:
        subject += f" ({overdue} overdue)"
    await enqueue(to, subject, html, kind="reminder_digest")


async def send_document_request_email(
    to: str, name: str, upload_url: str, docs: list[str], message: str | None
) -> None:
    html = render(
        "document_request.html", name=name, upload_url=upload_url,
        docs=docs, message=message,
    )
    await enqueue(to, f"{company.COMPANY_NAME}: documents requested", html,
                  kind="document_request")


# --- Channel Partner wallet / policy approval emails -------------------------------------


async def send_withdrawal_requested_email(
    to: str | list[str], name: str, partner_name: str, partner_code: str,
    amount: str, code: str, review_url: str
) -> None:
    html = render(
        "withdrawal_requested.html", name=name, partner_name=partner_name,
        partner_code=partner_code, amount=amount, code=code, review_url=review_url,
    )
    await enqueue(to, f"{settings.app_name}: withdrawal request {code}", html,
                  kind="withdrawal_requested", related_type="withdrawal")


async def send_withdrawal_update_email(
    to: str, name: str, code: str, amount: str, status_label: str,
    wallet_url: str, reference: str | None = None, reason: str | None = None
) -> None:
    html = render(
        "withdrawal_update.html", name=name, code=code, amount=amount,
        status_label=status_label, wallet_url=wallet_url, reference=reference,
        reason=reason,
    )
    await enqueue(to, f"{settings.app_name}: withdrawal {status_label}", html,
                  kind="withdrawal_update", related_type="withdrawal")


async def send_policy_approval_email(
    to: str, name: str, policy_code: str, status_label: str, approved: bool,
    policies_url: str, policy_number: str | None = None,
    reward_amount: str | None = None, reason: str | None = None
) -> None:
    html = render(
        "policy_approval.html", name=name, policy_code=policy_code,
        status_label=status_label, approved=approved, policies_url=policies_url,
        policy_number=policy_number, reward_amount=reward_amount, reason=reason,
    )
    await enqueue(to, f"{settings.app_name}: policy {policy_code} {status_label}",
                  html, kind="policy_approval", related_type="policy")
