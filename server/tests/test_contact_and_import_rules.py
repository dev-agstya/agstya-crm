"""Phone numbers are 10 digits everywhere, and the customer file has 4 columns.

Owner, 2026-07-26: "all over app/software mobile phone is to be of 10 digits
only" — screenshot 24 showed an insurer saved with a 20-digit phone. And the
postal address came off the customer record entirely, which the import template
has to follow or the two drift apart.
"""

import pytest
from pydantic import ValidationError

from app.schemas.broker import BrokerCreate, BrokerUpdate
from app.schemas.common import validate_optional_mobile
from app.schemas.insurer import InsurerCreate, InsurerUpdate
from app.services import customer_import


# --- Phone numbers ----------------------------------------------------------------


def test_a_ten_digit_number_is_kept():
    assert validate_optional_mobile("9876543210") == "9876543210"


def test_separators_are_stripped_not_rejected():
    """Pasting "98765 43210" or "+91-98765-43210" is a human typing a real
    number, not an error — keep the ten digits."""
    assert validate_optional_mobile("98765 43210") == "9876543210"
    assert validate_optional_mobile("98765-43210") == "9876543210"


def test_blank_stays_blank():
    assert validate_optional_mobile("") is None
    assert validate_optional_mobile(None) is None
    assert validate_optional_mobile("   ") is None


@pytest.mark.parametrize("bad", [
    "998996795946946946949469",     # the screenshot-24 value
    "12345",
    "919876543210",                 # country code included
])
def test_anything_that_is_not_ten_digits_is_refused(bad):
    with pytest.raises(ValueError):
        validate_optional_mobile(bad)


def test_insurer_phone_is_validated_on_create_and_update():
    ok = InsurerCreate(name="SBI General", phone="9876543210")
    assert ok.phone == "9876543210"
    with pytest.raises(ValidationError):
        InsurerCreate(name="SBI General", phone="998996795946946946949469")
    with pytest.raises(ValidationError):
        InsurerUpdate(phone="123")


def test_an_insurer_without_a_phone_is_fine():
    assert InsurerCreate(name="NivaBupa").phone is None


def test_broker_registered_mobile_follows_the_same_rule():
    ok = BrokerCreate(name="Policy Bazaar", short_code="PB",
                      reg_mobile="98765 43210")
    assert ok.reg_mobile == "9876543210"
    with pytest.raises(ValidationError):
        BrokerUpdate(reg_mobile="12345678901")


# --- Broker payment cycle is gone --------------------------------------------------


def test_payment_cycle_is_no_longer_part_of_a_broker():
    """Removed from the form, the API and the model (owner 2026-07-26)."""
    from app.models.broker import Broker

    assert "payment_cycle" not in BrokerCreate.model_fields
    assert "payment_cycle" not in BrokerUpdate.model_fields
    assert "payment_cycle" not in Broker.model_fields


def test_posting_a_payment_cycle_does_not_resurrect_it():
    body = BrokerCreate(name="Policy Bazaar", short_code="PB",
                        **{"payment_cycle": "monthly"})
    assert not hasattr(body, "payment_cycle")


def test_a_legacy_broker_document_still_serialises():
    """Old rows keep the retired field in Mongo; the response model drops it
    instead of blowing up."""
    from datetime import datetime, timezone

    from app.schemas.broker import BrokerOut

    class _LegacyBroker:
        id = "abc123"

        def model_dump(self):
            return {
                "code": "BRK-1", "short_code": "PB", "name": "Policy Bazaar",
                "tds_percent": 200, "account_login": None, "reg_mobile": None,
                "payment_cycle": "monthly",          # the retired field
                "active": True, "notes": None,
                "created_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
            }

    out = BrokerOut.from_model(_LegacyBroker())
    assert out.name == "Policy Bazaar"
    assert not hasattr(out, "payment_cycle")


# --- Customer import template -------------------------------------------------------


def test_the_template_has_only_the_four_columns_we_still_collect():
    assert customer_import.EXPECTED_HEADERS == [
        "Full Name", "Mobile", "Email", "Notes"]


def test_the_sample_row_matches_the_headers():
    assert len(customer_import.SAMPLE_ROW) == len(
        customer_import.EXPECTED_HEADERS)


def test_a_file_using_the_new_template_parses():
    csv_text = ("Full Name,Mobile,Email,Notes\n"
                "Ramesh Kumar,9812345678,ramesh@example.com,VIP\n")
    rows = customer_import.parse_file("customers.csv", csv_text.encode())
    assert rows == [{"full name": "Ramesh Kumar", "mobile": "9812345678",
                     "email": "ramesh@example.com", "notes": "VIP"}]


def test_an_old_file_with_address_columns_is_rejected_with_guidance():
    """Silently ignoring the address columns would let someone believe an
    address had been imported."""
    csv_text = ("Full Name,Mobile,Email,Address,City,State,Pincode,Notes\n"
                "Ramesh,9812345678,r@e.com,12 MG Road,Pune,MH,411001,VIP\n")
    with pytest.raises(customer_import.ImportFormatError) as exc:
        customer_import.parse_file("old.csv", csv_text.encode())
    message = str(exc.value)
    assert "address" in message
    assert "sample file" in message


def test_the_generated_template_is_what_the_parser_accepts():
    """The download and the upload can never drift apart."""
    built = customer_import.build_template_csv()
    rows = customer_import.parse_file("template.csv", built.encode())
    assert len(rows) == 1


# --- Customer address is gone --------------------------------------------------------


def test_a_customer_no_longer_carries_a_postal_address():
    from app.models.customer import Customer
    from app.schemas.customer import CustomerCreate, CustomerUpdate

    assert "address" not in Customer.model_fields
    assert "address" not in CustomerCreate.model_fields
    assert "address" not in CustomerUpdate.model_fields


def test_a_legacy_customer_with_an_address_still_serialises():
    from datetime import datetime, timezone

    from app.schemas.customer import CustomerOut

    class _LegacyCustomer:
        id = "cus1"

        def model_dump(self):
            return {
                "code": "CX-1", "name": "Ramesh", "mobile": "9812345678",
                "email": None, "alt_mobile": None, "kyc": None,
                "nominees": [], "renewal_reminders_enabled": True,
                "notes": None, "tags": [], "origin": "inhouse",
                "owner_user_id": "u1", "partner_id": None,
                "created_by_name": None, "is_archived": False,
                "address": {"city": "Pune"},        # the retired sub-document
                "created_at": datetime(2026, 7, 1, tzinfo=timezone.utc),
            }

        origin = "inhouse"

    out = CustomerOut.from_model(_LegacyCustomer())
    assert out.name == "Ramesh"
    assert not hasattr(out, "address")
