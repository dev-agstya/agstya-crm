"""Schemas for Broker (a brokerage/aggregator we place business through)."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import validate_optional_mobile

# A broker short code: 2-20 chars, capital letters / digits / -/_ .
_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-_]{1,19}$")

# TDS is a percentage; guard against fat-finger values (stored as percent*100).
_MAX_TDS = 10000   # 100.00%


def _normalize_code(v: str) -> str:
    v = (v or "").strip().upper()
    if not _CODE_RE.match(v):
        raise ValueError(
            "Broker short code must be 2-20 chars: capital letters, digits, - or _.")
    return v


class BrokerCreate(BaseModel):
    name: str
    short_code: str
    tds_percent: int = Field(default=0, ge=0, le=_MAX_TDS)  # percent*100
    account_login: Optional[str] = None
    reg_mobile: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _trim_name(cls, v: str) -> str:
        v = (v or "").strip()
        if len(v) < 2:
            raise ValueError("Broker name is required.")
        return v

    @field_validator("short_code")
    @classmethod
    def valid_code(cls, v: str) -> str:
        return _normalize_code(v)

    @field_validator("reg_mobile")
    @classmethod
    def _mobile(cls, v):
        return validate_optional_mobile(v)


class BrokerUpdate(BaseModel):
    name: Optional[str] = None
    short_code: Optional[str] = None
    tds_percent: Optional[int] = Field(default=None, ge=0, le=_MAX_TDS)
    account_login: Optional[str] = None
    reg_mobile: Optional[str] = None
    active: Optional[bool] = None
    notes: Optional[str] = None

    @field_validator("short_code")
    @classmethod
    def valid_code(cls, v: Optional[str]) -> Optional[str]:
        return _normalize_code(v) if v is not None else v

    @field_validator("reg_mobile")
    @classmethod
    def _mobile(cls, v):
        return validate_optional_mobile(v)


class BrokerOut(BaseModel):
    id: str
    code: str
    short_code: str
    name: str
    tds_percent: int = 0
    account_login: Optional[str] = None
    reg_mobile: Optional[str] = None
    active: bool = True
    notes: Optional[str] = None
    created_at: datetime
    # True when a policy, rate card, TDS entry or ledger row points at this
    # broker. Brokers are the most connected record in the app — premium
    # payable, reward receivable and TDS all hang off them — so a delete is only
    # offered when this is False (services/references).
    in_use: bool = True

    @classmethod
    def from_model(cls, b, *, in_use: bool = True) -> "BrokerOut":
        data = b.model_dump()
        data["id"] = str(b.id)
        data["in_use"] = in_use
        # Retired fields (e.g. payment_cycle, dropped 2026-07-26) may still sit
        # on older documents; the response model simply no longer carries them.
        data.pop("payment_cycle", None)
        return cls(**data)


class ShortCodeAvailability(BaseModel):
    short_code: str
    available: bool
