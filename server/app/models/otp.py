"""One-time password codes for password reset / verification."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import Field

from app.core.enums import OtpPurpose
from app.models.base import utcnow


class OtpCode(Document):
    user_id: Indexed(str)
    purpose: OtpPurpose
    code_hash: str                     # hashed OTP, never stored in clear
    expires_at: datetime
    attempts: int = 0                  # wrong guesses against THIS code
    consumed: bool = False

    # Wrong guesses carried over from the codes this one replaced. Without it,
    # the 5-attempts limit is per code and asking for a fresh code resets the
    # budget — so a 6-digit space could be walked five guesses at a time. The
    # running total follows the user across re-issues (and survives the TTL that
    # purges the old rows).
    prior_attempts: int = 0

    created_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "otp_codes"
        indexes = [
            [("user_id", pymongo.ASCENDING), ("purpose", pymongo.ASCENDING)],
            # TTL index: Mongo purges expired OTPs automatically.
            pymongo.IndexModel(
                [("expires_at", pymongo.ASCENDING)],
                expireAfterSeconds=0,
                name="otp_ttl",
            ),
        ]

    @property
    def is_expired(self) -> bool:
        exp = self.expires_at
        if exp.tzinfo is None:
            from datetime import timezone
            exp = exp.replace(tzinfo=timezone.utc)
        return utcnow() >= exp
