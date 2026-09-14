"""Standalone monthly job: email the owner last month's pack.

Run on the 1st of each month (Render Cron Job):

    cd server && python send_month_pack.py

Self-guarding: it no-ops unless today is the 1st in IST, so the schedule can be
daily without sending thirty packs — the same arrangement the partner-statement
job uses.

Owner A3.5: owner only, Excel attached. Gmail rejects very large attachments and
a 15 MB email helps nobody, so past a size cap the email is sent WITHOUT the
attachment and says to download it from Reports instead. Profit is included:
this goes to the owner, who holds every permission by definition.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from beanie import init_beanie  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.core.enums import AccountType  # noqa: E402
from app.db import _document_models  # noqa: E402
from app.models.base import utcnow  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import email as email_svc  # noqa: E402
from app.services import month_pack  # noqa: E402
from app.services.finance_reports import shift_month, to_ist  # noqa: E402

# Gmail's hard limit is 25 MB including encoding overhead; stay well under it.
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024


async def main(force: bool = False) -> None:
    today = to_ist(utcnow())
    if today.day != 1 and not force:
        print(f"[month-pack] {today:%Y-%m-%d} is not the 1st (IST) — nothing to do.")
        return

    client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True)
    await init_beanie(database=client[settings.mongo_db_name],
                      document_models=_document_models())

    year, mon = shift_month(today.year, today.month, -1)
    month = f"{year:04d}-{mon:02d}"
    lo, hi, label = month_pack.month_window(month)

    # The owner holds every permission by definition, so the pack is complete.
    data = await month_pack.collect(lo, hi, can_view_profit=True)
    content = month_pack.build_workbook(data, label)
    filename = f"month-pack-{month}.xlsx"

    owners = await User.find({
        "account_type": AccountType.OWNER.value,
        "is_deleted": {"$ne": True}, "status": "active"}).to_list()
    if not owners:
        print("[month-pack] no active owner account — nothing sent.")
        client.close()
        return

    oversized = len(content) > MAX_ATTACHMENT_BYTES
    sent = 0
    for owner in owners:
        if not owner.email:
            continue
        ok = await email_svc.send_month_pack_email(
            owner.email, owner.full_name, label,
            None if oversized else (filename, content),
            policies=len(data["policies"]),
            transactions=len(data["txns"]),
            net_profit_paise=data["cash"]["net_profit"])
        sent += 1 if ok else 0

    print(f"[month-pack] {label}: {len(data['policies'])} policies, "
          f"{len(data['txns'])} transactions, {len(content) // 1024} KB, "
          f"sent to {sent} owner(s)"
          + (" (link only — file too large to attach)" if oversized else ""))
    client.close()


if __name__ == "__main__":
    asyncio.run(main(force="--force" in sys.argv))
