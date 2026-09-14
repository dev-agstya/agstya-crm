"""MongoDB connection and Beanie ODM initialization."""

from __future__ import annotations

import logging

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.config import settings

logger = logging.getLogger("agastyacrm.db")

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        _client = AsyncIOMotorClient(
            settings.mongo_uri,
            uuidRepresentation="standard",
            tz_aware=True,
        )
    return _client


def get_database() -> AsyncIOMotorDatabase:
    return get_client()[settings.mongo_db_name]


def _document_models() -> list:
    """Import here to avoid circular imports at module load time."""
    from app.models.attendance import (
        AttendanceCorrection, AttendanceDay,
    )
    from app.models.audit import AuditLog
    from app.models.bank import BankAccount
    from app.models.counter import Counter
    from app.models.broker import Broker
    from app.models.customer import Customer
    from app.models.document import DocumentRecord, DocumentRequest
    from app.models.finance import LedgerTxn, PartyAccount, PolicyFinance, TdsEntry
    from app.models.holiday import Holiday
    from app.models.insurer import Insurer
    from app.models.lead import Lead
    from app.models.leave import LeaveLedgerRow, LeaveRequest
    from app.models.lead_activity import LeadActivityDaily
    from app.models.master import PolicyCategory
    from app.models.notification import Notification
    from app.models.otp import OtpCode
    from app.models.payslip import Payslip
    from app.models.pending_txn import PendingTransaction
    from app.models.policy_access import PolicyAccessRequest
    from app.models.announcement import Announcement
    from app.models.claim import Claim
    from app.models.policy import Policy
    from app.models.quote_request import QuoteRequest
    from app.models.rate_rule import RateRule
    from app.models.reminder import Reminder
    from app.models.reward import Reward
    from app.models.role import Role
    from app.models.settings import SystemSettings
    from app.models.system_logs import ApiCallLog, EmailOutbox, ErrorLog
    from app.models.target import Target
    from app.models.user import User
    from app.models.wallet import Wallet, WalletTxn, WithdrawalRequest

    return [
        User, Role, Customer, Insurer, Broker, Policy, RateRule, Lead,
        Reminder, Reward, PolicyFinance, LedgerTxn, PartyAccount, TdsEntry,
        BankAccount, Target,
        AttendanceDay, AttendanceCorrection, LeaveRequest, LeaveLedgerRow,
        Holiday, Payslip,
        PendingTransaction, PolicyAccessRequest,
        AuditLog, OtpCode, DocumentRecord, DocumentRequest,
        PolicyCategory, Counter, Wallet, WalletTxn, WithdrawalRequest,
        QuoteRequest, Claim, Announcement,
        Notification, ErrorLog, EmailOutbox, ApiCallLog,
        LeadActivityDaily, SystemSettings,
    ]


async def init_db() -> None:
    """Initialise Beanie with all document models."""
    db = get_database()
    try:
        await init_beanie(database=db, document_models=_document_models())
    except Exception as exc:  # noqa: BLE001
        # Building a UNIQUE index fails if the collection already holds
        # duplicates — e.g. two policies sharing a policy number entered before
        # the index existed. Crashing here would take the whole API down on
        # deploy over a data problem nobody can fix while it's offline, so we
        # start WITHOUT the new index and say exactly what to clean up.
        logger.error(
            "Index build failed during startup — the app is running with the "
            "existing indexes. This usually means duplicate values block a new "
            "unique index; run `python scripts/check_duplicates.py` to find "
            "them, fix the data, then redeploy. Error: %s", exc)
        await init_beanie(database=db, document_models=_document_models(),
                          allow_index_dropping=False, skip_indexes=True)
    logger.info("Connected to MongoDB database '%s'", settings.mongo_db_name)
    await _verify_critical_indexes(db)


# Indexes whose ABSENCE is a correctness problem rather than a slow query, as
# {collection: [index name, ...]}. Kept short on purpose: this is the list of
# things that silently allow bad DATA, not an inventory of every index.
CRITICAL_INDEXES: dict[str, tuple[str, ...]] = {
    "policies": ("policy_number_unique",),
    "ledger_txns": ("ledger_idempotency_key",),
    # Two rows for one person on one day would double every count on the month
    # register, and the punch endpoints are exactly the shape a double-tap on a
    # phone races.
    "attendance_days": ("attendance_user_day_unique",),
    # The monthly leave accrual is idempotent BY THIS INDEX, not by a flag —
    # the daily job runs from a cron AND at boot, so the same month is genuinely
    # attempted more than once. Without it, everybody quietly earns 3 days a
    # month instead of 1.5.
    "leave_ledger": ("leave_ledger_period_unique",),
    "holidays": ("holiday_date_unique",),
}


async def _verify_critical_indexes(db) -> None:
    """Say out loud when an index that ENFORCES something did not get built.

    The fallback above is all-or-nothing: ONE bad spec means `skip_indexes=True`
    and therefore NO index on ANY model is created. That is the right call for
    availability — a CRM that will not start because of a duplicate row is worse
    than one running without an index — but it is invisible. It showed up as a
    single ERROR line during a deploy nobody was reading, and a permanently
    invalid `partialFilterExpression` meant `policy_number_unique` never existed
    in production at all while every startup looked clean.

    So the app now ASKS the database what actually landed and complains, per
    index, if something that enforces uniqueness is missing. It does not attempt
    a repair: the reason an enforcing index will not build is nearly always
    duplicate data, and a fix that guesses which duplicate to drop is worse than
    a line that says which script to run.

    Never fatal, and never raises: this is a diagnostic.
    """
    for collection, expected in CRITICAL_INDEXES.items():
        try:
            present = set(await db[collection].index_information())
        except Exception:  # noqa: BLE001 — a diagnostic must not break startup
            logger.warning("Could not read indexes on '%s'", collection)
            continue
        for name in expected:
            if name not in present:
                logger.error(
                    "MISSING INDEX %s on '%s'. The rule it enforces is NOT "
                    "being applied — duplicates can be written right now. Run "
                    "`python scripts/check_duplicates.py`, clear the data it "
                    "reports, then redeploy.", name, collection)


async def close_db() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None
        logger.info("Closed MongoDB connection")
