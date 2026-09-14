"""Who may read which policy, and what happens when a partner changes hands.

THE CHANGE THIS PINS (owner 2026-08-24)
----------------------------------------
Until now every employee holding `view_policies` read the entire agency book.
The owner ended that: "each employee can only see the policies that he has added
directly, or the channel partner under him has added... we do not want all the
employees to see all the data."

And the half that makes it work: "if I want to move one channel partner to
other employee, as soon as I do that, all the policies related to that channel
partner should also be moved to that new employee."

Those two sentences pull in opposite directions unless visibility is DERIVED
rather than stored, and that is the design these tests exist to hold in place:

  * `Policy.manager_id` is FROZEN at booking and is about CREDIT. Reassigning a
    partner must not rewrite last quarter's league table.
  * `policy_scope.visible_filter()` is LIVE and is about SIGHT. Reassigning a
    partner moves the whole book in the same instant, with no migration.

If a future pass "simplifies" one into the other, one of these fails.

WHAT IS DELIBERATELY ASSERTED IN THE QUERY, NOT THE SERIALISER
---------------------------------------------------------------
The filter is a Mongo clause. A visibility rule applied while rendering leaks
through the total, through `?page_size=100` and through the export — this
codebase already has that scar (`view_renewals` was decorative until the window
was forced into the list's own query), so the shape is asserted, not just the
outcome.
"""

from __future__ import annotations

import inspect

import pytest

from app.core import permissions as perms
from app.core.enums import AccountType
from app.models.policy import Policy
from app.models.policy_access import (
    DEFAULT_GRANT_HOURS, MAX_GRANT_HOURS, PolicyAccessRequest,
    PolicyAccessStatus,
)
from app.models.user import User
from app.services import policy_scope


# =============================================================================
# Fixtures — plain constructed documents, no database
# =============================================================================


def user(uid="e1", account_type=AccountType.EMPLOYEE, permissions=()) -> User:
    return User.model_construct(
        id=uid, full_name="Asha", account_type=account_type,
        permissions=list(permissions), permissions_version=perms.PERMISSIONS_VERSION,
        relationship_manager_id=None)


def policy(pid="p1", owner="e1", partner=None) -> Policy:
    return Policy.model_construct(id=pid, code="POL-1", owner_user_id=owner,
                                  partner_id=partner)


@pytest.fixture
def roster(monkeypatch):
    """Stub the live roster lookup. Returns a dict you set: {manager: [partners]}."""
    table: dict[str, list[str]] = {}

    async def fake(manager_id: str):
        return table.get(manager_id, [])

    monkeypatch.setattr(policy_scope, "partner_ids_for", fake)
    return table


@pytest.fixture
def grants(monkeypatch):
    """Stub the live JIT grant lookup. Returns a dict: {user: [policy ids]}."""
    table: dict[str, list[str]] = {}

    async def fake(actor, *, now=None):
        return table.get(str(actor.id), [])

    monkeypatch.setattr(policy_scope, "granted_policy_ids", fake)
    return table


# =============================================================================
# Who is exempt
# =============================================================================


def test_the_owner_sees_everything_by_account_type():
    """Not by a flag on their document. `User.permissions` is a denormalised
    snapshot and the owner's goes stale — CLAUDE.md's "Permission gotcha", which
    has already cost this app a Bank & Cash page that 403'd."""
    assert policy_scope.sees_everything(
        user(account_type=AccountType.OWNER, permissions=[]))


def test_an_employee_with_view_all_policies_sees_everything():
    assert policy_scope.sees_everything(
        user(permissions=["view_policies", "view_all_policies"]))


def test_an_ordinary_employee_does_not():
    assert not policy_scope.sees_everything(user(permissions=["view_policies"]))


@pytest.mark.asyncio
async def test_an_exempt_caller_gets_NO_filter_not_an_empty_one(roster):
    """`None`, and callers must treat it as "no limit".

    An empty `$or` matches NOTHING, which is the opposite failure — and the kind
    that reads as "the page is broken" rather than "the page is leaking", so it
    would be found late and by the wrong person.
    """
    assert await policy_scope.visible_filter(
        user(account_type=AccountType.OWNER)) is None


# =============================================================================
# The three clauses
# =============================================================================


@pytest.mark.asyncio
async def test_you_always_see_what_you_booked(roster, grants):
    f = await policy_scope.visible_filter(user(permissions=["view_policies"]))
    assert {"owner_user_id": "e1"} in f["$or"]


@pytest.mark.asyncio
async def test_you_see_your_partners_policies(roster, grants):
    roster["e1"] = ["cp1", "cp2"]
    f = await policy_scope.visible_filter(user(permissions=["view_policies"]))
    assert {"partner_id": {"$in": ["cp1", "cp2"]}} in f["$or"]


@pytest.mark.asyncio
async def test_an_empty_roster_adds_no_clause(roster, grants):
    """`{"partner_id": {"$in": []}}` matches nothing and would be harmless — but
    it is also noise in every query plan, and a clause that can never match is
    one somebody later "fixes" in the wrong direction."""
    f = await policy_scope.visible_filter(user(permissions=["view_policies"]))
    assert f["$or"] == [{"owner_user_id": "e1"}]


@pytest.mark.asyncio
async def test_a_live_grant_adds_the_policy_by_object_id(roster, grants):
    """Matching on the STRING id would never hit — `_id` is an ObjectId, so the
    clause would silently match nothing and the approval would appear to do
    nothing at all."""
    from beanie import PydanticObjectId

    oid = PydanticObjectId()
    grants["e1"] = [str(oid)]
    f = await policy_scope.visible_filter(user(permissions=["view_policies"]))
    assert {"_id": {"$in": [oid]}} in f["$or"]


@pytest.mark.asyncio
async def test_a_grant_on_a_deleted_policy_does_not_break_the_query(roster,
                                                                    grants):
    grants["e1"] = ["not-an-object-id"]
    f = await policy_scope.visible_filter(user(permissions=["view_policies"]))
    assert f["$or"] == [{"owner_user_id": "e1"}]


# =============================================================================
# Reassignment: the whole feature, in one test
# =============================================================================


@pytest.mark.asyncio
async def test_moving_a_partner_moves_their_whole_book_with_no_migration(
        roster, grants):
    """The owner's requirement, asserted end to end.

    Employee A holds partner CP. A policy CP booked is visible to A and not to
    B. Move CP to B — ONE field on ONE document — and the same policy is
    instantly visible to B and not to A. Nothing about the policy changed.
    """
    a = user("A", permissions=["view_policies"])
    b = user("B", permissions=["view_policies"])
    booked_by_cp = policy("p9", owner="someone_else", partner="CP")

    roster["A"] = ["CP"]
    assert await policy_scope.can_see(a, booked_by_cp)
    assert not await policy_scope.can_see(b, booked_by_cp)

    # The reassignment. In production this is
    # `PATCH /api/users/{id} {"relationship_manager_id": "B"}`.
    roster["A"] = []
    roster["B"] = ["CP"]

    assert await policy_scope.can_see(b, booked_by_cp)
    assert not await policy_scope.can_see(a, booked_by_cp)


@pytest.mark.asyncio
async def test_the_booker_keeps_sight_of_what_they_booked(roster, grants):
    """`owner_user_id == me` survives the partner moving away.

    The person who keyed a policy in is the one who will be asked about it, and
    taking the record off them reads as data loss. In the owner's own scenario
    the departing employee is deactivated and cannot sign in at all, so the
    clause costs nothing where it matters.
    """
    a = user("A", permissions=["view_policies"])
    keyed_by_a = policy("p9", owner="A", partner="CP")
    roster["A"] = []
    roster["B"] = ["CP"]
    assert await policy_scope.can_see(a, keyed_by_a)


def _string_constants(module) -> set[str]:
    """Every string LITERAL in a module, read from its AST.

    Deliberately the literals rather than a substring search over the source:
    this module's docstrings discuss `Policy.manager_id` at length, because
    explaining why it must not be read is half of why the file exists.
    Explaining a field is not querying it, and a test that cannot tell the
    difference is one that punishes the comments — the same reasoning
    `test_hr_module._imported_names` is written with.
    """
    import ast

    tree = ast.parse(inspect.getsource(module))
    return {node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)}


def test_attribution_is_frozen_and_visibility_is_not():
    """The two answers must come from two places.

    `stamp_manager` writes `Policy.manager_id` once, at booking. `policy_scope`
    never QUERIES it. If a future pass makes visibility read the frozen stamp,
    reassignment stops moving anything; if it makes the stamp live,
    reassignment rewrites last quarter's targets.

    Asserted on the string literals, because a Mongo field name in this codebase
    is always one — `{"manager_id": ...}` — and the docstrings are full of the
    words.
    """
    assert "manager_id" not in _string_constants(policy_scope), (
        "policy_scope queries Policy.manager_id — that field is frozen "
        "attribution, and visibility is derived live from the roster.")
    # The roster it DOES read, which is the live half.
    assert "relationship_manager_id" in _string_constants(policy_scope)

    from app.services import policy_ops
    assert "policy.manager_id = " in inspect.getsource(policy_ops.stamp_manager)


@pytest.mark.asyncio
async def test_the_filter_is_exactly_the_three_documented_clauses(roster,
                                                                  grants):
    """Owner, partner, grant. Nothing else, and in that order.

    A fourth clause appearing here is a widening of what everybody can see, and
    it would arrive with no error and no visible symptom — which is why the
    shape is pinned rather than only its behaviour.
    """
    from beanie import PydanticObjectId

    oid = PydanticObjectId()
    roster["e1"] = ["cp1"]
    grants["e1"] = [str(oid)]
    f = await policy_scope.visible_filter(user(permissions=["view_policies"]))
    assert f == {"$or": [
        {"owner_user_id": "e1"},
        {"partner_id": {"$in": ["cp1"]}},
        {"_id": {"$in": [oid]}},
    ]}


# =============================================================================
# The merge — the trap this module's helper exists for
# =============================================================================


def test_merging_a_scope_into_a_query_that_already_has_an_or():
    """`list_policies` builds `base["$or"]` for the search box.

    Assigning the scope's `$or` on top would REPLACE it, and a search for a
    customer name would then match any policy whose customer matched OR which
    the caller owned — the wrong results AND a leak, from one dict update.
    """
    base = {"$or": [{"code": "X"}], "status": "active"}
    scope = {"$or": [{"owner_user_id": "e1"}]}
    merged = policy_scope.merge(base, scope)
    assert merged == {"$and": [base, scope]}
    # Both survive, and neither is nested inside the other's `$or`.
    assert merged["$and"][0]["$or"] == [{"code": "X"}]
    assert merged["$and"][1]["$or"] == [{"owner_user_id": "e1"}]


def test_merging_no_scope_leaves_the_query_alone():
    base = {"status": "active"}
    assert policy_scope.merge(base, None) is base


def test_merging_into_an_empty_query_does_not_wrap_it_pointlessly():
    scope = {"$or": [{"owner_user_id": "e1"}]}
    assert policy_scope.merge({}, scope) == scope


# =============================================================================
# It is applied in the QUERY, everywhere that reads policies
# =============================================================================


def test_every_policy_read_path_applies_the_scope():
    """The list, the export and the global search all merge it.

    Asserted against the SOURCE because the alternative is three integration
    tests with a database, and the thing that actually goes wrong is somebody
    adding a fourth read path and not knowing this exists. A missing call here
    is a silent, total bypass of the feature.
    """
    import app.routers.policies as pol
    import app.routers.search as search

    for fn in (pol.list_policies, pol.export_policies):
        src = inspect.getsource(fn)
        assert "policy_scope.merge" in src, fn.__name__
        assert "visible_filter" in src, fn.__name__

    assert "policy_scope.merge" in inspect.getsource(search.global_search)


def test_the_single_record_path_goes_through_the_shared_hook():
    """`ensure_can_access` is Policy-aware, so all eleven call sites in
    routers/policies and routers/documents were correct the moment it learned
    about policies. A per-call-site check would have needed eleven edits and
    been one edit short within a month."""
    from app.routers import _helpers

    src = inspect.getsource(_helpers.ensure_can_access)
    assert "isinstance(record, Policy)" in src
    assert "assert_can_see" in src


def test_a_policy_you_cannot_see_is_a_404_not_a_403():
    """A 403 confirms the record exists, which is the fact being withheld. The
    ONE place that deliberately says "it exists and you may not see it" is the
    restricted-search endpoint, where saying so IS the feature."""
    # The docstring explains at length why it is not a 403, so the comment is
    # stripped before the code is searched — see `_string_constants`.
    import ast

    fn = ast.parse(inspect.getsource(policy_scope.assert_can_see)).body[0]
    body = ast.unparse(fn.body[1:])          # drop the docstring statement
    assert "HTTP_404_NOT_FOUND" in body
    assert "403" not in body and "FORBIDDEN" not in body


# =============================================================================
# The permission catalogue
# =============================================================================


def test_the_two_new_flags_exist_and_are_grantable():
    for flag in ("view_all_policies", "manage_policy_access"):
        assert flag in perms.ALL_PERMISSIONS, flag
    shown = {key for group in perms.PERMISSION_GROUPS
             for section in group["sections"]
             for key in (section["view"], section.get("manage")) if key}
    assert {"view_all_policies", "manage_policy_access"} <= shown


def test_seeing_the_whole_book_implies_seeing_the_page_it_widens():
    """Granting one without the other produces a Policies section that is
    invisible and unrestricted at the same time."""
    assert perms.VIEW_POLICIES in perms.expand_permissions(["view_all_policies"])


def test_an_approver_can_read_what_they_are_approving():
    """Deciding "may Ravi read POL-123" while unable to open POL-123 is
    rubber-stamping a code."""
    held = perms.expand_permissions(["manage_policy_access"])
    assert perms.VIEW_POLICIES in held
    assert perms.VIEW_ALL_POLICIES in held


def test_the_legacy_migration_does_NOT_hand_back_the_whole_book():
    """The old `view_policies` genuinely did open everything, so a faithful
    translation would re-grant `view_all_policies` to every account that
    predates the change — which is precisely the default the owner has just
    withdrawn. A migration must not undo a decision."""
    migrated = perms.migrate_legacy_permissions(["view_policies"])
    assert "view_policies" in migrated
    assert "view_all_policies" not in migrated


# =============================================================================
# JIT access requests
# =============================================================================


def test_a_grant_is_live_only_while_its_window_is_open():
    """Compared to the clock on every check, never read off `status`.

    A stored "approved" that a sweep is supposed to clear is access that stays
    open when the sweep does not run, which is the one failure mode a
    time-limited grant cannot have.
    """
    from datetime import timedelta

    from app.models.base import utcnow

    now = utcnow()
    live = PolicyAccessRequest.model_construct(
        status=PolicyAccessStatus.APPROVED, expires_at=now + timedelta(hours=1))
    lapsed = PolicyAccessRequest.model_construct(
        status=PolicyAccessStatus.APPROVED, expires_at=now - timedelta(hours=1))
    assert live.is_live(now)
    assert not lapsed.is_live(now)


def test_an_approved_row_with_no_expiry_is_not_live():
    """A missing window is a bug, and the safe reading of a bug is "closed"."""
    row = PolicyAccessRequest.model_construct(
        status=PolicyAccessStatus.APPROVED, expires_at=None)
    assert not row.is_live()


def test_a_pending_or_refused_request_is_never_live():
    from datetime import timedelta

    from app.models.base import utcnow

    for status in (PolicyAccessStatus.PENDING, PolicyAccessStatus.REJECTED,
                   PolicyAccessStatus.REVOKED, PolicyAccessStatus.CANCELLED,
                   PolicyAccessStatus.EXPIRED):
        row = PolicyAccessRequest.model_construct(
            status=status, expires_at=utcnow() + timedelta(hours=5))
        assert not row.is_live(), status


def test_the_default_window_is_the_owners_twelve_hours():
    """"So give like 12 hours JIT request kind of thing" (owner)."""
    assert DEFAULT_GRANT_HOURS == 12


def test_the_window_is_capped():
    """A week is not "just-in-time" any more. Anybody who needs that much needs
    `view_all_policies`, which is a deliberate grant somebody can see."""
    assert MAX_GRANT_HOURS <= 72


def test_the_clock_starts_at_APPROVAL_not_at_the_request():
    """A window that ticks while the request sits in a queue can be entirely
    spent before anybody says yes, and the requester would be granted access
    they never had."""
    from app.routers import policy_access as pa

    src = inspect.getsource(pa.decide)
    assert "row.expires_at = now + timedelta(hours=payload.hours)" in src


def test_nobody_decides_their_own_request():
    from app.routers import policy_access as pa

    assert "cannot decide your own access request" in inspect.getsource(pa.decide)


def test_the_restricted_search_reveals_only_the_code_number_and_holder():
    """THE security decision of this whole feature, in one schema.

    Every other 404-vs-403 rule in the app exists to avoid confirming a record
    exists. This endpoint confirms it on purpose — that IS the feature — so what
    it says has to be exactly enough to ask for access and nothing more.
    """
    from app.routers.policy_access import RestrictedPolicy

    assert set(RestrictedPolicy.model_fields) == {
        "id", "code", "policy_number", "held_by", "request_id",
        "request_status"}
    for leak in ("customer", "premium", "insurer", "reward", "broker",
                 "sum_insured", "expiry"):
        assert not any(leak in f for f in RestrictedPolicy.model_fields), leak


def test_the_restricted_search_does_not_match_customer_names():
    """Confirming a policy number somebody is holding a document for is a
    different disclosure from letting them enumerate the agency's client list
    one guess at a time."""
    from app.routers import policy_access as pa

    src = inspect.getsource(pa.restricted_search)
    assert '{"code": rx}' in src and '{"policy_number": rx}' in src
    assert "Customer" not in src


# =============================================================================
# The ways ROUND the scope, closed
# =============================================================================
#
# A scope applied to one list and nothing else is decorative. Every one of these
# is a real bypass that existed on the day the feature was written: a different
# collection, a different router, or a report over the same rows. They are
# asserted against the SOURCE because the alternative is five integration tests
# with a database, and the failure being guarded against is somebody adding a
# SIXTH read path without knowing the rule exists.


def test_a_customers_policy_list_is_scoped_too():
    """CUSTOMERS ARE NOT SCOPED, so the customer page was the shortest way
    round: open any customer, read every policy on them.

    Fixed by merging the same clause into the customer's policy list AND its
    stats tile — a tile counting policies the list refuses to show is two
    numbers on one screen disagreeing, which is this app's worst bug.
    """
    import app.routers.customers as cust

    for fn in (cust.customer_policies, cust.customer_stats):
        src = inspect.getsource(fn)
        assert "policy_scope.merge" in src, fn.__name__
        assert "visible_filter" in src, fn.__name__


def test_the_customers_LIST_counts_only_policies_you_may_open():
    """The "4 policies" on a customer row is a policy count, so it is scoped
    like one. Otherwise the Customers list quietly reports the size of somebody
    else's book, one row at a time."""
    import app.routers.customers as cust

    src = inspect.getsource(cust._customer_aggregates)
    assert "policy_scope.merge" in src
    assert "scope" in inspect.signature(cust._customer_aggregates).parameters


def test_the_reports_scope_policies_and_rewards_but_not_customers():
    """A REPORT IS A READ OF THE SAME COLLECTION.

    Scoping the list and leaving the dashboard alone would tell an employee
    "1,240 active policies" over a page showing them thirty — a leak, and a
    number they cannot reconcile with anything else on screen.

    Customers and leads stay UNSCOPED, deliberately: `_scope` still returns
    `{}`, and the policy/reward reads use their own helpers. Merging the three
    would put a policy-shaped clause on a Lead query, which matches nothing.
    """
    import app.routers.reports as reports

    assert "return {}" in inspect.getsource(reports._scope)
    assert "visible_filter" in inspect.getsource(reports._policy_scope)
    # Rewards carry `owner_user_id` and `partner_id` too, so the analytics
    # aggregates narrow the same way.
    reward_src = inspect.getsource(reports._reward_scope)
    assert "owner_user_id" in reward_src and "partner_id" in reward_src
    # But NOT the JIT clause: a grant names a POLICY id, which is not a reward
    # id, and being lent sight of one policy is not being lent a share of the
    # month's figures.
    assert "granted_policy_ids" not in reward_src


def test_another_managers_team_policies_need_the_whole_book():
    """`/api/managers/{id}/policies` returns actual policy ROWS.

    `_assert_may_read` is about whose NUMBERS you may read and `view_partners`
    is enough for that — it was never enough for somebody else's BOOK. Without
    the second check this route was the bypass: hold `view_partners`, pass
    another manager's id, read their entire book.
    """
    import app.routers.managers as managers

    src = inspect.getsource(managers.manager_team_policies)
    assert "policy_scope.sees_everything" in src
    assert "HTTP_403_FORBIDDEN" in src
    # Your own team is always readable — that is what /me/policies is.
    assert "str(actor.id) != manager_id" in src


def test_the_export_cannot_be_the_way_round():
    """One button, the entire book, as a spreadsheet. Asserted separately from
    the list because it is a DIFFERENT function that happens to read the same
    collection, and it is the one somebody forgets."""
    import app.routers.policies as pol

    src = inspect.getsource(pol.export_policies)
    assert "policy_scope.merge" in src


# =============================================================================
# Reassigning a partner
# =============================================================================


def test_a_partner_can_only_be_moved_to_an_ACTIVE_employee():
    """An orphaned partner is a partner nobody calls (owner T5.2) — and since
    2026-08-24 it is worse than that: their policies land on a set of screens
    nobody can sign in to open."""
    import app.routers.users as users

    for fn in (users.update_user, users.create_partner):
        assert "assignable_manager_ids" in inspect.getsource(fn), fn.__name__


def test_a_reassignment_gets_its_own_audit_row_and_tells_both_managers():
    """ITS OWN ACTION rather than a line inside ACCOUNT_UPDATED's field diff.

    This is not a field edit in any sense that matters: it moves a book of
    business between two people's screens. Burying "12 policies changed hands"
    inside a diff of `relationship_manager_id` makes "when did this move?"
    unanswerable six months later.

    BOTH managers are told — the new one because they have inherited work they
    know nothing about, the old one because a set of policies vanishing from
    their list with no explanation reads as data loss.
    """
    import app.routers.users as users
    from app.core.enums import AuditAction

    assert hasattr(AuditAction, "PARTNER_REASSIGNED")
    src = inspect.getsource(users._record_reassignment)
    assert "PARTNER_REASSIGNED" in src
    assert "policy_count" in src
    # Two notifications: to_id and from_manager_id.
    assert src.count("create_notification") == 2
    # And it says what does NOT change, which is the half people get wrong.
    assert "You keep the" in src and "credit for what they booked" in src


def test_the_reassignment_preview_writes_nothing():
    """A dry run behind the confirmation dialog. The person may still abandon
    the form, and a preview that wrote would be a reassignment nobody asked
    for."""
    import app.routers.users as users

    src = inspect.getsource(users.reassign_preview)
    for banned in (".save()", ".insert()", ".delete()", "update_many"):
        assert banned not in src, banned
