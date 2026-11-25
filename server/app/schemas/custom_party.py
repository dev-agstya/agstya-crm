"""Schemas for Custom Parties (KhataBook ledger)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class CustomPartyBase(BaseModel):
    name: str
    phone: Optional[str] = None
    category: str = "personal"  # "personal", "vendor", "loan", "landlord", "other"
    notes: Optional[str] = None


class CustomPartyCreate(CustomPartyBase):
    opening_balance_paise: int = 0  # > 0 they owe agency, < 0 agency owes party
    bank_account_id: Optional[str] = None


class CustomPartyUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class CustomPartyOut(CustomPartyBase):
    id: str
    balance_paise: int = 0
    total_charged_paise: int = 0  # total cash given (You Gave)
    total_settled_paise: int = 0  # total cash received (You Got)
    last_activity: Optional[datetime] = None
    is_archived: bool = False
    created_at: datetime


class CustomTransactionCreate(BaseModel):
    direction: str = Field(description="'gave' (money paid to party) or 'got' (money received from party)")
    amount_paise: int = Field(gt=0, description="Amount in paise (positive integer)")
    bank_account_id: Optional[str] = None
    occurred_at: Optional[datetime] = None
    note: Optional[str] = None
    reference: Optional[str] = None


class CustomTransactionOut(BaseModel):
    id: str
    party_id: str
    party_name: str
    txn_type: str
    direction: str  # "gave" or "got"
    amount_paise: int
    bank_account_id: Optional[str] = None
    bank_account_name: Optional[str] = None
    bank_delta_paise: Optional[int] = None
    running_balance_paise: int = 0
    note: Optional[str] = None
    reference: Optional[str] = None
    occurred_at: datetime
    created_at: datetime


class CustomPartyDetail(BaseModel):
    party: CustomPartyOut
    transactions: list[CustomTransactionOut]


class CustomPartiesOverview(BaseModel):
    parties: list[CustomPartyOut]
    total_you_will_get_paise: int  # sum of positive balances
    total_you_will_give_paise: int  # sum of negative balances (absolute)
    net_balance_paise: int          # net overall position
    total_parties: int
