"""Turning pydantic's validation errors into sentences a person can read.

FastAPI hands the app a list of machine-shaped errors:

    {"type": "string_too_short", "loc": ("body", "new_password"),
     "msg": "String should have at least 8 characters",
     "ctx": {"min_length": 8}}

and the 422 handler used to print ``"<loc>: <msg>"``, which is how somebody
resetting their password was told:

    new_password: Value error, Password must contain both letters and numbers.

Four rules (owner 2026-08-06, questions A1-A4):

  1. ONE SENTENCE. The first error becomes a complete, self-contained sentence —
     "New password must contain both letters and numbers." — never a
     "field: raw message" pair.
  2. ONE ERROR AT A TIME (A3). Several bad fields still surface a single
     message; the user fixes it, resubmits, and is told the next one. A wall of
     errors is not more helpful than the one at the top of it.
  3. GLOBALLY (A1). This runs inside the single RequestValidationError handler
     in main.py, so every form in the app benefits and no router has to
     remember.
  4. A CUSTOM MESSAGE WINS. A validator that already wrote a human sentence
     ("Enter a valid PAN (e.g. ABCDE1234F).") is passed through untouched. That
     is why the validators in `schemas/` are written as sentences that name
     their own field — they ARE the message, not an ingredient of one.

If you add a field whose machine name reads badly ("dob", "ifsc"), give it a
label in `_LABELS`. Everything else is humanised mechanically, which is fine for
`policy_number` and wrong for an acronym.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

# Path segments FastAPI adds to say WHERE the value came from. They are noise in
# a sentence aimed at somebody filling in a form.
_LOCATIONS = frozenset({"body", "query", "path", "header", "cookie"})

# Fields whose machine name does not humanise into anything readable. Acronyms,
# abbreviations, and the handful of names where the form's own label differs
# from the API field.
_LABELS: dict[str, str] = {
    "otp": "Verification code",
    "new_password": "New password",
    "current_password": "Current password",
    "password": "Password",
    "email": "Email",
    "new_email": "Email",
    "mobile": "Mobile number",
    "phone": "Mobile number",
    "dob": "Date of birth",
    "pan": "PAN",
    "pan_number": "PAN",
    "aadhaar_number": "Aadhaar number",
    "aadhaar_last4": "Aadhaar number",
    "gstin": "GSTIN",
    "gst_number": "GST number",
    "ifsc": "IFSC code",
    "upi_id": "UPI ID",
    "irdai_license_no": "IRDAI licence number",
    "tds_percent": "TDS rate",
    "url": "Link",
    "q": "Search",
}

# type -> sentence template. `{label}` is the humanised field name; anything
# else in braces comes from the error's `ctx`.
_TEMPLATES: dict[str, str] = {
    "missing": "{label} is required.",
    "string_type": "{label} must be text.",
    "string_pattern_mismatch": "{label} is not in the expected format.",
    "int_parsing": "{label} must be a whole number.",
    "int_type": "{label} must be a whole number.",
    "int_from_float": "{label} must be a whole number.",
    "float_parsing": "{label} must be a number.",
    "float_type": "{label} must be a number.",
    "decimal_parsing": "{label} must be a number.",
    "bool_parsing": "{label} must be yes or no.",
    "bool_type": "{label} must be yes or no.",
    "greater_than": "{label} must be more than {gt}.",
    "greater_than_equal": "{label} must be {ge} or more.",
    "less_than": "{label} must be less than {lt}.",
    "less_than_equal": "{label} must be {le} or less.",
    "multiple_of": "{label} must be a multiple of {multiple_of}.",
    "date_parsing": "{label} is not a valid date.",
    "date_type": "{label} is not a valid date.",
    "date_from_datetime_parsing": "{label} is not a valid date.",
    "datetime_parsing": "{label} is not a valid date.",
    "datetime_type": "{label} is not a valid date.",
    "datetime_from_date_parsing": "{label} is not a valid date.",
    "time_delta_parsing": "{label} is not a valid duration.",
    "enum": "{label} is not one of the allowed values.",
    "literal_error": "{label} is not one of the allowed values.",
    "list_type": "{label} must be a list.",
    "dict_type": "{label} is not in the expected format.",
    "model_type": "{label} is not in the expected format.",
    "model_attributes_type": "{label} is not in the expected format.",
    "extra_forbidden": "{label} is not a field we recognise.",
    "url_parsing": "{label} must be a valid link.",
    "url_type": "{label} must be a valid link.",
    "uuid_parsing": "{label} is not a valid id.",
    "json_invalid": "The information sent could not be read. Please try again.",
    "json_type": "The information sent could not be read. Please try again.",
}

# Prefixes pydantic puts in front of the message raised by a `@field_validator`.
_RAISED_PREFIXES = ("Value error, ", "Assertion failed, ")

# What email-validator says when an address is malformed. Its explanations are
# written for a developer debugging a mail server ("The part after the @-sign is
# not valid. It should have a period.") and are replaced wholesale.
_EMAIL_MARKERS = ("valid email address", "email address is not valid")

FALLBACK = "Please check the details you entered and try again."


def _label_for(loc: Sequence[Any]) -> str:
    """The field name as a person would say it.

    Takes the LAST named segment, so a nested field reads as itself:
    ``("body", "bank", "ifsc")`` is "IFSC code", not "Bank". A trailing ``_id``
    is dropped — `relationship_manager_id` is a picker labelled "Relationship
    manager" on screen, and the user never sees the id.
    """
    parts = [p for p in loc if isinstance(p, str) and p not in _LOCATIONS]
    if not parts:
        return "This request"
    key = parts[-1]
    if key in _LABELS:
        return _LABELS[key]
    if key.endswith("_id") and len(key) > 3:
        key = key[:-3]
    words = key.replace("_", " ").strip()
    if not words:
        return "This request"
    return words[0].upper() + words[1:]


def _as_sentence(text: str) -> str:
    """Capitalised, full-stopped, and stripped of pydantic's raised-by prefix."""
    text = (text or "").strip()
    for prefix in _RAISED_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
            break
    if not text:
        return FALLBACK
    text = text[0].upper() + text[1:]
    if text[-1] not in ".!?":
        text += "."
    return text


def _length_message(err_type: str, label: str, ctx: Mapping[str, Any]) -> str:
    """Length limits, phrased for the thing being limited.

    A string is measured in characters and a list in entries, and pydantic
    reports both under `min_length` / `max_length` — so the type is what decides
    the noun, not the context.
    """
    if err_type == "string_too_short":
        n = ctx.get("min_length", 1)
        if n == 1:
            return f"{label} cannot be empty."
        return f"{label} must be at least {n} characters."
    if err_type == "string_too_long":
        return f"{label} must be {ctx.get('max_length')} characters or fewer."
    if err_type == "too_short":
        n = ctx.get("min_length", 1)
        if n == 1:
            return f"{label} cannot be empty."
        return f"{label} must have at least {n} entries."
    n = ctx.get("max_length")
    return f"{label} cannot have more than {n} " + ("entry." if n == 1
                                                    else "entries.")


def message_for(err: Mapping[str, Any]) -> str:
    """One pydantic error, as a sentence."""
    err_type = str(err.get("type") or "")
    raw = str(err.get("msg") or "")
    ctx = err.get("ctx") or {}
    label = _label_for(err.get("loc") or ())

    # An address the mail library rejected. Its own explanation is written for
    # somebody debugging DNS, so it never reaches the user (owner A2).
    if any(marker in raw.lower() for marker in _EMAIL_MARKERS):
        return "Enter a valid email address."

    # A message a validator in this codebase wrote on purpose. It already names
    # its own field and reads as a sentence, so it is used verbatim — adding
    # "Email: " in front of "Enter a valid PAN." would only make it worse.
    if err_type in ("value_error", "assertion_error"):
        return _as_sentence(raw)

    if err_type in ("string_too_short", "string_too_long",
                    "too_short", "too_long"):
        return _length_message(err_type, label, ctx)

    template = _TEMPLATES.get(err_type)
    if template is None:
        # An error type nobody has met yet. The raw message is at least true,
        # and naming the field keeps it actionable.
        return _as_sentence(f"{label}: {raw}" if raw else f"{label} is not valid")
    try:
        return template.format(label=label, **ctx)
    except (KeyError, IndexError, ValueError):
        # A context key the template expected is missing — say the safe thing
        # rather than 500-ing inside the error handler.
        return f"{label} is not valid."


def friendly_message(errors: Iterable[Mapping[str, Any]]) -> str:
    """The single sentence a 422 carries (see the module docstring, rule 2)."""
    for err in errors or ():
        return message_for(err)
    return FALLBACK
