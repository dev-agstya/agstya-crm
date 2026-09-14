"""Unit tests for policy-type custom fields + the per-policy reward base.

Covers the "Comm On" behaviour from the sample ledger: an amount field (e.g. OD)
can be flagged as the commission base and, when chosen on a policy, drives the
reward maths instead of the commissionable premium.
"""

from types import SimpleNamespace

import pytest

from app.models.master import COMMISSIONABLE_BASE, CustomFieldSpec, PolicyCategory
from app.services.custom_fields import (
    FieldValidationError,
    resolve_reward_base_field,
    validate_custom_field_specs,
    validate_details,
)
from app.services.policy_ops import effective_commissionable


def _specs():
    return [
        CustomFieldSpec(key="vehicle_no", label="Vehicle No", type="text",
                        required=True),
        CustomFieldSpec(key="od_amount", label="OD Amount", type="amount",
                        is_reward_base=True),
        CustomFieldSpec(key="tp_amount", label="TP Amount", type="amount",
                        is_reward_base=True),
        CustomFieldSpec(key="idv", label="IDV", type="number",
                        min_value=1000, max_value=10_000_000),
        CustomFieldSpec(key="cover", label="Cover", type="select",
                        options=["Package", "Third Party"], required=True),
    ]


# --- validate_details --------------------------------------------------------

def test_valid_details_pass_through_and_coerce():
    cleaned = validate_details(_specs(), {
        "vehicle_no": "  RJ01AB1234 ",
        "od_amount": 689700,          # paise
        "cover": "Package",
        "idv": 50000,
    })
    assert cleaned["vehicle_no"] == "RJ01AB1234"     # trimmed
    assert cleaned["od_amount"] == 689700
    assert cleaned["cover"] == "Package"
    assert cleaned["idv"] == 50000                    # kept as int
    assert "tp_amount" not in cleaned                 # blank optional dropped


def test_required_field_missing_raises():
    with pytest.raises(FieldValidationError, match="Vehicle No"):
        validate_details(_specs(), {"cover": "Package"})


def test_select_must_be_a_known_option():
    with pytest.raises(FieldValidationError, match="Cover"):
        validate_details(_specs(), {"vehicle_no": "X", "cover": "Nonsense"})


def test_number_bounds_enforced():
    with pytest.raises(FieldValidationError, match="at least"):
        validate_details(_specs(), {
            "vehicle_no": "X", "cover": "Package", "idv": 10})


def test_unknown_keys_are_dropped():
    cleaned = validate_details(_specs(), {
        "vehicle_no": "X", "cover": "Package", "hacker": "drop me"})
    assert "hacker" not in cleaned


def test_phone_and_email_validation():
    specs = [
        CustomFieldSpec(key="m", label="Mobile", type="phone"),
        CustomFieldSpec(key="e", label="Email", type="email"),
    ]
    assert validate_details(specs, {"m": "98-765 43210", "e": "a@b.co"}) == {
        "m": "9876543210", "e": "a@b.co"}
    with pytest.raises(FieldValidationError):
        validate_details(specs, {"m": "123"})
    with pytest.raises(FieldValidationError):
        validate_details(specs, {"e": "not-an-email"})


# --- resolve_reward_base_field ----------------------------------------------

def test_resolve_reward_base_accepts_eligible_amount_field():
    assert resolve_reward_base_field(_specs(), "od_amount") == "od_amount"


def test_resolve_reward_base_rejects_non_eligible_or_unknown():
    specs = _specs()
    # A text field is never eligible.
    assert resolve_reward_base_field(specs, "vehicle_no") == COMMISSIONABLE_BASE
    assert resolve_reward_base_field(specs, "ghost") == COMMISSIONABLE_BASE
    assert resolve_reward_base_field(specs, None) == COMMISSIONABLE_BASE


# --- validate_custom_field_specs (admin-side) -------------------------------

def test_duplicate_keys_rejected():
    dup = [CustomFieldSpec(key="a", label="A"), CustomFieldSpec(key="a", label="A2")]
    with pytest.raises(ValueError, match="Duplicate"):
        validate_custom_field_specs(dup, COMMISSIONABLE_BASE)


def test_choice_field_needs_options():
    specs = [CustomFieldSpec(key="c", label="C", type="select", options=[])]
    with pytest.raises(ValueError, match="options"):
        validate_custom_field_specs(specs, COMMISSIONABLE_BASE)


def test_default_base_must_reference_eligible_field():
    with pytest.raises(ValueError, match="reward base"):
        validate_custom_field_specs(_specs(), "vehicle_no")
    # A valid eligible field passes.
    validate_custom_field_specs(_specs(), "od_amount")


# --- effective_commissionable (reward base wiring) --------------------------

def _policy(**kw):
    base = dict(
        premium_amount=1_000_000, commissionable_premium=847457,
        gst_percent=1800, reward_base_field="commissionable", details={},
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_base_is_commissionable_by_default():
    pol = _policy()
    assert effective_commissionable(pol) == 847457


def test_base_switches_to_amount_field_when_selected():
    pol = _policy(reward_base_field="od_amount", details={"od_amount": 350000})
    assert effective_commissionable(pol) == 350000


def test_base_falls_back_when_amount_field_blank():
    # Selected OD but no value entered -> fall back to commissionable premium.
    pol = _policy(reward_base_field="od_amount", details={})
    assert effective_commissionable(pol) == 847457


def test_category_coerces_legacy_string_fields():
    # Old shape (list[str]) is coerced into text specs by the model validator.
    coerced = PolicyCategory._coerce_legacy_fields(["Vehicle No", "Chassis"])
    specs = [CustomFieldSpec(**c) for c in coerced]
    assert specs[0].label == "Vehicle No"
    assert specs[0].key == "Vehicle No"
    assert specs[0].type == "text"
