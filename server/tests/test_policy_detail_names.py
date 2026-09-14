"""One policy carries the same names as the same policy in a list (2026-08-04).

The bug this pins: `GET /api/policies/{id}` showed "—" where the customer and
the insurer should be, while the LIST one click away showed both. The cause was
structural rather than a typo — the list endpoint bulk-resolves customer,
insurer and partner names into maps before serialising, and the single-record
path (`_policy_out`) resolved only the broker. Seven endpoints go through it,
so seven of them were missing names, and the policy page was simply the one
anybody looked at.

The fix is in `_policy_out` rather than at the call sites, which is what these
tests protect: adding the lookup to `get_policy` alone would have left renew,
approve and the status changes still blank, and the next endpoint added would
have started blank too.

Pure tests: `_name_of` and `_policy_out` run against stub document classes, so
no database is involved.
"""

import asyncio
import inspect

from beanie import PydanticObjectId

from app.routers import policies as policies_router

CUST_ID = "6a69b6715cdb8b4ebe247d3a"
INS_ID = "6a69b6715cdb8b4ebe247d3b"
PARTNER_ID = "6a69b6715cdb8b4ebe247d3c"


def _run(coro):
    return asyncio.run(coro)


class _Doc:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _model(rows: dict):
    """A stand-in for a Beanie document class: .get(oid) out of a dict."""
    class _Model:
        @staticmethod
        async def get(oid):
            return rows.get(str(oid))
    return _Model


# --- Resolving one name ------------------------------------------------------------


def test_a_name_is_read_off_the_referenced_document():
    model = _model({CUST_ID: _Doc(name="Prakash Dangi")})
    assert _run(policies_router._name_of(model, CUST_ID, "name")) \
        == "Prakash Dangi"


def test_no_id_means_no_lookup_and_no_name():
    """Most policies have no channel partner. Turning that into a query per
    policy would be a round trip to learn nothing."""
    model = _model({})
    assert _run(policies_router._name_of(model, None, "name")) is None
    assert _run(policies_router._name_of(model, "", "name")) is None


def test_a_dangling_reference_is_not_an_error():
    """The insurer was deleted, the partner archived. The policy still has to
    open — a missing name is a dash, not a 500."""
    assert _run(policies_router._name_of(_model({}), INS_ID, "name")) is None


def test_a_malformed_id_from_an_old_row_does_not_blow_up():
    assert _run(policies_router._name_of(_model({}), "not-an-objectid", "name")) \
        is None


# --- Serialising one policy ---------------------------------------------------------


def _policy():
    return _Doc(
        id=PydanticObjectId(), code="AG-POL-000123", policy_number="43636/34737",
        category_key="vehicle", subcategory_path=["four_wheeler"],
        subcategory_key="four_wheeler",
        insurer_id=INS_ID, broker_id=None, customer_id=CUST_ID,
        partner_id=PARTNER_ID, status="active", approval_status="approved",
    )


def _serialise(monkeypatch, *, policy=None, **overrides):
    """Run _policy_out with every collection it touches stubbed out."""
    pol = policy or _policy()

    monkeypatch.setattr(policies_router, "Customer",
                        _model({CUST_ID: _Doc(name="Prakash Dangi")}))
    monkeypatch.setattr(policies_router, "Insurer",
                        _model({INS_ID: _Doc(name="Bajaj Allianz")}))
    monkeypatch.setattr(policies_router, "User",
                        _model({PARTNER_ID: _Doc(full_name="Manjit Sompo")}))

    async def _broker_display(_bid):
        return (None, None)

    monkeypatch.setattr(policies_router, "_broker_display", _broker_display)
    monkeypatch.setattr(policies_router, "_hide_agency", lambda _a: False)

    seen = {}

    class _Out:
        @staticmethod
        def from_model(p, **kw):
            seen.update(kw)
            return seen

    monkeypatch.setattr(policies_router, "PolicyOut", _Out)
    _run(policies_router._policy_out(pol, _Doc(), **overrides))
    return seen


def test_one_policy_carries_the_customer_name(monkeypatch):
    """THE regression — this is the field that showed as a dash."""
    assert _serialise(monkeypatch)["customer_name"] == "Prakash Dangi"


def test_one_policy_carries_the_insurer_name(monkeypatch):
    assert _serialise(monkeypatch)["insurer_name"] == "Bajaj Allianz"


def test_one_policy_carries_the_channel_partner_name(monkeypatch):
    """So the page stops depending on a separate lookup that needs manage_team —
    a staff user without that flag sat on a permanent "…"."""
    assert _serialise(monkeypatch)["partner_name"] == "Manjit Sompo"


def test_a_name_the_caller_already_has_is_not_looked_up_again(monkeypatch):
    """The callers that DO hold the record (create, renew) pass it in, and their
    value has to win — re-reading would be a wasted round trip."""
    got = _serialise(monkeypatch, customer_name="Already Known")
    assert got["customer_name"] == "Already Known"


def test_a_policy_with_no_partner_serialises_without_one(monkeypatch):
    pol = _policy()
    pol.partner_id = None
    assert _serialise(monkeypatch, policy=pol)["partner_name"] is None


# --- Where the fix lives -------------------------------------------------------------


def test_the_lookup_is_in_the_shared_serialiser_not_in_one_endpoint():
    """If this moves into `get_policy`, the other six single-policy endpoints go
    back to serving blank names and nothing else notices."""
    src = inspect.getsource(policies_router._policy_out)
    for field in ("customer_name", "insurer_name", "partner_name"):
        assert f"{field} = await _name_of" in src or f"{field}=" in src
    assert "_name_of(Customer" in src
    assert "_name_of(Insurer" in src
    assert "_name_of(User" in src


def test_every_single_policy_endpoint_goes_through_it():
    """Seven call sites today. A new one that hand-rolls PolicyOut.from_model
    instead would be the same bug again."""
    src = inspect.getsource(policies_router)
    # Was 7 until policy approval was removed (2026-08-05) and set_approval
    # went with it.
    assert src.count("await _policy_out(") >= 6
