"""Human-readable entity codes, e.g. CUS-26K352, POL-26A451, LED-267V54.

Format: ``{PREFIX}-{YY}{RAND}`` where

  - PREFIX is a short entity tag (CUS, POL, LED, …),
  - YY is the current (IST) calendar year's last two digits, and
  - RAND is a 4-character base-36 block (0-9, A-Z), picked RANDOMLY — NOT a
    running serial. 4 base-36 chars give 36**4 = 1,679,616 combinations per
    prefix/year, so collisions are rare; we still verify uniqueness against the
    entity's collection and retry, widening to 5 chars if a year's space ever
    fills. Every entity code column carries a unique index as a final backstop.
"""

from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta, timezone

from app.models.counter import Counter

# Entity -> short code prefix. Every internal id now shares one format.
PREFIXES = {
    "user": "USR",
    "partner": "CP",       # channel partners (external), e.g. CP-26K352
    "customer": "CUS",
    "insurer": "INS",
    "broker": "BRK",       # brokerages we place business through
    "policy": "POL",
    "lead": "LED",
    "withdrawal": "WDL",
    "quote": "QR",         # channel-partner quote requests
    "claim": "CLM",
    "announcement": "ANN",
    "leave": "LV",         # leave requests (Workplace HR, 2026-08-20)
    "payslip": "PSL",      # monthly payslips (payroll, 2026-08-24)
    # A colleague's time-limited request to read a policy that is not theirs.
    # Coded because people quote them at each other ("approve JIT-26K3P1").
    "policy_access": "JIT",
}

# base-36 alphabet for the random block (digits then uppercase letters).
_ALPHABET = string.digits + string.ascii_uppercase

# IST is UTC+5:30 — code year-stamps follow the Indian calendar like the rest of
# the app's date boundaries.
_IST = timezone(timedelta(hours=5, minutes=30))


def _year_yy() -> str:
    return datetime.now(timezone.utc).astimezone(_IST).strftime("%y")


def _random_block(length: int) -> str:
    # `secrets`, not `random`: Mersenne Twister's output is reconstructable from
    # a handful of observed values, and these codes appear in URLs, exports and
    # emails. Same cost, no guessing.
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def format_code(entity: str, *, yy: str | None = None, length: int = 4) -> str:
    """Build one candidate code (no uniqueness guarantee) — handy for tests."""
    return f"{PREFIXES[entity]}-{yy or _year_yy()}{_random_block(length)}"


def _model_for(entity: str):
    """Lazily resolve the Beanie model whose ``code`` field this entity fills.
    Lazy import keeps this module free of model-level import cycles."""
    from app.models.broker import Broker
    from app.models.customer import Customer
    from app.models.insurer import Insurer
    from app.models.lead import Lead
    from app.models.policy import Policy
    from app.models.user import User
    from app.models.wallet import WithdrawalRequest
    from app.models.quote_request import QuoteRequest
    from app.models.claim import Claim
    from app.models.announcement import Announcement
    from app.models.leave import LeaveRequest
    from app.models.payslip import Payslip
    from app.models.policy_access import PolicyAccessRequest

    return {
        "user": User,
        "partner": User,       # partners are Users; prefixes keep codes distinct
        "customer": Customer,
        "insurer": Insurer,
        "broker": Broker,
        "policy": Policy,
        "lead": Lead,
        "withdrawal": WithdrawalRequest,
        "quote": QuoteRequest,
        "claim": Claim,
        "announcement": Announcement,
        "leave": LeaveRequest,
        "payslip": Payslip,
        "policy_access": PolicyAccessRequest,
    }[entity]


async def _code_exists(entity: str, code: str) -> bool:
    coll = _model_for(entity).get_motor_collection()
    return await coll.find_one({"code": code}, {"_id": 1}) is not None


async def next_code(entity: str) -> str:
    """A fresh, unique code for ``entity`` in the new short format.

    Tries random 4-char blocks first; after several clashes it widens the block
    to 5 chars (covers the pathological case of a nearly-exhausted year)."""
    yy = _year_yy()
    for length in (4, 5, 6):
        for _ in range(12):
            candidate = format_code(entity, yy=yy, length=length)
            if not await _code_exists(entity, candidate):
                return candidate
    # Astronomically unlikely — fall back to a wide block and let the unique
    # index be the final arbiter.
    return format_code(entity, yy=yy, length=8)


async def next_customer_code() -> str:
    """Customer code in the shared short format, e.g. ``CUS-26K352``."""
    return await next_code("customer")


async def next_statement_no(fy_label: str) -> str:
    """Sequential statement reference, e.g. ``STMT/2026-27/000148``.

    The counter is per financial year so numbering restarts each 1 April, which
    is what an accountant expects on a document series. (Statement references are
    a numbered document series, NOT an entity code — they stay sequential.)
    """
    seq = await Counter.next_value(f"statement_{fy_label}")
    return f"STMT/{fy_label}/{seq:06d}"
