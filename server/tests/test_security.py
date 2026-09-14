"""Unit tests for password hashing, temp passwords, and JWT."""

from app.core.security import (
    ACCESS_TOKEN,
    create_access_token,
    decode_token,
    generate_numeric_otp,
    generate_temp_password,
    hash_password,
    verify_password,
)


def test_password_hash_and_verify():
    h = hash_password("Secret123")
    assert h != "Secret123"
    assert verify_password("Secret123", h)
    assert not verify_password("Wrong123", h)


def test_temp_password_strength():
    for _ in range(20):
        pw = generate_temp_password()
        assert len(pw) >= 12
        assert any(c.isdigit() for c in pw)


def test_numeric_otp_length():
    otp = generate_numeric_otp(6)
    assert len(otp) == 6
    assert otp.isdigit()


def test_jwt_roundtrip_and_claims():
    token = create_access_token("user123", "owner", token_version=2)
    payload = decode_token(token)
    assert payload is not None
    assert payload["sub"] == "user123"
    assert payload["role"] == "owner"
    assert payload["tv"] == 2
    assert payload["type"] == ACCESS_TOKEN


def test_jwt_invalid_returns_none():
    assert decode_token("garbage.token.value") is None
