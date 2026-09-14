"""Field-encryption utility: dormant passthrough without a key, round-trip with
one."""

import importlib

import pytest

from app.core import crypto


def test_passthrough_without_key():
    # Default config has no key -> encrypt/decrypt are identity.
    assert crypto.encrypt("secret") == "secret"
    assert crypto.decrypt("secret") == "secret"
    assert crypto.encrypt(None) is None
    assert crypto.encrypt("") == ""
    # An already-prefixed value is returned untouched when disabled.
    assert crypto.decrypt("enc:v1:whatever") == "enc:v1:whatever"


def test_round_trip_with_key(monkeypatch):
    fernet = pytest.importorskip("cryptography.fernet")
    key = fernet.Fernet.generate_key().decode()

    from app.config import settings
    monkeypatch.setattr(settings, "data_encryption_key", key, raising=False)
    # Reset the cached fernet so it picks up the patched key.
    mod = importlib.reload(crypto)
    monkeypatch.setattr(mod, "_fernet", None, raising=False)
    monkeypatch.setattr(mod, "_tried", False, raising=False)

    token = mod.encrypt("1234567890")
    assert token.startswith("enc:v1:")
    assert token != "1234567890"
    assert mod.decrypt(token) == "1234567890"
    # Idempotent: encrypting an already-encrypted value is a no-op.
    assert mod.encrypt(token) == token
