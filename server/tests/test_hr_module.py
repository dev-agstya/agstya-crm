"""The Workplace HR module's contracts: permissions, boundaries, and the
promise that no money got into it.

Three groups of tests, each pinning a decision that fails SILENTLY if it drifts:

  1. THE PERMISSION SHAPE. Seven new flags, one pair per page plus `view_salary`
     standing alone. A missing flag does not error — it just means a page nobody
     can be granted, or a figure everybody can read.
  2. THE PARTNER BOUNDARY. Every HR router carries the staff-only guard at
     ROUTER level. test_partner_boundary already sweeps for this globally; these
     name the three routers so a failure says which one.
  3. NO MONEY. The owner dropped payslips on 2026-08-20 and asked for the
     amounts to come out. A rupee field creeping back into an HR schema is
     exactly the kind of thing nobody notices until it is on a screen.
"""

from __future__ import annotations

import inspect

import pytest

from app.core import permissions as perms
from app.core.dependencies import get_inhouse_user
from app.main import app


# =============================================================================
# 1. The permission shape
# =============================================================================


def test_each_hr_page_is_grantable_on_its_own():
    """One pair per NAVIGABLE SECTION, the rule the whole catalogue follows.

    Attendance, Leave and Holidays are three sidebar pages, so they are three
    pairs — hiring somebody to approve leave must not hand them the register,
    and letting somebody declare a holiday must not hand them either.
    """
    for flag in ("view_attendance", "manage_attendance",
                 "view_leave", "manage_leave",
                 "view_holidays", "manage_holidays",
                 "view_payslips", "manage_payslips",
                 "view_salary"):
        assert flag in perms.ALL_PERMISSIONS, flag


def test_manage_implies_view_for_every_hr_pair():
    for manage, view in (("manage_attendance", "view_attendance"),
                         ("manage_leave", "view_leave"),
                         ("manage_holidays", "view_holidays")):
        assert perms.IMPLIES[manage] == (view,)
        assert view in perms.expand_permissions([manage])


def test_salary_has_no_manage_flag():
    """Setting a salary is part of editing the employee, which `manage_employees`
    already covers. A `manage_salary` would be a second answer to "may I edit
    this person's record", and two answers is how they start disagreeing."""
    assert "manage_salary" not in perms.ALL_PERMISSIONS


def test_salary_is_not_the_same_decision_as_sensitive_pii():
    """They rode together until 2026-08-20, which meant "may see identity
    documents" and "may see what people are paid" were one grant. An accountant
    may well need a PAN and have no business knowing a salary; in a small office
    the reverse is just as common."""
    assert perms.VIEW_SALARY != perms.VIEW_SENSITIVE_PII
    assert perms.VIEW_SENSITIVE_PII not in perms.IMPLIES.get(
        perms.VIEW_SALARY, ())
    assert perms.VIEW_SALARY not in perms.IMPLIES.get(
        perms.VIEW_SENSITIVE_PII, ())


def test_the_hr_flags_are_displayable_in_the_editor():
    """The UI renders whatever PERMISSION_GROUPS says, so a flag missing from it
    is a flag nobody can ever be granted — a permanently dead page."""
    shown = {key for group in perms.PERMISSION_GROUPS
             for section in group["sections"]
             for key in (section["view"], section.get("manage")) if key}
    for flag in ("view_attendance", "manage_attendance", "view_leave",
                 "manage_leave", "view_holidays", "manage_holidays",
                 "view_salary"):
        assert flag in shown, flag


def test_the_hr_group_exists_and_says_what_needs_no_flag():
    """The hint has to say that everybody reaches their OWN attendance and leave
    without any of these, because the flag names alone read as though nobody can
    clock in until an owner ticks something."""
    group = next((g for g in perms.PERMISSION_GROUPS
                  if g["group"] == "Workplace HR"), None)
    assert group is not None, "the Workplace HR permission group is missing"
    assert "own" in group["hint"].lower()


def test_an_owner_holds_every_hr_flag_without_being_re_saved():
    """`User.permissions` is a stored snapshot and the owner's goes stale — the
    owner is written once by create_owner.py and never re-saved, so every new
    flag would otherwise leave them locked out of a page their own sidebar
    shows them. `effective_permissions` derives it instead."""
    class _Owner:
        account_type = "owner"
        permissions: list = []
        permissions_version = perms.PERMISSIONS_VERSION

    held = perms.effective_permissions(_Owner())
    for flag in ("view_attendance", "manage_attendance", "view_leave",
                 "manage_leave", "view_holidays", "manage_holidays",
                 "view_salary"):
        assert flag in held, flag


def test_a_legacy_permission_set_does_not_pick_up_the_hr_flags():
    """LEGACY_FLAG_MAP translates the PRE-SPLIT vocabulary. These flags did not
    exist then, so no old set can imply them — an employee migrated from the old
    model must not silently gain the right to read everybody's attendance."""
    migrated = perms.migrate_legacy_permissions(["view_policies", "view_team"])
    for flag in ("view_attendance", "view_leave", "manage_holidays",
                 "view_salary"):
        assert flag not in migrated, flag


def test_a_current_set_holding_an_hr_flag_survives_migration():
    """The other direction, and the one that would silently REMOVE access: a set
    written by the new editor whose version stamp failed to persist must be
    passed through, not emptied."""
    migrated = perms.migrate_legacy_permissions(
        ["view_attendance", "manage_leave"])
    assert "view_attendance" in migrated
    assert "manage_leave" in migrated
    assert "view_leave" in migrated          # implied by manage


# =============================================================================
# 2. The partner boundary
# =============================================================================


HR_PREFIXES = ("/api/hr/attendance", "/api/hr/leave", "/api/hr/holidays")


def _hr_routes():
    for route in app.routes:
        path = getattr(route, "path", "")
        if path.startswith("/api/hr/"):
            yield route


def _has_inhouse_guard(route) -> bool:
    dependant = getattr(route, "dependant", None)
    for dep in (dependant.dependencies if dependant else []):
        if dep.call is get_inhouse_user:
            return True
        for sub in dep.dependencies:
            if sub.call is get_inhouse_user:
                return True
    return False


def test_every_hr_endpoint_is_closed_to_channel_partners():
    """A partner reaching an HR endpoint would read the whole agency's staff
    roster. They are external, they are not covered by this module at all
    (owner A10), and the guard is on the ROUTER so a new route here is closed by
    default rather than by somebody remembering."""
    unguarded = [f"{sorted(r.methods)} {r.path}"
                 for r in _hr_routes() if not _has_inhouse_guard(r)]
    assert not unguarded, (
        "These HR endpoints are reachable by a signed-in channel partner:\n  "
        + "\n  ".join(sorted(unguarded)))


def test_the_three_hr_routers_are_all_mounted():
    """A router written and never registered in main.py is a feature that ships
    as a 404. It has happened in this repo before with a client calling an
    endpoint that did not exist."""
    paths = {getattr(r, "path", "") for r in app.routes}
    for prefix in HR_PREFIXES:
        assert any(p.startswith(prefix) for p in paths), prefix


def test_the_punch_endpoints_take_no_user_and_no_date():
    """A backdated or delegated self-punch is an attendance system that records
    nothing (owner C3/C6). The absence of the parameter is the safeguard — a
    check inside the body could be removed by somebody who did not know why it
    was there."""
    from app.routers import attendance as router_mod

    for name in ("punch_in", "punch_out", "break_start", "break_end"):
        sig = inspect.signature(getattr(router_mod, name))
        params = set(sig.parameters)
        assert "user_id" not in params, f"{name} accepts a user_id"
        assert "day" not in params and "date" not in params, \
            f"{name} accepts a date"


def test_a_correction_is_always_about_the_caller():
    """Raising one for somebody else is a MANAGER'S EDIT, which is PATCH /day
    and demands a reason on the record. The schema having no user_id is what
    keeps the two apart."""
    from app.schemas.hr import CorrectionCreate
    assert "user_id" not in CorrectionCreate.model_fields


# =============================================================================
# 3. The money lives in ONE place
# =============================================================================
#
# THIS SECTION WAS INVERTED ON 2026-08-24, not deleted, and the distinction is
# the whole point of keeping it.
#
# It used to assert that Workplace HR carried no money at all — the owner's
# instruction on 2026-08-20 ("remove the salary and the amount being calculated
# here... no money anywhere in it"). The owner reversed that four days later and
# asked for payroll: "based on the attendance of the employee and the salary
# which is set of an employee, at the end of month, a salary should be
# calculated... so that the owner knows how much to pay each employee."
#
# A test asserting removed behaviour is worse than no test — this repo has the
# scar (`policyRecordAug04.test.ts` pinned the paused-portal copy and therefore
# pinned the BUG in place). So the assertions were rewritten to say what is true
# now, which is a NARROWER claim than "no money" and a more useful one:
#
#   * `services/payroll` is the only module in the HR services that multiplies.
#   * The REGISTER — attendance, leave, the calendar — still carries none, so an
#     employee disputing a payslip is disputing a DAY, on a screen they can open.
#   * Payroll reaches the ledger through `finance._post_expense` and nothing
#     else, so a salary paid from a payslip and one keyed by hand are the same
#     row.


MONEY_WORDS = ("salary", "amount", "paise", "rupee", "inr", "deduction",
               "gross", "net_pay", "payslip", "ctc")


def test_no_hr_schema_has_a_money_field():
    """The REGISTER carries no money. Still true, and still the rule.

    `schemas/hr` is attendance, leave and holidays — days and hours. Payroll's
    shapes live in `schemas/payroll` deliberately so this sweep goes on
    protecting the register rather than being widened until it protects nothing.

    The omission is the safeguard, exactly as it is on the partner portal: a
    schema with no field for a figure cannot leak one, and cannot quietly grow
    logic that computes one.
    """
    import app.schemas.hr as hr_schemas
    from pydantic import BaseModel

    offenders = []
    for name, obj in vars(hr_schemas).items():
        if not (inspect.isclass(obj) and issubclass(obj, BaseModel)):
            continue
        if obj.__module__ != hr_schemas.__name__:
            continue
        for field in obj.model_fields:
            if any(word in field.lower() for word in MONEY_WORDS):
                offenders.append(f"{name}.{field}")
    assert not offenders, (
        "The attendance/leave register carries no money — payroll's shapes go "
        "in schemas/payroll. Move or remove:\n  " + "\n  ".join(offenders))


def test_the_hr_settings_carry_no_money():
    """Still true after payroll shipped, and load-bearing.

    A rupee on `HrSettings` would be a pay rule stored beside the shift times,
    editable on the Attendance & leave settings page, and applied retroactively
    like everything else there — which for money would silently restate months
    that have already been paid. The one payroll constant that exists
    (`PAYROLL_DAYS_PER_MONTH`) is a CONSTANT in the model for exactly that
    reason: changing what an absence costs should be a deploy somebody thought
    about, not a text box.
    """
    from app.models.settings import HrSettings
    for field in HrSettings.model_fields:
        assert not any(w in field.lower() for w in MONEY_WORDS), field


def _imported_names(module) -> set[str]:
    """Every name a module IMPORTS, read from its AST.

    Deliberately the imports rather than a substring search over the source:
    these files discuss `PartyAccount` and the bank ledger in their docstrings,
    because the append-only balance here is modelled on them. Explaining a
    pattern is not using it, and a test that cannot tell the difference is one
    that punishes the comments.

    An import is also the first thing that appears when somebody starts wiring a
    module up to something, so it is the right thing to watch.
    """
    import ast

    tree = ast.parse(inspect.getsource(module))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[-1])
                names.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            names.add(node.module or "")
            for alias in node.names:
                names.add(alias.asname or alias.name)
    return names


BANNED_MONEY_NAMES = {
    "LedgerTxn", "PartyAccount", "BankAccount", "PolicyFinance",
    "TdsEntry", "Wallet", "WalletTxn",
    "app.services.bank", "app.services.wallet",
    "app.services.finance", "app.services.finance_balance",
}


def test_the_register_never_reaches_the_finance_ledger():
    """Attendance, leave and holidays record DAYS. Still true after payroll.

    Same shape as the rule that a claim never touches the ledger, and asserted
    the same way: by what the module imports. An import is the first thing that
    appears when somebody starts wiring a module up to something, so it is the
    right thing to watch.

    `services/hr_daily` is in this list even though it now calls payroll as its
    fifth step — it calls `payroll.run_monthly()` and knows nothing about what
    that does, which is exactly the separation being pinned.
    """
    import app.routers.attendance as a
    import app.routers.holidays as h
    import app.routers.leave as lv
    import app.services.hr_attendance as sa
    import app.services.hr_calendar as sc
    import app.services.hr_daily as sd
    import app.services.hr_leave as sl

    for module in (a, h, lv, sa, sc, sd, sl):
        clash = _imported_names(module) & BANNED_MONEY_NAMES
        assert not clash, (
            f"{module.__name__} imports {sorted(clash)} — the attendance and "
            f"leave register must not reach the finance ledger. Payroll is "
            f"the one module that carries money (services/payroll).")


def test_payroll_computes_but_never_posts():
    """`services/payroll` multiplies. It does not write to the books.

    The boundary that keeps the register arguable, from the other side: payroll
    reads `hr_attendance.summarise()` and turns a day count into rupees, and
    that is ALL it does. Recording the payment is a separate, deliberate act by
    a person on `routers/payslips`, which posts through `finance._post_expense`.

    If this ever fails, somebody has made generating a payslip write a ledger
    row — which would mean the monthly cron silently books thirty salary
    expenses on the 1st for money nobody has actually paid yet.
    """
    import app.services.payroll as p

    clash = _imported_names(p) & BANNED_MONEY_NAMES
    assert not clash, (
        f"services/payroll imports {sorted(clash)}. It computes a figure; "
        f"posting it is routers/payslips, through finance._post_expense.")


def test_paying_a_payslip_goes_through_the_shared_expense_path():
    """The ONE place payroll touches the ledger, and it borrows rather than
    writes.

    `routers/payslips.mark_paid` fills in an `ExpenseCreate` and calls
    `finance._post_expense` — the same function the Add-transaction form and
    the bank-statement importer use. That function owns the bank delta, the
    account requirement and the idempotency key. A payroll module with its own
    copy of those would drift within a release, and then a salary paid from a
    payslip and one keyed by hand would be two different kinds of row in every
    report.
    """
    import inspect as _inspect

    import app.routers.payslips as r

    source = _inspect.getsource(r)
    assert "_post_expense" in source
    # The model must NOT be reachable from here: constructing a LedgerTxn is
    # what "writing its own ledger row" looks like.
    assert "LedgerTxn(" not in source
    for banned in ("PartyAccount", "bank_delta_paise", "apply_delta"):
        assert banned not in source, (
            f"routers/payslips reaches {banned} directly. Everything about "
            f"posting belongs to finance._post_expense.")


def test_payslips_are_live_and_reachable():
    """INVERTED on 2026-08-24 (it asserted payslips were NOT built).

    The owner reversed the 2026-08-20 decision and asked for the calculation
    back. A test that goes on asserting the absence of a shipped feature is a
    permanently red suite, which teaches people to ignore red — so it now
    asserts the feature is actually WIRED, which is the failure this repo keeps
    having (`quotesApi.markBooked` existed, worked, and was called from nowhere
    for weeks).
    """
    paths = {getattr(r, "path", "") for r in app.routes}
    assert any("payslip" in p for p in paths), (
        "The payslips router is not registered in app/main.py.")
    for path in ("/api/hr/payslips", "/api/hr/payslips/mine",
                 "/api/hr/payslips/run/{month}"):
        assert path in paths, f"{path} is not routed."


# =============================================================================
# The salary field itself
# =============================================================================


def test_the_dead_annual_ctc_field_is_gone():
    """`salary_ctc` was on the model from the beginning and no editor in the app
    ever wrote it, so no live account carried a value. Keeping it alongside
    `monthly_salary_paise` would give the app two salary fields, one of which is
    always empty and always wrong."""
    from app.models.user import EmployeeProfile
    assert "salary_ctc" not in EmployeeProfile.model_fields
    assert "monthly_salary_paise" in EmployeeProfile.model_fields


def test_the_salary_is_stripped_rather_than_masked():
    """Gated the way house profit is: the server removes the value, so a
    devtools tweak reveals nothing. A masked string would still tell you a
    salary had been set."""
    from app.models.user import EmployeeProfile
    from app.schemas.user import _strip_salary

    prof = EmployeeProfile(monthly_salary_paise=1_500_000,
                           designation="Executive")
    stripped = _strip_salary(prof)
    assert stripped.monthly_salary_paise is None
    assert stripped.designation == "Executive"     # nothing else is touched
    assert prof.monthly_salary_paise == 1_500_000  # the original is untouched


def test_hiding_the_salary_is_the_default_on_serialisation():
    """A call site that forgets the flag must err towards NOT leaking. The
    opposite default would make every new serialisation path a potential
    disclosure — and this app has shipped a list/detail serialiser drifting
    apart before."""
    import inspect as _inspect
    from app.schemas.user import UserOut

    sig = _inspect.signature(UserOut.from_model)
    assert sig.parameters["hide_salary"].default is True


def test_the_employee_profile_carries_what_hr_reads():
    """`date_of_joining` is load-bearing now — leave accrues from it and days
    before it are never absences. It existed on the model from the beginning and
    no form collected it, which is why it is asserted here rather than assumed."""
    from app.models.user import EmployeeProfile
    for field in ("date_of_joining", "shift_start", "shift_end",
                  "monthly_leave_accrual"):
        assert field in EmployeeProfile.model_fields, field


# =============================================================================
# Settings
# =============================================================================


def test_every_settings_block_is_actually_merged():
    """THE BUG THIS CAUGHT. `settings_svc.update` handled `whatsapp` and `email`
    with two hand-written branches and silently ignored `partner_portal` — so
    the Partner Portal settings page PATCHed, got a 200 and a full response
    back, and changed nothing. The switches sprang back on the next load.

    Adding `hr` would have been the third chance to make the same omission, so
    the branches became a list. This asserts every block on the document is in
    it."""
    from app.models.settings import SystemSettings
    from app.services.settings_svc import _BLOCKS
    from pydantic import BaseModel

    nested = {name for name, field in SystemSettings.model_fields.items()
              if inspect.isclass(field.annotation)
              and issubclass(field.annotation, BaseModel)}
    assert nested <= set(_BLOCKS), (
        f"settings_svc.update silently ignores: {sorted(nested - set(_BLOCKS))}")


def test_the_settings_payload_can_carry_hr_policy():
    from app.schemas.settings import SettingsOut, SettingsUpdate
    assert "hr" in SettingsUpdate.model_fields
    assert "hr" in SettingsOut.model_fields


def test_every_hr_setting_can_actually_be_SAVED():
    """One level down from the block test above, and the same failure.

    `settings_svc.update` merges each block with `model_copy(update=...)` built
    from `HrSettingsUpdate`. A field the MODEL has and that schema does not is
    silently dropped: the PATCH returns 200 with a full body and nothing
    changes. That is exactly how the `partner_portal` block behaved for weeks.

    "A field on a model that no schema declares is a field that cannot be
    saved" — this is that rule, enforced field by field rather than trusted to
    whoever adds the next one. It caught the geofence fields on the way in
    (2026-08-21).
    """
    from app.models.settings import HrSettings
    from app.schemas.hr import HrSettingsUpdate

    missing = set(HrSettings.model_fields) - set(HrSettingsUpdate.model_fields)
    assert not missing, (
        "these HrSettings fields would be silently dropped by a PATCH: "
        f"{sorted(missing)}")


def test_the_geofence_ships_switched_off():
    """Nothing changes on deploy. Switching it on is a decision somebody makes
    on the settings page AFTER checking the pin on a map — a wrong centre marks
    the whole office work-from-home and no screen would explain why."""
    from app.models.settings import HrSettings
    assert HrSettings().geofence_enabled is False
    # And a punch is never refused for want of a location unless asked for.
    assert HrSettings().require_location is False


def test_the_geofence_defaults_to_the_owners_office_and_radius():
    """HMWQ+FQ Udaipur decoded (7JPMHMWQ+FQ), and the owner's 150 m."""
    from app.models.settings import HrSettings
    hr = HrSettings()
    assert round(hr.office_lat, 4) == 24.5962
    assert round(hr.office_lng, 4) == 73.6894
    assert hr.office_radius_m == 150


def test_a_half_day_longer_than_a_full_day_is_refused():
    """Clamping it silently would make every day a half day, and the person who
    typed it would only find out at month end."""
    from pydantic import ValidationError
    from app.schemas.hr import HrSettingsUpdate

    with pytest.raises(ValidationError):
        HrSettingsUpdate(full_day_minutes=480, half_day_minutes=600)


def test_the_office_cannot_be_closed_every_day():
    from pydantic import ValidationError
    from app.schemas.hr import HrSettingsUpdate

    with pytest.raises(ValidationError):
        HrSettingsUpdate(week_off_days=[0, 1, 2, 3, 4, 5, 6])


def test_the_default_week_is_monday_to_saturday():
    """Owner: "we work from Monday to Saturday, only weekly off on Sunday,
    nothing else". Python's weekday() puts Sunday at 6."""
    from app.models.settings import HrSettings
    assert HrSettings().week_off_days == [6]


def test_the_default_accrual_is_one_and_a_half_days():
    from app.models.settings import HrSettings
    assert HrSettings().monthly_leave_accrual == 1.5


# =============================================================================
# Indexes that ENFORCE something
# =============================================================================


def test_the_enforcing_hr_indexes_are_declared_critical():
    """db.py's index fallback is ALL-OR-NOTHING: one bad spec means no index on
    any model is built, and it shows up only as a log line. CRITICAL_INDEXES is
    what makes the app say so out loud. Without the accrual's unique index
    everybody quietly earns 3 days a month instead of 1.5."""
    from app.db import CRITICAL_INDEXES
    assert "attendance_user_day_unique" in CRITICAL_INDEXES["attendance_days"]
    assert "leave_ledger_period_unique" in CRITICAL_INDEXES["leave_ledger"]
    assert "holiday_date_unique" in CRITICAL_INDEXES["holidays"]


def test_the_partial_filter_avoids_the_ne_trap():
    """`"$ne": ""` compiles to $not, which Mongo rejects outright — and because
    the fallback is all-or-nothing, ONE such spec means NO index anywhere. It
    has already cost this repo `policy_number_unique` in production. `"$gt": ""`
    is the allowed spelling of "non-empty string"."""
    import pymongo
    from app.models.leave import LeaveLedgerRow

    specs = [i for i in LeaveLedgerRow.Settings.indexes
             if isinstance(i, pymongo.IndexModel)]
    doc = next(i.document for i in specs
               if i.document["name"] == "leave_ledger_period_unique")
    expr = doc["partialFilterExpression"]["period_key"]
    assert "$ne" not in expr
    assert expr["$gt"] == ""


def test_the_hr_models_are_registered_for_beanie():
    """A model that is not in `_document_models()` raises the moment anything
    touches it — but only at RUNTIME, on the first request that uses it."""
    from app.db import _document_models
    names = {m.__name__ for m in _document_models()}
    for name in ("AttendanceDay", "AttendanceCorrection", "LeaveRequest",
                 "LeaveLedgerRow", "Holiday"):
        assert name in names, name
