"""Bank / cash account balances: what actually moves money, and by how much.

THE ONE RULE WORTH READING
--------------------------
The ledger's sign convention is the PARTY-RECEIVABLE view (+ve = the party owes
the agency), NOT the direction of cash. "Premium collected" is stored negative
because it reduces what the customer owes, and it is money coming IN. So bank
direction can never be read off the stored sign — it is a property of the
transaction TYPE, which is what CASH_EFFECT below spells out.

Three classes of ledger row:
  - real cash        premium collected/paid, reward received, payouts, advances,
                     refunds, expenses, transfers
  - accrual only     premium due, discount, TDS deducted  -> never touch a bank
  - informational    premium paid by agency, reward cancelled -> never touch a
                     bank (the matching real movement is recorded separately)

TDS: when a broker settles a Rs 10,000 reward having withheld 2%, the bank is
credited Rs 9,800 while the ledger correctly records the gross Rs 10,000 (so the
broker's receivable clears in full) plus a separate TdsEntry. cash_delta takes
`tds_paise` for exactly this case. Get it wrong and every balance in the system
drifts by the total tax withheld — which is why test_bank.py pins it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from beanie import PydanticObjectId

from app.core.enums import LedgerTxnType
from app.models.bank import BankAccount
from app.models.base import utcnow
from app.models.finance import LedgerTxn

# +1 money in, -1 money out, 0 no cash movement at all.
# Anything absent is treated as 0 — a new ledger type must opt IN to moving cash,
# so forgetting to classify one can never silently corrupt a balance.
CASH_EFFECT: dict[LedgerTxnType, int] = {
    LedgerTxnType.PREMIUM_COLLECTED: +1,     # buyer paid us
    LedgerTxnType.REWARD_RECEIVED: +1,       # broker settled our reward (net TDS)
    LedgerTxnType.PREMIUM_TO_INSURER: -1,    # we paid the broker/insurer
    LedgerTxnType.PARTNER_PAYOUT: -1,        # reward paid to a partner
    LedgerTxnType.PARTNER_ADVANCE: -1,       # cash advanced to a partner
    LedgerTxnType.REFUND: -1,                # we paid someone back
    LedgerTxnType.EXPENSE: -1,               # salary, rent, …
    # PREMIUM_DUE / PREMIUM_PAID_BY_AGENCY / REWARD_CANCELLED / DISCOUNT /
    # TDS_DEDUCTED: accrual or informational, deliberately absent.
    # ADJUSTMENT: absent on purpose — a correction only moves cash when the
    # person recording it says so, via the explicit `manual_delta` argument.
    # TRANSFER: absent on purpose — a transfer row already stores its own true
    # cash sign, handled below.
}

# Types the payments UI may attach a bank account to without an explicit
# direction. Used to validate incoming requests.
CASH_MOVING_TYPES = frozenset(CASH_EFFECT) | {LedgerTxnType.TRANSFER,
                                              LedgerTxnType.ADJUSTMENT}


def cash_delta(txn_type: LedgerTxnType, amount_paise: int, *,
               tds_paise: int = 0,
               manual_delta: Optional[int] = None) -> int:
    """The signed amount this transaction puts into (+) or takes out of (−) a
    bank account. 0 means "this row moves no money".

    `amount_paise` is the row's STORED (party-signed) amount; only its magnitude
    is used, because direction comes from the type.
    `tds_paise`    reward receipts only: tax the broker withheld, so the bank is
                   credited net.
    `manual_delta` adjustments and transfers: the caller states the true signed
                   cash effect and it is used verbatim.
    """
    if txn_type in (LedgerTxnType.TRANSFER, LedgerTxnType.ADJUSTMENT):
        return int(manual_delta or 0)
    effect = CASH_EFFECT.get(txn_type, 0)
    if effect == 0:
        return 0
    magnitude = abs(int(amount_paise))
    if txn_type == LedgerTxnType.REWARD_RECEIVED:
        # Net of TDS, and never below zero (a TDS rate above 100% is nonsense,
        # but a corrupt rate must not turn a receipt into a withdrawal).
        magnitude = max(0, magnitude - abs(int(tds_paise or 0)))
    return effect * magnitude


def is_cash_moving(txn_type: LedgerTxnType) -> bool:
    """True when this kind of row is expected to hit a bank account."""
    return txn_type in CASH_MOVING_TYPES


# --- Account balance maintenance ------------------------------------------------


async def get_account(account_id: Optional[str]) -> Optional[BankAccount]:
    if not account_id:
        return None
    try:
        return await BankAccount.get(PydanticObjectId(account_id))
    except Exception:  # noqa: BLE001 — malformed id is simply "no account"
        return None


async def default_account() -> Optional[BankAccount]:
    return (await BankAccount.find_one(BankAccount.is_default == True,  # noqa: E712
                                       BankAccount.active == True)      # noqa: E712
            or await BankAccount.find_one(BankAccount.active == True))   # noqa: E712


async def apply_delta(account_id: str, delta: int,
                      occurred_at: Optional[datetime] = None) -> None:
    """Move an account's running balance by `delta`, atomically.

    A read-modify-write here would lose one of two concurrent postings — the
    same bug that was fixed on the partner wallet. $inc is applied by the
    database, so simultaneous receipts both land.
    """
    if not account_id:
        return
    try:
        oid = PydanticObjectId(account_id)
    except Exception:  # noqa: BLE001
        return
    inc = {"balance_paise": delta}
    if delta >= 0:
        inc["total_in_paise"] = delta
    else:
        inc["total_out_paise"] = -delta
    await BankAccount.get_motor_collection().update_one(
        {"_id": oid},
        {"$inc": inc,
         "$set": {"last_txn_at": occurred_at or utcnow(),
                  "updated_at": utcnow()}},
    )


async def post(txn: LedgerTxn, *, account_id: Optional[str], delta: int) -> None:
    """Attach a transaction to an account and move that account's balance.

    Writes the delta onto the row FIRST: if the balance update is lost to a
    crash, recompute_balance() rebuilds the truth from these rows, exactly as
    recompute_party_account() does for party balances.
    """
    if not account_id:
        return                       # no account chosen — nothing to link
    txn.bank_account_id = account_id
    txn.bank_delta_paise = delta
    await txn.save()
    await apply_delta(account_id, delta, txn.occurred_at)


async def unpost(txn: LedgerTxn) -> None:
    """Back a transaction's effect off its account (edit / cancel / delete)."""
    if not txn.bank_account_id or not txn.bank_delta_paise:
        return
    await apply_delta(txn.bank_account_id, -txn.bank_delta_paise,
                      txn.occurred_at)


async def repost(txn: LedgerTxn, *, account_id: Optional[str],
                 delta: int) -> None:
    """Move a transaction to a (possibly different) account with a new amount."""
    await unpost(txn)
    txn.bank_account_id = account_id
    txn.bank_delta_paise = delta if account_id else None
    await txn.save()
    if account_id:
        await apply_delta(account_id, delta, txn.occurred_at)


def reconcile_delta(current_balance_paise: int,
                    actual_balance_paise: int) -> int:
    """The adjustment needed to make our balance equal the real one.

    Positive = we were SHORT (the bank holds more than we thought) and the
    account must be credited; negative = we were over.

    This exists as a named function rather than a subtraction inline in the
    router because the property that matters is not the arithmetic, it is what
    the arithmetic is FOR: posting this as a ledger row means

        opening + Σ(existing deltas + this one) == actual

    so recompute_balance() below — the repair path, and a button on the account
    page — reproduces the reconciled figure instead of undoing it. Overwriting
    `balance_paise` directly does not have that property: the next recompute
    silently restores the wrong number. test_bank.py pins the round trip.
    """
    return int(actual_balance_paise) - int(current_balance_paise)


async def recompute_balance(account: BankAccount) -> BankAccount:
    """Rebuild an account's balance from its transactions.

    The ledger is the append-only truth; the stored balance is a cache. This is
    the repair path for a crash between the two writes in post().
    """
    balance = account.opening_balance_paise
    total_in = total_out = 0
    last_at: Optional[datetime] = None
    async for t in LedgerTxn.find(
            LedgerTxn.bank_account_id == str(account.id)):
        delta = int(t.bank_delta_paise or 0)
        balance += delta
        if delta >= 0:
            total_in += delta
        else:
            total_out += -delta
        if last_at is None or (t.occurred_at and t.occurred_at > last_at):
            last_at = t.occurred_at
    account.balance_paise = balance
    account.total_in_paise = total_in
    account.total_out_paise = total_out
    account.last_txn_at = last_at
    account.updated_at = utcnow()
    await account.save()
    return account


async def find_broken_transfers() -> list[dict]:
    """Transfers whose two legs do not agree — the detection half of the
    non-transactional write problem.

    A transfer is two rows sharing a `transfer_group_id`, one negative and one
    positive, summing to zero. A crash between the inserts leaves one row, which
    means money left an account and arrived nowhere; nothing in the app surfaces
    that, because a single TRANSFER row is a perfectly valid document.

    Returns one dict per suspect group (never raises, never repairs — a repair
    that guesses is worse than a report a human reads). Cheap enough to run from
    a script or a health check; it touches only TRANSFER rows.
    """
    groups: dict[str, list[LedgerTxn]] = {}
    async for t in LedgerTxn.find(
            LedgerTxn.txn_type == LedgerTxnType.TRANSFER):
        if t.transfer_group_id:
            groups.setdefault(t.transfer_group_id, []).append(t)

    broken: list[dict] = []
    for group_id, rows in groups.items():
        deltas = [int(r.bank_delta_paise or 0) for r in rows]
        if len(rows) == 2 and sum(deltas) == 0:
            continue                      # healthy: paired and balanced
        broken.append({
            "transfer_group_id": group_id,
            "legs": len(rows),
            "net_paise": sum(deltas),
            "reason": ("only one leg was written" if len(rows) == 1
                       else "legs do not sum to zero" if len(rows) == 2
                       else f"{len(rows)} legs"),
            "txn_ids": [str(r.id) for r in rows],
            "account_ids": [r.bank_account_id for r in rows],
            "occurred_at": min((r.occurred_at for r in rows if r.occurred_at),
                               default=None),
        })
    broken.sort(key=lambda b: b["occurred_at"] or utcnow(), reverse=True)
    return broken


async def totals() -> dict:
    """Headline position across every active account.

    Cash and credit are summed SEPARATELY: a credit card balance is money owed,
    and adding it into "cash in hand" would report a smaller balance than the
    agency actually holds.
    """
    cash = credit = 0
    accounts = await BankAccount.find(BankAccount.active == True).to_list()  # noqa: E712
    for a in accounts:
        if a.is_cash_asset:
            cash += a.balance_paise
        else:
            credit += a.balance_paise
    return {"cash_in_hand": cash, "credit_outstanding": -credit,
            "accounts": len(accounts)}
