"""Realised (cash-basis) net profit for the agency.

The house only counts money that actually MOVED. The owner's rule (2026-07,
test-case 1.2): the moment the agency FRONTS a premium, net profit drops by
that amount, and it recovers as the buyer pays the premium back. So inside a
window:

    net_profit = premium collected from buyers
               + reward received from brokers
               − premium fronted by the agency
               − reward paid out to channel partners (incl. advances)
               − refunds paid to customers/partners   (house-borne discounts)
               − house expenses (salary, rent, …)

Over a policy's full life the premium legs cancel (fronted == collected) and
what remains is reward − payouts − refunds − expenses, i.e. true cash profit.
TDS withheld by brokers is excluded (a reclaimable advance tax). The
"unrealised" figure is reward still pending to collect (eligible but not yet
received) — shown as a muted helper so nothing feels missing.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from app.core.enums import LedgerTxnType, PartyType, WalletTxnType
from app.models.finance import LedgerTxn, PolicyFinance
from app.models.policy import Policy
from app.models.wallet import WalletTxn


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _in(dt: datetime, lo: Optional[datetime], hi: Optional[datetime]) -> bool:
    dt = _aware(dt)
    if lo and dt < lo:
        return False
    if hi and dt > hi:
        return False
    return True


def net_from_components(premium_collected: int, reward_received: int,
                        premium_fronted: int, partner_payouts: int,
                        refunds: int, expenses: int) -> int:
    """Realised profit = cash in (premium collected + reward received) minus
    cash out (premium fronted + payouts/advances + refunds + expenses).

    Pure so the money definition can be unit-tested independently of the DB."""
    return (premium_collected + reward_received
            - premium_fronted - partner_payouts - refunds - expenses)


async def realized_profit(lo: Optional[datetime],
                          hi: Optional[datetime]) -> dict:
    """Cash-basis profit components + net inside [lo, hi] (either bound optional)."""
    premium_collected = reward_received = premium_fronted = 0
    refunds = advances = 0
    async for t in LedgerTxn.find():
        if not _in(t.occurred_at, lo, hi):
            continue
        if t.txn_type == LedgerTxnType.REWARD_RECEIVED:
            reward_received += -t.amount_paise               # stored negative
        elif t.txn_type == LedgerTxnType.PREMIUM_COLLECTED:
            premium_collected += -t.amount_paise             # stored negative
        elif t.txn_type == LedgerTxnType.PREMIUM_PAID_BY_AGENCY:
            premium_fronted += -t.amount_paise               # stored negative
        elif t.txn_type == LedgerTxnType.PARTNER_ADVANCE:
            advances += t.amount_paise                       # stored positive
        elif t.txn_type == LedgerTxnType.REFUND:
            refunds += t.amount_paise                        # stored positive

    partner_payouts = advances
    async for w in WalletTxn.find(
            WalletTxn.type == WalletTxnType.WITHDRAWAL_DEBIT):
        if w.amount_paise < 0 and _in(w.created_at, lo, hi):
            partner_payouts += -w.amount_paise

    expenses = await expenses_total(lo, hi)

    net = net_from_components(premium_collected, reward_received,
                              premium_fronted, partner_payouts,
                              refunds, expenses)
    return {
        "premium_collected": premium_collected,
        "premium_fronted": premium_fronted,
        "reward_received": reward_received,
        "partner_payouts": partner_payouts,
        "refunds": refunds,
        "expenses": expenses,
        "net_profit": net,
    }


async def net_profit(lo: Optional[datetime], hi: Optional[datetime]) -> int:
    return (await realized_profit(lo, hi))["net_profit"]


async def expenses_total(lo: Optional[datetime],
                         hi: Optional[datetime]) -> int:
    """Sum of house expenses (positive rupees-in-paise) inside the window."""
    total = 0
    async for t in LedgerTxn.find(
            LedgerTxn.txn_type == LedgerTxnType.EXPENSE):
        if _in(t.occurred_at, lo, hi):
            total += -t.amount_paise    # stored negative; reversals net out
    return total


async def unrealised_reward() -> int:
    """Reward still to collect from brokers = Σ eligible agency reward −
    Σ reward received, floored at 0 per broker (point in time, not windowed).

    Eligible-only falls out automatically: a not-eligible policy's PolicyFinance
    snapshot carries agency_reward == 0.
    """
    expected: dict[str, int] = {}
    policies = {str(p.id): p async for p in Policy.find_all()}
    async for pf in PolicyFinance.find_all():
        pol = policies.get(pf.policy_id)
        if pol is None or not pol.broker_id:
            continue
        expected[pol.broker_id] = expected.get(pol.broker_id, 0) + pf.agency_reward
    received: dict[str, int] = {}
    async for t in LedgerTxn.find(
            LedgerTxn.party_type == PartyType.BROKER,
            LedgerTxn.txn_type == LedgerTxnType.REWARD_RECEIVED):
        received[t.party_id] = received.get(t.party_id, 0) + (-t.amount_paise)
    return sum(max(0, exp - received.get(bid, 0))
               for bid, exp in expected.items())


# Backwards-compatible alias (old name).
unrealised_commission = unrealised_reward
