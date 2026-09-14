"""Channel Partner wallet and withdrawal requests.

Channel Partners view their wallet/ledger and request withdrawals. Staff with the right
permissions approve, reject or mark withdrawals paid. Emails fire at each step.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.config import settings
from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AccountType, AuditAction, WithdrawalStatus
from app.core.permissions import can, MANAGE_TRANSACTIONS
from app.models.base import utcnow
from app.models.user import User
from app.models.wallet import Wallet, WalletTxn, WithdrawalRequest
from app.routers._helpers import parse_object_id
from app.schemas.common import Page
from app.schemas.wallet import (
    AgencyPayoutCreate,
    AgencyPayoutResult,
    WalletOut,
    WalletTxnOut,
    WithdrawalAction,
    WithdrawalCreate,
    WithdrawalOut,
)
from app.services import email as email_svc
from app.services import wallet as wallet_svc
from app.services.audit import log_action
from app.services.codes import next_code
from app.services.money import paise_to_rupees

# Staff-only. The guard is attached to the WHOLE router, not per endpoint,
# so a new route added here is closed to channel partners by default.
router = APIRouter(prefix="/api", tags=["wallet"],
                   dependencies=[Depends(get_inhouse_user)])


def _fmt(paise: int) -> str:
    return f"{paise_to_rupees(paise):,.2f}"


# --- Withdrawals: STAFF ONLY -----------------------------------------------------
#
# There is no partner-facing wallet or withdrawal endpoint any more (owner A1,
# 2026-08-05). A partner does not ask to be paid through the app: the team pays
# them and records it, and it reaches the partner as a transaction on their
# earnings screen — the same ledger the agency's own statement is built from.
#
# The WithdrawalRequest model and the staff review screens below survive because
# they still describe a real thing the agency does; only the partner's half of
# the flow is gone.


@router.post("/wallet/payouts", response_model=AgencyPayoutResult,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_TRANSACTIONS))])
async def record_agency_payout(payload: AgencyPayoutCreate,
                               actor: User = Depends(get_active_user)
                               ) -> AgencyPayoutResult:
    """Staff-recorded payout to a partner (the partner portal is paused, so
    partners can't self-request). The amount draws from the partner's reward
    balance first; anything ABOVE it is allowed and booked as a PARTNER_ADVANCE
    on their premium ledger — the partner then owes it back, so their net
    balance goes negative until it is recovered (or eaten by future rewards)."""
    return await post_agency_payout(payload, actor)


async def post_agency_payout(payload: AgencyPayoutCreate,
                             actor: User) -> AgencyPayoutResult:
    """The body of `record_agency_payout`, callable without a request.

    Extracted 2026-08-19 for the bank-statement import, which books a "paid to a
    channel partner" line through THIS function rather than through a second
    copy of it. Paying a partner is the most intricate money path in the app —
    it splits across the wallet and the premium ledger, mirrors an
    informational row onto Transactions, and books the excess as an advance —
    and a bulk importer with its own version would go wrong quietly and
    expensively.
    """
    from app.core.enums import LedgerTxnType, PartyType
    from app.models.bank import BankAccount
    from app.models.finance import LedgerTxn, PartyAccount
    from app.services import bank as bank_svc
    from app.services import finance as finance_svc
    from app.services import finance_balance
    from app.services import idempotency

    partner = await User.get(await parse_object_id(payload.partner_id))
    if partner is None \
            or partner.account_type != AccountType.CHANNEL_PARTNER:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "Channel partner not found.")

    # Paying a partner twice because the button was double-clicked is the single
    # most expensive duplicate this app can produce — it hands out real money and
    # zeroes a wallet that was never owed twice.
    key = idempotency.clean(payload.idempotency_key)
    if key and await idempotency.existing(idempotency.derive(key, "payout")) \
            is not None:
        wallet = await wallet_svc.get_or_create_wallet(payload.partner_id)
        acct = await PartyAccount.find_one(
            PartyAccount.party_type == PartyType.CHANNEL_PARTNER,
            PartyAccount.party_id == payload.partner_id)
        reward_after = wallet.available_paise + wallet.pending_paise
        return AgencyPayoutResult(
            partner_id=payload.partner_id, amount_paise=payload.amount_paise,
            paid_from_reward_paise=0, advance_paise=0,
            reward_balance_paise=reward_after,
            net_balance_paise=finance_balance.partner_net_balance(
                reward_after, acct.balance_paise if acct else 0))

    # A payout is real cash leaving a real account.
    account_id = payload.bank_account_id
    if account_id:
        account = await bank_svc.get_account(account_id)
        if account is None or not account.active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Choose an active account to pay from.")
    elif await BankAccount.find(BankAccount.active == True).count():  # noqa: E712
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Choose which account this money was paid from.")

    wallet = await wallet_svc.get_or_create_wallet(payload.partner_id)
    reward_balance = wallet.available_paise + wallet.pending_paise
    from_reward = min(payload.amount_paise, max(0, reward_balance))
    advance = payload.amount_paise - from_reward

    # The reward portion goes through the existing withdrawal mechanism so the
    # partner's wallet ledger and lifetime figures stay honest.
    req = None
    if from_reward > 0:
        bank = partner.partner_profile.bank if partner.partner_profile else None
        req = WithdrawalRequest(
            code=await next_code("withdrawal"),
            partner_id=payload.partner_id,
            amount_paise=from_reward,
            status=WithdrawalStatus.PAID,
            bank_snapshot=bank,
            note=payload.note,
            processed_by=str(actor.id),
            processed_at=utcnow(),
            reference=payload.reference,
        )
        await req.insert()
        await wallet_svc.agency_payout(
            payload.partner_id, from_reward, ref_id=str(req.id),
            note=payload.note, actor_id=str(actor.id))
        # Mirror the reward payout as an informational, balance-neutral ledger
        # row so it shows on the central Transactions page (the wallet already
        # holds the reward position — this row must NOT move the premium balance,
        # see BALANCE_NEUTRAL_LEDGER_TYPES). Stored negative to read as an
        # outflow. Inserted directly (not via record_ledger_txn) so no party
        # balance is touched.
        # It IS real cash leaving a bank account, though — balance-neutral on
        # the PARTY ledger is not the same as invisible to the bank.
        payout_row = LedgerTxn(
            txn_type=LedgerTxnType.PARTNER_PAYOUT,
            party_type=PartyType.CHANNEL_PARTNER,
            party_id=payload.partner_id,
            amount_paise=-from_reward,
            note=payload.note or "Reward paid to partner",
            reference=payload.reference,
            created_by=str(actor.id),
            bank_account_id=account_id,
            bank_delta_paise=(-from_reward if account_id else None),
            idempotency_key=idempotency.derive(key, "payout"),
            **({"occurred_at": payload.occurred_at}
               if payload.occurred_at else {}),
        )
        await payout_row.insert()
        if account_id:
            await bank_svc.apply_delta(account_id, -from_reward,
                                       payout_row.occurred_at)

    # The excess is an advance the partner owes back: +ve on their premium
    # ledger, visible in Transactions and on their statement.
    if advance > 0:
        await finance_svc.record_ledger_txn(
            txn_type=LedgerTxnType.PARTNER_ADVANCE,
            party_type=PartyType.CHANNEL_PARTNER,
            party_id=payload.partner_id,
            amount_paise=advance,
            note=payload.note or "Advance paid to partner",
            reference=payload.reference,
            occurred_at=payload.occurred_at,
            created_by=str(actor.id),
            bank_account_id=account_id,
            bank_delta_paise=-advance,
            idempotency_key=idempotency.derive(key, "advance"))

    await log_action(
        AuditAction.WITHDRAWAL_PAID, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="withdrawal",
        entity_id=str(req.id) if req is not None else payload.partner_id,
        entity_code=req.code if req is not None else None,
        summary=f"Paid ₹ {_fmt(payload.amount_paise)} to partner "
                f"{partner.code}"
                + (f" (₹ {_fmt(advance)} as advance)" if advance else ""),
        meta={"reference": payload.reference, "advance_paise": advance},
    )

    wallet = await wallet_svc.get_or_create_wallet(payload.partner_id)
    acct = await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.CHANNEL_PARTNER,
        PartyAccount.party_id == payload.partner_id)
    reward_after = wallet.available_paise + wallet.pending_paise
    return AgencyPayoutResult(
        partner_id=payload.partner_id,
        amount_paise=payload.amount_paise,
        paid_from_reward_paise=from_reward,
        advance_paise=advance,
        reward_balance_paise=reward_after,
        net_balance_paise=finance_balance.partner_net_balance(
            reward_after, acct.balance_paise if acct else 0))


@router.get("/withdrawals", response_model=Page[WithdrawalOut])
async def list_withdrawals(
    actor: User = Depends(get_active_user),
    status_filter: WithdrawalStatus | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[WithdrawalOut]:
    is_reviewer = can(actor, MANAGE_TRANSACTIONS)
    if actor.account_type == AccountType.CHANNEL_PARTNER:
        base: dict = {"partner_id": str(actor.id)}
    elif is_reviewer:
        base = {}
    else:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You can't view withdrawals.")
    if status_filter:
        base["status"] = status_filter.value

    total = await WithdrawalRequest.find(base).count()
    items = (await WithdrawalRequest.find(base).sort("-requested_at")
             .skip((page - 1) * page_size).limit(page_size).to_list())
    # Resolve partner names for reviewers.
    partner_map: dict[str, User] = {}
    if is_reviewer and actor.account_type != AccountType.CHANNEL_PARTNER:
        ids = {parse_bid(w.partner_id) for w in items}
        ids.discard(None)
        for b in await User.find({"_id": {"$in": list(ids)}}).to_list():
            partner_map[str(b.id)] = b
    out = []
    for w in items:
        b = partner_map.get(w.partner_id)
        out.append(WithdrawalOut.from_model(
            w, partner_name=b.full_name if b else (actor.full_name
                if w.partner_id == str(actor.id) else None),
            partner_code=b.code if b else (actor.code
                if w.partner_id == str(actor.id) else None)))
    return Page[WithdrawalOut](items=out, total=total, page=page,
                               page_size=page_size)


def parse_bid(value: str):
    from beanie import PydanticObjectId
    try:
        return PydanticObjectId(value)
    except Exception:  # noqa: BLE001
        return None


@router.patch("/withdrawals/{withdrawal_id}", response_model=WithdrawalOut)
async def act_on_withdrawal(withdrawal_id: str, payload: WithdrawalAction,
                            actor: User = Depends(get_active_user)
                            ) -> WithdrawalOut:
    req = await WithdrawalRequest.get(await parse_object_id(withdrawal_id))
    if req is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Withdrawal not found.")

    partner = await User.get(req.partner_id)
    wallet_url = f"{settings.frontend_base_url}/wallet"

    if payload.action == "approve":
        if not can(actor, MANAGE_TRANSACTIONS):
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "You can't approve withdrawals.")
        if req.status != WithdrawalStatus.REQUESTED:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Only requested withdrawals can be approved.")
        req.status = WithdrawalStatus.APPROVED
        req.processed_by = str(actor.id)
        req.processed_at = utcnow()
        audit_action, label = AuditAction.WITHDRAWAL_APPROVED, "approved"
        if partner and partner.email:
            await email_svc.send_withdrawal_update_email(
                partner.email, partner.full_name, req.code,
                _fmt(req.amount_paise), "approved", wallet_url)

    elif payload.action == "reject":
        if not can(actor, MANAGE_TRANSACTIONS):
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "You can't reject withdrawals.")
        if req.status not in (WithdrawalStatus.REQUESTED,
                              WithdrawalStatus.APPROVED):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "This withdrawal can't be rejected.")
        if not payload.reason:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "A reason is required when rejecting.")
        req.status = WithdrawalStatus.REJECTED
        req.reject_reason = payload.reason
        req.processed_by = str(actor.id)
        req.processed_at = utcnow()
        # Refund the reserved amount back to the partner's available balance.
        await wallet_svc.refund_withdrawal(
            req.partner_id, req.amount_paise, str(req.id), str(actor.id))
        audit_action, label = AuditAction.WITHDRAWAL_REJECTED, "rejected"
        if partner and partner.email:
            await email_svc.send_withdrawal_update_email(
                partner.email, partner.full_name, req.code,
                _fmt(req.amount_paise), "rejected", wallet_url,
                reason=payload.reason)

    else:  # pay
        if not can(actor, MANAGE_TRANSACTIONS):
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "You can't mark withdrawals paid.")
        # APPROVED only. finalize_withdrawal_paid() assumes the amount was
        # already reserved out of `available` when the request was raised and
        # therefore only moves the lifetime counter; letting a REQUESTED row
        # skip straight to paid still works today (the reserve happens on
        # request), but it silently removes the approval step from a money
        # movement. Keep the two-person rule explicit.
        if req.status != WithdrawalStatus.APPROVED:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Approve this withdrawal before marking it paid.")
        req.status = WithdrawalStatus.PAID
        req.reference = payload.reference
        req.processed_by = str(actor.id)
        req.processed_at = utcnow()
        await wallet_svc.finalize_withdrawal_paid(
            req.partner_id, req.amount_paise, str(req.id), str(actor.id))
        audit_action, label = AuditAction.WITHDRAWAL_PAID, "paid"
        if partner and partner.email:
            await email_svc.send_withdrawal_update_email(
                partner.email, partner.full_name, req.code,
                _fmt(req.amount_paise), "paid", wallet_url,
                reference=payload.reference)

    req.updated_at = utcnow()
    await req.save()
    await log_action(
        audit_action, actor_id=str(actor.id), actor_name=actor.full_name,
        actor_role=actor.account_type.value, entity_type="withdrawal",
        entity_id=str(req.id), entity_code=req.code,
        summary=f"Withdrawal {req.code} {label}",
        meta={"reference": payload.reference, "reason": payload.reason},
    )
    return WithdrawalOut.from_model(
        req, partner_name=partner.full_name if partner else None,
        partner_code=partner.code if partner else None)
