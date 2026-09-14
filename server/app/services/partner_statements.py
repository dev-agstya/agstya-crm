"""Monthly channel-partner statements: render a PDF, store it in S3, and email
it (with the PDF attached) — plus an optional WhatsApp copy.

Designed to run OFF-HOURS (e.g. 23:00 on the last working day of the month via a
cron job) so it never competes with staff using the app during the day. The job
self-guards on ``is_last_working_day`` so a simple "daily at 23:00" cron only
actually does work once a month.
"""

from __future__ import annotations

import calendar
import logging
from datetime import datetime, timezone

from app.config import settings
from app.core.enums import AccountStatus, AccountType
from app.models.document import DocumentRecord
from app.models.user import User
from app.services import email as email_svc
from app.services import finance_balance, s3, settings_svc, statement_pdf, whatsapp

logger = logging.getLogger("agastyacrm.partner_statements")

_LINK_TTL = 7 * 24 * 3600
ENTITY = "partner_statement"


def month_bounds(now: datetime) -> tuple[datetime, datetime]:
    """First moment and last moment of `now`'s calendar month (UTC)."""
    start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    last_day = calendar.monthrange(now.year, now.month)[1]
    end = datetime(now.year, now.month, last_day, 23, 59, 59,
                   tzinfo=timezone.utc)
    return start, end


def last_working_day(year: int, month: int) -> int:
    """Day-of-month of the last weekday (Mon–Fri). Public holidays are not
    modelled — weekends only."""
    day = calendar.monthrange(year, month)[1]
    while datetime(year, month, day).weekday() >= 5:   # Sat=5, Sun=6
        day -= 1
    return day


def is_last_working_day(now: datetime) -> bool:
    return now.day == last_working_day(now.year, now.month)


def _has_activity(stmt: dict) -> bool:
    return bool(stmt.get("policies")) or bool(stmt.get("transactions")) \
        or stmt.get("net_balance") or stmt.get("opening_balance")


async def _store_pdf(partner_id: str, ym: str, pdf_bytes: bytes,
                     filename: str) -> tuple[str, str | None]:
    """Upload the PDF to S3 (overwriting the same period's key), record it, and
    return (s3_key, presigned_url)."""
    key = f"{ENTITY}/{partner_id}/{ym}.pdf"
    s3.get_s3_client().put_object(
        Bucket=settings.aws_bucket_name, Key=key, Body=pdf_bytes,
        ContentType="application/pdf")
    # Replace any prior record for this period (S3 object is overwritten).
    old = await DocumentRecord.find({
        "entity_type": ENTITY, "entity_id": partner_id, "doc_key": ym,
    }).to_list()
    for o in old:
        await o.delete()
    await DocumentRecord(
        entity_type=ENTITY, entity_id=partner_id, doc_key=ym,
        label=f"Statement {ym}", s3_key=key, filename=filename,
        content_type="application/pdf", size_bytes=len(pdf_bytes),
    ).insert()
    url = None
    try:
        url = s3.presigned_download(key, filename, expires_in=_LINK_TTL)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to presign statement %s", key)
    return key, url


async def run_monthly_statements(now: datetime | None = None, *,
                                 force: bool = False) -> dict:
    """Generate + store + email statements for the current month.

    `force` bypasses both the last-working-day guard and the already-generated
    idempotency check (for manual runs / testing). Returns a summary dict."""
    now = now or datetime.now(timezone.utc)
    if not force and not is_last_working_day(now):
        summary = {"skipped_reason": "not the last working day",
                   "date": now.date().isoformat()}
        logger.info("Monthly statements skipped: %s", summary)
        return summary

    lo, hi = month_bounds(now)
    ym = lo.strftime("%Y-%m")
    label = lo.strftime("%B %Y")
    s = await settings_svc.get_settings()

    partners = await User.find({
        "account_type": AccountType.CHANNEL_PARTNER.value,
        "status": AccountStatus.ACTIVE.value,
        "is_deleted": {"$ne": True},
    }).to_list()

    stored = emailed = whatsapped = skipped = failed = 0
    for p in partners:
        try:
            # Idempotency: don't regenerate/re-send a period already produced.
            if not force and await DocumentRecord.find_one({
                    "entity_type": ENTITY, "entity_id": str(p.id),
                    "doc_key": ym}):
                skipped += 1
                continue

            stmt = await finance_balance.partner_statement(str(p.id), lo, hi)
            if not _has_activity(stmt):
                skipped += 1
                continue

            pdf = statement_pdf.render_statement_pdf(stmt)
            filename = f"Agastya_Statement_{p.code or p.id}_{ym}.pdf"
            _key, url = await _store_pdf(str(p.id), ym, pdf, filename)
            stored += 1

            if p.email and s.email.enabled:
                ok = await email_svc.send_partner_statement_email(
                    p.email, p.full_name, label, pdf, filename, url)
                if ok:
                    emailed += 1

            if (s.whatsapp.enabled and s.whatsapp.tpl_statement_partner
                    and p.mobile and url):
                res = await whatsapp.send_template(
                    p.mobile, s.whatsapp.tpl_statement_partner,
                    language=s.whatsapp.default_lang,
                    body_params=[p.full_name, label],
                    document_url=url, document_filename=filename,
                    operation="partner_statement", related_type="partner",
                    related_id=str(p.id))
                if res.ok:
                    whatsapped += 1
        except Exception:  # noqa: BLE001 — one partner must not stop the batch
            failed += 1
            logger.exception("Statement failed for partner %s", p.id)

    summary = {"period": ym, "partners": len(partners), "stored": stored,
               "emailed": emailed, "whatsapped": whatsapped,
               "skipped": skipped, "failed": failed}
    logger.info("Monthly statements run: %s", summary)
    return summary
