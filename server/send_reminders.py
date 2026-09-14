"""Standalone daily job: renewal reminders to customers + follow-up digests to staff.

Run once per day (e.g. a Render Cron Job or any scheduler):

    cd server && python send_reminders.py

Several unrelated jobs share this schedule because they want the same slot
(08:00 IST) and the same database connection:

  1. RENEWAL reminders — emails customers whose policies expire in
     30 / 15 / 7 / 1 / 0 days, skipping renewed/cancelled policies. Each offset
     is sent at most once per policy.
  2. FOLLOW-UP reminders — rings the in-app bell for reminders that have come
     due, and emails each staff member ONE digest of what they owe today plus
     anything overdue.
  3. WORKPLACE HR (2026-08-20) — closes yesterday's forgotten punch-outs,
     credits the monthly leave accrual, lapses last year's balances, and tells
     anybody whose day was auto-closed. Every step is idempotent, so running
     this twice in a morning is a no-op rather than a double credit.

Everything after the first is wrapped so a failure cannot stop what came before
it: a broken digest must not mean customers stop being told their cover is
expiring, and a broken accrual must not stop either.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from beanie import init_beanie  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.models.attendance import (  # noqa: E402
    AttendanceCorrection, AttendanceDay,
)
from app.models.customer import Customer  # noqa: E402
from app.models.holiday import Holiday  # noqa: E402
from app.models.leave import LeaveLedgerRow, LeaveRequest  # noqa: E402
from app.models.settings import SystemSettings  # noqa: E402
from app.models.master import PolicyCategory  # noqa: E402
from app.models.notification import Notification  # noqa: E402
from app.models.payslip import Payslip  # noqa: E402
from app.models.policy import Policy  # noqa: E402
from app.models.policy_access import PolicyAccessRequest  # noqa: E402
from app.models.reminder import Reminder  # noqa: E402
from app.models.system_logs import ApiCallLog, EmailOutbox  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.reminders import send_due_reminders  # noqa: E402
from app.services import hr_daily  # noqa: E402
from app.services import policy_lifecycle  # noqa: E402
from app.services import reminder_svc  # noqa: E402
from app.routers import policy_access  # noqa: E402


async def main() -> None:
    client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True)
    await init_beanie(
        database=client[settings.mongo_db_name],
        document_models=[Policy, Customer, PolicyCategory, Reminder, User,
                         Notification, EmailOutbox, ApiCallLog,
                         # Workplace HR. SystemSettings comes with them because
                         # the HR job reads the shift and accrual policy off it;
                         # without it in this list the job raises on its first
                         # settings read rather than doing anything.
                         AttendanceDay, AttendanceCorrection, LeaveRequest,
                         LeaveLedgerRow, Holiday, SystemSettings,
                         # Payroll (2026-08-24). The HR job generates last
                         # month's payslips as its fifth step; without this in
                         # the list that step raises on its first read rather
                         # than producing anything, and the failure is caught
                         # and logged, so it would look like "payroll simply
                         # never runs" with no error anybody sees.
                         Payslip,
                         # Closing lapsed policy-access grants, below.
                         PolicyAccessRequest],
    )

    # Age the book FIRST. Nothing else in the app ever wrote PolicyStatus.EXPIRED
    # (see services/policy_lifecycle), so cover that ended months ago was still
    # reporting as active everywhere — including in the renewal queue this job
    # is about to email people from. Wrapped like the digest below: a failure
    # here must not stop customers being told their cover is expiring.
    try:
        aged = await policy_lifecycle.sweep()
        print(f"[lifecycle] {aged}")
    except Exception as exc:  # noqa: BLE001
        print(f"[lifecycle] FAILED: {type(exc).__name__}: {exc}")

    summary = await send_due_reminders()
    print(f"[renewals] {summary}")

    try:
        follow_ups = await reminder_svc.run_daily()
        print(f"[follow-ups] {follow_ups}")
    except Exception as exc:  # noqa: BLE001 — never let this sink the run
        print(f"[follow-ups] FAILED: {type(exc).__name__}: {exc}")

    # hr_daily.run_daily() already wraps each of its own steps, so a failure
    # inside it is reported rather than raised. This belt as well, because a
    # settings read failing before the first step would still escape.
    try:
        hr = await hr_daily.run_daily()
        print(f"[hr] {hr}")
    except Exception as exc:  # noqa: BLE001
        print(f"[hr] FAILED: {type(exc).__name__}: {exc}")

    # Close JIT policy-access grants whose window has run out. Cosmetic — the
    # grants are already inert (see policy_access.expire_lapsed) — so this is
    # last and wrapped like everything else.
    try:
        lapsed = await policy_access.expire_lapsed()
        print(f"[policy-access] {lapsed} lapsed grants closed")
    except Exception as exc:  # noqa: BLE001
        print(f"[policy-access] FAILED: {type(exc).__name__}: {exc}")

    client.close()


if __name__ == "__main__":
    asyncio.run(main())
