"""OTP generation, storage (hashed) and verification."""

from __future__ import annotations

from datetime import timedelta

from app.config import settings
from app.core.enums import OtpPurpose
from app.core.security import (
    generate_numeric_otp,
    hash_password,
    verify_password,
)
from app.models.base import utcnow
from app.models.otp import OtpCode


async def issue_otp(user_id: str, purpose: OtpPurpose) -> str:
    """Invalidate any prior codes and create a fresh OTP. Returns the plain code."""
    # Carry the wrong-guess tally forward before retiring the old codes, so a
    # re-issue cannot be used to buy another five attempts at the same 6-digit
    # space (see OtpCode.prior_attempts).
    outstanding = await OtpCode.find(
        OtpCode.user_id == user_id,
        OtpCode.purpose == purpose,
        OtpCode.consumed == False,  # noqa: E712
    ).to_list()
    carried = max((o.prior_attempts + o.attempts for o in outstanding),
                  default=0)
    for o in outstanding:
        o.consumed = True
        await o.save()

    code = generate_numeric_otp(settings.otp_length)
    await OtpCode(
        user_id=user_id,
        purpose=purpose,
        code_hash=hash_password(code),
        prior_attempts=carried,
        expires_at=utcnow() + timedelta(minutes=settings.otp_expire_minutes),
    ).insert()
    return code


class OtpResult:
    OK = "ok"
    INVALID = "invalid"
    EXPIRED = "expired"
    TOO_MANY = "too_many_attempts"
    NOT_FOUND = "not_found"


async def verify_otp(user_id: str, purpose: OtpPurpose, code: str) -> str:
    """Verify a code, marking it consumed on success. Returns an OtpResult str."""
    record = await OtpCode.find_one(
        OtpCode.user_id == user_id,
        OtpCode.purpose == purpose,
        OtpCode.consumed == False,  # noqa: E712
        sort=[("created_at", -1)],
    )
    if record is None:
        return OtpResult.NOT_FOUND
    if record.is_expired:
        return OtpResult.EXPIRED
    # Budget spans re-issues, not just this code (see issue_otp).
    if record.prior_attempts + record.attempts >= settings.otp_max_attempts:
        record.consumed = True
        await record.save()
        return OtpResult.TOO_MANY

    if not verify_password(code, record.code_hash):
        record.attempts += 1
        await record.save()
        return OtpResult.INVALID

    record.consumed = True
    await record.save()
    return OtpResult.OK
