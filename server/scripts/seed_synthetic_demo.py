"""One-shot synthetic data seed for a scratch database, so the whole app can be
clicked through without building a book by hand first.

    python seed_synthetic_demo.py

Run against whatever database `server/.env`'s MONGO_DB_NAME points at. This is
meant for a throwaway/test database — check `.env` before running it against
anything you care about. It is idempotent-ish (existing accounts/records by
email or a seed tag are left alone and reused), so re-running it after an
interrupted run will not duplicate the fixed accounts, though it does not
un-do a partial run of the money/HR sections the way --reset does in
insert_test_data.py.

WHAT THIS CREATES
------------------
  Accounts (password Test@123 for every one):
    work4rajan+owner@gmail.com   Owner
    work4rajan+emp1@gmail.com    Employee — Sales Executive (policies only)
    work4rajan+emp2@gmail.com    Employee — Operations (+ finance, no profit)
    work4rajan+emp3@gmail.com    Employee — Manager (profit, targets, HR,
                                  the relationship manager for both partners)
    work4rajan+cp1@gmail.com     Channel partner (portal access on)
    work4rajan+cp2@gmail.com     Channel partner (portal access on)

  Catalog: 2 insurers, 2 brokers with rate cards, 3 policy types (Health,
  Life, Motor) each with custom fields and required/claim documents.

  Bank & Cash: two accounts with opening balances.

  Book: ~18 customers, 8 leads across all three lead types and several
  stages, ~24 policies over the last 6 months booked through the real
  services (so finance/rewards/TDS/balances agree with each other), premium
  and reward receipts on most of them, house expenses, targets for every
  employee AND both partners (current + previous 2 months).

  Workplace HR: a few holidays, ~45 days of attendance per employee (a mix of
  on-time, late and one absence, punched through the real service so
  `recompute()` derives real statuses), leave accrued for 3 months plus one
  approved and one pending leave request per employee, and last month's
  payslip generated (left as DRAFT, so the pay run has something to act on).

WHY IT GOES THROUGH THE REAL SERVICES, not straight collection inserts: a
policy is booked via resolve_reward_terms -> sync_reward -> credit_reward ->
book_policy_finance exactly as the API does, and attendance via punch_in /
punch_out exactly as an employee pressing the button would, so what you find
when clicking around is real, self-consistent app state rather than numbers
that only look right in isolation.
"""

from __future__ import annotations

import asyncio
import random
import sys
from datetime import datetime, timedelta

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

from app.config import settings                                    # noqa: E402
from app.core.enums import (                                       # noqa: E402
    AccountStatus, AccountType, BuyerType, HrRequestStatus, LeadStage,
    LeadType, LeaveDayPart, LeaveLedgerEntry, LeaveReason,
    LedgerTxnType, PartyType, PayerType, PolicyStatus, RewardBasis,
    TargetMetric, TargetPeriod,
)
from app.core.permissions import (                                 # noqa: E402
    ALL_PERMISSIONS, MANAGE_ATTENDANCE, MANAGE_CUSTOMERS, MANAGE_EMPLOYEES,
    MANAGE_HOLIDAYS, MANAGE_LEADS, MANAGE_LEAVE, MANAGE_PARTNERS,
    MANAGE_PAYSLIPS, MANAGE_POLICIES, MANAGE_RENEWALS, MANAGE_TARGETS,
    MANAGE_TRANSACTIONS, VIEW_AGENCY_PROFIT, VIEW_ATTENDANCE,
    VIEW_BALANCE_SHEET, VIEW_CUSTOMERS, VIEW_EMPLOYEES, VIEW_FINANCE_OVERVIEW,
    VIEW_HOLIDAYS, VIEW_LEADS, VIEW_LEAVE, VIEW_PARTNERS, VIEW_PAYSLIPS,
    VIEW_POLICIES, VIEW_REPORTS, VIEW_SALARY, VIEW_TARGETS, VIEW_TDS,
    VIEW_TRANSACTIONS,
)
from app.core.security import hash_password                        # noqa: E402
from app.db import close_db, init_db                                # noqa: E402
from app.models.bank import BankAccount                            # noqa: E402
from app.core.enums import BankAccountType                         # noqa: E402
from app.models.base import utcnow                                 # noqa: E402
from app.models.broker import Broker                               # noqa: E402
from app.models.customer import Customer                           # noqa: E402
from app.models.finance import LedgerTxn                           # noqa: E402
from app.models.holiday import Holiday                             # noqa: E402
from app.models.attendance import AttendanceDay                    # noqa: E402
from app.models.leave import LeaveLedgerRow, LeaveRequest           # noqa: E402
from app.models.insurer import Insurer                             # noqa: E402
from app.models.lead import Lead                                   # noqa: E402
from app.models.master import (                                    # noqa: E402
    CategoryNode, CustomFieldSpec, PolicyCategory, RequiredDocSpec,
)
from app.models.policy import Policy                                # noqa: E402
from app.models.rate_rule import RateRule                          # noqa: E402
from app.models.reward import Reward                                # noqa: E402
from app.models.target import Target                                # noqa: E402
from app.models.user import EmployeeProfile, User                   # noqa: E402
from app.services import finance as finance_svc                    # noqa: E402
from app.services import hr_attendance, hr_leave, payroll            # noqa: E402
from app.services import settings_svc                               # noqa: E402
from app.services import targets as target_svc                     # noqa: E402
from app.services import wallet as wallet_svc                      # noqa: E402
from app.services.codes import next_code, next_customer_code        # noqa: E402
from app.services.hr_calendar import combine_ist, now_ist          # noqa: E402
from app.services.money import commissionable_from_premium          # noqa: E402
from app.services.policy_ops import resolve_reward_terms, sync_reward  # noqa: E402

random.seed(20260913)

EMAIL_DOMAIN = "gmail.com"
LOCAL_PREFIX = "work4rajan"
PASSWORD = "Test@123"
SEED_TAG = "[demo]"


def email_for(tag: str) -> str:
    return f"{LOCAL_PREFIX}+{tag}@{EMAIL_DOMAIN}"


def rupees(amount: int) -> int:
    return amount * 100


def money(paise: int) -> str:
    return f"Rs {paise / 100:,.2f}"


# --- Catalog data --------------------------------------------------------------

INSURERS = [("HDFC Life", "HDFCL", True), ("Tata AIG General", "TATA", True)]
BROKERS = [
    # name, short, tds_pct*100, agency%*100, partner%*100
    ("Probus Insurance", "PRB", 200, 1800, 1200),
    ("Girnar Insurance", "GIR", 500, 2000, 1500),
]
POLICY_TYPES = [
    {"key": "health", "label": "Health", "sort_order": 10,
     "children": [("individual", "Individual"), ("family_floater", "Family Floater")],
     "custom_fields": [("sum_assured", "Sum Assured", "amount", False, True)],
     "docs": [("id_proof", "ID Proof"), ("medical_report", "Medical Report")],
     "claim_docs": [("discharge_summary", "Discharge Summary"),
                    ("hospital_bills", "Hospital Bills")]},
    {"key": "life", "label": "Life", "sort_order": 20,
     "children": [("term", "Term"), ("endowment", "Endowment")],
     "custom_fields": [("sum_assured", "Sum Assured", "amount", False, True)],
     "docs": [("id_proof", "ID Proof")],
     "claim_docs": [("death_certificate", "Death Certificate")]},
    {"key": "motor", "label": "Motor", "sort_order": 30,
     "children": [("car", "Car"), ("two_wheeler", "Two Wheeler")],
     "custom_fields": [("registration_number", "Registration Number",
                        "text", True, False),
                       ("idv", "IDV", "amount", False, True)],
     "docs": [("rc_book", "RC Book"), ("previous_policy", "Previous Policy")],
     "claim_docs": [("fir_copy", "FIR Copy"), ("repair_estimate",
                    "Repair Estimate"), ("photos", "Photos of Damage")]},
]

CUSTOMERS = [
    "Ayush Verma", "Ishaan Patel", "Meera Krishnan", "Rahul Saxena",
    "Ananya Bose", "Kunal Kapoor", "Swati Mishra", "Devansh Trivedi",
    "Lakshmi Pillai", "Harsh Vardhan", "Nidhi Chopra", "Siddharth Rao",
    "Pallavi Deshmukh", "Gaurav Khanna", "Ritika Sinha", "Mohit Aggarwal",
    "Juhi Bhatt", "Aditya Kulkarni",
]

LEADS = [
    # name, mobile, interest, est premium (rupees), type, stage
    ("Naveen Kumar", "9700200011", "Health cover for family", 250000,
     LeadType.CUSTOMER, LeadStage.NEW),
    ("Shreya Banerjee", "9700200012", "Term life 1 crore", 180000,
     LeadType.CUSTOMER, LeadStage.CONTACTED),
    ("Parth Doshi", "9700200013", "Car insurance renewal", 95000,
     LeadType.CUSTOMER, LeadStage.QUOTED),
    ("Anjali Rathore", "9700200014", "Top-up health plan", 120000,
     LeadType.CUSTOMER, LeadStage.LOST),
    ("Deepak Negi", "9700200015", "Endowment / savings plan", 600000,
     LeadType.CUSTOMER, LeadStage.CONVERTED),
    ("Rathi Motors Pvt Ltd", "9700200016", "Fleet motor cover", 450000,
     LeadType.BUSINESS, LeadStage.NEW),
    ("Sunrise Traders", "9700200017", "Group health for staff", 300000,
     LeadType.BUSINESS, LeadStage.CONTACTED),
    ("Ramesh Iyer", "9700200018", "Wants to bring in business", 0,
     LeadType.CHANNEL_PARTNER, LeadStage.NEW),
]

PREMIUM_POOL = [11800, 23600, 17700, 35400, 8850, 47200, 14160,
               29500, 59000, 21240, 9440, 41300]


# --- Accounts --------------------------------------------------------------


async def upsert_owner() -> User:
    email = email_for("owner")
    existing = await User.find_one(User.email == email,
                                   {"is_deleted": {"$ne": True}})
    if existing:
        print(f"  = owner {email} (exists)")
        return existing
    owner = User(
        code=await next_code("user"), full_name="Rajan Rajawat (Owner)",
        email=email, mobile="9800000001", account_type=AccountType.OWNER,
        hashed_password=hash_password(PASSWORD), must_change_password=False,
        onboarded=True, status=AccountStatus.ACTIVE,
        permissions=list(ALL_PERMISSIONS),
    )
    await owner.insert()
    print(f"  + owner {email}")
    return owner


EMPLOYEES = [
    # tag, full name, designation, salary(rupees), permissions
    ("emp1", "Vikram Rao", "Sales Executive", 22000,
     [VIEW_POLICIES, MANAGE_POLICIES, VIEW_LEADS, MANAGE_LEADS]),
    ("emp2", "Priya Menon", "Operations", 28000,
     [VIEW_POLICIES, MANAGE_POLICIES, VIEW_CUSTOMERS, MANAGE_CUSTOMERS,
      VIEW_TRANSACTIONS, MANAGE_TRANSACTIONS, VIEW_FINANCE_OVERVIEW,
      VIEW_BALANCE_SHEET, VIEW_TDS]),
    ("emp3", "Anita Desai", "Relationship Manager", 45000,
     [VIEW_POLICIES, MANAGE_POLICIES, VIEW_LEADS, MANAGE_LEADS,
      VIEW_CUSTOMERS, MANAGE_CUSTOMERS, MANAGE_RENEWALS,
      VIEW_TRANSACTIONS, VIEW_FINANCE_OVERVIEW, VIEW_BALANCE_SHEET, VIEW_TDS,
      VIEW_AGENCY_PROFIT, VIEW_EMPLOYEES, MANAGE_EMPLOYEES,
      VIEW_PARTNERS, MANAGE_PARTNERS, VIEW_TARGETS, MANAGE_TARGETS,
      VIEW_REPORTS, VIEW_ATTENDANCE, MANAGE_ATTENDANCE, VIEW_LEAVE,
      MANAGE_LEAVE, VIEW_HOLIDAYS, MANAGE_HOLIDAYS, VIEW_PAYSLIPS,
      MANAGE_PAYSLIPS, VIEW_SALARY]),
]


async def upsert_employees(owner: User) -> list[User]:
    print("\n--- Employees ---")
    out: list[User] = []
    for tag, full_name, designation, salary, perms in EMPLOYEES:
        email = email_for(tag)
        existing = await User.find_one(User.email == email,
                                       {"is_deleted": {"$ne": True}})
        if existing:
            out.append(existing)
            print(f"  = {full_name} {email} (exists)")
            continue
        u = User(
            code=await next_code("user"), full_name=full_name, email=email,
            mobile=f"98000001{len(out):02d}",
            account_type=AccountType.EMPLOYEE,
            hashed_password=hash_password(PASSWORD),
            must_change_password=False, onboarded=True,
            status=AccountStatus.ACTIVE,
            permissions=list(perms), extra_permissions=list(perms),
            created_by=str(owner.id),
            employee_profile=EmployeeProfile(
                designation=designation, department="Sales",
                monthly_salary_paise=rupees(salary)),
        )
        await u.insert()
        out.append(u)
        print(f"  + {full_name:<16} {email}  ({designation}, "
              f"Rs {salary}/mo)")
    return out


async def upsert_partners(manager: User) -> list[User]:
    print("\n--- Channel partners ---")
    out: list[User] = []
    names = ["Yogesh Sharma", "Ayesha Khan"]
    for i, (tag, name) in enumerate(zip(["cp1", "cp2"], names), start=1):
        email = email_for(tag)
        existing = await User.find_one(User.email == email,
                                       {"is_deleted": {"$ne": True}})
        if existing:
            out.append(existing)
            print(f"  = {name} {email} (exists)")
            continue
        u = User(
            code=await next_code("partner"), full_name=name, email=email,
            mobile=f"97000002{i:02d}", account_type=AccountType.CHANNEL_PARTNER,
            hashed_password=hash_password(PASSWORD), must_change_password=False,
            onboarded=True, status=AccountStatus.ACTIVE, portal_access=True,
            relationship_manager_id=str(manager.id), created_by=str(manager.id),
        )
        await u.insert()
        out.append(u)
        print(f"  + {name:<16} {email}  (portal access on, "
              f"reports to {manager.full_name})")
    return out


# --- Catalog -----------------------------------------------------------------


async def seed_insurers() -> dict[str, Insurer]:
    print("\n--- Insurers ---")
    out: dict[str, Insurer] = {}
    for name, short, active in INSURERS:
        existing = await Insurer.find_one(Insurer.name == name)
        if existing:
            out[short] = existing
            continue
        ins = Insurer(code=await next_code("insurer"), name=name,
                      short_name=short, active=active,
                      phone=f"98765{random.randint(10000, 99999)}",
                      notes=SEED_TAG)
        await ins.insert()
        out[short] = ins
        print(f"  + {name} [{short}]")
    return out


async def seed_brokers() -> dict[str, Broker]:
    print("\n--- Brokers ---")
    out: dict[str, Broker] = {}
    for name, short, tds, _a, _p in BROKERS:
        existing = await Broker.find_one(Broker.name == name)
        if existing:
            out[short] = existing
            continue
        b = Broker(code=await next_code("broker"), short_code=short, name=name,
                   tds_percent=tds, active=True, notes=SEED_TAG)
        await b.insert()
        out[short] = b
        print(f"  + {name} [{short}] TDS {tds / 100:.2f}%")
    return out


async def seed_policy_types() -> dict[str, PolicyCategory]:
    print("\n--- Policy types ---")
    out: dict[str, PolicyCategory] = {}
    for spec in POLICY_TYPES:
        existing = await PolicyCategory.find_one(PolicyCategory.key == spec["key"])
        if existing:
            out[spec["key"]] = existing
            continue
        cat = PolicyCategory(
            key=spec["key"], label=spec["label"], sort_order=spec["sort_order"],
            description=f"{spec['label']} business {SEED_TAG}",
            children=[CategoryNode(key=k, label=lbl)
                      for k, lbl in spec["children"]],
            custom_fields=[
                CustomFieldSpec(key=k, label=lbl, type=t, required=req,
                                is_reward_base=base)
                for k, lbl, t, req, base in spec["custom_fields"]],
            required_documents=[RequiredDocSpec(key=k, label=lbl, required=False)
                                for k, lbl in spec["docs"]],
            claim_documents=[RequiredDocSpec(key=k, label=lbl, required=False)
                             for k, lbl in spec["claim_docs"]],
            active=True)
        await cat.insert()
        out[spec["key"]] = cat
        print(f"  + {spec['label']}")
    return out


async def seed_rate_rules(brokers, cats, insurers) -> None:
    print("\n--- Rate cards ---")
    for name, short, _tds, agency, partner in BROKERS:
        b = brokers.get(short)
        if b is None:
            continue
        for key, cat in cats.items():
            existing = await RateRule.find_one(
                RateRule.broker_id == str(b.id), RateRule.category_key == key,
                RateRule.insurer_id == None)          # noqa: E711 (beanie)
            if existing:
                continue
            await RateRule(
                broker_id=str(b.id), category_key=key,
                agency_basis=RewardBasis.PERCENT, agency_value=agency,
                partner_basis=RewardBasis.PERCENT, partner_value=partner,
                label=f"{short} default - {cat.label}",
            ).insert()
    print("  + rate cards for every broker / policy type")


async def seed_banks() -> None:
    print("\n--- Bank & cash ---")
    accounts = [
        ("HDFC Current", BankAccountType.BANK, rupees(500000)),
        ("Cash in hand", BankAccountType.CASH, rupees(15000)),
    ]
    for name, kind, opening in accounts:
        existing = await BankAccount.find_one(BankAccount.name == name)
        if existing:
            continue
        await BankAccount(
            name=name, account_type=kind,
            opening_balance_paise=opening, balance_paise=opening,
        ).insert()
        print(f"  + {name}  opening {money(opening)}")


# --- Book --------------------------------------------------------------------


async def seed_customers(owner: User) -> list[Customer]:
    print("\n--- Customers ---")
    out: list[Customer] = []
    made = 0
    for i, name in enumerate(CUSTOMERS, start=1):
        mobile = f"98100000{i:02d}"
        existing = await Customer.find_one(Customer.mobile == mobile)
        if existing:
            out.append(existing)
            continue
        c = Customer(
            code=await next_customer_code(), name=name, mobile=mobile,
            email=f"cust{i:02d}@{EMAIL_DOMAIN}", owner_user_id=str(owner.id),
            created_by_name=owner.full_name, notes=SEED_TAG,
        )
        await c.insert()
        out.append(c)
        made += 1
    print(f"  + {made} customers")
    return out


async def seed_leads(owner: User) -> None:
    print("\n--- Leads ---")
    made = 0
    for name, mobile, interest, est, ltype, stage in LEADS:
        if await Lead.find_one(Lead.mobile == mobile):
            continue
        await Lead(
            code=await next_code("lead"), type=ltype, name=name, mobile=mobile,
            email=f"{name.split()[0].lower()}@{EMAIL_DOMAIN}",
            interested_in=interest, estimated_premium=rupees(est) if est else None,
            stage=stage, owner_user_id=str(owner.id), created_by=str(owner.id),
            created_by_name=owner.full_name, note=SEED_TAG,
        ).insert()
        made += 1
    print(f"  + {made} leads (customer / business / channel_partner types)")


async def seed_policies(owner: User, insurers, brokers, cats, customers,
                        partners: list[User], employees: list[User]
                        ) -> list[Policy]:
    print("\n--- Policies (booked through the real finance path) ---")
    existing = await Policy.find({"notes": SEED_TAG}).to_list()
    if existing:
        print(f"  = {len(existing)} already seeded, skipping")
        return existing

    active_insurers = [i for i in insurers.values() if i.active]
    rated_brokers = list(brokers.values())
    type_paths = [("health", ["individual"]), ("health", ["family_floater"]),
                  ("life", ["term"]), ("motor", ["car"]),
                  ("motor", ["two_wheeler"])]
    made: list[Policy] = []
    now = utcnow()

    for n in range(24):
        cust = customers[n % len(customers)]
        insurer = active_insurers[n % len(active_insurers)]
        broker = rated_brokers[n % len(rated_brokers)]
        cat_key, path = type_paths[n % len(type_paths)]
        if cat_key not in cats:
            continue
        gross = rupees(PREMIUM_POOL[n % len(PREMIUM_POOL)])
        partner = partners[n % len(partners)] if (n % 2 == 0 and partners) else None
        started = now - timedelta(days=random.randint(5, 175))
        booker = employees[n % len(employees)] if employees else owner
        # Motor needs its own required custom field.
        details = {"sum_assured": gross * 40} if cat_key != "motor" \
            else {"registration_number": f"RJ14AB{1000 + n}", "idv": gross * 30}
        pol = Policy(
            code=await next_code("policy"), policy_number=f"DEMO-{1000 + n}",
            category_key=cat_key, subcategory_path=list(path),
            subcategory_key=path[-1] if path else None,
            insurer_id=str(insurer.id), broker_id=str(broker.id),
            customer_id=str(cust.id), status=PolicyStatus.ACTIVE,
            approved_by=str(owner.id), approved_at=started,
            premium_amount=gross,
            commissionable_premium=commissionable_from_premium(gross),
            sum_insured=gross * 40, issue_date=started, start_date=started,
            expiry_date=started + timedelta(days=365), payer=PayerType.AGENCY,
            buyer_type=(BuyerType.CHANNEL_PARTNER if partner else BuyerType.DIRECT),
            details=details,
            reward_base_field="commissionable" if cat_key != "motor" else "idv",
            owner_user_id=str(booker.id),
            partner_id=str(partner.id) if partner else None,
            created_by=str(owner.id), created_at=started, notes=SEED_TAG,
        )
        pol.reward = await resolve_reward_terms(pol)
        await pol.insert()
        reward = await sync_reward(pol)
        if pol.partner_id:
            await wallet_svc.credit_reward(reward)
        await finance_svc.book_policy_finance(pol, reward)
        made.append(pol)

    total = sum(p.premium_amount for p in made)
    print(f"  + {len(made)} policies, gross premium {money(total)}")
    return made


async def seed_money(owner: User, policies: list[Policy]) -> None:
    print("\n--- Payments, rewards, TDS, expenses ---")
    if await LedgerTxn.find_one({"reference": SEED_TAG}):
        print("  = already seeded, skipping")
        return
    collected = rewarded = 0
    for i, pol in enumerate(policies):
        reward = await Reward.find_one(Reward.policy_id == str(pol.id))
        paid_on = (pol.start_date or utcnow()) + timedelta(days=3)
        if i % 5 != 4:
            await finance_svc.record_ledger_txn(
                txn_type=LedgerTxnType.PREMIUM_COLLECTED,
                party_type=PartyType.CUSTOMER, party_id=pol.customer_id,
                amount_paise=-pol.premium_amount, policy_id=str(pol.id),
                occurred_at=paid_on, reference=SEED_TAG,
                note="Premium received", created_by=str(owner.id))
            collected += pol.premium_amount
        if reward and reward.agency_amount > 0 and i % 5 < 3 and pol.broker_id:
            await finance_svc.record_ledger_txn(
                txn_type=LedgerTxnType.REWARD_RECEIVED,
                party_type=PartyType.BROKER, party_id=pol.broker_id,
                amount_paise=-reward.agency_amount, policy_id=str(pol.id),
                occurred_at=paid_on + timedelta(days=10), reference=SEED_TAG,
                note="Reward received", created_by=str(owner.id))
            rewarded += reward.agency_amount
            broker = await Broker.get(pol.broker_id)
            if broker and broker.tds_percent > 0:
                await finance_svc.record_reward_tds(
                    broker_id=pol.broker_id, tds_percent=broker.tds_percent,
                    gross_reward_paise=reward.agency_amount,
                    policy_id=str(pol.id), ledger_txn_id=None,
                    reference=SEED_TAG, note="TDS on reward",
                    created_by=str(owner.id))
    print(f"  + premium collected {money(collected)}, reward received "
          f"{money(rewarded)}")

    expenses = [("salary", rupees(45000), "Staff salary"),
                ("rent", rupees(25000), "Office rent"),
                ("marketing", rupees(6000), "Lead campaign"),
                ("software", rupees(3500), "CRM subscription")]
    now = utcnow()
    for k, (category, amount, note) in enumerate(expenses):
        await LedgerTxn(
            txn_type=LedgerTxnType.EXPENSE, party_type=PartyType.EXPENSE,
            party_id="house", amount_paise=-amount, note=note,
            reference=SEED_TAG, occurred_at=now - timedelta(days=15 * k),
            expense_category=category, created_by=str(owner.id),
        ).insert()
    print(f"  + {len(expenses)} house expenses")


async def seed_targets(employees: list[User], partners: list[User]) -> None:
    print("\n--- Targets ---")
    now = utcnow()
    made = 0
    for person, kind in [(e, AccountType.EMPLOYEE.value) for e in employees] \
            + [(p, AccountType.CHANNEL_PARTNER.value) for p in partners]:
        anchor = now
        for _back in range(3):
            lo, hi = target_svc.normalise_period(TargetPeriod.MONTH, anchor)
            if not await Target.find_one(Target.assignee_id == str(person.id),
                                         Target.period_start == lo):
                metrics = {TargetMetric.POLICIES.value: 6}
                if kind == AccountType.EMPLOYEE.value:
                    metrics[TargetMetric.HOUSE_PROFIT.value] = rupees(20000)
                await Target(
                    assignee_type=kind, assignee_id=str(person.id),
                    period=TargetPeriod.MONTH, period_start=lo, period_end=hi,
                    metrics=metrics,
                ).insert()
                made += 1
            anchor = lo - timedelta(days=1)
    print(f"  + {made} monthly targets across "
          f"{len(employees) + len(partners)} people")


# --- Workplace HR --------------------------------------------------------------


async def seed_holidays(owner: User) -> None:
    print("\n--- Holidays ---")
    year = utcnow().year
    holidays = [(f"{year}-01-26", "Republic Day"),
                (f"{year}-08-15", "Independence Day"),
                (f"{year}-10-02", "Gandhi Jayanti")]
    made = 0
    for date_str, name in holidays:
        if await Holiday.find_one(Holiday.date == date_str):
            continue
        await Holiday(date=date_str, year=year, name=name,
                     created_by=str(owner.id),
                     created_by_name=owner.full_name).insert()
        made += 1
    print(f"  + {made} holidays for {year}")


async def seed_attendance(employees: list[User], hr) -> None:
    print("\n--- Attendance (punched through the real service) ---")
    if await AttendanceDay.find_one({"user_id": str(employees[0].id),
                                     "source": "punch"}):
        print("  = attendance already exists for the first employee, "
              "skipping the whole batch")
        return
    today_ist = now_ist().date()
    made = 0
    for emp in employees:
        for back in range(1, 46):
            day = today_ist - timedelta(days=back)
            if day.weekday() == 6:            # Sunday off, per default HrSettings
                continue
            # One absence a fortnight, a late clock-in every fourth day,
            # otherwise a normal 10:00-19:00 day.
            if back % 14 == 0:
                continue                       # absent — no punch at all
            in_time = "10:25" if back % 4 == 0 else "09:55"
            clock_in = combine_ist(day, in_time)
            clock_out = combine_ist(day, "19:05")
            try:
                await hr_attendance.punch_in(emp, hr, now=clock_in)
                await hr_attendance.punch_out(emp, hr, now=clock_out)
                made += 1
            except ValueError:
                continue
    print(f"  + {made} punched days across {len(employees)} employees "
          "(late marks + one absence built in)")


async def seed_leave(employees: list[User], hr) -> None:
    print("\n--- Leave ---")
    now = utcnow()
    for emp in employees:
        year = now.year
        if await LeaveLedgerRow.find_one({"user_id": str(emp.id),
                                          "leave_year": year}):
            continue
        anchor = now
        for _back in range(3):
            period_key = anchor.strftime("%Y-%m")
            await hr_leave.post(str(emp.id), LeaveLedgerEntry.ACCRUAL.value,
                                hr_leave.accrual_for(emp, hr),
                                leave_year=year, period_key=period_key,
                                note="Monthly accrual")
            anchor = anchor.replace(day=1) - timedelta(days=1)

        # One approved leave, already taken, deducted from the balance.
        start = (now - timedelta(days=20)).date().isoformat()
        end = start
        req = LeaveRequest(
            code=await next_code("leave"), user_id=str(emp.id),
            user_name=emp.full_name, start_date=start, end_date=end,
            day_part=LeaveDayPart.FULL.value, reason_type=LeaveReason.PERSONAL.value,
            reason="Personal work", days=1.0, paid_days=1.0, unpaid_days=0.0,
            status=HrRequestStatus.APPROVED.value, decided_by=str(emp.id),
            decided_by_name=emp.full_name, decided_at=now - timedelta(days=21),
        )
        await req.insert()
        await hr_leave.spend(req, hr, emp)

        # One pending request, upcoming, for the approval queue to have
        # something in it.
        future = (now + timedelta(days=10)).date().isoformat()
        await LeaveRequest(
            code=await next_code("leave"), user_id=str(emp.id),
            user_name=emp.full_name, start_date=future, end_date=future,
            day_part=LeaveDayPart.FULL.value, reason_type=LeaveReason.OTHER.value,
            reason="Family function", days=1.0,
            status=HrRequestStatus.PENDING.value,
        ).insert()
    print(f"  + accrual, one approved and one pending request per employee")


async def seed_payslips(employees: list[User], hr) -> None:
    print("\n--- Payslips ---")
    month = payroll.previous_month(utcnow())
    made = 0
    for emp in employees:
        _slip, changed = await payroll.generate_for(emp, month, hr)
        if changed:
            made += 1
    print(f"  + {made} draft payslips generated for {month}")


# --- Entry point ---------------------------------------------------------------


async def main() -> None:
    print(f"\n=== {settings.app_name}: synthetic demo seed ===")
    print(f"    database: {settings.mongo_db_name}")
    if "test" not in settings.mongo_db_name.lower():
        print("    !! MONGO_DB_NAME does not contain 'test' — double-check "
              ".env before continuing.")
    await init_db()

    owner = await upsert_owner()
    employees = await upsert_employees(owner)
    manager = employees[-1]                    # Anita Desai, the RM
    partners = await upsert_partners(manager)

    insurers = await seed_insurers()
    brokers = await seed_brokers()
    cats = await seed_policy_types()
    await seed_rate_rules(brokers, cats, insurers)
    await seed_banks()

    customers = await seed_customers(owner)
    await seed_leads(owner)
    policies = await seed_policies(owner, insurers, brokers, cats, customers,
                                   partners, employees)
    await seed_money(owner, policies)
    await seed_targets(employees, partners)

    await seed_holidays(owner)
    hr = (await settings_svc.get_settings()).hr
    await seed_attendance(employees, hr)
    await seed_leave(employees, hr)
    await seed_payslips(employees, hr)

    print(f"""
================================================================================
 DONE. Every login below uses the password: {PASSWORD}

   {email_for("owner"):<28} Owner — sees everything
   {email_for("emp1"):<28} Sales Executive — policies + leads only
   {email_for("emp2"):<28} Operations — + finance, no profit
   {email_for("emp3"):<28} Relationship Manager — profit, targets, HR,
                                manages both channel partners below
   {email_for("cp1"):<28} Channel partner — portal login
   {email_for("cp2"):<28} Channel partner — portal login

 Seeded: 2 insurers, 2 brokers with rate cards, 3 policy types (Health, Life,
 Motor), 2 bank accounts, {len(customers)} customers, {len(LEADS)} leads,
 {len(policies)} policies with payments/rewards/TDS, targets for every
 employee and partner, holidays, ~45 days of attendance per employee, leave
 accrual + requests, and last month's payslips (draft).
================================================================================
""")
    await close_db()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
