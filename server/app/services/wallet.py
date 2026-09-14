"""Channel Partner wallet operations: reward credits and withdrawal accounting.

Accounting rules (all paise):
  - Policy approved + partner attributed -> partner share credited as AVAILABLE
    immediately. Rewards are assumed eligible by default (owner decision) — the
    per-policy reward outcome only matters when it is a REVERSAL state.
  - Reward reversed (cancelled / rejected / not eligible / refunded / 0%) ->
    the credit is removed from the wallet.
  - Paying a partner MORE than their wallet balance is allowed at the router
    level: the wallet is debited down to zero and the excess is booked as a
    PARTNER_ADVANCE on their premium ledger (they owe it back). The wallet
    itself never goes negative.
  - Withdrawal REQUESTED -> available is debited immediately (reserved) so a
    partner cannot request more than they hold across several requests.
      approve -> no balance change (already reserved).
      paid    -> lifetime_withdrawn += amount.
      reject  -> refund the reserved amount back to available.
"""

from __future__ import annotations

from typing import Optional

from pymongo import ReturnDocument

from app.core.enums import REWARD_REVERSAL_STATES, RewardStatus, WalletTxnType
from app.models.base import utcnow
from app.models.reward import Reward
from app.models.wallet import Wallet, WalletTxn


async def get_or_create_wallet(partner_id: str) -> Wallet:
    wallet = await Wallet.find_one(Wallet.partner_id == partner_id)
    if wallet is None:
        wallet = Wallet(partner_id=partner_id)
        await wallet.insert()
    return wallet


async def _apply(partner_id: str, **deltas: int) -> Wallet:
    """Apply signed deltas to a wallet ATOMICALLY and return the fresh document.

    Every wallet operation used to be load -> mutate a Python attribute ->
    save(), which writes the whole document back. Two overlapping requests both
    read the same starting balance and the second save silently discarded the
    first: pay a partner from two tabs (or double-click Pay) and they are paid
    twice while the wallet records one debit. Money can't be reconciled from a
    balance that lost a write.

    `$inc` is applied by the database to whatever the CURRENT value is, so
    concurrent operations compose instead of clobbering. The returned document
    is the post-update state, which is what callers log and return.
    """
    await get_or_create_wallet(partner_id)          # ensure the row exists
    inc = {k: v for k, v in deltas.items() if v}
    coll = Wallet.get_motor_collection()
    doc = await coll.find_one_and_update(
        {"partner_id": partner_id},
        {"$inc": inc, "$set": {"updated_at": utcnow()}} if inc
        else {"$set": {"updated_at": utcnow()}},
        return_document=ReturnDocument.AFTER,
    )
    return Wallet.model_validate(doc)


async def _debit_bucket(partner_id: str, amount: int, *, from_available: bool,
                        drop_lifetime: bool = False) -> Wallet:
    """Take `amount` out of one bucket, never below zero, atomically.

    Reversals clamp at zero (a wallet must never go negative — an overpayment
    is booked as a PARTNER_ADVANCE on the premium ledger instead). A plain
    $inc cannot express that floor, so this uses an aggregation-pipeline update:
    Mongo evaluates the $max against the value AS STORED at write time, which
    keeps both the clamp and the concurrency-safety that read-modify-write
    threw away.
    """
    await get_or_create_wallet(partner_id)
    bucket = "available_paise" if from_available else "pending_paise"
    stage: dict = {
        bucket: {"$max": [0, {"$subtract": [f"${bucket}", amount]}]},
        "updated_at": utcnow(),
    }
    if drop_lifetime:
        stage["lifetime_earned_paise"] = {
            "$max": [0, {"$subtract": ["$lifetime_earned_paise", amount]}]}
    doc = await Wallet.get_motor_collection().find_one_and_update(
        {"partner_id": partner_id}, [{"$set": stage}],
        return_document=ReturnDocument.AFTER,
    )
    return Wallet.model_validate(doc)


async def _txn(wallet: Wallet, txn_type: WalletTxnType, amount: int,
               *, note: Optional[str] = None, ref_type: Optional[str] = None,
               ref_id: Optional[str] = None,
               from_available: Optional[int] = None,
               from_pending: Optional[int] = None,
               created_by: Optional[str] = None) -> None:
    await WalletTxn(
        partner_id=wallet.partner_id,
        type=txn_type,
        amount_paise=amount,
        balance_after_paise=wallet.available_paise,
        note=note,
        ref_type=ref_type,
        ref_id=ref_id,
        from_available_paise=from_available,
        from_pending_paise=from_pending,
        created_by=created_by,
    ).insert()


async def credit_reward(reward: Reward) -> None:
    """Credit a partner's reward share to their wallet as AVAILABLE the moment
    the policy is booked/approved. Rewards are eligible by default (owner
    decision) — only a reversal outcome takes the credit back."""
    if not reward.partner_id or reward.partner_amount <= 0:
        return
    if reward.wallet_credited:
        return
    wallet = await _apply(reward.partner_id,
                          available_paise=reward.partner_amount,
                          lifetime_earned_paise=reward.partner_amount)
    await _txn(wallet, WalletTxnType.REWARD_CREDIT, reward.partner_amount,
               note="Reward credited (policy booked)", ref_type="reward",
               ref_id=str(reward.id))
    reward.wallet_credited = True
    reward.wallet_available = True
    reward.updated_at = utcnow()
    await reward.save()


async def make_reward_available(reward: Reward) -> None:
    """Move a legacy PENDING partner reward to AVAILABLE. New credits land in
    AVAILABLE directly (see credit_reward); this only reconciles old wallets
    that still carry a pending bucket."""
    if not reward.partner_id or reward.partner_amount <= 0:
        return
    if not reward.wallet_credited or reward.wallet_available:
        return
    current = await get_or_create_wallet(reward.partner_id)
    move = min(reward.partner_amount, current.pending_paise)
    wallet = await _apply(reward.partner_id, pending_paise=-move,
                          available_paise=reward.partner_amount)
    await _txn(wallet, WalletTxnType.REWARD_CREDIT, reward.partner_amount,
               note="Reward available (payout received)", ref_type="reward",
               ref_id=str(reward.id))
    reward.wallet_available = True
    reward.updated_at = utcnow()
    await reward.save()


async def reverse_reward(reward: Reward, *, actor_id: Optional[str] = None) -> None:
    """Reverse a previously credited partner reward (policy cancelled/rejected)."""
    if not reward.partner_id or reward.partner_amount <= 0:
        return
    if not reward.wallet_credited:
        return
    wallet = await _debit_bucket(
        reward.partner_id, reward.partner_amount,
        from_available=reward.wallet_available, drop_lifetime=True)
    await _txn(wallet, WalletTxnType.REWARD_REVERSAL, -reward.partner_amount,
               note="Reward reversed", ref_type="reward", ref_id=str(reward.id),
               created_by=actor_id)
    reward.wallet_credited = False
    reward.wallet_available = False
    reward.updated_at = utcnow()
    await reward.save()


async def remove_stale_credit(partner_id: str, amount: int, was_available: bool,
                              *, ref_id: str,
                              actor_id: Optional[str] = None) -> None:
    """Pull a previously credited reward amount back out of a partner's wallet
    using the ORIGINAL credit's partner/amount/bucket — used when a policy edit
    re-prices the reward (or moves it to another partner) after the wallet was
    already credited. The caller re-credits the new amount via
    apply_reward_outcome, so the wallet always matches the current reward."""
    if not partner_id or amount <= 0:
        return
    wallet = await _debit_bucket(partner_id, amount,
                                 from_available=was_available,
                                 drop_lifetime=True)
    await _txn(wallet, WalletTxnType.REWARD_REVERSAL, -amount,
               note="Reward re-priced (policy edited)", ref_type="reward",
               ref_id=ref_id, created_by=actor_id)


async def apply_reward_outcome(reward: Reward, new_status: RewardStatus,
                               *, actor_id: Optional[str] = None) -> None:
    """Reconcile a partner's wallet to match a reward's outcome, from ANY prior
    state. Reversal outcomes remove the credit; every other outcome (pending,
    received, paid out) means the reward is owed, so the wallet is credited as
    AVAILABLE. A no-op when there's no partner or no share (e.g. a direct
    policy, or a 0% reward)."""
    if new_status in REWARD_REVERSAL_STATES:
        if reward.wallet_credited:
            await reverse_reward(reward, actor_id=actor_id)
        return
    # Eligible-by-default: pending and received are both owed & payable.
    if not reward.wallet_credited:
        await credit_reward(reward)
    elif not reward.wallet_available:
        await make_reward_available(reward)


def payout_split(available: int, pending: int, amount: int) -> tuple[int, int]:
    """Split an agency-initiated payout across a partner's reward balance,
    drawing from AVAILABLE first then PENDING (legacy bucket).

    Returns (from_available, from_pending). Any excess beyond both buckets is
    ignored here — the caller books it as a PARTNER_ADVANCE ledger row.
    """
    from_available = min(max(0, amount), max(0, available))
    from_pending = min(max(0, amount - from_available), max(0, pending))
    return from_available, from_pending


async def agency_payout(partner_id: str, amount: int, *, ref_id: str,
                        note: Optional[str] = None,
                        actor_id: Optional[str] = None) -> None:
    """Debit a partner's wallet for the reward portion of a payout the agency
    made. The caller caps `amount` at the wallet balance; anything paid beyond
    it is booked separately as a PARTNER_ADVANCE on the premium ledger."""
    if amount <= 0:
        return
    current = await get_or_create_wallet(partner_id)
    from_available, from_pending = payout_split(
        current.available_paise, current.pending_paise, amount)
    wallet = await _apply(partner_id, available_paise=-from_available,
                          pending_paise=-from_pending,
                          lifetime_withdrawn_paise=amount)
    await _txn(wallet, WalletTxnType.WITHDRAWAL_DEBIT, -amount,
               note=note or "Reward paid to partner", ref_type="withdrawal",
               ref_id=ref_id, from_available=from_available,
               from_pending=from_pending, created_by=actor_id)


async def reserve_for_withdrawal(partner_id: str, amount: int, ref_id: str) -> None:
    wallet = await _apply(partner_id, available_paise=-amount)
    await _txn(wallet, WalletTxnType.WITHDRAWAL_DEBIT, -amount,
               note="Withdrawal requested", ref_type="withdrawal", ref_id=ref_id)


async def finalize_withdrawal_paid(partner_id: str, amount: int,
                                   ref_id: str, actor_id: str) -> None:
    wallet = await _apply(partner_id, lifetime_withdrawn_paise=amount)
    await _txn(wallet, WalletTxnType.WITHDRAWAL_DEBIT, 0,
               note="Withdrawal paid", ref_type="withdrawal", ref_id=ref_id,
               created_by=actor_id)


async def refund_withdrawal(partner_id: str, amount: int, ref_id: str,
                            actor_id: str) -> None:
    wallet = await _apply(partner_id, available_paise=amount)
    await _txn(wallet, WalletTxnType.ADJUSTMENT, amount,
               note="Withdrawal rejected — refunded", ref_type="withdrawal",
               ref_id=ref_id, created_by=actor_id)
