"""The pending queue: statement lines somebody parked instead of deciding.

WHAT THIS IS FOR
-----------------
The owner, on the bank-statement importer: "let's say I added a CSV file of 10
transactions. I filled details for eight transactions, but two I selected as
pending. And then I click on record. So it will record eight transactions, but
it will push those two pending transactions into a pending transaction list, so
that the owner can come back later and fix those transactions... make sure there
is a proper view somewhere on the transactions page where the owner can see the
pending actions to take on these imported transactions."

So this is a to-do list that happens to be shaped like money, and the two rules
that follow from that are the whole file:

  1. NOTHING HERE POSTS. Deciding a pending row calls
     `statement_import._commit_row` — the same function the importer's own rows
     go through, which is itself only a shim over `finance._post_payment`,
     `finance._post_expense` and `wallet.post_agency_payout`. A queue with its
     own copy of the posting rules would drift from the importer within a
     release, and then the same statement line would book differently depending
     on which day somebody got round to it.
  2. NOTHING HERE IS DELETED. Discarding is a status with a name, a date and a
     reason on it. The owner asked for the confirmation dialog for exactly this
     reason — "we don't want to delete any of the transactions actually" — and a
     dismissed statement line is precisely the line somebody asks about six
     months later.

THE ACCOUNT IS FROZEN ONTO THE ROW
-----------------------------------
A pending row carries the bank account it came from, because a statement does
not name the account inside its lines — the account is what the FILE is, and the
file is long gone by the time anybody works the queue. It is not re-choosable
here for the same reason it is not re-choosable per row in the importer.
"""

from __future__ import annotations

from typing import Optional

from fastapi import (
    APIRouter, Depends, HTTPException, Query, Request, status,
)
from pydantic import BaseModel, Field

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction, LedgerTxnType, PartyType
from app.core.permissions import MANAGE_TRANSACTIONS, VIEW_TRANSACTIONS
from app.models.base import utcnow
from app.models.pending_txn import PendingTransaction, PendingTxnStatus
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message
from app.services.audit import log_action

# Staff-only, like every other money router, at ROUTER level so a new route here
# is closed to channel partners by default.
router = APIRouter(prefix="/api/finance/pending-transactions",
                   tags=["finance"],
                   dependencies=[Depends(get_inhouse_user)])


# --- Shapes ---------------------------------------------------------------------


class PendingTxnOut(BaseModel):
    id: str
    bank_account_id: str
    bank_account_name: str = ""
    import_batch_id: str = ""
    source_file: str = ""
    occurred_on: str = ""
    description: str = ""
    reference: str = ""
    amount_paise: int = 0
    direction: str = ""
    source_line: int = 0
    duplicate_of: Optional[str] = None
    duplicate_note: Optional[str] = None
    suggested_terms: list[str] = Field(default_factory=list)
    note: Optional[str] = None
    status: str
    created_at: str
    created_by_name: Optional[str] = None
    resolved_txn_id: Optional[str] = None
    resolved_by_name: Optional[str] = None
    discarded_by_name: Optional[str] = None
    discard_reason: Optional[str] = None

    @classmethod
    def from_model(cls, p: PendingTransaction) -> "PendingTxnOut":
        return cls(
            id=str(p.id),
            created_at=p.created_at.isoformat(),
            **{k: getattr(p, k) for k in (
                "bank_account_id", "bank_account_name", "import_batch_id",
                "source_file", "occurred_on", "description", "reference",
                "amount_paise", "direction", "source_line", "duplicate_of",
                "duplicate_note", "suggested_terms", "note", "status",
                "created_by_name", "resolved_txn_id", "resolved_by_name",
                "discarded_by_name", "discard_reason")})


class PendingBatch(BaseModel):
    """One import, summarised — what the queue is grouped by.

    A person works a FILE, not forty unrelated rows: "Tuesday's HDFC statement,
    six left" is a task with an end, and a flat list of ninety rows from four
    files is not.
    """

    import_batch_id: str
    source_file: str = ""
    bank_account_id: str = ""
    bank_account_name: str = ""
    open_count: int = 0
    net_paise: int = 0
    first_date: str = ""
    last_date: str = ""


class PendingList(BaseModel):
    items: list[PendingTxnOut] = Field(default_factory=list)
    total: int = 0
    # The badge on the Transactions page. Always the OPEN count regardless of
    # the filter in force, or the badge would go to zero the moment somebody
    # looked at the discarded rows.
    open_count: int = 0
    in_paise: int = 0
    out_paise: int = 0
    batches: list[PendingBatch] = Field(default_factory=list)


class PendingCount(BaseModel):
    """Just the number, for the badge. Its own endpoint because the badge is
    polled from every finance screen and must not drag a hundred rows with it."""

    open_count: int = 0


class ResolveRow(BaseModel):
    """One pending row, decided at last.

    Deliberately the same vocabulary as the importer's `CommitRow` — `action`,
    `party_type`, `party_id`, `expense_category` — because the SAME screen
    component renders both and the same server function books both. Two
    vocabularies for one decision is how the two screens start behaving
    differently.
    """

    id: str
    action: str                            # "party" | "expense"
    party_type: Optional[PartyType] = None
    party_id: Optional[str] = None
    expense_category: Optional[str] = None
    policy_id: Optional[str] = None
    txn_type: Optional[LedgerTxnType] = None
    reference: Optional[str] = None
    note: Optional[str] = None
    idempotency_key: Optional[str] = None


class ResolvePayload(BaseModel):
    rows: list[ResolveRow] = Field(default_factory=list)


class ResolveFailure(BaseModel):
    id: str
    reason: str


class ResolveResult(BaseModel):
    recorded: int = 0
    failed: list[ResolveFailure] = Field(default_factory=list)
    detail: str = ""


class DiscardIn(BaseModel):
    """Why this statement line is being dismissed.

    The reason is REQUIRED, and it is the only thing separating "we looked at
    this and it is not ours" from a row that vanished. `min_length` is 3 rather
    than 1 so a single keystroke does not satisfy it.
    """

    reason: str = Field(min_length=3, max_length=300)


class UpdateNoteIn(BaseModel):
    note: Optional[str] = None


# --- Reading ---------------------------------------------------------------------


@router.get("/count", response_model=PendingCount,
            dependencies=[Depends(require_permission(VIEW_TRANSACTIONS))])
async def pending_count() -> PendingCount:
    """How many rows are waiting. Registered BEFORE `/{pending_id}`.

    A static path declared after a dynamic one is shadowed by it — this
    codebase's oldest routing scar (see the /export note in routers/policies) —
    and "count" would otherwise be looked up as an object id.
    """
    return PendingCount(open_count=await PendingTransaction.find(
        {"status": PendingTxnStatus.PENDING}).count())


@router.get("", response_model=PendingList,
            dependencies=[Depends(require_permission(VIEW_TRANSACTIONS))])
async def list_pending(
    status_filter: str = Query(default=PendingTxnStatus.PENDING,
                               alias="status"),
    bank_account_id: Optional[str] = Query(default=None),
    import_batch_id: Optional[str] = Query(default=None),
    limit: int = Query(default=300, ge=1, le=1000),
) -> PendingList:
    """The queue. Open rows by default; `status=all` shows the history too.

    DEFAULTING TO OPEN is the whole ergonomics of this screen: it is a to-do
    list, and a to-do list that opens on everything you have ever done is one
    nobody opens twice. Discarded and recorded rows are kept and reachable, and
    that is a different question ("what happened to that Rs 12,400?").
    """
    query: dict = {}
    if status_filter and status_filter != "all":
        query["status"] = status_filter
    if bank_account_id:
        query["bank_account_id"] = bank_account_id
    if import_batch_id:
        query["import_batch_id"] = import_batch_id

    rows = await PendingTransaction.find(query) \
        .sort("-occurred_on", "source_line").limit(limit).to_list()
    total = await PendingTransaction.find(query).count()
    open_count = await PendingTransaction.find(
        {"status": PendingTxnStatus.PENDING}).count()

    # Money in and out are reported SEPARATELY rather than as one net figure.
    # A queue holding a Rs 50,000 receipt and a Rs 50,000 payment nets to zero,
    # which would read as "nothing outstanding" when in fact two real
    # transactions are missing from the books.
    inbound = sum(r.amount_paise for r in rows if r.direction == "in")
    outbound = sum(r.amount_paise for r in rows if r.direction == "out")

    return PendingList(
        items=[PendingTxnOut.from_model(r) for r in rows],
        total=total, open_count=open_count,
        in_paise=inbound, out_paise=outbound,
        batches=_batches(rows))


def _batches(rows: list[PendingTransaction]) -> list[PendingBatch]:
    """Group the loaded rows by the import they came from.

    Grouped in PYTHON over the rows already in hand rather than by a second
    aggregation: the queue is capped at a few hundred rows by the endpoint
    above, and a `$group` here would be a second definition of "what is open"
    that could disagree with the list it sits on top of.
    """
    by_batch: dict[str, PendingBatch] = {}
    for r in rows:
        key = r.import_batch_id or "—"
        b = by_batch.get(key)
        if b is None:
            b = PendingBatch(
                import_batch_id=key, source_file=r.source_file,
                bank_account_id=r.bank_account_id,
                bank_account_name=r.bank_account_name,
                first_date=r.occurred_on, last_date=r.occurred_on)
            by_batch[key] = b
        if r.status == PendingTxnStatus.PENDING:
            b.open_count += 1
            b.net_paise += (r.amount_paise if r.direction == "in"
                            else -r.amount_paise)
        if r.occurred_on:
            b.first_date = min(b.first_date or r.occurred_on, r.occurred_on)
            b.last_date = max(b.last_date or r.occurred_on, r.occurred_on)
    return sorted(by_batch.values(), key=lambda b: b.last_date, reverse=True)


@router.get("/{pending_id}", response_model=PendingTxnOut,
            dependencies=[Depends(require_permission(VIEW_TRANSACTIONS))])
async def get_pending(pending_id: str) -> PendingTxnOut:
    return PendingTxnOut.from_model(await _load(pending_id))


async def _load(pending_id: str) -> PendingTransaction:
    row = await PendingTransaction.get(await parse_object_id(pending_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "That pending transaction is not there.")
    return row


# --- Deciding --------------------------------------------------------------------


@router.post("/resolve", response_model=ResolveResult,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def resolve(payload: ResolvePayload, request: Request,
                  actor: User = Depends(get_active_user)) -> ResolveResult:
    """Book one or more pending rows, through the importer's own posting path.

    PARTIAL SUCCESS IS THE DESIGN, exactly as it is in the importer. Each row is
    posted independently and a failure is reported against its id rather than
    unwinding the ones that worked — the rows that DID post are real money
    movements, and rolling them back is a bigger risk than the one it avoids.

    A row is marked RECORDED only after its ledger row exists. If the post
    throws, the pending row is untouched and is still in the queue, which is the
    correct state: the work is not done.
    """
    if not payload.rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "There is nothing to record.")

    # Imported here rather than at module level: routers/statement_import pulls
    # in routers/finance inside its own function bodies for the same reason, and
    # a module-level import would make this file part of that cycle.
    from app.routers.statement_import import CommitRow, _commit_row

    recorded = 0
    failures: list[ResolveFailure] = []

    for decision in payload.rows:
        try:
            row = await _load(decision.id)
        except HTTPException as exc:
            failures.append(ResolveFailure(id=decision.id,
                                           reason=str(exc.detail)))
            continue
        if not row.is_open:
            failures.append(ResolveFailure(
                id=decision.id,
                reason="This row has already been dealt with."))
            continue

        try:
            await _commit_row(CommitRow(
                line=row.source_line,
                occurred_on=row.occurred_on,
                amount_paise=row.amount_paise,
                direction=row.direction,
                reference=decision.reference or row.reference or None,
                note=decision.note or row.description or None,
                description=row.description,
                action=decision.action,
                party_type=decision.party_type,
                party_id=decision.party_id,
                expense_category=decision.expense_category,
                policy_id=decision.policy_id,
                txn_type=decision.txn_type,
                idempotency_key=decision.idempotency_key,
            ), row.bank_account_id, actor)
        except HTTPException as exc:
            failures.append(ResolveFailure(id=decision.id,
                                           reason=str(exc.detail)))
            continue
        except Exception as exc:  # noqa: BLE001 — one bad row must not stop 39
            failures.append(ResolveFailure(
                id=decision.id,
                reason=f"Could not record this row ({type(exc).__name__})."))
            continue

        now = utcnow()
        row.status = PendingTxnStatus.RECORDED
        row.resolved_at = now
        row.resolved_by = str(actor.id)
        row.resolved_by_name = actor.full_name
        row.updated_at = now
        await row.save()
        recorded += 1

    await log_action(
        AuditAction.PENDING_TXN_RECORDED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="pending_transaction", request=request,
        summary=f"Recorded {recorded} pending transaction"
                f"{'s' if recorded != 1 else ''} from a bank statement")

    detail = f"{recorded} transaction{'s' if recorded != 1 else ''} recorded."
    if failures:
        detail += f" {len(failures)} could not be recorded."
    return ResolveResult(recorded=recorded, failed=failures, detail=detail)


@router.patch("/{pending_id}/note", response_model=PendingTxnOut,
              dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def set_note(pending_id: str, payload: UpdateNoteIn) -> PendingTxnOut:
    """Leave a note on a row you cannot decide yet ("ask Rakesh whose this is").

    The one editable field on a pending row, and the reason a parked row beats a
    sticky note: the question and the place it will be answered are the same
    object. Nothing the BANK said is editable — see the module docstring.
    """
    row = await _load(pending_id)
    row.note = (payload.note or "").strip() or None
    row.updated_at = utcnow()
    await row.save()
    return PendingTxnOut.from_model(row)


@router.delete("/{pending_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def discard(pending_id: str, payload: DiscardIn, request: Request,
                  actor: User = Depends(get_active_user)) -> Message:
    """Dismiss a statement line, with a reason. Never deletes it.

    The owner asked for the cross AND for the confirmation behind it: "removing
    any transaction from this import list should also send one pop-up and ask
    for confirmation because we don't want to delete any of the transactions
    actually." The dialog is the client's half; this is the other half — the row
    stays, marked, with who dismissed it and why.

    A DELETE verb on a route that does not delete looks wrong for a second and
    is right: it is the verb for "make this go away from my queue", and what the
    server does about that is the server's business. Making it a POST would have
    the client saying HOW rather than WHAT.
    """
    row = await _load(pending_id)
    if not row.is_open:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "This row has already been dealt with.")
    now = utcnow()
    row.status = PendingTxnStatus.DISCARDED
    row.discarded_at = now
    row.discarded_by = str(actor.id)
    row.discarded_by_name = actor.full_name
    row.discard_reason = payload.reason.strip()
    row.updated_at = now
    await row.save()

    await log_action(
        AuditAction.PENDING_TXN_DISCARDED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="pending_transaction", entity_id=str(row.id),
        request=request,
        summary=f"Dismissed a pending {row.direction} of "
                f"Rs {row.amount_paise / 100:,.2f} dated {row.occurred_on}",
        meta={"reason": row.discard_reason,
              "description": row.description[:200]})
    return Message(detail="Removed from the pending list.")


@router.post("/{pending_id}/restore", response_model=PendingTxnOut,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def restore(pending_id: str, request: Request,
                  actor: User = Depends(get_active_user)) -> PendingTxnOut:
    """Put a dismissed row back in the queue.

    The whole reason discarding is a status rather than a delete. Somebody
    dismisses a row, finds out a week later what it actually was, and the
    alternative to this button is re-importing the statement and re-deciding
    every other line in it.
    """
    row = await _load(pending_id)
    if row.status != PendingTxnStatus.DISCARDED:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Only a dismissed row can be put back in the queue.")
    row.status = PendingTxnStatus.PENDING
    row.discarded_at = row.discarded_by = row.discarded_by_name = None
    row.discard_reason = None
    row.updated_at = utcnow()
    await row.save()
    await log_action(
        AuditAction.PENDING_TXN_PARKED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="pending_transaction", entity_id=str(row.id),
        request=request,
        summary=f"Restored a dismissed pending transaction dated "
                f"{row.occurred_on}")
    return PendingTxnOut.from_model(row)
