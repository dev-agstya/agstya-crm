"""Validation + coercion for policy-type custom fields.

A policy type (PolicyCategory) can define `custom_fields` — admin-configured
inputs collected when booking a policy of that type and stored in the policy's
`details` dict. This module validates a submitted `details` payload against a
type's field specs and returns a cleaned dict (right JSON types, amounts kept in
paise). Kept DB-free so it can be unit-tested and reused by the policy router.
"""

from __future__ import annotations

import re
from typing import Any

from app.models.master import (
    COMMISSIONABLE_BASE,
    CustomFieldSpec,
    PolicyCategory,
)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^\d{10}$")


class FieldValidationError(ValueError):
    """A submitted custom-field value failed validation."""


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "") \
        or (isinstance(value, list) and len(value) == 0)


def _coerce_number(spec: CustomFieldSpec, value: Any) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        raise FieldValidationError(f"'{spec.label}' must be a number.")
    return num


def _check_bounds(spec: CustomFieldSpec, natural: float) -> None:
    """Bounds are compared in the field's natural unit (rupees for `amount`)."""
    if spec.min_value is not None and natural < spec.min_value:
        raise FieldValidationError(
            f"'{spec.label}' must be at least {spec.min_value:g}.")
    if spec.max_value is not None and natural > spec.max_value:
        raise FieldValidationError(
            f"'{spec.label}' must be at most {spec.max_value:g}.")


def _validate_one(spec: CustomFieldSpec, value: Any) -> Any:
    """Validate + coerce a single field's value. Assumes value is not blank."""
    t = spec.type
    if t == "amount":
        # Stored in paise (integer). Bounds are checked in rupees.
        paise = int(round(_coerce_number(spec, value)))
        if paise < 0:
            raise FieldValidationError(f"'{spec.label}' cannot be negative.")
        _check_bounds(spec, paise / 100)
        return paise
    if t == "number":
        num = _coerce_number(spec, value)
        _check_bounds(spec, num)
        # Keep whole numbers as ints for tidy storage.
        return int(num) if num.is_integer() else num
    if t == "checkbox":
        return bool(value)
    if t == "select":
        if spec.options and str(value) not in spec.options:
            raise FieldValidationError(
                f"'{spec.label}' must be one of: {', '.join(spec.options)}.")
        return str(value)
    if t == "multi_select":
        if not isinstance(value, list):
            raise FieldValidationError(f"'{spec.label}' must be a list.")
        vals = [str(v) for v in value]
        if spec.options:
            bad = [v for v in vals if v not in spec.options]
            if bad:
                raise FieldValidationError(
                    f"'{spec.label}' has invalid option(s): {', '.join(bad)}.")
        return vals
    if t == "phone":
        digits = re.sub(r"\D", "", str(value))
        if not _PHONE_RE.match(digits):
            raise FieldValidationError(
                f"'{spec.label}' must be a 10-digit mobile number.")
        return digits
    if t == "email":
        s = str(value).strip()
        if not _EMAIL_RE.match(s):
            raise FieldValidationError(f"'{spec.label}' must be a valid email.")
        return s
    # text / textarea / date / url — stored as a trimmed string.
    return str(value).strip()


def validate_details(specs: list[CustomFieldSpec],
                     details: dict[str, Any] | None) -> dict[str, Any]:
    """Validate a submitted `details` dict against a type's field specs.

    Returns a cleaned dict keyed by field key. Values for fields not defined on
    the type are dropped (only configured fields are persisted). Raises
    FieldValidationError with a user-facing message on the first problem.
    """
    details = details or {}
    cleaned: dict[str, Any] = {}
    for spec in specs:
        raw = details.get(spec.key)
        if _is_blank(raw):
            if spec.required:
                raise FieldValidationError(f"'{spec.label}' is required.")
            continue
        cleaned[spec.key] = _validate_one(spec, raw)
    return cleaned


def resolve_reward_base_field(specs: list[CustomFieldSpec],
                              requested: str | None) -> str:
    """Return a valid reward-base key: COMMISSIONABLE_BASE, or an amount field key
    flagged as reward-base-eligible. Falls back to commissionable on any mismatch.
    """
    if not requested or requested == COMMISSIONABLE_BASE:
        return COMMISSIONABLE_BASE
    eligible = {s.key for s in specs
                if s.type == "amount" and s.is_reward_base}
    return requested if requested in eligible else COMMISSIONABLE_BASE


def _as_specs(specs: list) -> list[CustomFieldSpec]:
    """Coerce a mix of CustomFieldSpec / plain dicts into CustomFieldSpec objects
    (an updated category assigns plain dicts before the document is saved)."""
    return [s if isinstance(s, CustomFieldSpec) else CustomFieldSpec(**s)
            for s in (specs or [])]


def validate_custom_field_specs(specs: list,
                                reward_base_field: str) -> None:
    """Validate a policy type's own field configuration (admin-side).

    Ensures unique keys and that the chosen default reward base refers to an
    amount field flagged eligible (or commissionable). Raises ValueError.
    """
    specs = _as_specs(specs)
    seen: set[str] = set()
    for s in specs:
        if not s.key:
            raise ValueError("Every custom field needs a name.")
        if s.key in seen:
            raise ValueError(f"Duplicate custom field key '{s.key}'.")
        seen.add(s.key)
        if s.type in ("select", "multi_select") and not s.options:
            raise ValueError(
                f"Field '{s.label}' is a choice field but has no options.")
    if reward_base_field and reward_base_field != COMMISSIONABLE_BASE:
        eligible = {s.key for s in specs
                    if s.type == "amount" and s.is_reward_base}
        if reward_base_field not in eligible:
            raise ValueError(
                "The default reward base must be the commissionable premium or "
                "an amount field marked as usable for commission.")


async def get_category_specs(category_key: str) -> list[CustomFieldSpec]:
    """Load a policy type's custom-field specs (empty list if unknown)."""
    cat = await PolicyCategory.find_one(PolicyCategory.key == category_key)
    return list(cat.custom_fields) if cat else []
