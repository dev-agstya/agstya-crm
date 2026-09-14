"""Password hashing and JWT creation/verification."""

from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# --- Passwords -----------------------------------------------------------------


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError:
        return False


def generate_temp_password(length: int = 12) -> str:
    """Human-typeable temporary password (avoids ambiguous chars).

    The special character and digit are guaranteed present but SHUFFLED into the
    result. Appending them left every generated password with the same shape —
    "...<special><digit>" — which is free structure for anyone guessing.
    """
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    specials = "@#$%&*"
    chars = [secrets.choice(alphabet) for _ in range(length - 2)]
    chars.append(secrets.choice(specials))
    chars.append(secrets.choice("23456789"))
    # secrets.SystemRandom for the shuffle too — random.shuffle would undo the
    # point of using a CSPRNG to pick the characters.
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def generate_numeric_otp(length: int) -> str:
    return "".join(secrets.choice(string.digits) for _ in range(length))


# --- JWT -----------------------------------------------------------------------

ACCESS_TOKEN = "access"
REFRESH_TOKEN = "refresh"


def _create_token(subject: str, token_type: str, expires: timedelta,
                  extra: dict[str, Any] | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "type": token_type,
        "iat": now,
        "exp": now + expires,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: str, role: str,
                        token_version: int = 0) -> str:
    return _create_token(
        user_id,
        ACCESS_TOKEN,
        timedelta(hours=settings.jwt_expire_hours),
        {"role": role, "tv": token_version},
    )


def create_refresh_token(user_id: str, token_version: int = 0) -> str:
    return _create_token(
        user_id,
        REFRESH_TOKEN,
        timedelta(days=settings.refresh_expire_days),
        {"tv": token_version},
    )


def decode_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
    except JWTError:
        return None
