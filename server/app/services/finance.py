"""The finance engine: per-policy P&L and per-party money positions.

Pure functions (no DB) do the maths and are unit-tested like services/money.py:
  house_profit = agency_reward - partner_share - discount   (discount house-borne)
A party's running balance is just the signed sum of their ledger postings
(+receivable / -payable), so "paid 50k, got 45k" nets to a 5k receivable.

Async helpers book the frozen PolicyFinance snapshot and post ledger entries that
keep PartyAccount balances in sync.
"""

from __future__ import annotations

from typing import NamedTuple, Optional

from app.core.enums import (
    REWARD_REVERSAL_STATES,
    LedgerTxnType,
    PartyType,
    PayerType,
    RewardBasis,
    SettlementStatus,
)
from app.models.base import utcnow
from app.models.finance import LedgerTxn, PartyAccount, PolicyFinance, TdsEntry
from app.services.money import PERCENT_SCALE

# Ledger rows that are recorded purely for visibility/audit and must NEVER move a
# party's running balance (they represent a pass-through, not a real position).
BALANCE_NEUTRAL_LEDGER_TYPES = {
    LedgerTxnType.PREMIUM_PAID_BY_AGENCY,
    # A not-eligible reward's cancellation is informational: the commission is
    # already removed from expected via the zeroed PolicyFinance snapshot, so this
    # row must not double-count against the broker balance.
    LedgerTxnType.REWARD_CANCELLED,
    # A partner reward payout is held by the wallet (available/pending reward),
    # NOT the premium party-ledger. This row exists only so the payout is visible
    # on the Transactions page; it must never move the partner's premium balance.
    LedgerTxnType.PARTNER_PAYOUT,
}


# --- Pure maths ---------------------------------------------------------------
def discount_amount(premium_paise: int, basis: RewardBasis, value: int) -> int:
    """Discount to the customer in paise (percent of GROSS premium, or flat)."""
    if value <= 0 or premium_paise <= 0:
        return 0
    if basis == RewardBasis.PERCENT:
        return round(premium_paise * value / (PERCENT_SCALE * 100))
    return int(value)


def house_profit(agency_reward: int, partner_share: int, discount: int) -> int:
    """Agency profit after paying the partner and absorbing the discount.

    TDS is deliberately NOT subtracted here — it is an advance tax we reclaim, so it
    reduces the cash we receive but not the profit we earned (owner Q7). It is
    tracked separately (TdsEntry / the TDS report)."""
    return agency_reward - partner_share - discount


def agency_premium_ledger_amount(payer: PayerType, broker_id: Optional[str],
                                 premium_paise: int) -> Optional[int]:
    """Signed amount for the auto "Premium paid by Agency" ledger row, or None when
    it does not apply. Only the agency-fronted case (with a broker and a positive
    premium) logs one; the amount is negative to read as an outflow."""
    if payer == PayerType.AGENCY and broker_id and premium_paise > 0:
        return -premium_paise
    return None


def eligible_snapshot_amounts(status, agency_reward: int, partner_share: int,
                              discount: int) -> tuple[int, int, int]:
    """Reward/discount amounts to freeze on a policy's P&L snapshot.

    A NOT-ELIGIBLE reward contributes nothing (agency, partner AND discount all
    zeroed) so it drops out of every commission/profit aggregate; an eligible one
    keeps its amounts. Pure, so the eligibility rule is unit-testable."""
    if status in REWARD_REVERSAL_STATES:
        return 0, 0, 0
    return agency_reward, partner_share, discount


def reward_cancellation_amount(status, broker_id, agency_reward: int) -> int:
    """Signed amount for the informational broker "reward cancelled" row: the
    negative of the reward we would have collected when the policy is not eligible
    (and has a broker), else 0 (no row)."""
    if status in REWARD_REVERSAL_STATES and broker_id and agency_reward:
        return -abs(agency_reward)
    return 0


def tds_on_reward(gross_reward_paise: int, tds_percent: int) -> int:
    """TDS a broker withholds on a gross reward, in paise. `tds_percent` is
    percent*100 (2% -> 200); mirrors discount_amount's percent handling."""
    if gross_reward_paise <= 0 or tds_percent <= 0:
        return 0
    return round(gross_reward_paise * tds_percent / (PERCENT_SCALE * 100))


class FinanceSnapshot(NamedTuple):
    gross_premium: int
    commissionable: int
    agency_reward: int
    partner_share: int
    discount: int
    house_profit: int


def compute_finance(*, gross_premium: int, commissionable: int,
                    agency_reward: int, partner_share: int,
                    discount_basis: RewardBasis,
                    discount_value: int) -> FinanceSnapshot:
    disc = discount_amount(gross_premium, discount_basis, discount_value)
    return FinanceSnapshot(
        gross_premium=gross_premium,
        commissionable=commissionable,
        agency_reward=agency_reward,
        partner_share=partner_share,
        discount=disc,
        house_profit=house_profit(agency_reward, partner_share, disc),
    )


def premium_receivable(payer: PayerType, gross_premium: int,
                       discount: int = 0) -> int:
    """How much premium the agency must collect from the buyer.

    If the agency fronts the premium it collects the premium back, LESS any
    discount granted to the customer (premium 1000, discount 100 -> collect 900).
    If the customer/partner pays the insurer directly the agency fronts nothing,
    so there is no premium receivable.
    """
    return max(0, gross_premium - discount) if payer == PayerType.AGENCY else 0


def policy_premium_due(payer: PayerType, gross_premium: int,
                       discount: int) -> int:
    """The buyer's net premium position with the agency for one policy.

      > 0  the buyer owes the agency (agency fronted the premium, less discount)
      < 0  the agency owes the buyer (buyer paid the insurer but is owed the
           discount back)
      = 0  nothing to settle
    """
    fronted = gross_premium if payer == PayerType.AGENCY else 0
    return fronted - discount


def settlement_status(receivable: int, collected: int) -> SettlementStatus:
    if receivable <= 0 or collected >= receivable:
        return SettlementStatus.SETTLED
    if collected <= 0:
        return SettlementStatus.PENDING
    return SettlementStatus.PARTIAL


def party_balance(postings: list[int]) -> int:
    """Signed running balance from ledger amounts (+receivable / -payable)."""
    return sum(postings)


# --- Async: snapshot + ledger -------------------------------------------------
async def book_policy_finance(policy, reward) -> PolicyFinance:
    """Create or refresh the frozen P&L snapshot for a policy.

    Called after a policy is approved (finance is booked only once approved) and
    whenever money terms change. Does NOT fabricate cash movements — those are
    recorded as real payments via record_payment (see the payments manager).

    A NOT-ELIGIBLE reward contributes zero to every commission/profit aggregate:
    its snapshot is booked with reward + discount zeroed (only the gross premium,
    a pass-through, is kept). This is how "not eligible" removes a policy from the
    broker's pending-to-collect and the partner's pending-to-pay everywhere.
    """
    eligible = getattr(reward, "status", None) not in REWARD_REVERSAL_STATES
    agency, partner, _disc = eligible_snapshot_amounts(
        getattr(reward, "status", None), reward.agency_amount,
        reward.partner_amount, 1)
    snap = compute_finance(
        gross_premium=policy.premium_amount,
        commissionable=reward.commissionable_premium if eligible else 0,
        agency_reward=agency,
        partner_share=partner,
        discount_basis=policy.discount_basis,
        discount_value=policy.discount_value if eligible else 0,
    )
    receivable = premium_receivable(policy.payer, policy.premium_amount,
                                    snap.discount)

    # Keep the buyer's premium receivable/payable in sync on the party ledger.
    await sync_policy_premium_due(policy, snap.discount)
    # Auto-log the "Agency paid the premium" transaction when the agency fronts it.
    await sync_agency_premium_payment(policy)

    existing = await PolicyFinance.find_one(
        PolicyFinance.policy_id == str(policy.id))
    if existing is None:
        pf = PolicyFinance(
            policy_id=str(policy.id),
            broker_id=policy.broker_id,
            partner_id=policy.partner_id,
            customer_id=policy.customer_id,
            gross_premium=snap.gross_premium,
            commissionable=snap.commissionable,
            agency_reward=snap.agency_reward,
            partner_share=snap.partner_share,
            discount=snap.discount,
            house_profit=snap.house_profit,
            payer=policy.payer,
            settlement_status=settlement_status(receivable, 0),
        )
        await pf.insert()
        return pf

    existing.broker_id = policy.broker_id
    existing.partner_id = policy.partner_id
    existing.customer_id = policy.customer_id
    existing.gross_premium = snap.gross_premium
    existing.commissionable = snap.commissionable
    existing.agency_reward = snap.agency_reward
    existing.partner_share = snap.partner_share
    existing.discount = snap.discount
    existing.house_profit = snap.house_profit
    existing.payer = policy.payer
    existing.settlement_status = settlement_status(
        receivable, existing.premium_collected)
    existing.computed_at = utcnow()
    existing.updated_at = utcnow()
    await existing.save()
    return existing


async def get_or_create_party_account(party_type: PartyType,
                                      party_id: str) -> PartyAccount:
    acct = await PartyAccount.find_one(
        PartyAccount.party_type == party_type,
        PartyAccount.party_id == party_id)
    if acct is None:
        acct = PartyAccount(party_type=party_type, party_id=party_id)
        await acct.insert()
    return acct


async def record_ledger_txn_ex(
    *, txn_type: LedgerTxnType, party_type: PartyType, party_id: str,
    amount_paise: int, policy_id: Optional[str] = None,
    note: Optional[str] = None, reference: Optional[str] = None,
    occurred_at=None, created_by: Optional[str] = None,
    reversal_of: Optional[str] = None,
    bank_account_id: Optional[str] = None,
    bank_delta_paise: int = 0,
    idempotency_key: Optional[str] = None,
) -> tuple[LedgerTxn, bool]:
    """Post one ledger movement; return (row, created).

    `occurred_at` is the real-world transaction date (defaults to now).
    `reversal_of` marks this row as the cancellation of another (see
    routers.finance._guard_reversal).
    `bank_account_id` / `bank_delta_paise` record which of the agency's own
    accounts the cash moved through and by how much (see services/bank).

    created=False means an identical posting already exists under the same
    idempotency key — a double-click or a retry. The existing row is returned
    and NO balance is moved, because it was moved when that row was written.
    Callers must skip their own side effects (TDS entries, emails, settlement
    refreshes) when created is False.
    """
    from app.services import bank as bank_svc
    from app.services import idempotency

    txn = LedgerTxn(
        txn_type=txn_type, party_type=party_type, party_id=party_id,
        amount_paise=amount_paise, policy_id=policy_id, note=note,
        reference=reference, created_by=created_by, reversal_of=reversal_of,
        bank_account_id=bank_account_id or None,
        bank_delta_paise=bank_delta_paise if bank_account_id else None,
        idempotency_key=idempotency.clean(idempotency_key),
        **({"occurred_at": occurred_at} if occurred_at else {}),
    )
    txn, created = await idempotency.insert_once(txn)
    if not created:
        return txn, False

    if bank_account_id and bank_delta_paise:
        await bank_svc.apply_delta(bank_account_id, bank_delta_paise,
                                   txn.occurred_at)

    # House expenses have no counterparty position — never touch a party balance.
    if party_type == PartyType.EXPENSE:
        return txn, True

    acct = await get_or_create_party_account(party_type, party_id)
    acct.balance_paise += amount_paise
    if amount_paise >= 0:
        acct.total_charged_paise += amount_paise
    else:
        acct.total_settled_paise += -amount_paise
    acct.last_txn_at = txn.occurred_at
    acct.updated_at = utcnow()
    await acct.save()
    return txn, True


async def record_ledger_txn(**kwargs) -> LedgerTxn:
    """Post one ledger movement and update the party's running balance.

    Thin wrapper over record_ledger_txn_ex for the callers that have no side
    effects of their own to skip.
    """
    txn, _created = await record_ledger_txn_ex(**kwargs)
    return txn


async def recompute_party_account(party_type: PartyType,
                                  party_id: str) -> Optional[PartyAccount]:
    """Rebuild a party's running balance from scratch by summing all of their
    ledger postings. Called after a ledger row is edited, cancelled or deleted
    so the derived PartyAccount can never drift from the ledger truth."""
    if party_type == PartyType.EXPENSE:
        return None                        # expenses never hold a position
    acct = await get_or_create_party_account(party_type, party_id)
    txns = await LedgerTxn.find(
        LedgerTxn.party_type == party_type,
        LedgerTxn.party_id == party_id).to_list()
    balance = charged = settled = 0
    last_at = None
    for t in txns:
        if t.txn_type in BALANCE_NEUTRAL_LEDGER_TYPES:
            continue                       # informational only — never a position
        balance += t.amount_paise
        if t.amount_paise >= 0:
            charged += t.amount_paise
        else:
            settled += -t.amount_paise
        if last_at is None or t.occurred_at > last_at:
            last_at = t.occurred_at
    acct.balance_paise = balance
    acct.total_charged_paise = charged
    acct.total_settled_paise = settled
    acct.last_txn_at = last_at
    acct.updated_at = utcnow()
    await acct.save()
    return acct


async def _adjust_party_balance(party_type: PartyType, party_id: str,
                                delta: int) -> None:
    """Move a party's running balance by delta (no separate ledger row)."""
    if delta == 0:
        return
    acct = await get_or_create_party_account(party_type, party_id)
    acct.balance_paise += delta
    if delta >= 0:
        acct.total_charged_paise += delta
    else:
        acct.total_settled_paise += -delta
    acct.last_txn_at = utcnow()
    acct.updated_at = utcnow()
    await acct.save()


async def sync_policy_premium_due(policy, discount: int) -> None:
    """Post/refresh the buyer's premium receivable for a policy as a single
    PREMIUM_DUE ledger row, so party balances reflect who owes the agency.

    Idempotent: re-runs on every (re)book, moving the balance by only the delta,
    and follows the buyer if the attributed partner changes. Buyer = the
    attributed partner if any, else the customer.
    """
    due = policy_premium_due(policy.payer, policy.premium_amount, discount)
    if policy.partner_id:
        party_type, party_id = PartyType.CHANNEL_PARTNER, policy.partner_id
    else:
        party_type, party_id = PartyType.CUSTOMER, policy.customer_id

    existing = await LedgerTxn.find_one(
        LedgerTxn.policy_id == str(policy.id),
        LedgerTxn.txn_type == LedgerTxnType.PREMIUM_DUE)

    if existing is None:
        if due == 0:
            return
        txn = LedgerTxn(
            txn_type=LedgerTxnType.PREMIUM_DUE, party_type=party_type,
            party_id=party_id, policy_id=str(policy.id), amount_paise=due,
            note="Policy premium due")
        await txn.insert()
        await _adjust_party_balance(party_type, party_id, due)
        return

    old_amount = existing.amount_paise
    same_party = (existing.party_type == party_type
                  and existing.party_id == party_id)
    if same_party:
        await _adjust_party_balance(party_type, party_id, due - old_amount)
    else:
        # Buyer changed: pull the old amount off the old party, put it on the new.
        await _adjust_party_balance(existing.party_type, existing.party_id,
                                    -old_amount)
        existing.party_type = party_type
        existing.party_id = party_id
        await _adjust_party_balance(party_type, party_id, due)
    existing.amount_paise = due
    existing.occurred_at = utcnow()
    await existing.save()


async def sync_agency_premium_payment(policy) -> None:
    """Auto-log a visible "Premium paid by Agency" transaction against the broker
    when the agency fronts the premium (owner request), so it appears in the
    transactions list without anyone recording it by hand.

    Informational / balance-neutral: the premium is a pass-through the agency
    recovers from the buyer (captured separately as PREMIUM_DUE), so this row must
    NOT move the broker's running balance — see BALANCE_NEUTRAL_LEDGER_TYPES. The
    amount is stored negative to read as an outflow in the transactions list.

    Idempotent: re-runs on every (re)book, updates the amount/broker if they
    change, and removes itself when the payer is no longer the agency (or the
    policy has no broker), so editing a policy away from agency-paid reverses it.
    """
    existing = await LedgerTxn.find_one(
        LedgerTxn.policy_id == str(policy.id),
        LedgerTxn.txn_type == LedgerTxnType.PREMIUM_PAID_BY_AGENCY)
    amount = agency_premium_ledger_amount(
        policy.payer, policy.broker_id, policy.premium_amount)
    if amount is None:
        if existing is not None:
            await existing.delete()
        return

    note = f"Premium paid by Agency for policy {policy.code}"
    ref = policy.policy_number or None
    if existing is None:
        txn = LedgerTxn(
            txn_type=LedgerTxnType.PREMIUM_PAID_BY_AGENCY,
            party_type=PartyType.BROKER, party_id=policy.broker_id,
            policy_id=str(policy.id), amount_paise=amount, note=note,
            reference=ref)
        await txn.insert()
        return
    existing.party_type = PartyType.BROKER
    existing.party_id = policy.broker_id
    existing.amount_paise = amount
    existing.note = note
    existing.reference = ref
    existing.occurred_at = utcnow()
    await existing.save()


async def remove_policy_premium_artifacts(policy) -> None:
    """Wipe a CANCELLED policy's premium bookkeeping (owner Q3: option b).

    The buyer no longer owes the premium, so the PREMIUM_DUE row is removed
    (its balance effect reversed off the party) together with the informational
    "Premium paid by Agency" row. Collections already recorded stay — if cash
    was taken for a policy that is now cancelled, the party's balance goes
    negative (we owe them a refund), which is the honest position.
    """
    due = await LedgerTxn.find_one(
        LedgerTxn.policy_id == str(policy.id),
        LedgerTxn.txn_type == LedgerTxnType.PREMIUM_DUE)
    if due is not None:
        await _adjust_party_balance(due.party_type, due.party_id,
                                    -due.amount_paise)
        await due.delete()
    info = await LedgerTxn.find_one(
        LedgerTxn.policy_id == str(policy.id),
        LedgerTxn.txn_type == LedgerTxnType.PREMIUM_PAID_BY_AGENCY)
    if info is not None:
        await info.delete()          # balance-neutral — nothing to adjust


async def sync_reward_cancellation(policy, reward) -> None:
    """Post/remove an informational REWARD_CANCELLED row on the policy's broker so
    a not-eligible reward's drop in pending-to-collect is visible in the ledger +
    statement. Balance-neutral (see BALANCE_NEUTRAL_LEDGER_TYPES). Idempotent:
    exists only while the reward is a reversal state and the policy has a broker.
    """
    existing = await LedgerTxn.find_one(
        LedgerTxn.policy_id == str(policy.id),
        LedgerTxn.txn_type == LedgerTxnType.REWARD_CANCELLED)
    amount = reward_cancellation_amount(
        getattr(reward, "status", None), policy.broker_id,
        getattr(reward, "agency_amount", 0) or 0)
    if amount == 0:
        if existing is not None:
            await existing.delete()
        return
    note = f"Reward cancelled — policy {policy.code} marked not eligible"
    ref = policy.policy_number or None
    if existing is None:
        await LedgerTxn(
            txn_type=LedgerTxnType.REWARD_CANCELLED, party_type=PartyType.BROKER,
            party_id=policy.broker_id, policy_id=str(policy.id),
            amount_paise=amount, note=note, reference=ref).insert()
        return
    existing.party_type = PartyType.BROKER
    existing.party_id = policy.broker_id
    existing.amount_paise = amount
    existing.note = note
    existing.reference = ref
    existing.occurred_at = utcnow()
    await existing.save()


# --- TDS ----------------------------------------------------------------------
async def record_reward_tds(
    *, broker_id: str, tds_percent: int, gross_reward_paise: int,
    policy_id: Optional[str] = None, ledger_txn_id: Optional[str] = None,
    reference: Optional[str] = None, note: Optional[str] = None,
    created_by: Optional[str] = None,
) -> Optional[TdsEntry]:
    """Record the TDS a broker withheld on a reward we received. Booked alongside
    the REWARD_RECEIVED ledger row so the broker's receivable still clears at the
    gross amount, while the tax withheld is tracked separately for the TDS report
    (never touches house profit). Returns None when no TDS applies."""
    tds = tds_on_reward(gross_reward_paise, tds_percent)
    if tds <= 0:
        return None
    entry = TdsEntry(
        broker_id=broker_id, policy_id=policy_id, ledger_txn_id=ledger_txn_id,
        gross_reward_paise=gross_reward_paise, tds_percent=tds_percent,
        tds_paise=tds, reference=reference, note=note, created_by=created_by,
    )
    await entry.insert()
    return entry
