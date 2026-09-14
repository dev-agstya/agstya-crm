"""A 422 must read like a sentence, not like a stack trace.

The bug (owner 2026-08-06): resetting a password with "ertertert" answered

    new_password: Value error, Password must contain both letters and numbers.

and a malformed email answered

    email: value is not a valid email address: The part after the @-sign is not
    valid. It should have a period.

Both are the raw pydantic error with the field path glued on the front. These
tests pin the replacement: ONE plain sentence, no field path, no "Value error,",
and nothing written for somebody debugging a mail server.
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel, EmailStr, Field, ValidationError, field_validator

from app.core.validation_errors import FALLBACK, friendly_message, message_for
from app.schemas.auth import (
    ChangePasswordRequest, OnboardingRequest, ResetPasswordRequest,
)


def _errors(model, payload) -> list[dict]:
    """The error list FastAPI would hand the 422 handler."""
    with pytest.raises(ValidationError) as exc:
        model(**payload)
    return exc.value.errors()


def _message(model, payload) -> str:
    return friendly_message(_errors(model, payload))


# --- The two the owner actually hit ---------------------------------------------


def test_weak_password_reads_as_a_sentence():
    msg = _message(ResetPasswordRequest,
                   {"email": "a@b.com", "otp": "123456",
                    "new_password": "ertertert"})
    assert msg == "New password must contain both letters and numbers."


def test_invalid_email_says_one_simple_thing():
    msg = _message(ResetPasswordRequest,
                   {"email": "work4rajan@gmail", "otp": "123456",
                    "new_password": "abcd1234"})
    assert msg == "Enter a valid email address."


def test_no_field_path_or_pydantic_punctuation_survives():
    """The shape of the old message, asserted as absent.

    Any of these appearing again means the handler went back to gluing the raw
    error onto a field path.
    """
    for payload in (
        {"email": "nope", "otp": "1", "new_password": "abcd1234"},
        {"email": "a@b.com", "otp": "1", "new_password": "ertertert"},
        {"email": "a@b.com", "otp": "1", "new_password": "ab1"},
    ):
        msg = _message(ResetPasswordRequest, payload)
        assert "new_password" not in msg
        assert "Value error" not in msg
        assert "@-sign" not in msg
        assert not msg.startswith("email:")
        # A sentence: starts capitalised, ends with a full stop.
        assert msg[0].isupper() and msg.endswith(".")


# --- The rest of the sweep (owner A4) --------------------------------------------


def test_too_short_counts_characters_and_names_the_field():
    msg = _message(ChangePasswordRequest,
                   {"current_password": "x", "new_password": "ab1"})
    assert msg == "New password must be at least 8 characters."


def test_missing_field_says_it_is_required():
    msg = _message(ResetPasswordRequest, {"email": "a@b.com"})
    # `otp` is declared before `new_password`, so it is the first error.
    assert msg == "Verification code is required."


def test_custom_validator_sentences_pass_through_untouched():
    msg = _message(OnboardingRequest,
                   {"pan_number": "NOPE", "aadhaar_number": "123456789012",
                    "new_password": "abcd1234"})
    assert msg == "Enter a valid PAN (e.g. ABCDE1234F)."


def test_aadhaar_message_is_the_validators_own():
    msg = _message(OnboardingRequest,
                   {"pan_number": "ABCDE1234F", "aadhaar_number": "12",
                    "new_password": "abcd1234"})
    assert msg == "Enter a valid 12-digit Aadhaar number."


# --- Only ONE message, whatever the form (owner A3) ------------------------------


def test_several_bad_fields_still_produce_one_sentence():
    errors = _errors(ResetPasswordRequest,
                     {"email": "nope", "otp": "123456",
                      "new_password": "ertertert"})
    assert len(errors) >= 2, "fixture must actually break two fields"
    msg = friendly_message(errors)
    assert msg.count(".") == 1
    assert "\n" not in msg


def test_empty_error_list_still_says_something_useful():
    assert friendly_message([]) == FALLBACK
    assert friendly_message(None) == FALLBACK


# --- Labels and templates --------------------------------------------------------


class _Sample(BaseModel):
    relationship_manager_id: str
    policy_number: str = Field(min_length=3)
    ifsc: str
    premium_amount: int
    email: EmailStr

    @field_validator("ifsc")
    @classmethod
    def _ifsc(cls, v: str) -> str:
        if len(v) != 11:
            raise ValueError("Enter a valid 11-character IFSC code.")
        return v


@pytest.mark.parametrize("err, expected", [
    ({"type": "missing", "loc": ("body", "relationship_manager_id"), "msg": ""},
     "Relationship manager is required."),
    ({"type": "missing", "loc": ("body", "policy_number"), "msg": ""},
     "Policy number is required."),
    ({"type": "missing", "loc": ("body", "ifsc"), "msg": ""},
     "IFSC code is required."),
    ({"type": "missing", "loc": ("body", "bank", "upi_id"), "msg": ""},
     "UPI ID is required."),
    ({"type": "int_parsing", "loc": ("body", "premium_amount"), "msg": ""},
     "Premium amount must be a whole number."),
    ({"type": "greater_than_equal", "loc": ("query", "page"), "msg": "",
      "ctx": {"ge": 1}},
     "Page must be 1 or more."),
    ({"type": "less_than_equal", "loc": ("query", "page_size"), "msg": "",
      "ctx": {"le": 100}},
     "Page size must be 100 or less."),
    ({"type": "date_parsing", "loc": ("body", "dob"), "msg": ""},
     "Date of birth is not a valid date."),
    ({"type": "enum", "loc": ("body", "status"), "msg": ""},
     "Status is not one of the allowed values."),
    ({"type": "string_too_long", "loc": ("body", "note"), "msg": "",
      "ctx": {"max_length": 500}},
     "Note must be 500 characters or fewer."),
    ({"type": "string_too_short", "loc": ("body", "note"), "msg": "",
      "ctx": {"min_length": 1}},
     "Note cannot be empty."),
    ({"type": "too_short", "loc": ("body", "assignee_ids"), "msg": "",
      "ctx": {"min_length": 1}},
     "Assignee ids cannot be empty."),
    ({"type": "bool_parsing", "loc": ("query", "inactive"), "msg": ""},
     "Inactive must be yes or no."),
])
def test_templates(err, expected):
    assert message_for(err) == expected


def test_id_suffix_is_dropped_from_the_label():
    """A user picks a "Relationship manager", not a `relationship_manager_id`."""
    msg = _message(_Sample, {"policy_number": "AB1", "ifsc": "HDFC0001234",
                             "premium_amount": 1, "email": "a@b.com"})
    assert msg == "Relationship manager is required."


def test_unknown_error_type_still_names_the_field():
    msg = message_for({"type": "something_new_in_pydantic",
                       "loc": ("body", "policy_number"),
                       "msg": "it went wrong somehow"})
    assert msg.startswith("Policy number:")
    assert msg.endswith(".")


def test_a_template_missing_its_context_does_not_explode():
    """The handler runs INSIDE an error path — it may never raise itself."""
    msg = message_for({"type": "greater_than_equal",
                       "loc": ("body", "premium_amount"), "msg": ""})
    assert msg == "Premium amount is not valid."


def test_every_template_ends_as_a_sentence():
    """A template that forgets its full stop reads as truncated on screen."""
    from app.core.validation_errors import _TEMPLATES
    for err_type, template in _TEMPLATES.items():
        assert template.endswith("."), err_type
        assert template[0].isupper() or template.startswith("{label}"), err_type
