"""Granular permission flags, account-type defaults, and role templates.

RBAC has two layers:
  1. AccountType  — coarse kind of account (owner / employee / partner).
  2. Permissions  — fine-grained flags.

Where the flags come from:
  - Owner   : always the full set (ALL_PERMISSIONS).
  - Channel Partner  : an EMPTY set (PARTNER_PERMISSIONS) — see the note on it
              below. Partners can sign in; they simply reach nothing that is
              gated on a flag.
  - Employee: their own directly-managed set, denormalised onto User.permissions
              by services.permissions_svc.recompute_permissions so request-time
              checks stay a single in-memory lookup.

DESIGN (2026-08-07 rewrite, owner-directed) — ONE PAIR PER SECTION
------------------------------------------------------------------
The model has been through both extremes now, and the history matters because
it explains the shape:

  * Before 2026-07-26 there were 43 flags split by VERB — edit vs delete a
    customer, three separate export flags, a `manage_finance` umbrella that
    overlapped `record_payments`. The owner called it "very ugly", and it was:
    nobody staffing a small agency thinks "this person may edit a customer but
    not delete one".
  * That was collapsed to 20 flags: one pair per *broad area*. Too far the other
    way. `view_policies` was a single flag covering leads, customers, policies,
    renewals, quote requests, claims, insurers, brokers, policy types and rate
    cards — so hiring someone to chase renewals handed them the entire book of
    business, every insurer's rate card included.

The rule now is **one `view_x` / `manage_x` pair per NAVIGABLE SECTION** — per
page in the sidebar, not per verb inside it. `view_x` opens the section,
`manage_x` adds create + edit + delete within it. That is what makes 42 flags
readable where 43 were not: the catalogue has the same shape as the sidebar, so
"give this person renewals and nothing else" is one row to find and one box to
tick.

Splitting by verb is what must not come back. If a future ask sounds like
"let them edit but not delete", that is a *workflow* question (an approval
step, a status), not another flag.

Flags that deliberately stand ALONE, because they are not "a page":
  - `view_agency_profit`  — house/net profit is the agency's most sensitive
    number and is zeroed server-side without it. Someone can run the whole
    finance desk and still not see the margin.
  - `view_sensitive_pii`  — unmask PAN / Aadhaar / bank / UPI.
  - `export_data`         — taking data OUT of the building is its own decision,
    independent of which sections you may read.
  - `manage_roles_permissions` — deciding what everyone else may reach.
  - `view_all_policies`   — the WIDTH of the Policies section rather than a
    section of its own: without it you read your own book, with it you read
    the agency's. See its own note below.
  - `manage_policy_access` — deciding a colleague's time-limited request to
    read a policy that is not theirs.
  - `view_payslips` / `manage_payslips` are a normal pair; `view_salary` stands
    alone beside them because the contracted figure and last month's payslip
    are different disclosures.

RECORD-LEVEL SCOPING, AND WHERE IT DOES AND DOES NOT EXIST
-----------------------------------------------------------
The blanket "v1 has no record-level data scoping" that used to close this
docstring is no longer true, and the exception is deliberately ONE thing:

  * POLICIES are scoped, from 2026-08-24 (owner). An employee reads the
    policies they booked plus the policies booked by the channel partners on
    their roster RIGHT NOW, unless they hold `view_all_policies`. The rule
    lives in services/policy_scope and is applied in the QUERY.
  * EVERYTHING ELSE — customers, leads, transactions, the catalog — is still
    unscoped and access is decided by flags alone. `core/scoping.py`,
    `visible_user_ids()` and the per-employee `data_scope` field remain
    deleted, and reintroducing them is still not the plan.

The distinction matters because they fail differently. A flag is a decision
somebody made in an editor; a scope is derived from today's roster and changes
under you when a partner is reassigned — which is exactly what the owner asked
for ("as soon as I move the partner, all the policies related to that channel
partner should also be moved to the new employee").
"""

from app.core.enums import AccountType

# Bumped whenever the flag vocabulary changes in a way that needs existing
# stored sets translated. See LEGACY_FLAG_MAP and services/permissions_svc.
PERMISSIONS_VERSION = 2


# =============================================================================
# 1. The book of business  (sidebar: "Work")
# =============================================================================
# One pair per page. These used to be a single `view_policies` / `manage_policies`
# pair covering all six, which is why the split exists at all.

VIEW_LEADS = "view_leads"
MANAGE_LEADS = "manage_leads"

VIEW_CUSTOMERS = "view_customers"
MANAGE_CUSTOMERS = "manage_customers"

VIEW_POLICIES = "view_policies"
MANAGE_POLICIES = "manage_policies"

# THE WHOLE BOOK, rather than only what you brought in (owner 2026-08-24).
#
# Stands alone, exactly like `view_agency_profit`: it is not a page, it is the
# WIDTH of a page somebody already holds. `view_policies` opens the Policies
# section; this decides whether that section is the agency's entire book or the
# caller's own — the policies they booked themselves, plus the policies booked
# by the channel partners currently on their roster.
#
# WITHOUT IT IS THE DEFAULT, and that is the change. Until now every employee
# with `view_policies` read every policy in the agency, which the owner asked
# to end: "we only want them to see their own data". So a grant of
# `view_policies` narrowed on the day this shipped and existing accounts were
# NOT given this flag — the owner holds it by being the owner, and anybody else
# who genuinely needs the whole book is granted it deliberately.
#
# The scope itself is computed in services/policy_scope, never here, and is
# applied IN THE QUERY. A visibility rule enforced in a serialiser is a
# visibility rule that leaks through `?page_size=100` and the export.
VIEW_ALL_POLICIES = "view_all_policies"

# Deciding a colleague's request to read a policy that is not theirs, for a
# fixed window ("JIT access" — the owner's term, from support tooling).
#
# Its own flag rather than `manage_policies`, because the two are different
# jobs: booking policies is the day job, and granting somebody sight of
# another desk's customer is a supervisory act with an expiry on it. In a small
# agency this is usually the owner and one senior person.
#
# NAMED `manage_`, NOT `approve_`, and that is not cosmetic. This catalogue's
# oldest rule is that flags are never split by VERB (43 of them once were, and
# the owner called it "very ugly"); a flag called `approve_x` reads as the first
# of a family — approve, revoke, extend — and `tests/test_permissions_model`
# refuses the prefix outright for exactly that reason. What is being managed is
# the ACCESS GRANTS, which are their own objects with their own lifecycle, so
# `manage_policy_access` is also the more honest name.
MANAGE_POLICY_ACCESS = "manage_policy_access"

# Renewals is its own page and its own job — the owner's example of a permission
# that had to be grantable on its own. It is a *scoped* view of policies: the
# list endpoint forces the expiring-soon window for anyone holding this without
# `view_policies`, so the flag cannot be used to read the whole book.
VIEW_RENEWALS = "view_renewals"
MANAGE_RENEWALS = "manage_renewals"

VIEW_QUOTES = "view_quotes"
MANAGE_QUOTES = "manage_quotes"

VIEW_CLAIMS = "view_claims"
MANAGE_CLAIMS = "manage_claims"


# =============================================================================
# 2. Money  (sidebar: "Finance")
# =============================================================================
# The cash ledger: who paid what, when.
VIEW_TRANSACTIONS = "view_transactions"
MANAGE_TRANSACTIONS = "manage_transactions"

# The Finance Overview page — the agency's money at a glance.
VIEW_FINANCE_OVERVIEW = "view_finance_overview"

# Who owes whom: party balances, receivable / payable, the statement PDFs.
VIEW_BALANCE_SHEET = "view_balance_sheet"

# Tax deducted at source — its own page, and a compliance job that is often one
# person's whole responsibility.
VIEW_TDS = "view_tds"
MANAGE_TDS = "manage_tds"

# The agency's OWN cash position — what is actually in the bank right now. More
# sensitive than the ledger (which shows who owes what): someone can reconcile
# the whole book without being told how much money the house is sitting on.
VIEW_BANK_ACCOUNTS = "view_bank_accounts"
MANAGE_BANK_ACCOUNTS = "manage_bank_accounts"

# House/net profit anywhere it appears. Without it the server ZEROES the figure
# rather than hiding the column, so a client-side tweak cannot reveal it.
VIEW_AGENCY_PROFIT = "view_agency_profit"


# =============================================================================
# 3. Catalog — the money RULES  (sidebar: "Administration -> Catalog")
# =============================================================================
# Reading an insurer list and editing the rate card that decides commission are
# very different acts of trust, and they used to share `manage_finance`.

VIEW_INSURERS = "view_insurers"
MANAGE_INSURERS = "manage_insurers"

VIEW_BROKERS = "view_brokers"
MANAGE_BROKERS = "manage_brokers"

VIEW_POLICY_TYPES = "view_policy_types"
MANAGE_POLICY_TYPES = "manage_policy_types"

# Rate cards decide what the agency earns and what a partner is paid. Its own
# pair, and the one to grant last.
VIEW_RATE_CARDS = "view_rate_cards"
MANAGE_RATE_CARDS = "manage_rate_cards"


# =============================================================================
# 4. People  (sidebar: "Workplace HR")
# =============================================================================
# Employees and channel partners were one `view_team` / `manage_team` pair. They
# are different populations managed by different people: an agency's partner
# manager has no business in staff records, and HR has none in the partner book.

VIEW_EMPLOYEES = "view_employees"
MANAGE_EMPLOYEES = "manage_employees"

VIEW_PARTNERS = "view_partners"
MANAGE_PARTNERS = "manage_partners"

# Broadcasting to every channel partner at once. Its OWN pair (owner D5): a
# broadcast cannot be unsent, so being able to send one should be a deliberate
# grant, not a side effect of being able to add an employee.
VIEW_ANNOUNCEMENTS = "view_announcements"
MANAGE_ANNOUNCEMENTS = "manage_announcements"

# Everyone always sees their OWN targets without any flag; these cover *others*.
VIEW_TARGETS = "view_targets"
MANAGE_TARGETS = "manage_targets"

# Deciding what everybody else can reach. Stands alone — it is not a page.
MANAGE_ROLES_PERMISSIONS = "manage_roles_permissions"


# =============================================================================
# 4b. Workplace HR  (sidebar: "Workplace HR" -> Attendance / Leave / Holidays)
# =============================================================================
# Added 2026-08-20 with the HR module. One pair per page, same rule as the rest.
#
# WHAT THESE DO **NOT** COVER, and it matters: every employee always reaches
# their OWN attendance, their own leave and the holiday list with NO flag at
# all. That is the same rule targets already follow — being told your own
# number is not a privilege — and it is enforced in the routers by scoping to
# `actor.id` when the flag is absent, not by hiding a button. These three pairs
# are strictly about reading and editing OTHER PEOPLE's.

# The register, the team board, the day editor and the correction queue.
VIEW_ATTENDANCE = "view_attendance"
MANAGE_ATTENDANCE = "manage_attendance"

# Somebody else's leave, and the approval queue. `manage_leave` is the right to
# approve — there is no separate "approve" flag, because splitting by VERB is
# the failure mode this catalogue was rebuilt to get away from.
VIEW_LEAVE = "view_leave"
MANAGE_LEAVE = "manage_leave"

# The yearly holiday list. `view_holidays` is granted to every employee
# structurally (the list is not sensitive and everybody needs to plan around
# it); the pair exists so `manage_holidays` — who may declare a day off for the
# whole agency — is grantable on its own.
VIEW_HOLIDAYS = "view_holidays"
MANAGE_HOLIDAYS = "manage_holidays"

# An employee's monthly salary, on their profile. STANDS ALONE, exactly like
# `view_agency_profit`: it is a sensitive FIGURE, not a page, and the same
# treatment applies — the server strips it from the response rather than the
# client hiding it, so a devtools tweak reveals nothing. In a small office this
# is the most sensitive field on a staff record, more so than house profit.
#
# There is no `manage_salary`: setting one is part of editing the employee, and
# `manage_employees` already means "you may edit this person's record".
VIEW_SALARY = "view_salary"

# Payslips (owner 2026-08-24) — the decision that was dropped on 2026-08-20 and
# is now taken the other way. "At the end of month, a salary should be
# calculated… so that the owner knows how much to pay each employee."
#
# EVERYBODY READS THEIR OWN WITH NO FLAG, exactly like attendance and leave —
# a payslip is a statement OF somebody, and being told what you are owed is not
# a privilege. `view_payslips` opens SOMEBODY ELSE'S; `manage_payslips` is the
# pay desk: regenerate a draft, finalise a month, record the payment.
#
# Distinct from `view_salary`, and the distinction is load-bearing. `view_salary`
# is the CONTRACTED figure on a profile (what somebody is paid per month);
# `view_payslips` is what they were actually paid LAST month after attendance.
# Whoever hands out cheques needs the second and not necessarily the first, and
# an HR assistant setting up new joiners needs the first and not the second.
VIEW_PAYSLIPS = "view_payslips"
MANAGE_PAYSLIPS = "manage_payslips"


# =============================================================================
# 5. Reports & compliance
# =============================================================================
VIEW_REPORTS = "view_reports"
EXPORT_DATA = "export_data"          # download/export any list or report
VIEW_AUDIT_LOGS = "view_audit_logs"
VIEW_SENSITIVE_PII = "view_sensitive_pii"


# Order here is the order the UI renders and the order audit diffs read in.
ALL_PERMISSIONS: list[str] = [
    # Work
    VIEW_LEADS, MANAGE_LEADS,
    VIEW_CUSTOMERS, MANAGE_CUSTOMERS,
    VIEW_POLICIES, MANAGE_POLICIES,
    VIEW_ALL_POLICIES, MANAGE_POLICY_ACCESS,
    VIEW_RENEWALS, MANAGE_RENEWALS,
    VIEW_QUOTES, MANAGE_QUOTES,
    VIEW_CLAIMS, MANAGE_CLAIMS,
    # Money
    VIEW_TRANSACTIONS, MANAGE_TRANSACTIONS,
    VIEW_FINANCE_OVERVIEW,
    VIEW_BALANCE_SHEET,
    VIEW_TDS, MANAGE_TDS,
    VIEW_BANK_ACCOUNTS, MANAGE_BANK_ACCOUNTS,
    VIEW_AGENCY_PROFIT,
    # Catalog
    VIEW_INSURERS, MANAGE_INSURERS,
    VIEW_BROKERS, MANAGE_BROKERS,
    VIEW_POLICY_TYPES, MANAGE_POLICY_TYPES,
    VIEW_RATE_CARDS, MANAGE_RATE_CARDS,
    # People
    VIEW_EMPLOYEES, MANAGE_EMPLOYEES,
    VIEW_PARTNERS, MANAGE_PARTNERS,
    VIEW_ANNOUNCEMENTS, MANAGE_ANNOUNCEMENTS,
    VIEW_TARGETS, MANAGE_TARGETS,
    MANAGE_ROLES_PERMISSIONS,
    # Workplace HR
    VIEW_ATTENDANCE, MANAGE_ATTENDANCE,
    VIEW_LEAVE, MANAGE_LEAVE,
    VIEW_HOLIDAYS, MANAGE_HOLIDAYS,
    VIEW_PAYSLIPS, MANAGE_PAYSLIPS,
    VIEW_SALARY,
    # Reports & compliance
    VIEW_REPORTS, EXPORT_DATA,
    VIEW_AUDIT_LOGS, VIEW_SENSITIVE_PII,
]

# Permissions an in-house user may hold (everything). Kept for validation.
ASSIGNABLE_PERMISSIONS: list[str] = list(ALL_PERMISSIONS)


# --- Convenience bundles ---------------------------------------------------------
# Endpoints that back SEVERAL finance pages (party balances, an entity's money
# profile, a policy's P&L snapshot) can't belong to one page's flag. Holding any
# finance view is the honest gate for them — narrower than the old catch-all
# `view_finance`, and it still can't be reached by someone with no money rights
# at all.
FINANCE_VIEW_ANY: tuple[str, ...] = (
    VIEW_FINANCE_OVERVIEW, VIEW_BALANCE_SHEET, VIEW_TDS, VIEW_TRANSACTIONS,
)

# The People pages share list/detail endpoints across both populations.
PEOPLE_VIEW_ANY: tuple[str, ...] = (VIEW_EMPLOYEES, VIEW_PARTNERS)
PEOPLE_MANAGE_ANY: tuple[str, ...] = (MANAGE_EMPLOYEES, MANAGE_PARTNERS)


# --- Implications ----------------------------------------------------------------
# "Manage" always includes "view": granting edit rights while withholding the
# right to open the screen is never what anyone means, and the resulting 403s
# look like bugs. Applied server-side in expand_permissions() so it holds even
# if a client posts a half set.
#
# Nothing else is implied. In particular `manage_renewals` does NOT imply
# `view_policies` — the whole point of the renewals split is that it stays a
# window onto the expiring book.
IMPLIES: dict[str, tuple[str, ...]] = {
    MANAGE_LEADS: (VIEW_LEADS,),
    MANAGE_CUSTOMERS: (VIEW_CUSTOMERS,),
    MANAGE_POLICIES: (VIEW_POLICIES,),
    MANAGE_RENEWALS: (VIEW_RENEWALS,),
    MANAGE_QUOTES: (VIEW_QUOTES,),
    MANAGE_CLAIMS: (VIEW_CLAIMS,),
    MANAGE_TRANSACTIONS: (VIEW_TRANSACTIONS,),
    MANAGE_TDS: (VIEW_TDS,),
    MANAGE_BANK_ACCOUNTS: (VIEW_BANK_ACCOUNTS,),
    MANAGE_INSURERS: (VIEW_INSURERS,),
    MANAGE_BROKERS: (VIEW_BROKERS,),
    MANAGE_POLICY_TYPES: (VIEW_POLICY_TYPES,),
    MANAGE_RATE_CARDS: (VIEW_RATE_CARDS,),
    MANAGE_EMPLOYEES: (VIEW_EMPLOYEES,),
    MANAGE_PARTNERS: (VIEW_PARTNERS,),
    MANAGE_ANNOUNCEMENTS: (VIEW_ANNOUNCEMENTS,),
    MANAGE_TARGETS: (VIEW_TARGETS,),
    MANAGE_ROLES_PERMISSIONS: (VIEW_EMPLOYEES,),
    MANAGE_ATTENDANCE: (VIEW_ATTENDANCE,),
    MANAGE_LEAVE: (VIEW_LEAVE,),
    MANAGE_HOLIDAYS: (VIEW_HOLIDAYS,),
    MANAGE_PAYSLIPS: (VIEW_PAYSLIPS,),
    # Deciding a JIT access request means READING the policy it is about — an
    # approver who cannot open the record is being asked to rubber-stamp a code.
    MANAGE_POLICY_ACCESS: (VIEW_POLICIES, VIEW_ALL_POLICIES),
    # Seeing the whole book is meaningless without the page it widens, and
    # granting one without the other produces a Policies section that is
    # invisible and unrestricted at the same time.
    VIEW_ALL_POLICIES: (VIEW_POLICIES,),
}


# --- Translating the old vocabulary ----------------------------------------------
# Every flag that existed before the 2026-08-07 split, mapped to what it actually
# granted. Applied ONCE per user (services/permissions_svc), not on every read.
#
# It cannot be a read-time expansion, and that is worth spelling out because it
# looks like it could be: `view_policies` survives the split under the SAME NAME
# with a NARROWER meaning. Expanding it on every read would re-widen every fresh,
# deliberate grant of "policies only" back into the whole book — the migration
# has to distinguish "this set was written under the old vocabulary" from "this
# set was written under the new one", which is what User.permissions_version is.
LEGACY_FLAG_MAP: dict[str, tuple[str, ...]] = {
    # One flag opened Leads, Customers, Policies, Renewals, Quotes, Claims AND
    # the read side of the whole catalog.
    "view_policies": (
        VIEW_LEADS, VIEW_CUSTOMERS, VIEW_POLICIES, VIEW_RENEWALS,
        VIEW_QUOTES, VIEW_CLAIMS,
        VIEW_INSURERS, VIEW_BROKERS, VIEW_POLICY_TYPES, VIEW_RATE_CARDS,
        # `view_all_policies` is deliberately NOT here, even though the old
        # `view_policies` genuinely did open the whole book. A MIGRATION MUST
        # NOT RE-GRANT A RIGHT THE OWNER HAS JUST WITHDRAWN: the point of the
        # 2026-08-24 change is that seeing everybody's policies stops being the
        # default, and translating the old flag faithfully would hand it
        # straight back to every account that predates the change. Somebody who
        # really needs the whole book is granted it on purpose, once.
    ),
    "manage_policies": (
        MANAGE_LEADS, MANAGE_CUSTOMERS, MANAGE_POLICIES, MANAGE_RENEWALS,
        MANAGE_QUOTES, MANAGE_CLAIMS,
    ),
    # `view_finance` was Overview + Balance Sheet + TDS + party balances.
    "view_finance": (VIEW_FINANCE_OVERVIEW, VIEW_BALANCE_SHEET, VIEW_TDS),
    # `manage_finance` was "the money rules": rate cards, brokers, insurers,
    # policy types and TDS settings.
    "manage_finance": (
        MANAGE_TDS, MANAGE_INSURERS, MANAGE_BROKERS, MANAGE_POLICY_TYPES,
        MANAGE_RATE_CARDS,
    ),
    # People split in two.
    "view_team": (VIEW_EMPLOYEES, VIEW_PARTNERS),
    "manage_team": (MANAGE_EMPLOYEES, MANAGE_PARTNERS),
    # Unchanged flags still have to appear here: migrate() rebuilds the set from
    # this map alone, so anything missing would be silently dropped.
    # Neither of these can appear in a genuine pre-split set (they did not
    # exist), but migrate_legacy_permissions rebuilds the set from this map
    # alone, so a name that is absent here is a name it drops. They are listed
    # for the same reason every other current flag is.
    "manage_policy_access": (MANAGE_POLICY_ACCESS,),
    "view_all_policies": (VIEW_ALL_POLICIES,),
    "view_transactions": (VIEW_TRANSACTIONS,),
    "manage_transactions": (MANAGE_TRANSACTIONS,),
    "view_bank_accounts": (VIEW_BANK_ACCOUNTS,),
    "manage_bank_accounts": (MANAGE_BANK_ACCOUNTS,),
    "view_agency_profit": (VIEW_AGENCY_PROFIT,),
    "view_announcements": (VIEW_ANNOUNCEMENTS,),
    "manage_announcements": (MANAGE_ANNOUNCEMENTS,),
    "view_targets": (VIEW_TARGETS,),
    "manage_targets": (MANAGE_TARGETS,),
    "manage_roles_permissions": (MANAGE_ROLES_PERMISSIONS,),
    "view_reports": (VIEW_REPORTS,),
    "export_data": (EXPORT_DATA,),
    "view_audit_logs": (VIEW_AUDIT_LOGS,),
    "view_sensitive_pii": (VIEW_SENSITIVE_PII,),
    # NOTE: the Workplace HR flags (2026-08-20) are deliberately ABSENT.
    # LEGACY_FLAG_MAP translates the PRE-SPLIT vocabulary, and no pre-split set
    # can contain a flag that did not exist then. A current set holding one is
    # passed through by the `elif flag in known` branch of
    # migrate_legacy_permissions, which is exactly the right behaviour: adding
    # them here would claim they had an older meaning to translate FROM.
}


def migrate_legacy_permissions(perms) -> list[str]:
    """Translate a pre-split permission set into the current vocabulary.

    A flag that is ALREADY current and has no legacy meaning passes straight
    through. That matters more than it looks: without it, a set written by the
    new editor whose `permissions_version` stamp failed to persist would be
    translated to NOTHING — every unrecognised key dropped — and the account
    would silently lose all access rather than merely be re-translated. No
    genuine pre-split set can contain one of those keys, because they did not
    exist, so passing them through cannot widen anybody.

    Still not idempotent for the names that SURVIVED the split with a narrower
    meaning: run it twice on a set holding `view_policies` and the second pass
    re-expands it into the whole book. `User.permissions_version` is the guard —
    see services/permissions_svc.migrate_user_permissions.
    """
    known = set(ALL_PERMISSIONS)
    out: set[str] = set()
    for flag in perms:
        if flag in LEGACY_FLAG_MAP:
            out.update(LEGACY_FLAG_MAP[flag])
        elif flag in known:
            out.add(flag)
    return expand_permissions(out)


def expand_permissions(perms) -> list[str]:
    """Add every implied flag and drop anything unknown.

    Unknown keys are dropped rather than kept so a stale flag from an older
    build can never linger in a live permission set and silently mean nothing.
    Order is stable (ALL_PERMISSIONS order) so audit diffs stay readable.
    """
    held = set(perms) & set(ALL_PERMISSIONS)
    for flag, implied in IMPLIES.items():
        if flag in held:
            held.update(implied)
    return [p for p in ALL_PERMISSIONS if p in held]


# --- Presentation ----------------------------------------------------------------
# Grouped labels + help text, served to the UI so the permission editor and this
# file can never drift apart. (The frontend renders whatever this returns.)
#
# SHAPE: a group holds `sections`. A section is one row of the editor with a
# `view` flag and an optional `manage` flag — the two-column matrix that keeps
# 42 flags readable. A section with no `manage` is a single switch.
PERMISSION_GROUPS: list[dict] = [
    {
        "group": "Work",
        "hint": "The day-to-day book of business. Each page is grantable on its "
                "own — renewals without the rest of the book, for example.",
        "sections": [
            {"name": "Leads", "view": VIEW_LEADS, "manage": MANAGE_LEADS,
             "help": "The pipeline: enquiries, follow-ups and reminders."},
            {"name": "Customers", "view": VIEW_CUSTOMERS,
             "manage": MANAGE_CUSTOMERS,
             "help": "Customer records and their contact details."},
            {"name": "Policies", "view": VIEW_POLICIES,
             "manage": MANAGE_POLICIES,
             "help": "Booking, editing and cancelling policies, and the "
                     "documents attached to them."},
            {"name": "The whole book", "view": VIEW_ALL_POLICIES,
             "help": "Without this, Policies shows only what this person "
                     "booked plus what the channel partners on their roster "
                     "booked. With it, every policy in the agency. Moving a "
                     "partner to another manager moves their policies with "
                     "them, automatically."},
            {"name": "Approve access requests", "view": MANAGE_POLICY_ACCESS,
             "help": "Grant a colleague temporary sight of a policy that is "
                     "not theirs. Access expires on its own."},
            {"name": "Renewals", "view": VIEW_RENEWALS,
             "manage": MANAGE_RENEWALS,
             "help": "Only the expiring book, not the whole of it. Manage adds "
                     "renewing a policy."},
            {"name": "Quote requests", "view": VIEW_QUOTES,
             "manage": MANAGE_QUOTES,
             "help": "Requests raised by channel partners. Manage adds "
                     "replying, quoting and marking one booked."},
            {"name": "Claims", "view": VIEW_CLAIMS, "manage": MANAGE_CLAIMS,
             "help": "Claims raised on policies. Manage adds moving a claim "
                     "through its stages."},
        ],
    },
    {
        "group": "Money",
        "hint": "Cash, balances and tax. Agency profit is separate on purpose — "
                "someone can run the money without seeing the margin.",
        "sections": [
            {"name": "Transactions", "view": VIEW_TRANSACTIONS,
             "manage": MANAGE_TRANSACTIONS,
             "help": "The cash ledger. Manage adds recording receipts and "
                     "payouts, and correcting them."},
            {"name": "Finance overview", "view": VIEW_FINANCE_OVERVIEW,
             "help": "The Finance Overview page — the agency's money at a "
                     "glance."},
            {"name": "Balance sheet", "view": VIEW_BALANCE_SHEET,
             "help": "Who owes whom: party balances, receivable and payable, "
                     "and the statement PDFs."},
            {"name": "TDS", "view": VIEW_TDS, "manage": MANAGE_TDS,
             "help": "Tax deducted at source. Manage adds editing TDS rates "
                     "and entries."},
            {"name": "Bank & cash accounts", "view": VIEW_BANK_ACCOUNTS,
             "manage": MANAGE_BANK_ACCOUNTS,
             "help": "The agency's own accounts and what is actually in them. "
                     "Manage adds transfers and reconciliation."},
            {"name": "Agency / net profit", "view": VIEW_AGENCY_PROFIT,
             "help": "House profit wherever it appears. Without it the server "
                     "blanks the figure — it is not merely hidden."},
        ],
    },
    {
        "group": "Catalog",
        "hint": "The rules behind the money. Rate cards decide what the agency "
                "earns and what a partner is paid — grant that one last.",
        "sections": [
            {"name": "Insurers", "view": VIEW_INSURERS,
             "manage": MANAGE_INSURERS,
             "help": "The insurer list and the agency's codes with each."},
            {"name": "Brokers", "view": VIEW_BROKERS, "manage": MANAGE_BROKERS,
             "help": "Brokers, their codes and their TDS settings."},
            {"name": "Policy types", "view": VIEW_POLICY_TYPES,
             "manage": MANAGE_POLICY_TYPES,
             "help": "Categories, their custom fields and their document "
                     "checklists."},
            {"name": "Rate cards", "view": VIEW_RATE_CARDS,
             "manage": MANAGE_RATE_CARDS,
             "help": "Commission and partner-share rates. Manage changes what "
                     "every future policy pays."},
        ],
    },
    {
        "group": "People",
        "hint": "Staff and channel partners are separate populations — an "
                "agency's partner manager has no business in staff records.",
        "sections": [
            {"name": "Employees", "view": VIEW_EMPLOYEES,
             "manage": MANAGE_EMPLOYEES,
             "help": "The staff directory. Manage adds adding, editing, "
                     "deactivating and resetting passwords."},
            {"name": "Channel partners", "view": VIEW_PARTNERS,
             "manage": MANAGE_PARTNERS,
             "help": "Every partner. Without it an employee still sees the "
                     "partners they personally manage — that is the job, not a "
                     "privilege."},
            {"name": "Partner notices", "view": VIEW_ANNOUNCEMENTS,
             "manage": MANAGE_ANNOUNCEMENTS,
             "help": "Broadcasts to channel partners. A notice reaches their "
                     "portal and their email, and cannot be recalled."},
            {"name": "Targets", "view": VIEW_TARGETS, "manage": MANAGE_TARGETS,
             "help": "Everyone always sees their own. These cover other "
                     "people's targets and attainment."},
            {"name": "Roles & permissions", "view": MANAGE_ROLES_PERMISSIONS,
             "help": "Decide what everyone else can reach. Nobody can grant a "
                     "permission they do not hold themselves."},
        ],
    },
    {
        "group": "Workplace HR",
        "hint": "Attendance, leave and the holiday calendar. Everybody always "
                "reaches their OWN attendance, their own leave and the holiday "
                "list without any of these — these cover other people's.",
        "sections": [
            {"name": "Attendance", "view": VIEW_ATTENDANCE,
             "manage": MANAGE_ATTENDANCE,
             "help": "Everyone's attendance register and the daily board. "
                     "Manage adds editing any day and approving correction "
                     "requests."},
            {"name": "Leave", "view": VIEW_LEAVE, "manage": MANAGE_LEAVE,
             "help": "Everyone's leave and their balances. Manage adds "
                     "approving, rejecting and adjusting a balance."},
            {"name": "Holidays", "view": VIEW_HOLIDAYS,
             "manage": MANAGE_HOLIDAYS,
             "help": "The yearly holiday list. Manage adds declaring a day "
                     "off, which changes the attendance of the whole agency."},
            {"name": "Payslips", "view": VIEW_PAYSLIPS,
             "manage": MANAGE_PAYSLIPS,
             "help": "Everybody always sees their own. This covers other "
                     "people's. Manage adds regenerating a draft, finalising a "
                     "month and recording the payment."},
            {"name": "Salary figures", "view": VIEW_SALARY,
             "help": "The monthly salary on an employee's profile. Without it "
                     "the server strips the figure — it is not merely hidden. "
                     "Nothing computes with it; pay is worked out by hand."},
        ],
    },
    {
        "group": "Reports & compliance",
        "hint": "Analytics, downloads and the audit trail.",
        "sections": [
            {"name": "Reports", "view": VIEW_REPORTS,
             "help": "Open the Reports pages and the analytics on them."},
            {"name": "Export data", "view": EXPORT_DATA,
             "help": "Download any list or report as Excel or PDF. Separate "
                     "from reading it: taking data out of the building is its "
                     "own decision."},
            {"name": "Audit log", "view": VIEW_AUDIT_LOGS,
             "help": "Read the trail of who changed what."},
            {"name": "Sensitive details", "view": VIEW_SENSITIVE_PII,
             "help": "Unmask PAN, Aadhaar, bank account, IFSC and UPI values."},
        ],
    },
]


# Fixed permission set for every partner account: EMPTY, and deliberately so.
#
# A partner CAN sign in, behind two live gates (core/feature_flags:
# SystemSettings.partner_portal.enabled, and their own User.portal_access). What
# they cannot do is hold a flag, because the flags gate STAFF surfaces and a
# partner must never reach one. Their access is decided structurally instead:
#
#   * every staff router carries Depends(get_inhouse_user) at the ROUTER level,
#     so a new staff route is closed to partners by default;
#   * routers/portal.py is the only surface they reach, it scopes every query by
#     partner_id, and its schemas have no field for agency reward, house profit,
#     rate, broker, TDS or discount.
#
# So this list staying empty is load-bearing, not vestigial. Granting a partner
# any flag here would hand them a staff permission check they were never meant
# to pass. See core/dependencies.get_inhouse_user and
# tests/test_partner_boundary.py.
PARTNER_PERMISSIONS: list[str] = []


def permissions_for_account_type(account_type: str) -> list[str]:
    """Base permissions implied purely by the account type."""
    if account_type == AccountType.OWNER.value:
        return list(ALL_PERMISSIONS)
    if account_type == AccountType.CHANNEL_PARTNER.value:
        return list(PARTNER_PERMISSIONS)
    return []  # employees derive theirs from their own set


def effective_permissions(user) -> list[str]:
    """What this account can actually do — not merely what its document says.

    An owner holds every flag BY DEFINITION, but the set is denormalised onto
    the User document and only rewritten on create/edit. So an owner created
    before a flag existed has a short list on disk: adding
    `manage_bank_accounts` (2026-08-02) left the existing owner unable to add a
    bank account on a page their own sidebar still showed them.

    Serialise through this, never through `user.permissions` directly, and a
    future flag can't reintroduce that. (Enforcement is healed separately, at
    the point of authentication — see services/permissions_svc.)

    An employee still on the pre-split vocabulary is translated here too, so a
    request that lands before the boot migration has run — or after it failed —
    is answered with the same set it would get afterwards.

    Duck-typed on .account_type / .permissions so this module stays free of a
    model import.
    """
    account_type = getattr(user.account_type, "value", user.account_type)
    if account_type == AccountType.OWNER.value:
        return list(ALL_PERMISSIONS)
    if getattr(user, "permissions_version", 1) < PERMISSIONS_VERSION:
        return migrate_legacy_permissions(user.permissions)
    return list(user.permissions)


def can(user, *flags: str) -> bool:
    """Does this account hold ALL of `flags`? The read every call site wants.

    Prefer this to `FLAG in actor.permissions`, which is what ~90 places did.
    That form is correct only because `heal_owner_permissions()` rewrites a
    stale owner's set at authentication — and that heal is a database WRITE
    which deliberately swallows its own failure (services/permissions_svc), so
    on the request where it fails the owner proceeds with the short list and
    silently loses a flag.

    Reading through `effective_permissions` removes the dependency on that write
    ever succeeding: an owner holds every flag by definition, so the answer is
    derived rather than looked up. The heal stays — it keeps the stored document
    honest for everything that reads it directly — but nothing depends on it.
    """
    held = set(effective_permissions(user))
    return all(f in held for f in flags)


def can_any(user, *flags: str) -> bool:
    """Does this account hold AT LEAST ONE of `flags`? (See `can`.)"""
    held = set(effective_permissions(user))
    return any(f in held for f in flags)


# --- Role templates --------------------------------------------------------------
# NOT seeded. Nothing is written to the database on first run — the owner asked
# for roles to be created manually only. These are offered in the "Create role"
# dialog as a starting tick-set the owner can edit before saving.
#
# With one pair per page, a template is now the fastest way to fill 42 boxes, so
# they earn their place more than they did at 20. Each one is a real job in a
# small brokerage.
ROLE_TEMPLATES: list[dict] = [
    {
        "key": "blank",
        "name": "Blank",
        "description": "Start with nothing ticked.",
        "permissions": [],
    },
    {
        "key": "renewals_desk",
        "name": "Renewals desk",
        "description": "Chases the expiring book and nothing else. Sees "
                       "policies coming up for renewal, not the whole book.",
        "permissions": [VIEW_RENEWALS, MANAGE_RENEWALS, VIEW_CUSTOMERS],
    },
    {
        "key": "telecaller",
        "name": "Telecaller",
        "description": "Works the pipeline: leads, follow-ups and reminders.",
        "permissions": [VIEW_LEADS, MANAGE_LEADS, VIEW_CUSTOMERS],
    },
    {
        "key": "policy_executive",
        "name": "Policy executive",
        "description": "Books and services policies, customers and leads. "
                       "Sees no money beyond the premium on the policy.",
        "permissions": [VIEW_LEADS, MANAGE_LEADS,
                        VIEW_CUSTOMERS, MANAGE_CUSTOMERS,
                        VIEW_POLICIES, MANAGE_POLICIES,
                        VIEW_RENEWALS, MANAGE_RENEWALS,
                        VIEW_INSURERS, VIEW_BROKERS, VIEW_POLICY_TYPES,
                        VIEW_REPORTS],
    },
    {
        "key": "partner_desk",
        "name": "Channel partner desk",
        "description": "Handles the partner relationship: their quote "
                       "requests, their claims and their notices.",
        "permissions": [VIEW_QUOTES, MANAGE_QUOTES,
                        VIEW_CLAIMS, MANAGE_CLAIMS,
                        VIEW_PARTNERS,
                        VIEW_ANNOUNCEMENTS, MANAGE_ANNOUNCEMENTS,
                        VIEW_POLICIES],
    },
    {
        "key": "claims_officer",
        "name": "Claims officer",
        "description": "Runs claims end to end. Reads the policy behind each "
                       "one; touches no money.",
        "permissions": [VIEW_CLAIMS, MANAGE_CLAIMS, VIEW_POLICIES,
                        VIEW_CUSTOMERS],
    },
    {
        "key": "accountant",
        "name": "Accountant",
        "description": "Records receipts and payouts and reconciles the "
                       "ledger. Cannot see agency profit.",
        # The whole book, because reconciling a payment means finding the
        # policy it belongs to whoever booked it.
        "permissions": [VIEW_POLICIES, VIEW_ALL_POLICIES, VIEW_CUSTOMERS,
                        VIEW_TRANSACTIONS, MANAGE_TRANSACTIONS,
                        VIEW_FINANCE_OVERVIEW, VIEW_BALANCE_SHEET,
                        VIEW_TDS, MANAGE_TDS,
                        VIEW_REPORTS, EXPORT_DATA],
    },
    {
        "key": "finance_manager",
        "name": "Finance manager",
        "description": "Runs the money end to end — ledger, rate cards, "
                       "balance sheet and the agency's own profit.",
        "permissions": [VIEW_POLICIES, VIEW_ALL_POLICIES, VIEW_CUSTOMERS,
                        VIEW_TRANSACTIONS, MANAGE_TRANSACTIONS,
                        VIEW_FINANCE_OVERVIEW, VIEW_BALANCE_SHEET,
                        VIEW_TDS, MANAGE_TDS,
                        VIEW_AGENCY_PROFIT,
                        VIEW_BANK_ACCOUNTS, MANAGE_BANK_ACCOUNTS,
                        VIEW_INSURERS, MANAGE_INSURERS,
                        VIEW_BROKERS, MANAGE_BROKERS,
                        VIEW_POLICY_TYPES, MANAGE_POLICY_TYPES,
                        VIEW_RATE_CARDS, MANAGE_RATE_CARDS,
                        VIEW_REPORTS, EXPORT_DATA],
    },
    {
        "key": "hr",
        "name": "HR",
        "description": "Manages staff records and sets their monthly targets. "
                       "No access to the partner book.",
        "permissions": [VIEW_EMPLOYEES, MANAGE_EMPLOYEES,
                        VIEW_TARGETS, MANAGE_TARGETS, VIEW_REPORTS],
    },
    {
        "key": "manager",
        "name": "Manager",
        "description": "Runs the branch: the whole book, the money, the team "
                       "and their targets.",
        "permissions": [VIEW_LEADS, MANAGE_LEADS,
                        VIEW_CUSTOMERS, MANAGE_CUSTOMERS,
                        VIEW_POLICIES, MANAGE_POLICIES,
                        VIEW_RENEWALS, MANAGE_RENEWALS,
                        VIEW_QUOTES, MANAGE_QUOTES,
                        VIEW_CLAIMS, MANAGE_CLAIMS,
                        VIEW_TRANSACTIONS, MANAGE_TRANSACTIONS,
                        VIEW_FINANCE_OVERVIEW, VIEW_BALANCE_SHEET,
                        VIEW_TDS, VIEW_AGENCY_PROFIT, VIEW_BANK_ACCOUNTS,
                        VIEW_INSURERS, VIEW_BROKERS, VIEW_POLICY_TYPES,
                        VIEW_RATE_CARDS,
                        VIEW_EMPLOYEES, MANAGE_EMPLOYEES,
                        VIEW_PARTNERS, MANAGE_PARTNERS,
                        VIEW_ANNOUNCEMENTS, MANAGE_ANNOUNCEMENTS,
                        VIEW_TARGETS, MANAGE_TARGETS,
                        VIEW_REPORTS, EXPORT_DATA, VIEW_AUDIT_LOGS],
    },
    {
        "key": "full_access",
        "name": "Full access",
        "description": "Everything an owner can do.",
        "permissions": list(ALL_PERMISSIONS),
    },
]
