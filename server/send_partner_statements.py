"""Standalone monthly job: email channel-partner statements + archive to S3.

Schedule this OFF-HOURS so it never competes with staff using the app during the
day. Recommended: a daily Render Cron Job at 23:00 IST (i.e. 17:30 UTC) —

    cd server && python send_partner_statements.py

The job self-guards: it only does work on the **last working day** (Mon–Fri) of
the month; on every other day it exits immediately. For each active channel
partner with activity in the month it renders a PDF statement, stores it in S3
(``partner_statement/<partner_id>/<YYYY-MM>.pdf``) and emails it with the PDF
attached (plus a WhatsApp copy when that's enabled). Running it twice in the same
month is a no-op (idempotent) unless you pass ``--force``.

Manual run for the current month regardless of the date:

    python send_partner_statements.py --force
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.db import close_db, init_db  # noqa: E402
from app.services.partner_statements import run_monthly_statements  # noqa: E402


async def main(force: bool) -> None:
    await init_db()
    try:
        summary = await run_monthly_statements(force=force)
        print(f"[partner-statements] {summary}")
    finally:
        await close_db()


if __name__ == "__main__":
    asyncio.run(main(force="--force" in sys.argv))
