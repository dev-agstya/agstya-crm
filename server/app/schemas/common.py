"""Shared response schemas + small validators reused across schema modules."""

from __future__ import annotations

from typing import Generic, Optional, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


def validate_optional_mobile(v: Optional[str]) -> Optional[str]:
    """Normalise an OPTIONAL Indian mobile/phone to exactly 10 digits.

    Owner rule (2026-07-26): every phone number captured anywhere in the app is
    a 10-digit Indian mobile — no country codes, no landline formats. Blank
    stays blank (the field is optional); anything else must be 10 digits once
    separators are stripped, so "98765 43210" is accepted and stored clean.
    """
    if v is None:
        return None
    digits = "".join(ch for ch in str(v) if ch.isdigit())
    if not digits:
        return None
    if len(digits) != 10:
        raise ValueError("Mobile number must be exactly 10 digits.")
    return digits


class Message(BaseModel):
    detail: str


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int

    @property
    def pages(self) -> int:
        if self.page_size <= 0:
            return 0
        return (self.total + self.page_size - 1) // self.page_size
