"""Standalone job: "you have not clocked in today" (owner I2).

Run once a day, roughly 30 minutes after the shift starts:

    cd server && python send_hr_nudges.py

WHY THIS IS NOT IN send_reminders.py, which is the daily job everything else
rides: that one fires at 08:00 IST and the shift starts at 10:00. A nudge from
there would land two hours before anybody was due, which is noise, and noise is
how a prompt stops being read. It needs a different SLOT, so it is a different
entry point.

SAFE TO RUN AS OFTEN AS YOU LIKE. The guard is "has this person already been
nudged today", asked of the notification rows themselves rather than of a flag
anywhere, so a second run sends nothing. That is what lets this be wired to its
own schedule without any coordination with the 08:00 one.

Skips week offs, declared holidays, anybody already clocked in, anybody on
approved leave, and anybody who has not joined yet. If nobody qualifies it makes
three queries and exits.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from beanie import init_beanie  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.models.attendance import AttendanceDay  # noqa: E402
from app.models.holiday import Holiday  # noqa: E402
from app.models.leave import LeaveRequest  # noqa: E402
from app.models.notification import Notification  # noqa: E402
from app.models.settings import SystemSettings  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import hr_daily  # noqa: E402


async def main() -> None:
    client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True)
    await init_beanie(
        database=client[settings.mongo_db_name],
        document_models=[User, AttendanceDay, LeaveRequest, Holiday,
                         Notification, SystemSettings],
    )
    try:
        sent = await hr_daily.notify_not_clocked_in()
        print(f"[hr-nudge] notified {sent}")
    except Exception as exc:  # noqa: BLE001 — a nudge must never exit non-zero
        print(f"[hr-nudge] FAILED: {type(exc).__name__}: {exc}")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
