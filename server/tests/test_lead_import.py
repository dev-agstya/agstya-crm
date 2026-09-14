"""Unit tests for lead-import file parsing and header validation."""

import pytest

from app.core.enums import LeadType
from app.services.lead_import import (
    EXPECTED_HEADERS,
    ImportFormatError,
    build_template_csv,
    label_for_type,
    parse_file,
    parse_lead_type,
)


def _csv_bytes(rows: list[list[str]]) -> bytes:
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in rows:
        w.writerow(r)
    return buf.getvalue().encode("utf-8")


def test_template_has_expected_headers():
    text = build_template_csv()
    first_line = text.splitlines()[0]
    for h in EXPECTED_HEADERS:
        assert h in first_line


def test_parse_valid_csv():
    # Current template columns: Full Name, Type, Mobile, Email, Interested In,
    # Note. (Type came back 2026-08-03; Address and Source stay dropped.)
    data = _csv_bytes([
        EXPECTED_HEADERS,
        ["Ramesh Kumar", "Customer", "9812345678", "r@x.com",
         "Motor insurance", "Called once"],
        ["Acme Co", "Business", "9800000000", "a@acme.com",
         "Health insurance", "Web enquiry"],
    ])
    rows = parse_file("leads.csv", data)
    assert len(rows) == 2
    assert rows[0]["full name"] == "Ramesh Kumar"
    assert rows[0]["mobile"] == "9812345678"
    assert rows[0]["type"] == "Customer"
    assert rows[1]["full name"] == "Acme Co"
    assert rows[1]["type"] == "Business"


def test_parse_rejects_wrong_headers():
    data = _csv_bytes([
        ["Name", "Mobile", "Mail"],
        ["Ramesh", "98120", "r@x.com"],
    ])
    with pytest.raises(ImportFormatError):
        parse_file("bad.csv", data)


def test_parse_skips_blank_rows():
    data = _csv_bytes([
        EXPECTED_HEADERS,
        ["Ramesh", "Customer", "9812345678", "", "", ""],
        ["", "", "", "", "", ""],
    ])
    rows = parse_file("leads.csv", data)
    assert len(rows) == 1


def test_parse_rejects_unknown_extension():
    with pytest.raises(ImportFormatError):
        parse_file("leads.pdf", b"whatever")


# --- Lead type column (owner Q1.5, 2026-08-03) -----------------------------------


def test_a_file_saved_from_the_old_template_still_imports():
    """Type is optional on purpose. A sheet exported before 2026-08-03 has no
    Type column, and rejecting it would strand every file the owner already
    has — every row in one is a Customer, which is what those rows were."""
    old_headers = [h for h in EXPECTED_HEADERS if h != "Type"]
    data = _csv_bytes([
        old_headers,
        ["Ramesh Kumar", "9812345678", "r@x.com", "Motor", "Called"],
    ])
    rows = parse_file("leads.csv", data)
    assert len(rows) == 1
    assert parse_lead_type(rows[0].get("type")) is LeadType.CUSTOMER


def test_a_file_with_the_dropped_address_column_still_imports():
    """Address is no longer collected on a lead, but a file the owner already
    has must not be rejected over a column WE chose to stop reading — it is
    accepted and the value ignored."""
    data = _csv_bytes([
        EXPECTED_HEADERS[:4] + ["Address"] + EXPECTED_HEADERS[4:],
        ["Ramesh Kumar", "Customer", "9812345678", "r@x.com", "12 MG Road",
         "Motor", "Called"],
    ])
    rows = parse_file("leads.csv", data)
    assert len(rows) == 1
    assert rows[0]["full name"] == "Ramesh Kumar"
    # Parsed, but nothing downstream reads it.
    assert rows[0]["address"] == "12 MG Road"


def test_address_is_not_part_of_the_template_any_more():
    assert "Address" not in EXPECTED_HEADERS
    assert "Address" not in build_template_csv().splitlines()[0]


def test_a_missing_required_column_is_still_rejected():
    """Making Type optional must not have made everything optional."""
    data = _csv_bytes([
        [h for h in EXPECTED_HEADERS if h != "Mobile"],
        ["Ramesh Kumar", "Customer", "r@x.com", "Motor", "Called"],
    ])
    with pytest.raises(ImportFormatError) as exc:
        parse_file("leads.csv", data)
    assert "mobile" in str(exc.value)


@pytest.mark.parametrize("text,expected", [
    ("Customer", LeadType.CUSTOMER),
    ("customer", LeadType.CUSTOMER),
    ("Channel partner", LeadType.CHANNEL_PARTNER),
    ("channel_partner", LeadType.CHANNEL_PARTNER),
    ("Channel-Partner", LeadType.CHANNEL_PARTNER),
    ("  partner  ", LeadType.CHANNEL_PARTNER),
    ("CP", LeadType.CHANNEL_PARTNER),
    ("Business", LeadType.BUSINESS),
    ("company", LeadType.BUSINESS),
    ("Corporate", LeadType.BUSINESS),
])
def test_type_cell_accepts_what_people_actually_type(text, expected):
    assert parse_lead_type(text) is expected


@pytest.mark.parametrize("text", ["", "   ", None, "wat"])
def test_an_unreadable_type_cell_falls_back_to_customer(text):
    """A typo must not fail the row — importing 500 leads and losing one to
    "Custmer" is worse than filing it under the default."""
    assert parse_lead_type(text) is LeadType.CUSTOMER


def test_every_type_has_a_label_and_it_round_trips():
    """A file this app exports must be a file this app can import back."""
    for t in LeadType:
        label = label_for_type(t)
        assert label and label[0].isupper()
        assert parse_lead_type(label) is t


def test_label_for_an_unknown_value_does_not_leak_a_raw_enum():
    assert label_for_type("something_else") == "Customer"
    assert label_for_type(None) == "Customer"
