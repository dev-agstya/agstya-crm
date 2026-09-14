"""A statement line somebody could not decide yet.

WHAT REPLACED "SKIP", AND WHY IT HAD TO
----------------------------------------
The bank-statement importer opened with every row set to SKIP. A skipped row was
counted in the result ("8 recorded, 2 skipped") and then thrown away with the
browser tab. That is fine for a line that is genuinely not ours -- an internal
sweep, a reversal already handled -- and quietly wrong for the far more common
case, which is "I do not know what this Rs 12,400 was, I will find out."

The owner: "instead of skip, I want you to add one thing called pending. And
after, let's say I added a CSV file of 10 transactions, I filled details for
eight transactions but two I selected as pending, and then I click on record. So
it will record eight transactions but it will push those two pending
transactions into a pending transaction list, so that the owner can come back
later and fix those transactions."

So the file stops being the only place the row exists. A pending row is a
PARKED IMPORT LINE: everything the statement said about it, kept, with nothing
posted and no balance touched.

IT IS NOT A LEDGER ROW, AND MUST NOT BECOME ONE
-------------------------------------------------
Nothing in this collection appears in the ledger, in a balance, in a report or
in the bank account's `balance_paise`. It is a to-do list that happens to be
shaped like money. The moment one is decided it goes through
`statement_import._commit_row` -- the SAME path the eight decided rows took --
and the ledger row that comes out is indistinguishable from one entered by hand.
That is why this model carries no `txn_type`, no party balance and no bank
delta: it holds the QUESTION, and the answer is written by code that already
knows how.

REMOVING ONE IS A DELIBERATE, RECORDED ACT
-------------------------------------------
The owner asked for the cross too: "instead of a skip button, add at the top
right corner a cross button so that we can remove that transaction from there.
However, removing any transaction from this import list should also send a
pop-up and ask for confirmation because we don't want to delete any of the
transactions actually."

DISCARDED rows are kept, not deleted. A statement line that somebody dismissed
is exactly the line an auditor asks about six months later, and "we removed it"
with a name and a date is an answer; a missing row is not. The list hides them
by default and can show them back.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.models.base import utcnow


class PendingTxnStatus:
    PENDING = "pending"        # parked, waiting for somebody to decide
    RECORDED = "recorded"      # posted to the ledger; carries the txn id
    DISCARDED = "discarded"    # deliberately dismissed, with a reason


class PendingTransaction(Document):
    # --- Where it came from ---
    #
    # The account is a property of the FILE, not of the row: a statement does
    # not name the account inside its lines, the account is what the statement
    # IS. Copied here so a pending row can be committed months later without
    # anybody having to remember which account the file was for.
    bank_account_id: Indexed(str)
    bank_account_name: str = ""
    # One id per import, so "the 40 rows from Tuesday's HDFC file" is a group a
    # person can work through together rather than 40 unrelated to-dos.
    import_batch_id: Indexed(str) = ""
    source_file: str = ""

    # --- What the statement said ---
    #
    # Every field here is the BANK's, and none of them is editable. The
    # direction especially: if the statement says the money left, it left. What
    # a person decides later is who it concerned.
    occurred_on: str = ""                    # "YYYY-MM-DD", IST calendar day
    description: str = ""
    reference: str = ""
    amount_paise: int = 0                    # positive magnitude
    direction: str = ""                      # "in" | "out"
    # The statement's own line number, kept so a row can be found in the
    # original file when somebody goes back to check.
    source_line: int = 0

    # --- What the importer noticed ---
    duplicate_of: Optional[str] = None       # an existing LedgerTxn id
    duplicate_note: Optional[str] = None
    # Words pulled out of the narration, for the party search. ADVISORY, exactly
    # as they are in the importer -- carried across so the pending screen offers
    # the same hint the import screen did rather than a worse one.
    suggested_terms: list[str] = Field(default_factory=list)

    # --- What somebody said about it ---
    #
    # A note the person parking it left for themselves ("ask Rakesh whose this
    # is"). The whole reason a pending row beats a sticky note.
    note: Optional[str] = None

    status: str = PendingTxnStatus.PENDING
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)

    resolved_txn_id: Optional[str] = None
    resolved_at: Optional[datetime] = None
    resolved_by: Optional[str] = None
    resolved_by_name: Optional[str] = None

    discarded_at: Optional[datetime] = None
    discarded_by: Optional[str] = None
    discarded_by_name: Optional[str] = None
    discard_reason: Optional[str] = None

    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "pending_transactions"
        indexes = [
            # THE QUEUE, and the badge count above it.
            [("status", pymongo.ASCENDING), ("occurred_on", pymongo.DESCENDING)],
            [("bank_account_id", pymongo.ASCENDING),
             ("status", pymongo.ASCENDING)],
            [("import_batch_id", pymongo.ASCENDING)],
            # NO UNIQUE INDEX, deliberately. Two genuine Rs 5,000 cash deposits
            # on the same day into the same account are a real thing that
            # happens -- the importer's duplicate detection is a FLAG for the
            # same reason, and a constraint here would make real data
            # un-parkable. A re-import of the same file is prevented by the
            # person seeing the rows already flagged as duplicates, not by the
            # database refusing them.
        ]

    @property
    def is_open(self) -> bool:
        return self.status == PendingTxnStatus.PENDING
