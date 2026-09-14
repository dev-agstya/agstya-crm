"""Bank / cash accounts: CRUD, live balances, statements and own-account
transfers.

Gated on its own permission pair (view_bank_accounts / manage_bank_accounts)
rather than view_finance — the ledger tells you who owes what, this tells you how
much money the house is actually sitting on, which the owner wanted separately
grantable.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core import crypto
from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction, LedgerTxnType, PartyType
from app.core.permissions import (
    can,
    MANAGE_BANK_ACCOUNTS,
    VIEW_BANK_ACCOUNTS,
    VIEW_SENSITIVE_PII,
)
from app.models.bank import BankAccount
from app.models.base import utcnow
from app.models.finance import LedgerTxn
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.bank import (
    BankAccountCreate,
    BankAccountList,
    BankAccountOut,
    BankAccountUpdate,
    BankReconcile,
    BankReconcileResult,
    BankTotals,
    TransferCreate,
    TransferResult,
)
from app.schemas.common import Message, Page
from app.schemas.finance import LedgerTxnOut
from app.services import bank as bank_svc
from app.services import finance_reports as fr
from app.services import idempotency
from app.services.audit import diff_dict_async, log_action

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/banks", tags=["banks"],
                   dependencies=[Depends(get_inhouse_user)])

# Sentinel party for a transfer: the agency itself. PartyType.EXPENSE never
# carries a counterparty position (services/finance.record_ledger_txn skips it),
# which is exactly right — moving your own money owes nobody anything.
TRANSFER_PARTY_ID = "house"


def _digits(value: Optional[str]) -> Optional[str]:
    return "".join(ch for ch in value if ch.isdigit()) if value else None


# Date bounds a user picked are IST, not UTC — see services/finance_reports.
# This router used to carry its own UTC-attaching copy, which put the bank
# statement's window 5h30m out of step with the Business Report's.
_parse_dt = fr.parse_ist_bound
_end_of_day = fr.parse_ist_end_of_day


def _aware(dt: datetime) -> datetime:
    """A datetime supplied in a REQUEST BODY (occurred_at, opening_as_of).

    Deliberately UTC, unlike the query-string bounds above: these arrive from
    the client as full ISO instants, and a naive one is a client bug rather than
    a calendar date somebody typed.
    """
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def _clear_other_defaults(keep_id: Optional[str]) -> None:
    """Exactly one account may be the default — it is what the money forms
    preselect, and two defaults means the selection depends on query order."""
    async for other in BankAccount.find(BankAccount.is_default == True):  # noqa: E712
        if keep_id and str(other.id) == keep_id:
            continue
        other.is_default = False
        await other.save()


# --- List / totals ---------------------------------------------------------------


@router.get("", response_model=BankAccountList,
            dependencies=[Depends(require_permission(VIEW_BANK_ACCOUNTS))])
async def list_accounts(
    actor: User = Depends(get_active_user),
    include_inactive: bool = Query(default=False),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
) -> BankAccountList:
    query = {} if include_inactive else {"active": True}
    accounts = await BankAccount.find(query).sort("-is_default", "+name").to_list()

    # Movement inside the window, per account. One pass over the window's rows
    # rather than a query per account — the Banks page is a small list, but this
    # keeps it O(1) queries as the number of accounts grows.
    window: dict = {}
    if (lo := _parse_dt(date_from)):
        window["$gte"] = lo
    if (hi := _end_of_day(date_to)):
        window["$lte"] = hi
    period: dict[str, list[int]] = {}
    if window:
        async for t in LedgerTxn.find({"bank_account_id": {"$ne": None},
                                       "occurred_at": window}):
            delta = int(t.bank_delta_paise or 0)
            bucket = period.setdefault(t.bank_account_id, [0, 0])
            if delta >= 0:
                bucket[0] += delta
            else:
                bucket[1] += -delta

    unmask = can(actor, VIEW_SENSITIVE_PII)
    totals = await bank_svc.totals()
    return BankAccountList(
        totals=BankTotals(**totals),
        items=[BankAccountOut.from_model(
            a, unmask=unmask,
            period_in=period.get(str(a.id), [0, 0])[0],
            period_out=period.get(str(a.id), [0, 0])[1]) for a in accounts],
    )


@router.get("/totals", response_model=BankTotals,
            dependencies=[Depends(require_permission(VIEW_BANK_ACCOUNTS))])
async def account_totals() -> BankTotals:
    return BankTotals(**await bank_svc.totals())


# --- Create / update / delete ------------------------------------------------------


@router.post("", response_model=BankAccountOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_BANK_ACCOUNTS))])
async def create_account(payload: BankAccountCreate,
                         actor: User = Depends(get_active_user)
                         ) -> BankAccountOut:
    if await BankAccount.find_one(BankAccount.name == payload.name.strip()):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "An account with that name already exists.")
    number = (payload.account_number or "").strip() or None
    account = BankAccount(
        name=payload.name.strip(),
        account_type=payload.account_type,
        bank_name=(payload.bank_name or "").strip() or None,
        account_number=crypto.encrypt(number),
        account_last4=(_digits(number) or "")[-4:] or None,
        ifsc=((payload.ifsc or "").strip().upper() or None),
        upi_id=(payload.upi_id or "").strip() or None,
        opening_balance_paise=payload.opening_balance_paise,
        opening_as_of=(_aware(payload.opening_as_of)
                       if payload.opening_as_of else utcnow()),
        # The opening balance IS the balance until something moves.
        balance_paise=payload.opening_balance_paise,
        is_default=payload.is_default,
        note=payload.note,
        created_by=str(actor.id),
    )
    await account.insert()
    # First account created becomes the default, so the money forms always have
    # something preselected without anyone having to think about it.
    if payload.is_default or await BankAccount.find(
            BankAccount.active == True).count() == 1:  # noqa: E712
        account.is_default = True
        await account.save()
        await _clear_other_defaults(str(account.id))
    await log_action(
        AuditAction.BANK_ACCOUNT_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="bank_account", entity_id=str(account.id),
        summary=f"Added {account.account_type.value} account {account.name}")
    return BankAccountOut.from_model(account, unmask=False)


@router.patch("/{account_id}", response_model=BankAccountOut,
              dependencies=[Depends(require_permission(MANAGE_BANK_ACCOUNTS))])
async def update_account(account_id: str, payload: BankAccountUpdate,
                         actor: User = Depends(get_active_user)
                         ) -> BankAccountOut:
    account = await BankAccount.get(await parse_object_id(account_id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")

    before = {"name": account.name, "type": account.account_type.value,
              "opening_balance_paise": account.opening_balance_paise,
              "active": account.active, "is_default": account.is_default}
    data = payload.model_dump(exclude_unset=True)

    if "name" in data and data["name"]:
        clash = await BankAccount.find_one(BankAccount.name == data["name"].strip())
        if clash is not None and str(clash.id) != account_id:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "An account with that name already exists.")
        account.name = data["name"].strip()
    if "account_number" in data:
        number = (data["account_number"] or "").strip() or None
        account.account_number = crypto.encrypt(number)
        account.account_last4 = (_digits(number) or "")[-4:] or None
    for field in ("account_type", "bank_name", "upi_id", "note", "active"):
        if field in data:
            setattr(account, field, data[field])
    if "ifsc" in data:
        account.ifsc = (data["ifsc"] or "").strip().upper() or None
    if "opening_as_of" in data and data["opening_as_of"]:
        account.opening_as_of = _aware(data["opening_as_of"])
    if "opening_balance_paise" in data \
            and data["opening_balance_paise"] is not None:
        # Correcting the opening balance must move the live balance by the same
        # amount, or the account silently disagrees with its own statement.
        account.balance_paise += (data["opening_balance_paise"]
                                  - account.opening_balance_paise)
        account.opening_balance_paise = data["opening_balance_paise"]
    # PRESENCE, not truthiness. This read `if data.get("is_default")`, so a
    # PATCH carrying `false` was parsed, survived exclude_unset, and was then
    # silently dropped — an account could be made the default but never
    # un-defaulted. The only way to move it was to set it somewhere else, and if
    # someone deactivated the default instead, `bank_svc.default_account()` fell
    # through to "any active account", so the money forms preselected one by
    # query order — the exact thing _clear_other_defaults exists to prevent.
    if "is_default" in data and data["is_default"] is not None:
        account.is_default = bool(data["is_default"])
    account.updated_at = utcnow()
    await account.save()
    if account.is_default:
        await _clear_other_defaults(account_id)

    await log_action(
        AuditAction.BANK_ACCOUNT_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="bank_account", entity_id=account_id,
        summary=f"Updated account {account.name}",
        meta={"changes": await diff_dict_async(before, {
            "name": account.name, "type": account.account_type.value,
            "opening_balance_paise": account.opening_balance_paise,
            "active": account.active, "is_default": account.is_default})})
    return BankAccountOut.from_model(
        account, unmask=can(actor, VIEW_SENSITIVE_PII))


@router.delete("/{account_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_BANK_ACCOUNTS))])
async def delete_account(account_id: str,
                         actor: User = Depends(get_active_user)) -> Message:
    """Delete an account that no money has ever moved through.

    Same rule as every other relational record (services/references): once
    transactions point at it, deleting would strip the account name off historic
    rows and leave their balances unexplained — deactivate instead.
    """
    account = await BankAccount.get(await parse_object_id(account_id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    used = await LedgerTxn.find(LedgerTxn.bank_account_id == account_id).count()
    if used:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"This account is used by {used} "
            f"transaction{'s' if used != 1 else ''}. Deactivate it instead — "
            f"everything already recorded against it keeps working.")
    name = account.name
    await account.delete()
    await log_action(
        AuditAction.BANK_ACCOUNT_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="bank_account", entity_id=account_id,
        summary=f"Deleted account {name}")
    return Message(detail="Account deleted.")


# --- Statement --------------------------------------------------------------------


@router.get("/{account_id}/statement", response_model=Page[LedgerTxnOut],
            dependencies=[Depends(require_permission(VIEW_BANK_ACCOUNTS))])
async def account_statement(
    account_id: str,
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> Page[LedgerTxnOut]:
    account = await BankAccount.get(await parse_object_id(account_id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    query: dict = {"bank_account_id": account_id}
    window: dict = {}
    if (lo := _parse_dt(date_from)):
        window["$gte"] = lo
    if (hi := _end_of_day(date_to)):
        window["$lte"] = hi
    if window:
        query["occurred_at"] = window
    total = await LedgerTxn.find(query).count()
    rows = (await LedgerTxn.find(query).sort("-occurred_at")
            .skip((page - 1) * page_size).limit(page_size).to_list())
    return Page[LedgerTxnOut](
        items=[LedgerTxnOut.from_model(t) for t in rows],
        total=total, page=page, page_size=page_size)


@router.post("/{account_id}/recompute", response_model=BankAccountOut,
             dependencies=[Depends(require_permission(MANAGE_BANK_ACCOUNTS))])
async def recompute_account(account_id: str,
                            actor: User = Depends(get_active_user)
                            ) -> BankAccountOut:
    """Rebuild the running balance from the transactions (the repair path)."""
    account = await BankAccount.get(await parse_object_id(account_id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    account = await bank_svc.recompute_balance(account)
    return BankAccountOut.from_model(
        account, unmask=can(actor, VIEW_SENSITIVE_PII))


@router.post("/{account_id}/reconcile", response_model=BankReconcileResult,
             dependencies=[Depends(require_permission(MANAGE_BANK_ACCOUNTS))])
async def reconcile_account(account_id: str, payload: BankReconcile,
                            actor: User = Depends(get_active_user)
                            ) -> BankReconcileResult:
    """Make the balance match the real account by POSTING THE DIFFERENCE.

    The owner's ask was "hard reset the balance, without changing previous
    balances". Those two halves pull against each other if you take the first
    literally, because the balance is not stored — it is
    `opening_balance_paise + Σ bank_delta_paise`, healed by recompute_balance().
    Overwriting the field lasts until the next Recompute and disagrees with the
    statement in the meantime; moving `opening_balance_paise` shifts every
    historical statement's opening figure, which is precisely the thing that was
    supposed not to move.

    Posting one dated ADJUSTMENT row for the gap satisfies both halves exactly:
    every prior row keeps the balance it always had, the total now matches the
    bank, and the correction is inside the append-only ledger rather than
    layered on top of it.

    Run /recompute FIRST. If the ledger is right and only the cache drifted —
    the crash window in bank_svc.post() between the row write and the $inc —
    then recompute fixes it for free and there is nothing to reconcile. Booking
    an adjustment in that case invents a transaction to hide a bug.
    """
    account = await BankAccount.get(await parse_object_id(account_id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")

    previous = account.balance_paise
    difference = bank_svc.reconcile_delta(previous, payload.actual_balance_paise)

    # Nothing to do, and say so rather than writing a zero-value row. A ledger
    # full of ₹0 adjustments is a ledger people stop reading.
    if difference == 0:
        # Nothing is POSTED, but the check still happened and the answer was
        # "we agree with the bank" — which is the single most reassuring thing
        # this feature can record. Not stamping it would leave a diligent
        # account, reconciled monthly and always correct, permanently flagged
        # as never reconciled.
        await BankAccount.get_motor_collection().update_one(
            {"_id": account.id},
            {"$set": {"last_reconciled_at": (
                _aware(payload.occurred_at) if payload.occurred_at
                else utcnow()),
                "last_reconciled_diff_paise": 0,
                "updated_at": utcnow()}})
        return BankReconcileResult(
            account_id=account_id, difference_paise=0, adjusted=False,
            balance_paise=previous, previous_balance_paise=previous)

    key = idempotency.clean(payload.idempotency_key)
    if key and (dupe := await idempotency.existing(key)) is not None:
        # Double-click or a retry after a dropped response. Report the position
        # as it stands; do NOT move the money twice.
        current = await bank_svc.get_account(account_id)
        return BankReconcileResult(
            account_id=account_id,
            difference_paise=int(dupe.bank_delta_paise or difference),
            adjusted=True,
            balance_paise=current.balance_paise if current else previous,
            previous_balance_paise=previous)

    occurred = _aware(payload.occurred_at) if payload.occurred_at else utcnow()
    reason = payload.reason.strip()

    # Party is the house sentinel, exactly as a transfer is: a reconciliation
    # owes nobody anything, so no counterparty balance may move. PartyType.EXPENSE
    # carries no position (services/finance.record_ledger_txn skips it), and
    # finance_profit counts only LedgerTxnType.EXPENSE rows — so an ADJUSTMENT
    # cannot leak into house profit either. An unexplained difference is not a
    # cost until somebody decides it is one and books it as an expense.
    row = LedgerTxn(
        txn_type=LedgerTxnType.ADJUSTMENT, party_type=PartyType.EXPENSE,
        party_id=TRANSFER_PARTY_ID,
        # The stored amount is party-signed; the bank delta is the true cash
        # direction, and for an adjustment they are the same number because
        # there is no counterparty to sign it against.
        amount_paise=difference,
        note=f"Balance reconciled: {reason}",
        occurred_at=occurred,
        bank_account_id=account_id, bank_delta_paise=difference,
        created_by=str(actor.id), idempotency_key=key)
    row, created = await idempotency.insert_once(row)
    if not created:
        current = await bank_svc.get_account(account_id)
        return BankReconcileResult(
            account_id=account_id, difference_paise=difference, adjusted=True,
            balance_paise=current.balance_paise if current else previous,
            previous_balance_paise=previous)

    await bank_svc.apply_delta(account_id, difference, occurred)
    # Record that somebody actually checked. This is what lets Bank & Cash say
    # "not reconciled in 74 days" instead of leaving the question unasked —
    # $set rather than account.save() because apply_delta above has already
    # moved balance_paise in the database, and saving the stale document we
    # loaded before that would write the pre-adjustment balance straight back.
    await BankAccount.get_motor_collection().update_one(
        {"_id": account.id},
        {"$set": {"last_reconciled_at": occurred,
                  "last_reconciled_diff_paise": difference,
                  "updated_at": utcnow()}})

    direction = "short by" if difference > 0 else "over by"
    await log_action(
        AuditAction.BANK_RECONCILED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="bank_account", entity_id=account_id,
        summary=f"Reconciled {account.name}: was {direction} "
                f"Rs {abs(difference) / 100:,.2f} — {reason}",
        meta={"previous_balance_paise": previous,
              "actual_balance_paise": payload.actual_balance_paise,
              "difference_paise": difference,
              "reason": reason,
              "ledger_txn_id": str(row.id)})

    current = await bank_svc.get_account(account_id)
    return BankReconcileResult(
        account_id=account_id, difference_paise=difference, adjusted=True,
        balance_paise=current.balance_paise if current else
        previous + difference,
        previous_balance_paise=previous)


# --- Transfers ---------------------------------------------------------------------


@router.post("/transfers", response_model=TransferResult,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_BANK_ACCOUNTS))])
async def create_transfer(payload: TransferCreate,
                          actor: User = Depends(get_active_user)
                          ) -> TransferResult:
    """Move money between the agency's own accounts.

    Booked as two paired TRANSFER rows against the house sentinel: no
    counterparty balance moves, and finance_profit only counts EXPENSE rows, so
    moving your own money can never read as a cost.
    """
    if payload.from_account_id == payload.to_account_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Choose two different accounts.")
    source = await bank_svc.get_account(payload.from_account_id)
    target = await bank_svc.get_account(payload.to_account_id)
    if source is None or target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")

    key = idempotency.clean(payload.idempotency_key)
    out_key = idempotency.derive(key, "out")
    in_key = idempotency.derive(key, "in")

    # A transfer is TWO rows, so "have we already done this?" is a question
    # about both of them. Asking only about the out leg — which is what this
    # did — treats a HALF-written transfer as a finished one: if the process
    # died between the two inserts, the retry that should have healed it
    # returned success instead, leaving the source debited (the out row carries
    # its own bank_delta, so the next Rebuild applies it) and the target never
    # credited. Money left one account and arrived nowhere.
    existing_out = await idempotency.existing(out_key)
    existing_in = await idempotency.existing(in_key)
    if existing_out is not None and existing_in is not None:
        # Genuinely already applied (double-click / retry after a lost
        # response): report the position, do not move the money again.
        return TransferResult(
            from_account_id=payload.from_account_id,
            to_account_id=payload.to_account_id,
            amount_paise=abs(existing_out.bank_delta_paise
                             or payload.amount_paise),
            from_balance_paise=source.balance_paise,
            to_balance_paise=target.balance_paise)

    amount = payload.amount_paise
    occurred = _aware(payload.occurred_at) if payload.occurred_at else utcnow()
    # Resume the ORIGINAL group when finishing a half-written transfer, so the
    # two legs stay findable as one movement.
    group = (existing_out.transfer_group_id if existing_out is not None
             else uuid4().hex)
    note = payload.note or f"Transfer {source.name} to {target.name}"

    if existing_out is None:
        out_row = LedgerTxn(
            txn_type=LedgerTxnType.TRANSFER, party_type=PartyType.EXPENSE,
            party_id=TRANSFER_PARTY_ID, amount_paise=-amount, note=note,
            reference=payload.reference, occurred_at=occurred,
            bank_account_id=payload.from_account_id, bank_delta_paise=-amount,
            transfer_group_id=group, created_by=str(actor.id),
            idempotency_key=out_key)
        out_row, created = await idempotency.insert_once(out_row)
        if not created:
            # Lost the insert race to a concurrent request; it owns the write.
            return TransferResult(
                from_account_id=payload.from_account_id,
                to_account_id=payload.to_account_id, amount_paise=amount,
                from_balance_paise=source.balance_paise,
                to_balance_paise=target.balance_paise)

    if existing_in is None:
        in_row = LedgerTxn(
            txn_type=LedgerTxnType.TRANSFER, party_type=PartyType.EXPENSE,
            party_id=TRANSFER_PARTY_ID, amount_paise=amount, note=note,
            reference=payload.reference, occurred_at=occurred,
            bank_account_id=payload.to_account_id, bank_delta_paise=amount,
            transfer_group_id=group, created_by=str(actor.id),
            idempotency_key=in_key)
        await idempotency.insert_once(in_row)

    # Both rows now exist. Rebuild each balance from its rows rather than
    # $inc-ing, because on the resume path we cannot know which of the two
    # increments already landed before the crash — and recompute_balance is
    # the append-only ledger's own definition of the answer, so it is right
    # either way. (Cost is one scan per account, on a rare write.)
    source = await bank_svc.recompute_balance(source)
    target = await bank_svc.recompute_balance(target)

    await log_action(
        AuditAction.BANK_TRANSFER, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="bank_account", entity_id=payload.from_account_id,
        summary=f"Transferred Rs {amount / 100:,.2f} from {source.name} "
                f"to {target.name}",
        meta={"to_account_id": payload.to_account_id, "amount_paise": amount})

    # recompute_balance saved and returned both, so these ARE the stored
    # figures — no re-fetch needed.
    return TransferResult(
        from_account_id=payload.from_account_id,
        to_account_id=payload.to_account_id, amount_paise=amount,
        from_balance_paise=source.balance_paise,
        to_balance_paise=target.balance_paise)
