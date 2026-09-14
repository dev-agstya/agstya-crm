"""Unit tests for the rebuilt permission model (no DB needed).

The owner asked for a small, obvious set of flags that map onto how the agency
is actually staffed, with no roles auto-created on first run. These tests pin
the shape of that model so a future change has to be deliberate.
"""

from dataclasses import dataclass

from app.core import permissions as perms
from app.core.enums import AccountType


@dataclass
class _FakeUser:
    """Enough of a User for the duck-typed permission reads (no DB, no Beanie).

    `permissions_version` defaults to CURRENT, not to 1: almost every test here
    is about how a set written TODAY reads. The compatibility path gets its own
    tests, which pass version 1 explicitly.
    """

    account_type: object
    permissions: list
    permissions_version: int = perms.PERMISSIONS_VERSION


# --- Shape -----------------------------------------------------------------------


def test_every_navigable_section_is_grantable_on_its_own():
    """THE 2026-08-07 ASK. `view_policies` used to be one flag covering leads,
    customers, policies, renewals, quote requests, claims AND the whole catalog,
    so hiring someone to chase renewals handed them the entire book of business
    with every insurer's rate card attached.

    One pair per navigable section is the rule now. The owner's own example was
    "if he wants to give only access of renewals to someone, he can give only
    renewals access" - so each of these has to exist separately.
    """
    for flag in ("view_leads", "manage_leads",
                 "view_customers", "manage_customers",
                 "view_policies", "manage_policies",
                 "view_renewals", "manage_renewals",
                 "view_quotes", "manage_quotes",
                 "view_claims", "manage_claims",
                 "view_transactions", "manage_transactions",
                 "view_finance_overview", "view_balance_sheet",
                 "view_tds", "manage_tds",
                 "view_bank_accounts", "manage_bank_accounts",
                 "view_agency_profit",
                 "view_insurers", "manage_insurers",
                 "view_brokers", "manage_brokers",
                 "view_policy_types", "manage_policy_types",
                 "view_rate_cards", "manage_rate_cards",
                 "view_employees", "manage_employees",
                 "view_partners", "manage_partners",
                 "view_announcements", "manage_announcements",
                 "view_targets", "manage_targets",
                 "manage_roles_permissions",
                 "view_reports", "export_data",
                 "view_audit_logs", "view_sensitive_pii"):
        assert flag in perms.ALL_PERMISSIONS, flag
    assert len(set(perms.ALL_PERMISSIONS)) == len(perms.ALL_PERMISSIONS)


def test_the_merged_umbrellas_are_gone():
    """These are what the split replaced. A surviving `view_team` would mean two
    ways to grant the same access, and the narrower one would quietly stop being
    enforced."""
    for flag in ("view_team", "manage_team", "view_finance", "manage_finance"):
        assert flag not in perms.ALL_PERMISSIONS, flag


def test_the_split_is_by_section_not_by_verb():
    """The OTHER failure mode, and the one this must not drift back into. Before
    2026-07-26 there were 43 flags split by VERB - edit vs delete a customer,
    three separate export flags - and the owner called it "very ugly". Nobody
    staffing an agency thinks "may edit a customer but not delete one".

    Every flag is therefore `view_x` or `manage_x` and nothing else.
    """
    for flag in perms.ALL_PERMISSIONS:
        assert flag.startswith(("view_", "manage_", "export_")), flag
    for flag in ("delete_customers", "delete_policies", "delete_ledger",
                 "edit_ledger", "edit_permissions", "cancel_policies",
                 "record_payments", "assign_leads", "reset_passwords",
                 "export_reports", "manage_roles"):
        assert flag not in perms.ALL_PERMISSIONS, flag


def test_dead_and_partner_portal_flags_are_gone():
    """No policy needs approval any more, and the partner wallet portal is off
    permanently — those flags must not linger as assignable clutter."""
    for flag in ("approve_policies", "approve_withdrawals",
                 "manage_withdrawals", "view_own_reward", "view_team_reward",
                 "manage_reward", "view_all_audit"):
        assert flag not in perms.ALL_PERMISSIONS, flag


def test_every_group_entry_is_a_real_flag_with_help_text():
    """The UI renders whatever PERMISSION_GROUPS says, so a typo here would
    render a checkbox that grants nothing."""
    seen = set()
    for group in perms.PERMISSION_GROUPS:
        assert group["group"] and group["hint"]
        for section in group["sections"]:
            assert section["name"] and section["help"]
            for key in (section["view"], section.get("manage")):
                if key is None:
                    continue
                assert key in perms.ALL_PERMISSIONS, key
                seen.add(key)
    assert seen == set(perms.ALL_PERMISSIONS), "every flag must be displayable"


def test_a_section_pairs_view_with_its_own_manage():
    """The editor renders a section as one ROW with a View and a Manage box, so
    a mismatched pair would put "Manage transactions" next to "View leads"."""
    for group in perms.PERMISSION_GROUPS:
        for section in group["sections"]:
            manage = section.get("manage")
            if manage is None:
                continue
            assert perms.IMPLIES.get(manage) == (section["view"],), section["name"]


# --- Implications ------------------------------------------------------------------


def test_manage_always_implies_view():
    """Granting edit rights while withholding the right to open the screen is
    never what anyone means, and the 403s look like bugs."""
    for manage, implied in perms.IMPLIES.items():
        got = perms.expand_permissions([manage])
        for flag in implied:
            assert flag in got, f"{manage} should imply {flag}"


def test_expand_drops_unknown_flags():
    """A stale key from an older build must not survive in a live set."""
    assert perms.expand_permissions(["view_policies", "approve_policies"]) \
        == ["view_policies"]


def test_expand_is_stable_and_ordered():
    a = perms.expand_permissions(["manage_rate_cards", "view_policies"])
    b = perms.expand_permissions(["view_policies", "manage_rate_cards"])
    assert a == b
    assert a == [p for p in perms.ALL_PERMISSIONS if p in a]


def test_expand_of_nothing_is_nothing():
    assert perms.expand_permissions([]) == []


def test_viewing_profit_stays_independent_of_finance():
    """The owner wants net profit hideable on its own — someone can run the
    finance desk without seeing the house's margin."""
    got = perms.expand_permissions(["view_finance_overview", "view_balance_sheet",
                                    "manage_rate_cards", "manage_transactions"])
    assert "view_agency_profit" not in got


# --- Account types -----------------------------------------------------------------


def test_owner_holds_everything():
    assert perms.permissions_for_account_type(AccountType.OWNER.value) \
        == perms.ALL_PERMISSIONS


def test_the_bank_pair_is_part_of_the_model():
    """Added 2026-08-02, after the owner account already existed. Pinning it
    here alongside the other flags keeps test_an_owner_is_never_missing_a_new_flag
    honest about what "everything" currently means."""
    assert "view_bank_accounts" in perms.ALL_PERMISSIONS
    assert "manage_bank_accounts" in perms.ALL_PERMISSIONS


def test_an_owner_is_never_missing_a_new_flag():
    """THE REGRESSION. An owner's permissions are derived but STORED, so an
    account created before a flag existed has a short list on disk. That is how
    the owner ended up unable to add a bank account on a page their own sidebar
    still showed them: `manage_bank_accounts` simply was not in the array.

    effective_permissions() is the read that must not care what is on disk.
    """
    stale_owner = _FakeUser(AccountType.OWNER, ["view_policies"])
    assert perms.effective_permissions(stale_owner) == perms.ALL_PERMISSIONS
    for flag in perms.ALL_PERMISSIONS:
        assert flag in perms.effective_permissions(stale_owner), flag


def test_effective_permissions_accepts_a_plain_account_type_string():
    """User.account_type is an enum in the app but a bare string in some
    serialisation paths — both must resolve to the same answer."""
    assert perms.effective_permissions(_FakeUser("owner", [])) \
        == perms.ALL_PERMISSIONS


def test_effective_permissions_does_not_inflate_anyone_else():
    """Only the owner is 'everything by definition'. An employee on the CURRENT
    vocabulary is exactly their stored set - inflating them here would silently
    grant the whole app."""
    employee = _FakeUser(AccountType.EMPLOYEE, ["view_policies"])
    assert perms.effective_permissions(employee) == ["view_policies"]
    partner = _FakeUser(AccountType.CHANNEL_PARTNER, [])
    assert perms.effective_permissions(partner) == []


# --- The compatibility path (2026-08-07 split) --------------------------------------


def test_a_legacy_set_is_translated_on_read():
    """An employee whose document predates the split must not lose access
    between the deploy and the boot migration finishing - or if it fails
    entirely. The read applies the same translation the migration writes."""
    legacy = _FakeUser(AccountType.EMPLOYEE, ["view_policies"],
                       permissions_version=1)
    got = perms.effective_permissions(legacy)
    for flag in ("view_leads", "view_customers", "view_policies",
                 "view_renewals", "view_quotes", "view_claims",
                 "view_insurers", "view_brokers", "view_policy_types",
                 "view_rate_cards"):
        assert flag in got, flag


def test_the_same_name_narrows_once_the_set_is_migrated():
    """`view_policies` survived the split with a NARROWER meaning, which is the
    whole reason the translation cannot run on every read: a deliberate, fresh
    grant of "policies only" would be re-widened into the entire old book."""
    migrated = _FakeUser(AccountType.EMPLOYEE, ["view_policies"])
    assert perms.effective_permissions(migrated) == ["view_policies"]


def test_the_old_umbrellas_translate_to_what_they_actually_granted():
    assert set(perms.migrate_legacy_permissions(["view_team"])) == {
        "view_employees", "view_partners"}
    assert set(perms.migrate_legacy_permissions(["manage_team"])) >= {
        "manage_employees", "manage_partners"}
    assert set(perms.migrate_legacy_permissions(["view_finance"])) == {
        "view_finance_overview", "view_balance_sheet", "view_tds"}


def test_migrating_a_set_that_is_already_current_keeps_it():
    """If the version stamp fails to persist, the set is read through the
    migration a second time. Dropping the keys it does not recognise would empty
    the account - so anything already current passes through."""
    current = ["view_renewals", "manage_renewals", "view_bank_accounts"]
    assert set(perms.migrate_legacy_permissions(current)) == set(current)


def test_every_old_flag_has_a_translation():
    """A flag missing from the map is silently dropped for every account that
    holds it - the exact failure this migration exists to avoid."""
    old = {"view_policies", "manage_policies", "view_transactions",
           "manage_transactions", "view_finance", "manage_finance",
           "view_bank_accounts", "manage_bank_accounts", "view_agency_profit",
           "view_team", "manage_team", "manage_roles_permissions",
           "view_announcements", "manage_announcements",
           "view_targets", "manage_targets", "view_reports", "export_data",
           "view_audit_logs", "view_sensitive_pii"}
    assert old <= set(perms.LEGACY_FLAG_MAP), old - set(perms.LEGACY_FLAG_MAP)
    for flag, mapped in perms.LEGACY_FLAG_MAP.items():
        assert mapped, flag
        for new in mapped:
            assert new in perms.ALL_PERMISSIONS, (flag, new)


def test_a_legacy_owner_still_holds_everything():
    """The owner path short-circuits before the version check, so a stale owner
    document is answered from ALL_PERMISSIONS either way."""
    assert perms.effective_permissions(
        _FakeUser(AccountType.OWNER, ["view_policies"],
                  permissions_version=1)) == perms.ALL_PERMISSIONS


def test_effective_permissions_returns_a_copy():
    """Callers hand this straight to a response model; returning the module
    list would let one of them mutate ALL_PERMISSIONS for the whole process."""
    got = perms.effective_permissions(_FakeUser(AccountType.OWNER, []))
    got.append("not_a_real_flag")
    assert "not_a_real_flag" not in perms.ALL_PERMISSIONS

    stored = ["view_policies"]
    got = perms.effective_permissions(_FakeUser(AccountType.EMPLOYEE, stored))
    got.append("manage_policies")
    assert stored == ["view_policies"]


def test_employee_starts_with_nothing():
    assert perms.permissions_for_account_type(AccountType.EMPLOYEE.value) == []


def test_channel_partner_holds_nothing_since_the_portal_is_off():
    assert perms.permissions_for_account_type(
        AccountType.CHANNEL_PARTNER.value) == []


# --- Role templates ------------------------------------------------------------------


def test_no_roles_are_seeded():
    """The owner explicitly does not want Manager / Sales Executive /
    Operations created behind their back."""
    assert not hasattr(perms, "SYSTEM_ROLE_SEEDS")


def test_role_templates_only_reference_real_flags():
    assert perms.ROLE_TEMPLATES, "the create-role dialog needs starting points"
    for template in perms.ROLE_TEMPLATES:
        assert template["key"] and template["name"] and template["description"]
        for flag in template["permissions"]:
            assert flag in perms.ALL_PERMISSIONS, (template["key"], flag)


def test_role_templates_are_internally_consistent():
    """A template that grants manage without view would hand the owner a broken
    role the moment they clicked Save."""
    for template in perms.ROLE_TEMPLATES:
        assert perms.expand_permissions(template["permissions"]) \
            == sorted(set(template["permissions"]),
                      key=perms.ALL_PERMISSIONS.index), template["key"]


def test_the_accountant_template_cannot_see_agency_profit():
    """This is the whole point of splitting the profit flag out."""
    accountant = next(t for t in perms.ROLE_TEMPLATES
                      if t["key"] == "accountant")
    assert "manage_transactions" in accountant["permissions"]
    assert "view_agency_profit" not in accountant["permissions"]


def test_there_is_a_renewals_only_template():
    """The owner's worked example. If it cannot be expressed as a role, the
    split did not achieve what it was for."""
    desk = next(t for t in perms.ROLE_TEMPLATES if t["key"] == "renewals_desk")
    assert "view_renewals" in desk["permissions"]
    assert "manage_renewals" in desk["permissions"]
    assert "view_policies" not in desk["permissions"]
    assert "view_agency_profit" not in desk["permissions"]
    assert "view_transactions" not in desk["permissions"]


def test_a_blank_template_exists():
    assert any(t["permissions"] == [] for t in perms.ROLE_TEMPLATES)


# --- The migration QUERY, which is where this nearly died silently ----------------


def test_the_migration_query_matches_a_document_with_no_version_field():
    """THE BUG. `{"permissions_version": {"$lt": 2}}` does NOT match a document
    where the field is ABSENT — Mongo's comparison operators only match values
    that exist. Every account written before the field was added has no such
    key, so the obvious query matched exactly ZERO of the users who needed
    migrating: silently, on every boot, forever.

    Nobody would have lost access (effective_permissions translates at read
    time), which is precisely why it would have gone unnoticed — the stored sets
    would simply have stayed in the old vocabulary for good.

    Asserted against the query DOCUMENT rather than a live Mongo, so it fails
    for the next person who "simplifies" it back.
    """
    from app.services.permissions_svc import NEEDS_MIGRATION

    clauses = NEEDS_MIGRATION["$or"]
    assert {"permissions_version": {"$exists": False}} in clauses, (
        "a document with no permissions_version is the ENTIRE legacy "
        "population; without this clause the migration is a no-op")
    assert {"permissions_version": {"$lt": perms.PERMISSIONS_VERSION}} in clauses


def test_the_migration_is_guarded_by_the_version_not_by_the_data():
    """Running the translation twice on a set holding `view_policies` would
    re-expand it into the whole pre-split book, so the guard has to be the
    stamp. This pins that migrate_user_permissions checks it."""
    import inspect

    from app.services import permissions_svc

    src = inspect.getsource(permissions_svc.migrate_user_permissions)
    assert "permissions_version" in src
    assert ">= PERMISSIONS_VERSION" in src
