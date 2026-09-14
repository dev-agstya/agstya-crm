"""Bulk-record transactions from a downloaded bank statement.

THE FLOW, AND WHY IT HAS THREE STEPS
------------------------------------
    1. PREVIEW   upload the file -> we read the columns, guess what each one
                 means, normalise every line, and flag the ones that look
                 already recorded
    2. (the person confirms the mapping and assigns a party to each row —
       entirely client-side, nothing is stored in between)
    3. COMMIT    the decided rows come back and are BOOKED

Step 2 has no server state on purpose. Staging a half-finished import in the
database would mean a new collection, a lifecycle, an expiry, and a way for two
people to work the same file — for a form that is open for four minutes. The
file is re-sent on a mapping change; a bank statement is a few tens of KB.

WHAT THIS ROUTER DOES NOT DECIDE
--------------------------------
Money. Not one line of posting logic lives here: every row goes through
`finance._post_payment`, `finance._post_expense` or
`wallet.post_agency_payout`,
which are the same functions the single-transaction forms use. That is the whole
design. This file's job is to read a spreadsheet and hand rows to code that
already knows the TDS rule, the bank-delta rule and the idempotency rule — a
bulk importer with its own copy of those would drift within a release, and then
two screens would disagree about the same money.

DIRECTION IS THE BANK'S. If the statement says the money left, it left; there is
no field to change it. What a person chooses per row is WHO it concerns and what
KIND of movement it was, and from that the transaction type is derived exactly
as the Add-transaction form derives it.

"PENDING" REPLACED "SKIP" AS THE DEFAULT (owner 2026-08-24)
------------------------------------------------------------
Every row used to start SKIPPED, and a skipped row was counted in the result and
then thrown away with the browser tab. That is right for a line which genuinely
is not ours and wrong for the far more common case: "I do not know what this
Rs 12,400 was, I will find out."

A row marked PENDING now becomes a `PendingTransaction` — everything the
statement said about it, kept, with nothing posted and no balance touched — and
is finished later from the Pending list on the Transactions page, through THIS
FILE'S `_commit_row`. That last part is the important one: the pending queue has
no posting logic of its own either, so a row decided on Tuesday and one decided
in November produce the identical ledger entry.

`skip` still exists and is still honoured. The importer defaults a row it
believes is already recorded to "leave it alone", and that is a decision rather
than an unanswered question — parking it would put a known duplicate into a
queue of real work.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, UploadFile, status,
)
from pydantic import BaseModel, Field

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import (
    EXPENSE_CATEGORIES, AuditAction, LedgerTxnType, PartyType,
)
from app.core.permissions import MANAGE_TRANSACTIONS
from app.models.finance import LedgerTxn
from app.models.pending_txn import PendingTransaction
from app.models.user import User
from app.routers._helpers import parse_object_id, read_upload
from app.schemas.finance import ExpenseCreate, PaymentCreate
from app.services import statement_import as si
from app.services.audit import log_action

# Staff-only, like every other money router. The guard is on the WHOLE router so
# a new route added here is closed to channel partners by default.
router = APIRouter(prefix="/api/finance/statement-import",
                   tags=["finance"],
                   dependencies=[Depends(get_inhouse_user)])

# A statement is text; 5 MB is a very large one. Reading it into memory is the
# cost, and this is ONE small instance.
MAX_UPLOAD_BYTES = 5 * 1024 * 1024


# --- What comes back from a preview -------------------------------------------


class PreviewRow(BaseModel):
    """One normalised statement line, with everything a person needs to decide.

    Nothing here is a decision. `problem` and `duplicate_of` are observations;
    `suggested_terms` is a hint for the party search and is never applied.
    """

    line: int
    occurred_on: Optional[str] = None      # ISO date, or None if unreadable
    description: str = ""
    reference: str = ""
    amount_paise: int = 0
    direction: str = ""                    # "in" | "out", from the file
    problem: Optional[str] = None
    duplicate_of: Optional[str] = None     # an existing LedgerTxn id
    duplicate_note: Optional[str] = None
    suggested_terms: list[str] = Field(default_factory=list)


class PreviewResult(BaseModel):
    columns: list[str] = Field(default_factory=list)
    # What we guessed each column means. Sent back so the form can show it as
    # pre-filled dropdowns rather than as a fait accompli.
    mapping: dict[str, Optional[str]] = Field(default_factory=dict)
    # The first few raw lines, so somebody can SEE that the date column really
    # holds dates before trusting the rest.
    sample: list[list[str]] = Field(default_factory=list)
    rows: list[PreviewRow] = Field(default_factory=list)
    total_rows: int = 0
    # True when the file held more than MAX_ROWS and was cut off. Said out loud
    # rather than silently importing the first 2,000 of 3,000 lines.
    truncated: bool = False
    readable: int = 0                      # rows with no `problem`
    duplicates: int = 0


# --- What goes back on a commit -----------------------------------------------


class CommitRow(BaseModel):
    """One decided row. `action` is what the person chose to do with it."""

    line: int
    occurred_on: str                       # ISO date from the preview
    amount_paise: int = Field(gt=0)
    direction: str                         # "in" | "out"
    reference: Optional[str] = None
    note: Optional[str] = None
    # The narration, carried back so a PARKED row keeps the only description it
    # will ever have. The file is gone the moment the tab closes; a pending row
    # that says "Rs 12,400, 14 August" and nothing else is unanswerable.
    description: Optional[str] = None
    duplicate_of: Optional[str] = None
    duplicate_note: Optional[str] = None
    suggested_terms: list[str] = Field(default_factory=list)
    # "party"   -> book against a counterparty (party_type + party_id)
    # "expense" -> a house expense (category)
    # "pending" -> PARK it: nothing posts, and it joins the pending queue for
    #              somebody to finish later (owner 2026-08-24). This replaced
    #              "skip", which threw the row away with the browser tab.
    # "skip"    -> deliberately not imported and not parked. Still accepted,
    #              because the importer's own duplicate detection defaults a
    #              flagged row to "leave it alone" and that is genuinely a
    #              decision, not an unanswered question.
    action: str = "pending"
    party_type: Optional[PartyType] = None
    party_id: Optional[str] = None
    expense_category: Optional[str] = None
    policy_id: Optional[str] = None
    # Overrides the type derived from party + direction, for the rare row where
    # the obvious reading is wrong (a credit from a customer that is really a
    # refund coming back).
    txn_type: Optional[LedgerTxnType] = None
    # One per row, generated by the client. A retried commit — the tab was
    # refreshed, the connection dropped mid-response — re-sends the same keys
    # and the unique index refuses the second insert, so a half-finished import
    # can be safely repeated instead of doubling everything that got through.
    idempotency_key: Optional[str] = None


class CommitPayload(BaseModel):
    bank_account_id: str
    rows: list[CommitRow] = Field(default_factory=list)
    # The file this batch came from. Both are for the PENDING rows: months
    # later, "which statement was this from" is the first question anybody asks
    # about a parked line, and the batch id is what groups Tuesday's forty rows
    # into one thing to work through.
    source_file: Optional[str] = None
    import_batch_id: Optional[str] = None


class CommitFailure(BaseModel):
    line: int
    reason: str


class CommitResult(BaseModel):
    imported: int = 0
    # Parked for later, not thrown away. Counted separately from `skipped`
    # because they mean opposite things: one is work outstanding, the other is
    # work deliberately not done.
    pending: int = 0
    skipped: int = 0
    failed: list[CommitFailure] = Field(default_factory=list)
    detail: str = ""


# --- Deriving the transaction type --------------------------------------------
#
# The SAME table the Add-transaction form applies, stated once on the server so
# a client that got it wrong cannot book the wrong kind of row. Deriving rather
# than asking is deliberate: "premium collected" and "reward received" are not a
# choice a person should have to make per line — they follow from who paid and
# which way the money went.

_TYPE_BY_PARTY: dict[tuple[str, PartyType], LedgerTxnType] = {
    ("in", PartyType.CUSTOMER): LedgerTxnType.PREMIUM_COLLECTED,
    ("in", PartyType.CHANNEL_PARTNER): LedgerTxnType.PREMIUM_COLLECTED,
    ("in", PartyType.BROKER): LedgerTxnType.REWARD_RECEIVED,
    ("out", PartyType.BROKER): LedgerTxnType.PREMIUM_TO_INSURER,
    ("out", PartyType.CUSTOMER): LedgerTxnType.REFUND,
    # ("out", CHANNEL_PARTNER) is deliberately absent — paying a partner is a
    # PAYOUT, which draws on their reward balance and books the excess as an
    # advance. It goes through the wallet service, not through a plain ledger
    # row, so it is handled explicitly in _commit_row.
}


def _derived_type(direction: str,
                  party_type: PartyType) -> Optional[LedgerTxnType]:
    return _TYPE_BY_PARTY.get((direction, party_type))


# --- Preview -------------------------------------------------------------------


@router.post("/preview", response_model=PreviewResult,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def preview_statement(
    file: UploadFile = File(...),
    bank_account_id: str = Form(...),
    # A confirmed mapping, sent on the second and later calls. Absent on the
    # first, when we guess.
    date_col: Optional[str] = Form(default=None),
    description_col: Optional[str] = Form(default=None),
    reference_col: Optional[str] = Form(default=None),
    debit_col: Optional[str] = Form(default=None),
    credit_col: Optional[str] = Form(default=None),
    amount_col: Optional[str] = Form(default=None),
    dr_cr_col: Optional[str] = Form(default=None),
    _: User = Depends(get_active_user),
) -> PreviewResult:
    """Read the file and show what is in it. Writes NOTHING."""
    data = await read_upload(file, MAX_UPLOAD_BYTES, label="Statement")
    try:
        headers, body = si.read_table(data, file.filename or "statement.csv")
    except si.StatementFormatError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    any_choice = any([date_col, description_col, reference_col, debit_col,
                      credit_col, amount_col, dr_cr_col])
    if any_choice:
        # A confirmed mapping is used VERBATIM, including its gaps. Filling a
        # blank from the guess would silently overrule somebody who had just
        # cleared that dropdown on purpose.
        mapping = si.ColumnMapping(
            date=date_col or None, description=description_col or None,
            reference=reference_col or None,
            debit=debit_col or None, credit=credit_col or None,
            amount=amount_col or None, dr_cr=dr_cr_col or None)
    else:
        mapping = si.guess_mapping(headers)

    sample = [r[:len(headers)] for r in body[:si.SAMPLE_ROWS]]
    mapping_out = {
        "date": mapping.date, "description": mapping.description,
        "reference": mapping.reference, "debit": mapping.debit,
        "credit": mapping.credit, "amount": mapping.amount,
        "dr_cr": mapping.dr_cr,
    }

    gaps = mapping.missing()
    if gaps:
        # Not an error: it is the normal state of the FIRST call on a file we
        # could not guess. The columns and the sample are what the form needs in
        # order to ask, so they are returned rather than a 400 thrown away.
        return PreviewResult(columns=headers, mapping=mapping_out,
                             sample=sample, total_rows=len(body),
                             truncated=len(body) > si.MAX_ROWS)

    try:
        parsed = si.parse_rows(headers, body, mapping)
    except si.StatementFormatError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    await _flag_duplicates(bank_account_id, parsed)

    rows = [PreviewRow(
        line=r.line,
        occurred_on=r.occurred_on.isoformat() if r.occurred_on else None,
        description=r.description, reference=r.reference,
        amount_paise=r.amount_paise, direction=r.direction,
        problem=r.problem, duplicate_of=r.duplicate_of,
        duplicate_note=r.duplicate_note, suggested_terms=r.terms,
    ) for r in parsed]

    return PreviewResult(
        columns=headers, mapping=mapping_out, sample=sample, rows=rows,
        total_rows=len(body), truncated=len(body) > si.MAX_ROWS,
        readable=sum(1 for r in rows if not r.problem),
        duplicates=sum(1 for r in rows if r.duplicate_of))


async def _flag_duplicates(account_id: str,
                           rows: list[si.StatementRow]) -> None:
    """Mark rows that look like something already on the ledger.

    ONE query for the whole file, not one per row: the window is the statement's
    own date range, scoped to this account, and everything is matched in memory
    off `statement_import.fingerprint`.

    A flag, never a block. Two genuine ₹5,000 cash deposits on the same day into
    the same account happen; the UI defaults them to skipped and lets a person
    tick one back on. A hard refusal would make real data un-enterable.
    """
    dated = [r for r in rows if r.occurred_on and r.amount_paise > 0]
    if not dated or not account_id:
        return
    lo = min(r.occurred_on for r in dated)
    hi = max(r.occurred_on for r in dated)

    existing: dict[str, LedgerTxn] = {}
    async for t in LedgerTxn.find({
        "bank_account_id": account_id,
        "occurred_at": {"$gte": si.ist_instant(lo).replace(hour=0, minute=0),
                        "$lte": si.ist_instant(hi).replace(hour=23, minute=59)},
    }):
        delta = int(t.bank_delta_paise or 0)
        if delta == 0:
            continue          # an accrual row moved no cash; not a duplicate
        when = t.occurred_at
        if when is None:
            continue
        key = si.fingerprint(account_id, when.astimezone(si.IST).date(),
                             abs(delta), "in" if delta > 0 else "out")
        # Keep the FIRST match: the id is only used to say "this one", and any
        # of several identical rows answers that equally well.
        existing.setdefault(key, t)

    for r in dated:
        key = si.fingerprint(account_id, r.occurred_on, r.amount_paise,
                             r.direction)
        hit = existing.get(key)
        if hit is not None:
            r.duplicate_of = str(hit.id)
            r.duplicate_note = (
                f"A {'receipt' if r.direction == 'in' else 'payment'} of the "
                f"same amount is already recorded on this account that day.")


# --- Commit --------------------------------------------------------------------


@router.post("/commit", response_model=CommitResult,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def commit_statement(payload: CommitPayload,
                           actor: User = Depends(get_active_user)
                           ) -> CommitResult:
    """Book the decided rows.

    PARTIAL SUCCESS IS THE DESIGN. Each row is posted independently and a
    failure is reported against its line number rather than unwinding the ones
    that worked. Forty rows keyed by hand, refused at row 38 because one party
    was deactivated in the meantime, is how an importer stops being used — and
    the rows that DID post are real money movements that a rollback would have
    to un-post, which is a bigger risk than the one it avoids.

    Every row carries its own idempotency key, so re-sending the same file after
    a dropped response re-posts nothing.
    """
    if not payload.rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "There is nothing to import.")
    if len(payload.rows) > si.MAX_ROWS:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"That is more than {si.MAX_ROWS} transactions in one go. Split "
            f"the statement by month and import it in parts.")

    imported = skipped = pending = 0
    failures: list[CommitFailure] = []
    batch = payload.import_batch_id or uuid.uuid4().hex
    account_name = await _account_name(payload.bank_account_id)

    for row in payload.rows:
        if row.action == "skip":
            skipped += 1
            continue
        if row.action == "pending":
            # PARKED, not posted. Nothing about this row reaches the ledger, a
            # balance or an account — it becomes a to-do that happens to be
            # shaped like money. See models/pending_txn.
            try:
                await _park_row(row, payload, batch, account_name, actor)
                pending += 1
            except Exception as exc:  # noqa: BLE001
                failures.append(CommitFailure(
                    line=row.line,
                    reason=f"Could not hold this row for later "
                           f"({type(exc).__name__})."))
            continue
        try:
            await _commit_row(row, payload.bank_account_id, actor)
            imported += 1
        except HTTPException as exc:
            failures.append(CommitFailure(line=row.line, reason=str(exc.detail)))
        except Exception as exc:  # noqa: BLE001 — one bad row must not stop 39
            failures.append(CommitFailure(
                line=row.line,
                reason=f"Could not record this row ({type(exc).__name__})."))

    await log_action(
        AuditAction.PAYMENT_RECORDED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="bank_account", entity_id=payload.bank_account_id,
        summary=f"Imported {imported} transactions from a bank statement "
                f"({pending} held as pending, {skipped} skipped, "
                f"{len(failures)} failed)",
        meta={"import_batch_id": batch, "source_file": payload.source_file or ""})

    detail = f"{imported} transaction{'s' if imported != 1 else ''} recorded."
    if pending:
        # Said out loud and pointed at. A row parked into a queue nobody is told
        # about is a row thrown away with extra steps.
        detail += (f" {pending} held as pending — finish "
                   f"{'it' if pending == 1 else 'them'} from the Pending list "
                   f"on Transactions.")
    if skipped:
        detail += f" {skipped} skipped."
    if failures:
        detail += f" {len(failures)} could not be recorded."
    return CommitResult(imported=imported, pending=pending, skipped=skipped,
                        failed=failures, detail=detail)


async def _account_name(account_id: str) -> str:
    """The account's display name, or "". Copied onto every parked row so the
    pending queue reads without a join and still says which account a row
    belongs to after that account is renamed."""
    if not account_id:
        return ""
    from app.models.bank import BankAccount
    try:
        acct = await BankAccount.get(await parse_object_id(account_id))
    except HTTPException:
        return ""
    return acct.name if acct else ""


async def _park_row(row: CommitRow, payload: CommitPayload, batch: str,
                    account_name: str, actor: User) -> None:
    """Hold one statement line for later. Writes ONE document and nothing else.

    Everything the statement said is copied, including the duplicate flag and
    the narration hints, so the pending screen can offer exactly what the import
    screen offered rather than a thinner version of it. `note` carries whatever
    the person typed while parking it, which is usually the only clue there will
    ever be about why they could not decide.
    """
    doc = PendingTransaction(
        bank_account_id=payload.bank_account_id,
        bank_account_name=account_name,
        import_batch_id=batch,
        source_file=payload.source_file or "",
        occurred_on=row.occurred_on,
        description=row.description or "",
        reference=row.reference or "",
        amount_paise=row.amount_paise,
        direction=row.direction,
        source_line=row.line,
        duplicate_of=row.duplicate_of,
        duplicate_note=row.duplicate_note,
        suggested_terms=row.suggested_terms,
        note=row.note if row.note != row.description else None,
        created_by=str(actor.id),
        created_by_name=actor.full_name)
    await doc.insert()


async def _commit_row(row: CommitRow, account_id: str, actor: User) -> None:
    """Book one row through the SAME path its single-transaction form uses.

    There is no posting logic here on purpose — see the module docstring. Each
    branch builds the payload the existing endpoint body expects and calls it.
    """
    # Imported inside the function: routers/finance imports a great deal, and a
    # module-level import here would make the two files circular.
    from app.routers.finance import _post_expense, _post_payment
    from app.routers.wallet import post_agency_payout
    from app.schemas.wallet import AgencyPayoutCreate

    when = si.parse_date(row.occurred_on)
    if when is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "The date on this row could not be read.")
    occurred = si.ist_instant(when)
    key = row.idempotency_key or uuid.uuid4().hex

    if row.action == "expense":
        if row.direction != "out":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Money coming IN cannot be a house expense.")
        if row.expense_category not in EXPENSE_CATEGORIES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Choose a category for this expense.")
        await _post_expense(ExpenseCreate(
            amount_paise=row.amount_paise, category=row.expense_category,
            note=row.note, reference=row.reference, occurred_at=occurred,
            bank_account_id=account_id, idempotency_key=key), actor)
        return

    if row.action != "party" or not row.party_type or not row.party_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Choose who this transaction was with.")

    # Paying a channel partner is a PAYOUT, not a plain ledger row: it draws on
    # their reward balance first and books anything above it as an advance they
    # owe back. The wallet service owns that, and re-deriving it here would be
    # the second implementation this whole module exists to avoid.
    if (row.direction == "out"
            and row.party_type == PartyType.CHANNEL_PARTNER
            and row.txn_type is None):
        await post_agency_payout(AgencyPayoutCreate(
            partner_id=row.party_id, amount_paise=row.amount_paise,
            reference=row.reference, note=row.note, occurred_at=occurred,
            bank_account_id=account_id, idempotency_key=key), actor)
        return

    txn_type = row.txn_type or _derived_type(row.direction, row.party_type)
    if txn_type is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "There is no kind of transaction that matches this direction and "
            "this party. Choose one explicitly, or skip the row.")

    await _post_payment(PaymentCreate(
        txn_type=txn_type, party_type=row.party_type, party_id=row.party_id,
        amount_paise=row.amount_paise, policy_id=row.policy_id,
        note=row.note, reference=row.reference, occurred_at=occurred,
        bank_account_id=account_id, idempotency_key=key), actor)
