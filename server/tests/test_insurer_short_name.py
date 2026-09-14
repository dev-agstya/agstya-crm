"""An insurer's short name is unique — and optional at the same time.

Owner, 2026-07-26: "The Short Name of insurer should also be unique."

That combination is the whole difficulty. A plain unique index would let only
ONE insurer leave the field blank, because MongoDB treats every missing field as
the same null value and a second blank row collides with the first. So the
constraint is a PARTIAL index limited to documents that actually carry a string,
and the router checks case-insensitively on top — an index cannot do that, and
"HDFC" / "hdfc" are plainly the same company.
"""

import asyncio
import inspect
import re

import pymongo
import pytest
from fastapi.routing import APIRoute

from app.main import app
from app.models.insurer import Insurer
from app.routers import insurers as router_mod
from app.schemas.insurer import InsurerCreate, InsurerUpdate


def _short_name_index():
    for idx in Insurer.Settings.indexes:
        if isinstance(idx, pymongo.IndexModel):
            doc = idx.document
            if any(k == "short_name" for k, _ in doc["key"].items()):
                return doc
    raise AssertionError("no index declared on short_name")


# --- the index itself -----------------------------------------------------------------


def test_short_name_has_a_unique_index():
    assert _short_name_index().get("unique") is True


def test_the_index_is_partial_so_blanks_do_not_collide():
    """Without this, saving a second insurer with no short name is a duplicate
    key error — the field is optional and most insurers won't have one."""
    doc = _short_name_index()
    assert doc.get("partialFilterExpression") == {
        "short_name": {"$type": "string"}}


def test_name_and_code_are_still_unique():
    """The new index must not have displaced the existing guarantees."""
    src = inspect.getsource(Insurer)
    assert "code: Indexed(str, unique=True)" in src
    assert "name: Indexed(str, unique=True)" in src


# --- normalising what gets stored ------------------------------------------------------


@pytest.mark.parametrize("payload_cls", [InsurerCreate, InsurerUpdate])
def test_a_blank_short_name_is_stored_as_nothing(payload_cls):
    """An empty box must not become the value "" — the second insurer saved
    that way would clash with the first."""
    kwargs = {"name": "HDFC Life"} if payload_cls is InsurerCreate else {}
    for blank in ("", "   "):
        obj = payload_cls(short_name=blank, **kwargs)
        assert obj.short_name is None


@pytest.mark.parametrize("payload_cls", [InsurerCreate, InsurerUpdate])
def test_a_short_name_is_trimmed(payload_cls):
    kwargs = {"name": "HDFC Life"} if payload_cls is InsurerCreate else {}
    assert payload_cls(short_name="  HDFC  ", **kwargs).short_name == "HDFC"


def test_an_absent_short_name_stays_absent():
    assert InsurerCreate(name="HDFC Life").short_name is None
    # exclude_unset is what makes a PATCH partial — the validator must not
    # invent a key that wasn't sent.
    assert "short_name" not in InsurerUpdate().model_dump(exclude_unset=True)


# --- the API refuses clashes readably --------------------------------------------------


def test_the_router_checks_short_name_on_create_and_update():
    create = inspect.getsource(router_mod.create_insurer)
    update = inspect.getsource(router_mod.update_insurer)
    assert "_short_name_taken" in create
    assert "_short_name_taken" in update


def test_the_router_also_checks_the_name_on_update():
    """It didn't before: renaming onto an existing insurer hit the unique index
    and surfaced as a 500 with an error reference instead of a plain message."""
    assert "_name_taken" in inspect.getsource(router_mod.update_insurer)


def test_uniqueness_checks_are_case_insensitive():
    for fn in (router_mod._name_taken, router_mod._short_name_taken):
        src = inspect.getsource(fn)
        assert '"$options": "i"' in src, f"{fn.__name__} is case-sensitive"


def test_the_checks_escape_what_the_user_typed():
    """A name is dropped into a regex; "HDFC (India)" must not blow up or match
    something else."""
    for fn in (router_mod._name_taken, router_mod._short_name_taken):
        assert "re.escape" in inspect.getsource(fn)


def test_a_record_does_not_clash_with_itself():
    """Saving an insurer without touching its short name must not report the
    short name as taken — by itself."""
    for fn in (router_mod._name_taken, router_mod._short_name_taken):
        src = inspect.getsource(fn)
        assert "exclude_id" in src
        assert "str(existing.id) != (exclude_id or \"\")" in src


def test_the_conflict_message_names_the_offending_value():
    """"Short name 'HDFC' is already used by another insurer" beats "conflict"."""
    src = inspect.getsource(router_mod.create_insurer)
    assert re.search(r"Short name .*already used", src)


# --- and the form asks BEFORE you save -------------------------------------------------
#
# Owner, 2026-07-26: "why show error after I click save! ... at least show in the
# UI, just make same logic like broker code." The 409 above is the backstop; the
# route below is what lets the Add/Edit Insurer form say "'HE' is available" (or
# not) while you type, the way the broker short code already does.


def _availability_routes():
    return [r for r in app.routes
            if isinstance(r, APIRoute)
            and r.path == "/api/insurers/short-name-available"]


def test_the_availability_route_is_registered():
    routes = _availability_routes()
    assert len(routes) == 1, "GET /api/insurers/short-name-available is missing"
    assert "GET" in routes[0].methods


def test_it_is_registered_before_the_id_route():
    """The routing gotcha: /{insurer_id} matches the literal string
    "short-name-available" too, so registering it first would turn the check
    into a 404 "Insurer not found"."""
    paths = [r.path for r in app.routes
             if isinstance(r, APIRoute) and r.path.startswith("/api/insurers")]
    assert (paths.index("/api/insurers/short-name-available")
            < paths.index("/api/insurers/{insurer_id}"))


def test_the_check_needs_the_same_right_as_saving():
    """No point letting someone probe the insurer list who cannot edit it —
    the decorator sits in the handler's source, so it is checkable here."""
    src = inspect.getsource(router_mod.short_name_available)
    assert "require_permission(MANAGE_INSURERS)" in src


def test_the_check_reuses_the_save_time_rule():
    """If the two ever diverge the form says "available" and Save then 409s."""
    assert "_short_name_taken" in inspect.getsource(
        router_mod.short_name_available)


def _ask(short_name: str, exclude_id: str | None = None):
    return asyncio.run(router_mod.short_name_available(
        short_name=short_name, exclude_id=exclude_id, _=None))


@pytest.fixture
def taken(monkeypatch):
    """Pretend "HE" belongs to insurer 111, and nothing else is taken."""
    seen: dict = {}

    async def fake(short_name: str, exclude_id: str | None = None) -> bool:
        seen["args"] = (short_name, exclude_id)
        return short_name.strip().lower() == "he" and exclude_id != "111"

    monkeypatch.setattr(router_mod, "_short_name_taken", fake)
    return seen


def test_a_free_short_name_comes_back_available(taken):
    assert _ask("BA").available is True


def test_a_used_short_name_comes_back_unavailable(taken):
    assert _ask("HE").available is False


def test_the_answer_echoes_the_trimmed_value(taken):
    """The form prints it back — "'HE' is available", not "' HE '"."""
    assert _ask("  BA  ").short_name == "BA"


def test_an_insurer_does_not_clash_with_itself(taken):
    """Editing HDFC Ergo without touching its short name must stay green."""
    assert _ask("HE", exclude_id="111").available is True


def test_a_blank_answer_is_available_not_an_error(taken):
    """Short name is optional, so an emptied box is a perfectly good save."""
    res = _ask("   ")
    assert (res.short_name, res.available) == ("", True)
    assert "args" not in taken, "a blank box should not hit the database"
