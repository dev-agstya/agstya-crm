"""Schemas for bank / cash accounts and transfers between them."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.core.enums import BankAccountType


class BankAccountCreate(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    account_type: BankAccountType = BankAccountType.BANK
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc: Optional[str] = None
    upi_id: Optional[str] = None
    # What the account held on `opening_as_of`. Negative is legitimate on a
    # credit card (money owed) and on an overdrawn current account.
    opening_balance_paise: int = 0
    opening_as_of: Optional[datetime] = None
    is_default: bool = False
    note: Optional[str] = None


class BankAccountUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=60)
    account_type: Optional[BankAccountType] = None
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc: Optional[str] = None
    upi_id: Optional[str] = None
    opening_balance_paise: Optional[int] = None
    opening_as_of: Optional[datetime] = None
    is_default: Optional[bool] = None
    active: Optional[bool] = None
    note: Optional[str] = None


class BankAccountOut(BaseModel):
    id: str
    name: str
    account_type: BankAccountType
    bank_name: Optional[str] = None
    # Masked by default; the full number is only ever sent to a caller holding
    # view_sensitive_pii (see the router's `unmask` flag).
    account_number: Optional[str] = None
    account_last4: Optional[str] = None
    ifsc: Optional[str] = None
    upi_id: Optional[str] = None
    opening_balance_paise: int = 0
    opening_as_of: Optional[datetime] = None
    balance_paise: int = 0
    total_in_paise: int = 0
    total_out_paise: int = 0
    last_txn_at: Optional[datetime] = None
    is_default: bool = False
    active: bool = True
    is_cash_asset: bool = True
    note: Optional[str] = None
    # Movement inside the requested window (0 when no window was asked for).
    period_in_paise: int = 0
    period_out_paise: int = 0
    # When this was last checked against the real account. None = never, which
    # is a normal state and the one most worth showing.
    last_reconciled_at: Optional[datetime] = None
    last_reconciled_diff_paise: Optional[int] = None

    @classmethod
    def from_model(cls, a, *, unmask: bool = False,
                   period_in: int = 0, period_out: int = 0) -> "BankAccountOut":
        from app.core import crypto

        number = None
        if unmask and a.account_number:
            number = crypto.decrypt(a.account_number)
        elif a.account_last4:
            number = f"XXXX{a.account_last4}"
        return cls(
            id=str(a.id), name=a.name, account_type=a.account_type,
            bank_name=a.bank_name, account_number=number,
            account_last4=a.account_last4, ifsc=a.ifsc, upi_id=a.upi_id,
            opening_balance_paise=a.opening_balance_paise,
            opening_as_of=a.opening_as_of, balance_paise=a.balance_paise,
            total_in_paise=a.total_in_paise, total_out_paise=a.total_out_paise,
            last_txn_at=a.last_txn_at, is_default=a.is_default,
            active=a.active, is_cash_asset=a.is_cash_asset, note=a.note,
            period_in_paise=period_in, period_out_paise=period_out,
            last_reconciled_at=getattr(a, "last_reconciled_at", None),
            last_reconciled_diff_paise=getattr(
                a, "last_reconciled_diff_paise", None),
        )


class BankTotals(BaseModel):
    """Headline position. Cash and credit are separate on purpose — a credit
    card balance is money owed, not money held."""

    cash_in_hand: int = 0
    credit_outstanding: int = 0     # positive = owed on cards
    accounts: int = 0


class BankAccountList(BaseModel):
    totals: BankTotals
    items: list[BankAccountOut] = []


class TransferCreate(BaseModel):
    """Move money between the agency's own accounts. Never touches profit and
    never touches a counterparty balance — it is the same money, elsewhere."""

    from_account_id: str
    to_account_id: str
    amount_paise: int = Field(gt=0)
    note: Optional[str] = None
    reference: Optional[str] = None
    occurred_at: Optional[datetime] = None
    idempotency_key: Optional[str] = None


class TransferResult(BaseModel):
    from_account_id: str
    to_account_id: str
    amount_paise: int
    from_balance_paise: int
    to_balance_paise: int


class BankReconcile(BaseModel):
    """Make the app agree with the real account, WITHOUT rewriting history.

    The obvious implementation — overwrite `balance_paise` — cannot work here,
    and both reasons are worth stating because both are silent:

      1. That field is a CACHE (`opening + Σ bank_delta_paise`). The Recompute
         button rebuilds it from the ledger, so an overwrite survives until the
         next person clicks it and then quietly reverts.
      2. The statement page rebuilds its running balance from the same rows, so
         an overwritten headline disagrees with the statement under it — two
         screens contradicting each other about money.

    Editing `opening_balance_paise` is the other tempting route and is worse: it
    changes what the account is claimed to have held on the opening date, so
    every historical statement's opening figure moves. The owner's requirement
    was explicitly that previous balances must NOT change.

    So this posts a dated ADJUSTMENT row for the difference. Prior rows are
    untouched, the correction lives in the append-only ledger where recompute
    can see it, and there is a permanent record of who decided the account was
    short and why.
    """

    # What the bank / the cash box ACTUALLY holds right now. Negative is
    # legitimate: a credit card balance is money owed, and a current account can
    # be overdrawn.
    actual_balance_paise: int
    # Mandatory, and mandatory on purpose. An adjustment with no explanation is
    # indistinguishable from a mistake six months later, and this is the one
    # bank row with no counterparty and no originating document behind it.
    reason: str = Field(min_length=3, max_length=300)
    occurred_at: Optional[datetime] = None
    idempotency_key: Optional[str] = None


class BankReconcileResult(BaseModel):
    account_id: str
    # The difference that was booked. 0 means the account already agreed and
    # NOTHING was written — an adjustment of zero is noise in the ledger.
    difference_paise: int
    adjusted: bool
    balance_paise: int
    previous_balance_paise: int
