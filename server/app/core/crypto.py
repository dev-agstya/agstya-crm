"""Application-layer field encryption (Fernet).

Symmetric encrypt/decrypt with a versioned prefix so values are self-describing
and the key can be rotated later. DORMANT until `settings.data_encryption_key`
is set — with no key, encrypt/decrypt are identity functions, so nothing changes
until you opt in. See extras/guide.txt for key generation and how to decrypt a
raw DB dump.

Wiring into models is intentionally a separate, deliberate step (it interacts
with API serialisation of shared schemas) — this module is the ready-to-use
primitive + is what scripts/decrypt_dump.py relies on.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.config import settings

logger = logging.getLogger("agastyacrm.crypto")

PREFIX = "enc:v1:"
_fernet = None
_tried = False


def _get_fernet():
    global _fernet, _tried
    if _fernet is not None:
        return _fernet
    if _tried:
        return None
    _tried = True
    key = settings.data_encryption_key
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet
        _fernet = Fernet(key.encode() if isinstance(key, str) else key)
    except Exception:  # noqa: BLE001
        logger.exception("Invalid DATA_ENCRYPTION_KEY — encryption disabled")
        _fernet = None
    return _fernet


def is_enabled() -> bool:
    return _get_fernet() is not None


def encrypt(value: Optional[str]) -> Optional[str]:
    if value is None or value == "":
        return value
    if isinstance(value, str) and value.startswith(PREFIX):
        return value                      # already encrypted
    f = _get_fernet()
    if f is None:
        return value                      # dormant: store as-is
    return PREFIX + f.encrypt(str(value).encode()).decode()


def decrypt(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str) or not value.startswith(PREFIX):
        return value                      # plaintext / not ours
    f = _get_fernet()
    if f is None:
        return value
    try:
        return f.decrypt(value[len(PREFIX):].encode()).decode()
    except Exception:  # noqa: BLE001
        logger.exception("Failed to decrypt a value")
        return value
