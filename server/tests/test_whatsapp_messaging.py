"""Tests for the WhatsApp sender, customer import parsing, messaging helpers and
the dashboard growth calculation. No DB or network — the WhatsApp no-op paths
short-circuit before any HTTP call, so we exercise them with asyncio.run().
"""

import asyncio

import pytest

from app.core.enums import RecordOrigin
from app.services import whatsapp
from app.services.customer_import import (
    EXPECTED_HEADERS,
    ImportFormatError,
    parse_file,
)
from app.services.messaging import _customer_scope_allows, _rupees


# --- WhatsApp msisdn normalisation -------------------------------------------
def test_normalize_bare_10_digits_gets_country_code():
    assert whatsapp.normalize_msisdn("9812345678") == "919812345678"


def test_normalize_strips_non_digits():
    assert whatsapp.normalize_msisdn("+91 98123-45678") == "919812345678"


def test_normalize_none_and_empty():
    assert whatsapp.normalize_msisdn(None) is None
    assert whatsapp.normalize_msisdn("   ") is None


# --- WhatsApp send no-ops (no credentials / no template / no number) ----------
def test_send_template_no_credentials(monkeypatch):
    monkeypatch.setattr(whatsapp.settings, "whatsapp_phone_number_id", "")
    monkeypatch.setattr(whatsapp.settings, "whatsapp_access_token", "")
    res = asyncio.run(whatsapp.send_template("9812345678", "tpl"))
    assert res.ok is False
    assert "credentials" in res.reason.lower()


def test_send_template_missing_template(monkeypatch):
    monkeypatch.setattr(whatsapp.settings, "whatsapp_phone_number_id", "123")
    monkeypatch.setattr(whatsapp.settings, "whatsapp_access_token", "tok")
    res = asyncio.run(whatsapp.send_template("9812345678", ""))
    assert res.ok is False
    assert "template" in res.reason.lower()


def test_send_template_invalid_number(monkeypatch):
    monkeypatch.setattr(whatsapp.settings, "whatsapp_phone_number_id", "123")
    monkeypatch.setattr(whatsapp.settings, "whatsapp_access_token", "tok")
    res = asyncio.run(whatsapp.send_template("", "tpl"))
    assert res.ok is False


# --- Customer import parsing --------------------------------------------------
def _csv(rows):
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in rows:
        w.writerow(r)
    return buf.getvalue().encode("utf-8")


def test_customer_import_valid():
    # Current template columns: Full Name, Mobile, Email, Address, City, State,
    # Pincode, Notes (Contact Person + GSTIN were dropped 2026-07-17).
    rows = parse_file("c.csv", _csv([
        EXPECTED_HEADERS,
        ["Ramesh", "9812345678", "r@x.com", "MG Road",
         "Pune", "MH", "411001", "vip"],
    ]))
    assert len(rows) == 1
    assert rows[0]["mobile"] == "9812345678"
    assert rows[0]["full name"] == "Ramesh"


def test_customer_import_rejects_wrong_headers():
    with pytest.raises(ImportFormatError):
        parse_file("bad.csv", _csv([["Name", "Mobile"], ["x", "9"]]))


# --- Messaging helpers --------------------------------------------------------
def test_customer_scope_allows_all():
    assert _customer_scope_allows("all", RecordOrigin.INHOUSE) is True
    assert _customer_scope_allows("all", RecordOrigin.CHANNEL_PARTNER) is True


def test_customer_scope_inhouse_only():
    assert _customer_scope_allows("inhouse", RecordOrigin.INHOUSE) is True
    assert _customer_scope_allows("inhouse", RecordOrigin.CHANNEL_PARTNER) is False


def test_customer_scope_partner_only():
    assert _customer_scope_allows("channel_partner",
                                  RecordOrigin.CHANNEL_PARTNER) is True
    assert _customer_scope_allows("channel_partner",
                                  RecordOrigin.INHOUSE) is False


def test_rupees_formats_paise():
    assert _rupees(118000) == "Rs. 1,180.00"
    assert _rupees(0) == "Rs. 0.00"
    assert _rupees(None) == "Rs. 0.00"


# --- Dashboard growth ---------------------------------------------------------
def test_growth_pct():
    from app.routers.reports import _growth_pct
    assert _growth_pct(120, 100) == 20.0
    assert _growth_pct(80, 100) == -20.0
    assert _growth_pct(5, 0) == 100.0      # no baseline, some current -> 100%
    assert _growth_pct(0, 0) is None       # nothing either side
