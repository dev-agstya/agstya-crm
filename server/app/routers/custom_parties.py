"""Custom Parties (KhataBook-style ledger) API for agency administrators."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.dependencies import get_inhouse_user
from app.core.enums import AccountType, LedgerTxnType, PartyType
from app.core.permissions import VIEW_BALANCE_SHEET, can
from app.models.bank import BankAccount
from app.models.base import utcnow
from app.models.custom_party import CustomParty
from app.models.finance import LedgerTxn, PartyAccount
from app.models.user import User
from app.schemas.common import Message
from app.schemas.custom_party import (
    CustomPartiesOverview,
    CustomPartyCreate,
    CustomPartyDetail,
    CustomPartyOut,
    CustomPartyUpdate,
    CustomTransactionCreate,
    CustomTransactionOut,
)
from app.services import bank, finance as finance_svc

router = APIRouter(prefix="/api/finance/custom-parties", tags=["finance-khata"])


def _require_admin_or_finance(actor: User = Depends(get_inhouse_user)) -> User:
    """Restricted to agency owners / admins or users with balance sheet permission."""
    if actor.account_type == AccountType.OWNER or can(actor, VIEW_BALANCE_SHEET):
        return actor
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        "Custom party khata ledger is restricted to agency administrators.",
    )


async def _get_party_account(party_id: str) -> Optional[PartyAccount]:
    return await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.CUSTOM,
        PartyAccount.party_id == party_id,
    )


@router.get("", response_model=CustomPartiesOverview)
async def list_custom_parties(
    q: Optional[str] = Query(default=None, description="Search party name or phone"),
    category: Optional[str] = Query(default=None),
    actor: User = Depends(_require_admin_or_finance),
) -> CustomPartiesOverview:
    """List all custom parties with their current running balances and overall Khata totals."""
    query = {"is_archived": False}
    if q:
        query["$or"] = [
            {"name": {"$regex": q.strip(), "$options": "i"}},
            {"phone": {"$regex": q.strip(), "$options": "i"}},
        ]
    if category:
        query["category"] = category

    parties = await CustomParty.find(query).sort("-created_at").to_list()
    party_ids = [str(p.id) for p in parties]

    # Batch read party accounts
    accounts = await PartyAccount.find(
        PartyAccount.party_type == PartyType.CUSTOM,
        {"party_id": {"$in": party_ids}},
    ).to_list()
    account_map = {a.party_id: a for a in accounts}

    items: list[CustomPartyOut] = []
    total_get = 0
    total_give = 0

    for p in parties:
        pid = str(p.id)
        acct = account_map.get(pid)
        bal = acct.balance_paise if acct else 0
        charged = acct.total_charged_paise if acct else 0
        settled = acct.total_settled_paise if acct else 0
        last_act = acct.last_txn_at if acct else p.created_at

        if bal > 0:
            total_get += bal
        elif bal < 0:
            total_give += abs(bal)

        items.append(
            CustomPartyOut(
                id=pid,
                name=p.name,
                phone=p.phone,
                category=p.category,
                notes=p.notes,
                balance_paise=bal,
                total_charged_paise=charged,
                total_settled_paise=settled,
                last_activity=last_act,
                is_archived=p.is_archived,
                created_at=p.created_at,
            )
        )

    # Sort so parties with open balances appear first, then by last activity
    items.sort(
        key=lambda x: (
            0 if x.balance_paise != 0 else 1,
            -(x.last_activity.timestamp() if x.last_activity else 0),
        )
    )

    return CustomPartiesOverview(
        parties=items,
        total_you_will_get_paise=total_get,
        total_you_will_give_paise=total_give,
        net_balance_paise=total_get - total_give,
        total_parties=len(items),
    )


@router.post("", response_model=CustomPartyOut, status_code=status.HTTP_201_CREATED)
async def create_custom_party(
    body: CustomPartyCreate,
    actor: User = Depends(_require_admin_or_finance),
) -> CustomPartyOut:
    """Create a new custom party and optional opening balance."""
    clean_name = body.name.strip()
    if len(clean_name) < 2:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Party name is required.")

    party = CustomParty(
        name=clean_name,
        phone=body.phone.strip() if body.phone else None,
        category=body.category or "personal",
        notes=body.notes.strip() if body.notes else None,
        created_by=str(actor.id),
    )
    await party.insert()
    pid = str(party.id)

    # Process opening balance if specified
    if body.opening_balance_paise != 0:
        is_gave = body.opening_balance_paise > 0
        txn_type = (
            LedgerTxnType.CUSTOM_PAYMENT_OUT if is_gave else LedgerTxnType.CUSTOM_PAYMENT_IN
        )
        amount = body.opening_balance_paise
        bank_delta = -amount if is_gave else abs(amount)

        txn = LedgerTxn(
            txn_type=txn_type,
            party_type=PartyType.CUSTOM,
            party_id=pid,
            amount_paise=amount,
            note="Opening balance",
            created_by=str(actor.id),
            occurred_at=utcnow(),
        )
        if body.bank_account_id:
            await txn.insert()
            await bank.post(txn, account_id=body.bank_account_id, delta=bank_delta)
        else:
            await txn.insert()

        await finance_svc.recompute_party_account(PartyType.CUSTOM, pid)

    acct = await _get_party_account(pid)
    return CustomPartyOut(
        id=pid,
        name=party.name,
        phone=party.phone,
        category=party.category,
        notes=party.notes,
        balance_paise=acct.balance_paise if acct else 0,
        total_charged_paise=acct.total_charged_paise if acct else 0,
        total_settled_paise=acct.total_settled_paise if acct else 0,
        last_activity=acct.last_txn_at if acct else party.created_at,
        is_archived=party.is_archived,
        created_at=party.created_at,
    )


@router.get("/{party_id}", response_model=CustomPartyDetail)
async def get_custom_party_detail(
    party_id: str,
    actor: User = Depends(_require_admin_or_finance),
) -> CustomPartyDetail:
    """Get party details and full running Khata ledger history."""
    try:
        party = await CustomParty.get(PydanticObjectId(party_id))
    except Exception:
        party = None

    if not party:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Custom party not found.")

    txns = (
        await LedgerTxn.find(
            LedgerTxn.party_type == PartyType.CUSTOM,
            LedgerTxn.party_id == party_id,
        )
        .sort("+occurred_at", "+created_at")
        .to_list()
    )

    # Collect bank account names
    bank_ids = {t.bank_account_id for t in txns if t.bank_account_id}
    banks_map: dict[str, str] = {}
    if bank_ids:
        for b_id in bank_ids:
            try:
                b_acct = await BankAccount.get(PydanticObjectId(b_id))
                if b_acct:
                    mask = f" (****{b_acct.account_last4})" if b_acct.account_last4 else ""
                    name = b_acct.bank_name or b_acct.name or "Account"
                    banks_map[b_id] = f"{name}{mask}"
            except Exception:
                continue

    # Compute running balance
    running = 0
    txn_outs: list[CustomTransactionOut] = []
    for t in txns:
        running += t.amount_paise
        direction = "gave" if t.amount_paise >= 0 else "got"
        txn_outs.append(
            CustomTransactionOut(
                id=str(t.id),
                party_id=party_id,
                party_name=party.name,
                txn_type=t.txn_type.value,
                direction=direction,
                amount_paise=abs(t.amount_paise),
                bank_account_id=t.bank_account_id,
                bank_account_name=banks_map.get(t.bank_account_id or ""),
                bank_delta_paise=t.bank_delta_paise,
                running_balance_paise=running,
                note=t.note,
                reference=t.reference,
                occurred_at=t.occurred_at,
                created_at=t.created_at,
            )
        )

    # Reverse so newest transactions are displayed at top
    txn_outs.reverse()

    acct = await _get_party_account(party_id)
    party_out = CustomPartyOut(
        id=party_id,
        name=party.name,
        phone=party.phone,
        category=party.category,
        notes=party.notes,
        balance_paise=acct.balance_paise if acct else 0,
        total_charged_paise=acct.total_charged_paise if acct else 0,
        total_settled_paise=acct.total_settled_paise if acct else 0,
        last_activity=acct.last_txn_at if acct else party.created_at,
        is_archived=party.is_archived,
        created_at=party.created_at,
    )

    return CustomPartyDetail(party=party_out, transactions=txn_outs)


@router.put("/{party_id}", response_model=CustomPartyOut)
async def update_custom_party(
    party_id: str,
    body: CustomPartyUpdate,
    actor: User = Depends(_require_admin_or_finance),
) -> CustomPartyOut:
    """Update custom party contact details."""
    try:
        party = await CustomParty.get(PydanticObjectId(party_id))
    except Exception:
        party = None

    if not party:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Custom party not found.")

    if body.name is not None:
        clean = body.name.strip()
        if len(clean) < 2:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Name is too short.")
        party.name = clean
    if body.phone is not None:
        party.phone = body.phone.strip() if body.phone else None
    if body.category is not None:
        party.category = body.category
    if body.notes is not None:
        party.notes = body.notes.strip() if body.notes else None

    party.updated_at = utcnow()
    await party.save()

    acct = await _get_party_account(party_id)
    return CustomPartyOut(
        id=party_id,
        name=party.name,
        phone=party.phone,
        category=party.category,
        notes=party.notes,
        balance_paise=acct.balance_paise if acct else 0,
        total_charged_paise=acct.total_charged_paise if acct else 0,
        total_settled_paise=acct.total_settled_paise if acct else 0,
        last_activity=acct.last_txn_at if acct else party.created_at,
        is_archived=party.is_archived,
        created_at=party.created_at,
    )


@router.delete("/{party_id}", response_model=Message)
async def archive_custom_party(
    party_id: str,
    actor: User = Depends(_require_admin_or_finance),
) -> Message:
    """Archive a custom party."""
    try:
        party = await CustomParty.get(PydanticObjectId(party_id))
    except Exception:
        party = None

    if not party:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Custom party not found.")

    party.is_archived = True
    party.updated_at = utcnow()
    await party.save()
    return Message(message="Custom party archived.")


@router.post("/{party_id}/transactions", response_model=CustomTransactionOut)
async def record_custom_transaction(
    party_id: str,
    body: CustomTransactionCreate,
    actor: User = Depends(_require_admin_or_finance),
) -> CustomTransactionOut:
    """Record a money payment to ('gave') or receipt from ('got') a custom party."""
    try:
        party = await CustomParty.get(PydanticObjectId(party_id))
    except Exception:
        party = None

    if not party:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Custom party not found.")

    if body.amount_paise <= 0:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Amount must be greater than zero."
        )

    direction = body.direction.lower().strip()
    if direction not in ("gave", "got"):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Direction must be 'gave' or 'got'."
        )

    is_gave = direction == "gave"
    # From party receivable view:
    #   amount_paise > 0 means party owes us (You Gave money)
    #   amount_paise < 0 means party paid us / we owe party (You Got money)
    stored_amount = abs(body.amount_paise) if is_gave else -abs(body.amount_paise)
    txn_type = (
        LedgerTxnType.CUSTOM_PAYMENT_OUT if is_gave else LedgerTxnType.CUSTOM_PAYMENT_IN
    )
    # Bank delta:
    #   You gave money -> money leaves bank (negative)
    #   You got money -> money enters bank (positive)
    bank_delta = -abs(body.amount_paise) if is_gave else abs(body.amount_paise)

    occurred = body.occurred_at or utcnow()
    if occurred.tzinfo is None:
        occurred = occurred.replace(tzinfo=timezone.utc)

    txn = LedgerTxn(
        txn_type=txn_type,
        party_type=PartyType.CUSTOM,
        party_id=party_id,
        amount_paise=stored_amount,
        note=body.note.strip() if body.note else None,
        reference=body.reference.strip() if body.reference else None,
        occurred_at=occurred,
        created_by=str(actor.id),
    )

    if body.bank_account_id:
        # Validate bank account exists
        try:
            b_acct = await BankAccount.get(PydanticObjectId(body.bank_account_id))
        except Exception:
            b_acct = None
        if not b_acct:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Selected bank account not found.")

        await txn.insert()
        await bank.post(txn, account_id=body.bank_account_id, delta=bank_delta)
    else:
        await txn.insert()

    # Recompute party account running balance
    acct = await finance_svc.recompute_party_account(PartyType.CUSTOM, party_id)
    current_balance = acct.balance_paise if acct else stored_amount

    bank_name = None
    if body.bank_account_id:
        b = await BankAccount.get(PydanticObjectId(body.bank_account_id))
        if b:
            mask = f" (****{b.account_last4})" if b.account_last4 else ""
            name = b.bank_name or b.name or "Account"
            bank_name = f"{name}{mask}"

    return CustomTransactionOut(
        id=str(txn.id),
        party_id=party_id,
        party_name=party.name,
        txn_type=txn.txn_type.value,
        direction=direction,
        amount_paise=abs(body.amount_paise),
        bank_account_id=txn.bank_account_id,
        bank_account_name=bank_name,
        bank_delta_paise=txn.bank_delta_paise,
        running_balance_paise=current_balance,
        note=txn.note,
        reference=txn.reference,
        occurred_at=txn.occurred_at,
        created_at=txn.created_at,
    )


@router.delete("/transactions/{txn_id}", response_model=Message)
async def delete_custom_transaction(
    txn_id: str,
    actor: User = Depends(_require_admin_or_finance),
) -> Message:
    """Delete a custom party transaction and restore bank/party balances."""
    try:
        txn = await LedgerTxn.get(PydanticObjectId(txn_id))
    except Exception:
        txn = None

    if not txn or txn.party_type != PartyType.CUSTOM:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")

    party_id = txn.party_id

    # If it affected a bank account, reverse the bank balance delta
    if txn.bank_account_id and txn.bank_delta_paise:
        await bank.unpost(txn)

    await txn.delete()
    await finance_svc.recompute_party_account(PartyType.CUSTOM, party_id)
    return Message(message="Transaction deleted and balances updated.")
