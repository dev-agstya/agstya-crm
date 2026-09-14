"""Auth request/response schemas."""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field, field_validator

_PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
_AADHAAR_RE = re.compile(r"^[0-9]{12}$")


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    # Cloudflare Turnstile token, required only after repeated failures when
    # CAPTCHA is configured (see services.captcha).
    captcha_token: Optional[str] = None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    must_change_password: bool = False


class RefreshRequest(BaseModel):
    refresh_token: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr
    # Where to deliver the OTP: "email" (default) or "whatsapp".
    channel: str = "email"


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    otp: str
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def strong_enough(cls, v: str) -> str:
        if not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError(
                "New password must contain both letters and numbers.")
        return v


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def strong_enough(cls, v: str) -> str:
        if not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError(
                "New password must contain both letters and numbers.")
        return v


class ProfileUpdate(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=2, max_length=120)
    # No min/max_length here on purpose: the validator below strips separators
    # before counting, so "98765 43210" is a valid ten-digit number that a
    # length constraint would reject with the wrong reason ("must be at least
    # 10 characters" when the real rule is ten DIGITS).
    mobile: Optional[str] = Field(default=None)

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v):
        if v is None:
            return v
        digits = "".join(ch for ch in str(v) if ch.isdigit())
        if len(digits) != 10:
            raise ValueError("Mobile number must be exactly 10 digits.")
        return digits


class EmailChangeWithPassword(BaseModel):
    new_email: EmailStr
    password: str


class MeResponse(BaseModel):
    id: str
    code: str
    full_name: str
    email: EmailStr
    mobile: Optional[str] = None
    account_type: str
    role_id: Optional[str] = None
    role_name: Optional[str] = None
    permissions: list[str]
    status: str
    must_change_password: bool
    onboarded: bool = True
    last_login_at: Optional[datetime] = None
    relationship_manager_id: Optional[str] = None


class OnboardingBank(BaseModel):
    account_holder: Optional[str] = None
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc: Optional[str] = None
    upi_id: Optional[str] = None


class OnboardingRequest(BaseModel):
    """First-login onboarding for an employee/partner: KYC + bank + new password.
    Documents (PAN/Aadhaar images) are uploaded separately.

    PAN and Aadhaar are OPTIONAL ON THE WIRE and mandatory for EMPLOYEES only —
    the router enforces that half (owner I1, 2026-08-06). A channel partner is
    external: the agency invites them, emails them a password, and then the
    wizard refused to let them in without an Aadhaar number they were not asked
    for on the phone. Staff chase the KYC afterwards; a partner who cannot sign
    in on day one is a partner who never signs in.

    Optional here does not mean unvalidated: a value that IS given must be a
    real PAN / Aadhaar, because a malformed one is worse than a missing one —
    it looks collected.
    """

    dob: Optional[date] = None
    gender: Optional[str] = None
    address: Optional[str] = None
    pan_number: Optional[str] = None
    aadhaar_number: Optional[str] = None
    irdai_license_no: Optional[str] = None   # partners only, optional
    bank: OnboardingBank = Field(default_factory=OnboardingBank)
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("pan_number")
    @classmethod
    def valid_pan(cls, v: Optional[str]) -> Optional[str]:
        v = (v or "").strip().upper()
        if not v:
            return None
        if not _PAN_RE.match(v):
            raise ValueError("Enter a valid PAN (e.g. ABCDE1234F).")
        return v

    @field_validator("aadhaar_number")
    @classmethod
    def valid_aadhaar(cls, v: Optional[str]) -> Optional[str]:
        v = re.sub(r"\s+", "", v or "")
        if not v:
            return None
        if not _AADHAAR_RE.match(v):
            raise ValueError("Enter a valid 12-digit Aadhaar number.")
        return v

    @field_validator("new_password")
    @classmethod
    def strong_enough(cls, v: str) -> str:
        if not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError(
                "New password must contain both letters and numbers.")
        return v
