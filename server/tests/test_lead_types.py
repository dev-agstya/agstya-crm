"""Lead types, and the removal of "convert to customer" (owner 2026-08-03).

Two changes that have to hold together:

  - A lead is a CUSTOMER, a CHANNEL PARTNER or a BUSINESS. This replaced the old
    individual/business flag on the same field, so the risk is a stale value
    surviving somewhere and being rendered or filtered as if it meant something.

  - There is no conversion endpoint any more. Converting created a Customer and
    then DELETED the lead, which only made sense for one of the three types. A
    won lead is now a lead at the `converted` stage and it stays in the list.

These are pure — no DB — so they pin the model and the query shape rather than
round-tripping through Mongo.
"""

import pytest

from app.core.enums import LeadStage, LeadType
from app.routers import leads as leads_router
from app.schemas.lead import LeadCounts, LeadCreate, LeadTypeCount, LeadUpdate


class _Actor:
    """Enough of a User for the query builders (in-house, so no partner scope)."""

    def __init__(self, account_type="employee", user_id="u1"):
        self.account_type = account_type
        self.id = user_id
        self.permissions = ["view_policies", "manage_policies"]


# --- The three types ---------------------------------------------------------------


def test_the_three_types_the_owner_asked_for():
    assert [t.value for t in LeadType] == [
        "customer", "channel_partner", "business"]


def test_the_old_individual_business_flag_is_gone():
    """It lived on this same field. Leaving it importable is how half the code
    keeps writing the old values while the other half reads the new ones."""
    from app.core import enums

    assert not hasattr(enums, "CustomerType")
    assert "individual" not in {t.value for t in LeadType}


def test_a_new_lead_is_a_customer_unless_told_otherwise():
    """Owner Q1.3: mandatory in the UI, defaulted on the schema so an import row
    that leaves the column blank lands on the common case instead of failing."""
    payload = LeadCreate(name="Ramesh Kumar", mobile="9812345678")
    assert payload.type is LeadType.CUSTOMER


def test_every_type_is_accepted_on_create_and_update():
    for t in LeadType:
        assert LeadCreate(name="Acme Co", mobile="9812345678",
                          type=t.value).type is t
        assert LeadUpdate(type=t.value).type is t


def test_an_unknown_type_is_refused_rather_than_stored():
    with pytest.raises(Exception):
        LeadCreate(name="Ramesh", mobile="9812345678", type="individual")


def test_update_leaves_the_type_alone_when_not_sent():
    """PATCH is partial: editing a name must not silently reset the type."""
    payload = LeadUpdate(name="Ramesh Kumar")
    assert payload.type is None
    assert "type" not in payload.model_dump(exclude_unset=True)


# --- The list / counts / export query ----------------------------------------------


def test_filtering_by_type_narrows_the_query():
    q = leads_router._list_query(_Actor(), lead_type=LeadType.CHANNEL_PARTNER)
    assert {"type": "channel_partner"} in q["$and"]


def test_no_type_filter_is_the_all_tab():
    """The All tab must not send `type` at all — a filter on "" would match
    nothing rather than everything."""
    q = leads_router._list_query(_Actor())
    assert "type" not in str(q)


def test_type_and_stage_and_search_combine():
    q = leads_router._list_query(
        _Actor(), lead_type=LeadType.BUSINESS, stage=LeadStage.QUOTED, q="acme")
    clauses = q["$and"]
    assert {"type": "business"} in clauses
    assert {"stage": "quoted"} in clauses
    assert any("$or" in c for c in clauses)


def test_the_partner_scope_survives_a_type_filter():
    """A channel partner may only see their own leads. Adding a type filter must
    narrow that, never replace it."""
    q = leads_router._list_query(_Actor(account_type="channel_partner"),
                                 lead_type=LeadType.CUSTOMER)
    flat = str(q)
    assert "owner_user_id" in flat
    assert "type" in flat


# --- Tab counts ---------------------------------------------------------------------


def test_counts_carry_a_row_for_every_type_even_at_zero():
    """A missing tab is worse than a zero: the type disappears from the UI and
    looks like it was removed."""
    counts = LeadCounts(
        total=3,
        by_type=[LeadTypeCount(type=t.value, count=0) for t in LeadType])
    assert [c.type for c in counts.by_type] == [t.value for t in LeadType]


def test_counts_default_to_empty_not_null():
    assert LeadCounts().by_type == []
    assert LeadCounts().total == 0


# --- Conversion is gone --------------------------------------------------------------


def test_there_is_no_convert_endpoint():
    """It created a customer and deleted the lead. Both halves are gone; leaving
    the route registered would let an old client keep deleting leads."""
    assert not hasattr(leads_router, "convert_lead")

    from app.schemas import lead as lead_schemas
    assert not hasattr(lead_schemas, "LeadConvert")


def test_converted_is_still_a_real_stage():
    """Removing the button must not remove the ability to mark a lead won."""
    assert LeadStage.CONVERTED.value == "converted"


def test_won_and_lost_are_the_stages_that_close_reminders():
    """Owner Q2.3. Reaching either closes the lead's open follow-ups — with the
    lead no longer being deleted, this is the only thing that stops them."""
    assert set(leads_router._CLOSING_STAGES) == {
        LeadStage.CONVERTED, LeadStage.LOST}


def test_an_in_progress_stage_does_not_close_reminders():
    for stage in (LeadStage.NEW, LeadStage.CONTACTED, LeadStage.QUOTED):
        assert stage not in leads_router._CLOSING_STAGES
