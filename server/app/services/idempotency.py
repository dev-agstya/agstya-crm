"""Stop a double-clicked or retried money write from posting twice.

The problem this solves is real and silent: "Record payment" posts a ledger row
and moves a party balance. Click it twice — or let axios retry a request whose
response was lost — and the agency's books gain a payment that never happened.
Nothing in the app could detect that afterwards, because the second row is a
perfectly valid transaction.

The client sends a key that is stable for one logical submission (generated when
the form opens, regenerated after a success). The UNIQUE partial index on
LedgerTxn.idempotency_key is the actual guard — two racing requests cannot both
insert, whatever the application code does. This module turns the resulting
duplicate-key error into "return the row that won", so the caller sees a normal
success and the UI stays correct.

Scope: one key covers one posting. A transfer writes two rows, so it derives a
distinct key per leg from the same client key (see `derive`).
"""

from __future__ import annotations

from typing import Optional

from pymongo.errors import DuplicateKeyError

from app.models.finance import LedgerTxn

# Keys are opaque to us; cap the length so a client cannot store data in them.
MAX_KEY_LENGTH = 100


def clean(key: Optional[str]) -> Optional[str]:
    """Normalise a client key, or None when absent/unusable."""
    if not key:
        return None
    key = str(key).strip()[:MAX_KEY_LENGTH]
    return key or None


def derive(key: Optional[str], suffix: str) -> Optional[str]:
    """A distinct key for one leg of a multi-row posting."""
    return f"{key}:{suffix}" if key else None


async def existing(key: Optional[str]) -> Optional[LedgerTxn]:
    """The transaction already written under this key, if any."""
    if not key:
        return None
    return await LedgerTxn.find_one(LedgerTxn.idempotency_key == key)


async def insert_once(txn: LedgerTxn) -> tuple[LedgerTxn, bool]:
    """Insert `txn`, returning (row, is_new).

    On a duplicate key the row that won the race is returned with is_new=False,
    so the caller knows to skip every side effect (balance moves, TDS entries,
    emails) — those already happened for the winning row.
    """
    try:
        await txn.insert()
        return txn, True
    except DuplicateKeyError:
        found = await existing(txn.idempotency_key)
        if found is not None:
            return found, False
        raise
