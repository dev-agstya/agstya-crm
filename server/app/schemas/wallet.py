"""Wallet & withdrawal schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class WalletOut(BaseModel):
    partner_id: str
    available_paise: int
    pending_paise: int
    lifetime_earned_paise: int
    lifetime_withdrawn_paise: int


class WalletTxnOut(BaseModel):
    id: str
    type: str
    amount_paise: int
    balance_after_paise: int
    note: Optional[str] = None
    ref_type: Optional[str] = None
    ref_id: Optional[str] = None
    created_at: datetime

    @classmethod
    def from_model(cls, t) -> "WalletTxnOut":
        return cls(
            id=str(t.id),
            type=t.type.value if hasattr(t.type, "value") else t.type,
            amount_paise=t.amount_paise,
            balance_after_paise=t.balance_after_paise,
            note=t.note, ref_type=t.ref_type, ref_id=t.ref_id,
            created_at=t.created_at,
        )


class WithdrawalCreate(BaseModel):
    amount_paise: int = Field(gt=0)
    note: Optional[str] = Field(default=None, max_length=500)


class AgencyPayoutCreate(BaseModel):
    """Agency-initiated payout to a partner (recorded in one step as PAID).

    Used while the partner portal is paused: partners can't self-request a
    withdrawal, so staff log the payout they made. Draws from the partner's
    reward owed first; anything ABOVE the reward balance is booked as an
    advance the partner owes back (their net balance goes negative).
    """

    partner_id: str
    amount_paise: int = Field(gt=0)
    reference: Optional[str] = Field(default=None, max_length=120)  # UTR / cheque
    note: Optional[str] = Field(default=None, max_length=500)
    occurred_at: Optional[datetime] = None   # real-world transaction date
    # Which of our accounts the money left. Required once any account exists.
    bank_account_id: Optional[str] = None
    # Same key on a retry/double-click -> the payout is recorded once, not twice.
    idempotency_key: Optional[str] = None


class AgencyPayoutResult(BaseModel):
    """Outcome of a staff payout: how it split between reward and advance."""

    partner_id: str
    amount_paise: int
    paid_from_reward_paise: int      # debited from the wallet
    advance_paise: int               # booked as PARTNER_ADVANCE (they owe it back)
    reward_balance_paise: int        # wallet balance after the payout
    net_balance_paise: int           # reward owed − premium/advance owed (after)


class WithdrawalAction(BaseModel):
    action: Literal["approve", "reject", "pay"]
    reference: Optional[str] = None    # UTR when paying
    reason: Optional[str] = None       # required when rejecting


class WithdrawalOut(BaseModel):
    id: str
    code: str
    partner_id: str
    partner_name: Optional[str] = None
    partner_code: Optional[str] = None
    amount_paise: int
    status: str
    note: Optional[str] = None
    reference: Optional[str] = None
    reject_reason: Optional[str] = None
    processed_by: Optional[str] = None
    processed_at: Optional[datetime] = None
    requested_at: datetime

    @classmethod
    def from_model(cls, w, *, partner_name: Optional[str] = None,
                   partner_code: Optional[str] = None) -> "WithdrawalOut":
        return cls(
            id=str(w.id),
            code=w.code,
            partner_id=w.partner_id,
            partner_name=partner_name,
            partner_code=partner_code,
            amount_paise=w.amount_paise,
            status=w.status.value if hasattr(w.status, "value") else w.status,
            note=w.note,
            reference=w.reference,
            reject_reason=w.reject_reason,
            processed_by=w.processed_by,
            processed_at=w.processed_at,
            requested_at=w.requested_at,
        )
