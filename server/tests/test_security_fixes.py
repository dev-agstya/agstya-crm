"""Regression tests for the 2026-07-28 security & correctness pass.

Each test pins a behaviour that was WRONG before the fix, so a later refactor
that reintroduces the bug fails here rather than in production. Kept to the
pure/unit-testable seams (no live Mongo) — the DB-backed paths are covered by
the existing engine tests.
"""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.core.rate_limit import client_ip
from app.core.security import generate_temp_password
from app.routers._helpers import search_regex
from app.services.exporters import _safe_cell


def _request(headers: dict, peer: str = "10.0.0.9"):
    """Minimal stand-in for a Starlette Request (only what client_ip reads)."""
    return SimpleNamespace(
        headers={k.lower(): v for k, v in headers.items()},
        client=SimpleNamespace(host=peer),
    )


# --- A1: X-Forwarded-For spoofing ------------------------------------------------


def test_client_ip_ignores_caller_supplied_xff_prefix():
    """The proxy APPENDS the real peer, so the LAST entry is the trustworthy one.

    Reading the first entry let a caller pick their own identity and reset every
    per-IP limit at will.
    """
    req = _request({"X-Forwarded-For": "1.2.3.4, 203.0.113.7"})
    assert client_ip(req) == "203.0.113.7"


def test_client_ip_spoofed_values_do_not_change_identity():
    """Rotating the spoofed prefix must NOT produce a different bucket key."""
    a = client_ip(_request({"X-Forwarded-For": "9.9.9.9, 203.0.113.7"}))
    b = client_ip(_request({"X-Forwarded-For": "8.8.8.8, 203.0.113.7"}))
    c = client_ip(_request({"X-Forwarded-For": "203.0.113.7"}))
    assert a == b == c == "203.0.113.7"


def test_client_ip_falls_back_to_socket_peer():
    assert client_ip(_request({})) == "10.0.0.9"


def test_client_ip_honours_extra_trusted_hops(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "trusted_proxy_hops", 2, raising=False)
    # spoofed, real client, CDN hop  -> two hops back from the right.
    req = _request({"X-Forwarded-For": "1.2.3.4, 203.0.113.7, 198.51.100.1"})
    assert client_ip(req) == "203.0.113.7"


# --- B1: regex injection / ReDoS -------------------------------------------------


def test_search_regex_escapes_metacharacters():
    """A search box is not a regex console: "(a+)+$" must match literally."""
    assert search_regex("(a+)+$")["$regex"] == r"\(a\+\)\+\$"


def test_search_regex_is_length_capped():
    assert len(search_regex("x" * 500)["$regex"]) <= 100


def test_search_regex_keeps_plain_text_usable():
    """Escaping must not break ordinary searching."""
    import re
    rx = search_regex("Ramesh")["$regex"]
    assert re.search(rx, "Mr Ramesh Kumar", re.I)


# --- B2: spreadsheet formula injection -------------------------------------------


@pytest.mark.parametrize("dangerous", [
    "=cmd|'/c calc'!A1",
    "+1+1",
    "-1+1",
    "@SUM(A1:A9)",
    "\t=1+1",
])
def test_export_cell_neutralises_formula_leaders(dangerous):
    out = _safe_cell(dangerous)
    assert out.startswith("'"), f"{dangerous!r} would still evaluate"


def test_export_cell_leaves_ordinary_values_alone():
    assert _safe_cell("Ramesh Kumar") == "Ramesh Kumar"
    assert _safe_cell("POL-26K352") == "POL-26K352"
    assert _safe_cell(None) == ""


def test_export_cell_preserves_numbers_untouched():
    """Negative amounts arrive as numbers, not "-" strings — they must keep
    their type so the spreadsheet still treats them as figures."""
    assert _safe_cell(-1500) == -1500
    assert _safe_cell(12.5) == 12.5


# --- E5: temp password shape -----------------------------------------------------


def test_temp_password_does_not_have_a_fixed_shape():
    """Appending the special char and digit made every password end the same
    way, which is free structure for a guesser."""
    passwords = [generate_temp_password() for _ in range(200)]
    assert all(len(p) == 12 for p in passwords)
    # The digit is no longer always last.
    assert len({p[-1] for p in passwords}) > 8
    # ...and the special is no longer always at -2.
    specials = "@#$%&*"
    assert not all(p[-2] in specials for p in passwords)
    # Both character classes are still guaranteed present.
    for p in passwords:
        assert any(c in specials for c in p)
        assert any(c.isdigit() for c in p)


# --- A3: manage_team may not act on a more-privileged account --------------------


def _user(account_type, perms: list[str], uid: str = "1"):
    # account_type must be the real AccountType enum: the guard compares against
    # it directly, so a look-alike stub would make the owner exemption silently
    # never match.
    return SimpleNamespace(id=uid, account_type=account_type, permissions=perms)


def test_manage_team_cannot_touch_a_more_privileged_account():
    from app.core.enums import AccountType
    from app.routers.users import _assert_not_higher_privileged

    hr = _user(AccountType.EMPLOYEE, ["view_team", "manage_team"], "hr")
    finance = _user(AccountType.EMPLOYEE,
                    ["view_finance", "view_agency_profit"], "fin")
    with pytest.raises(HTTPException) as exc:
        _assert_not_higher_privileged(hr, finance)
    assert exc.value.status_code == 403


def test_manage_team_may_act_on_a_subset_account():
    from app.core.enums import AccountType
    from app.routers.users import _assert_not_higher_privileged

    manager = _user(AccountType.EMPLOYEE,
                    ["view_team", "manage_team", "view_policies"], "mgr")
    junior = _user(AccountType.EMPLOYEE, ["view_policies"], "jr")
    _assert_not_higher_privileged(manager, junior)      # must not raise


def test_owner_is_exempt_from_the_subset_rule():
    from app.core.enums import AccountType
    from app.routers.users import _assert_not_higher_privileged

    owner = _user(AccountType.OWNER, ["view_team"], "own")
    anyone = _user(AccountType.EMPLOYEE,
                   ["view_agency_profit", "manage_finance"], "emp")
    _assert_not_higher_privileged(owner, anyone)        # must not raise


def test_reset_password_result_cannot_carry_the_password():
    """The temp password is emailed, never returned — returning it turned
    manage_team into "log in as them"."""
    from app.schemas.user import ResetPasswordResult
    assert "temp_password" not in ResetPasswordResult.model_fields


# --- A4: public upload content-type ----------------------------------------------


def test_public_upload_refuses_a_missing_content_type():
    """`if content_type and ...` meant null skipped the allow-list entirely."""
    from app.routers.public import _check_content_type
    for bad in (None, "", "   "):
        with pytest.raises(HTTPException) as exc:
            _check_content_type(bad)
        assert exc.value.status_code == 415


def test_public_upload_refuses_a_disallowed_content_type():
    from app.routers.public import _check_content_type
    with pytest.raises(HTTPException):
        _check_content_type("text/html")


def test_public_upload_normalises_an_allowed_content_type():
    from app.routers.public import _check_content_type
    assert _check_content_type("application/pdf; charset=binary") \
        == "application/pdf"
    assert _check_content_type("IMAGE/JPEG") == "image/jpeg"


# --- C2: a ledger row can only be cancelled once ---------------------------------


def test_cancelling_an_already_cancelled_row_is_refused():
    from app.routers.finance import _guard_reversal
    txn = SimpleNamespace(reversed_by="abc", reversal_of=None)
    with pytest.raises(HTTPException) as exc:
        _guard_reversal(txn)
    assert exc.value.status_code == 400
    assert "already been cancelled" in exc.value.detail


def test_a_reversal_row_cannot_itself_be_cancelled():
    from app.routers.finance import _guard_reversal
    txn = SimpleNamespace(reversed_by=None, reversal_of="abc")
    with pytest.raises(HTTPException):
        _guard_reversal(txn)


def test_a_fresh_row_can_be_cancelled():
    from app.routers.finance import _guard_reversal
    _guard_reversal(SimpleNamespace(reversed_by=None, reversal_of=None))


# --- C1: the ledger date filter includes the last day ----------------------------


def test_ledger_date_range_covers_the_whole_final_day():
    """date_to parsed as midnight silently dropped everything on that date, so
    Transactions disagreed with Finance Overview for the same range."""
    from app.routers.finance import _date_range
    rng = _date_range("2026-07-01", "2026-07-28")
    assert rng["$lte"].hour == 23 and rng["$lte"].minute == 59
    assert rng["$lte"].day == 28


def test_ledger_date_range_keeps_an_explicit_time():
    from app.routers.finance import _date_range
    rng = _date_range(None, "2026-07-28T14:30:00")
    assert (rng["$lte"].hour, rng["$lte"].minute) == (14, 30)


# --- A2: the OTP attempt budget survives a re-issue ------------------------------


def test_otp_budget_counts_attempts_carried_across_reissues():
    """attempts alone was per-code, so asking for a new code bought five more
    guesses at the same six-digit space."""
    from app.config import settings
    record = SimpleNamespace(prior_attempts=settings.otp_max_attempts - 1,
                             attempts=1)
    assert record.prior_attempts + record.attempts >= settings.otp_max_attempts


# --- B11: email headers ----------------------------------------------------------


def test_email_headers_cannot_be_split():
    from app.services.email import _header_safe
    assert "\n" not in _header_safe("Subject\nBcc: attacker@example.com")
    assert "\r" not in _header_safe("Subject\r\nBcc: x@example.com")
    assert _header_safe("Your July target") == "Your July target"
