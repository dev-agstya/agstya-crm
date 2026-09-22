"""Seed the BACKGROUND data for extras/test_cases_v5.txt (the 2-hour pre-demo pass).

    python insert_test_data.py            seed
    python insert_test_data.py --reset    wipe seeded data first, then seed
    python insert_test_data.py --wipe     wipe only, seed nothing

WHAT THIS DOES AND DOES NOT CREATE
----------------------------------
The v5 test file asks you to create some records BY HAND, because creating them
IS the test - the insurer short-name clash, the broker with no rate card, the
11,800 policy whose four reward numbers you check by eye. If this script created
those, those sections would be untestable.

So it seeds everything AROUND them: a second family of insurers, brokers, policy
types and rate cards, plus 25 customers, 12 channel partners, 3 employees, 30
policies spread over six months, their payments, TDS, wallets, targets and
leads. That is the part that takes forty minutes by hand and proves nothing.

  SEEDED (safe, never collides with a test-case name)
    Insurers ......... Star Health (STAR), ICICI Lombard (ICICI),
                       Reliance General (RGI - DEACTIVATED on purpose)
    Brokers .......... Probus (PRB, TDS 2%), Girnar (GIR, TDS 5%),
                       Square (SQR, TDS 0%, NO rate card)
    Policy types ..... Health (Individual / Family Floater),
                       Life (Term / Endowment) - both with custom fields
                       including a DATE field, so test 10.1 has something to
                       look at before you build Motor by hand
    People ........... 3 employees, 12 channel partners
    Book ............. 25 customers, 30 policies over 6 months, their premium
                       receipts, reward receipts (TDS auto-computed),
                       8 house expenses, 6 leads
    Targets .......... current + previous 2 months for each employee

  DELIBERATELY NOT SEEDED - you create these by hand, they are the test
    Insurer "HDFC Ergo" (HE) ............ case 2.1
    Insurer "Bajaj Allianz" (BA) ........ case 2.4
    Insurers "Test Dup" / "Test Blank" .. cases 2.5 - 2.7
    Broker "PolicyBazaar" (PB) .......... case 3.2
    Policy type "Motor" > "Car" ......... cases 3.8 - 3.10
    Rate card Motor/Car/PB/HDFC Ergo .... case 3.13
    Customer "Ramesh Kumar" ............. case 4.1
    The 11,800 policy ................... case 5.5
    Employee "Suresh Patel" ............. case 8.1
    Channel partner "Anil Shah" ......... case 5.13

  The script refuses to touch any of those names. If one already exists it says
  so and leaves it alone.

WHY IT GOES THROUGH THE REAL SERVICES
   Policies are booked with resolve_reward_terms -> sync_reward ->
   credit_reward -> book_policy_finance, and payments with
   finance.record_ledger_txn, exactly as the API does. Writing rows straight
   into the collections would leave the Balance Sheet, TDS report and party
   balances disagreeing with each other, and you would spend your two hours
   reporting bugs that only exist in the seed data.

Run it AFTER create_owner.py. It never touches the owner account.
"""

from __future__ import annotations

import argparse
import asyncio
import random
import secrets
import sys
from datetime import timedelta

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from app.config import settings                                    # noqa: E402
from app.core.enums import (                                       # noqa: E402
    AccountStatus, AccountType, BuyerType, LeadStage,
    LedgerTxnType, PartyType, PayerType, PolicyStatus, RewardBasis,
    TargetMetric, TargetPeriod,
)
from app.core.permissions import (                                 # noqa: E402
    MANAGE_CUSTOMERS, MANAGE_EMPLOYEES, MANAGE_LEADS, MANAGE_PARTNERS,
    MANAGE_POLICIES, MANAGE_RENEWALS, MANAGE_TARGETS, MANAGE_TRANSACTIONS,
    VIEW_AGENCY_PROFIT, VIEW_BALANCE_SHEET, VIEW_CUSTOMERS,
    VIEW_EMPLOYEES, VIEW_FINANCE_OVERVIEW, VIEW_LEADS, VIEW_PARTNERS,
    VIEW_POLICIES, VIEW_REPORTS, VIEW_TARGETS, VIEW_TDS, VIEW_TRANSACTIONS,
)
from app.core.security import hash_password                        # noqa: E402
from app.db import close_db, init_db                               # noqa: E402
from app.models.base import utcnow                                 # noqa: E402
from app.models.broker import Broker                               # noqa: E402
from app.models.customer import Customer                           # noqa: E402
from app.models.finance import (                                   # noqa: E402
    LedgerTxn, PartyAccount, PolicyFinance, TdsEntry,
)
from app.models.insurer import Insurer                             # noqa: E402
from app.models.lead import Lead                                   # noqa: E402
from app.models.master import (                                    # noqa: E402
    CategoryNode, CustomFieldSpec, PolicyCategory, RequiredDocSpec,
)
from app.models.policy import Policy                               # noqa: E402
from app.models.rate_rule import RateRule                          # noqa: E402
from app.models.reward import Reward                               # noqa: E402
from app.models.target import Target                               # noqa: E402
from app.models.user import EmployeeProfile, User                  # noqa: E402
from app.models.wallet import Wallet, WalletTxn                    # noqa: E402
from app.services import finance as finance_svc                    # noqa: E402
from app.services import targets as target_svc                     # noqa: E402
from app.services import wallet as wallet_svc                      # noqa: E402
from app.services.codes import next_code, next_customer_code       # noqa: E402
from app.services.money import commissionable_from_premium         # noqa: E402
from app.services.policy_ops import (                              # noqa: E402
    resolve_reward_terms, sync_reward,
)

# Deterministic run - the same book every time, so a number you queried
# yesterday still means the same thing today.
random.seed(20260727)

# --- Names the test cases own. The script must never create these. -----------
RESERVED_INSURERS = {"hdfc ergo", "bajaj allianz", "test dup",
                     "test blank a", "test blank b"}
RESERVED_SHORT_NAMES = {"HE", "BA"}
RESERVED_BROKERS = {"policybazaar"}
RESERVED_POLICY_TYPES = {"motor"}
RESERVED_MOBILES = {"9876543210",   # Ramesh Kumar, case 4.1
                    "9812345678"}   # Anil Shah, case 5.13
RESERVED_PEOPLE = {"ramesh kumar", "suresh patel", "anil shah"}

# Everything the script creates is tagged, so you can tell seeded rows from your
# own at a glance and --reset knows what it is looking at.
SEED_TAG = "[seed]"
# NOT a .test / .invalid domain: Customer.email is a pydantic EmailStr and
# rejects reserved special-use TLDs outright.
SEED_EMAIL_DOMAIN = "seed.agastyacrm.in"
SEED_PASSWORD = "Seed@12345"

# --- The seeded data set -----------------------------------------------------

INSURERS = [
    # name, short_name, active
    ("Star Health & Allied", "STAR", True),
    ("ICICI Lombard General", "ICICI", True),
    # Deactivated on purpose: case 9.4 asks you to confirm a deactivated
    # insurer is not offered when booking new business. One already exists.
    ("Reliance General", "RGI", False),
]

BROKERS = [
    # name, short_code, tds_percent (percent*100), agency%, partner% (percent*100)
    ("Probus Insurance", "PRB", 200, 1800, 1200),
    ("Girnar Insurance", "GIR", 500, 2000, 1500),
    # No rate card at all - proves a policy can still be booked with rates typed
    # by hand, and gives you a broker that is safe to delete (case 9.9).
    ("Square Insurance", "SQR", 0, None, None),
]

POLICY_TYPES = [
    {
        "key": "health", "label": "Health", "sort_order": 10,
        "children": [("individual", "Individual"),
                     ("family_floater", "Family Floater")],
        # key, label, type, required, is_reward_base
        "custom_fields": [
            ("sum_assured", "Sum Assured", "amount", False, True),
            # A DATE field, so test 10.1 has a custom date box to check before
            # you have built Motor by hand.
            ("medical_done_on", "Medical Done On", "date", False, False),
            ("pre_existing", "Pre-existing Disease", "select", False, False),
        ],
        "docs": [("id_proof", "ID Proof"), ("medical_report", "Medical Report")],
    },
    {
        "key": "life", "label": "Life", "sort_order": 20,
        "children": [("term", "Term"), ("endowment", "Endowment")],
        "custom_fields": [
            ("sum_assured", "Sum Assured", "amount", False, True),
            ("nominee_dob", "Nominee Date of Birth", "date", False, False),
        ],
        "docs": [("id_proof", "ID Proof")],
    },
]

# Employees, each with a DIFFERENT permission shape, so the RBAC checks in
# sections 8 and 10 have someone to try without creating Suresh Patel.
EMPLOYEES = [
    # full name, designation, permissions
    ("Vikram Rao", "Sales Executive",
     [VIEW_POLICIES, MANAGE_POLICIES]),
    ("Priya Menon", "Operations",
     [VIEW_POLICIES, MANAGE_POLICIES, VIEW_TRANSACTIONS, MANAGE_TRANSACTIONS,
      VIEW_FINANCE_OVERVIEW, VIEW_BALANCE_SHEET, VIEW_TDS]),
    # The only seeded employee who may see profit and set targets. Useful for
    # proving the gate works in BOTH directions, not just that it hides things.
    ("Anita Desai", "Manager",
     [VIEW_POLICIES, MANAGE_POLICIES, VIEW_LEADS, MANAGE_LEADS,
      VIEW_CUSTOMERS, MANAGE_CUSTOMERS, MANAGE_RENEWALS,
      VIEW_TRANSACTIONS, VIEW_FINANCE_OVERVIEW, VIEW_BALANCE_SHEET, VIEW_TDS,
      VIEW_AGENCY_PROFIT, VIEW_EMPLOYEES, MANAGE_EMPLOYEES,
      VIEW_PARTNERS, MANAGE_PARTNERS, VIEW_TARGETS, MANAGE_TARGETS,
      VIEW_REPORTS]),
]

PARTNERS = [
    "Yogesh Sharma", "Ayesha Khan", "Rohit Verma", "Neha Gupta",
    "Arjun Mehta", "Pooja Iyer", "Vikram Singh", "Divya Nair",
    "Karan Malhotra", "Sneha Kulkarni", "Manish Tiwari", "Ritu Agarwal",
]

CUSTOMERS = [
    "Ayush Verma", "Ishaan Patel", "Meera Krishnan", "Rahul Saxena",
    "Ananya Bose", "Kunal Kapoor", "Swati Mishra", "Devansh Trivedi",
    "Lakshmi Pillai", "Harsh Vardhan", "Nidhi Chopra", "Siddharth Rao",
    "Pallavi Deshmukh", "Gaurav Khanna", "Ritika Sinha", "Mohit Aggarwal",
    "Juhi Bhatt", "Aditya Kulkarni", "Sonal Jain", "Varun Nambiar",
    "Preeti Dubey", "Akash Solanki", "Bhavna Chawla", "Rajat Sehgal",
    "Ipsita Mohanty",
]

LEADS = [
    ("Naveen Kumar", "9700100011", "Health cover for family", 2500000),
    ("Shreya Banerjee", "9700100012", "Term life 1 crore", 1800000),
    ("Parth Doshi", "9700100013", "Car insurance renewal", 950000),
    ("Anjali Rathore", "9700100014", "Top-up health plan", 1200000),
    ("Deepak Negi", "9700100015", "Endowment / savings plan", 6000000),
    ("Kirti Saluja", "9700100016", "Family floater upgrade", 3200000),
]

# Gross premiums in RUPEES for the seeded book, spread so the monthly graphs
# have shape rather than a flat line.
PREMIUM_POOL = [11800, 23600, 17700, 35400, 8850, 47200, 14160,
                29500, 59000, 21240, 9440, 41300]


def rupees(amount: int) -> int:
    """Rupees -> paise. Money is stored as integer paise, never a float."""
    return amount * 100


def money(paise: int) -> str:
    return f"Rs {paise / 100:,.2f}"


# --- Guards ------------------------------------------------------------------


async def _reserved_conflicts() -> list[str]:
    """Anything already in the DB that the test cases expect to create fresh."""
    out = []
    for ins in await Insurer.find_all().to_list():
        if ins.name.strip().lower() in RESERVED_INSURERS:
            out.append(f"insurer '{ins.name}' already exists (case 2.1 / 2.4)")
        if (ins.short_name or "").strip().upper() in RESERVED_SHORT_NAMES:
            out.append(f"insurer short name '{ins.short_name}' already taken "
                       f"(cases 2.5 - 2.6 need it free)")
    for b in await Broker.find_all().to_list():
        if b.name.strip().lower() in RESERVED_BROKERS:
            out.append(f"broker '{b.name}' already exists (case 3.2)")
    for c in await PolicyCategory.find_all().to_list():
        if c.key.strip().lower() in RESERVED_POLICY_TYPES:
            out.append(f"policy type '{c.label}' already exists (case 3.8)")
    for m in sorted(RESERVED_MOBILES):
        if await Customer.find_one(Customer.mobile == m):
            out.append(f"a customer already uses mobile {m} (case 4.1)")
    return out


# --- Wipe --------------------------------------------------------------------


async def wipe(owner: User) -> None:
    """Remove everything except the owner account and the code counters.

    Deliberately blunt: this is for a scratch database before a test run, and a
    half-cleared book (policies gone, ledger rows left behind) is far more
    confusing to debug than an empty one.
    """
    print("\n--- Wiping ---")
    for model, label in (
        (WalletTxn, "wallet entries"), (Wallet, "wallets"),
        (TdsEntry, "TDS entries"), (LedgerTxn, "ledger rows"),
        (PartyAccount, "party accounts"), (PolicyFinance, "finance snapshots"),
        (Reward, "rewards"), (Policy, "policies"), (Target, "targets"),
        (Lead, "leads"), (Customer, "customers"), (RateRule, "rate rules"),
        (Broker, "brokers"), (Insurer, "insurers"),
        (PolicyCategory, "policy types"),
    ):
        res = await model.find_all().delete()
        print(f"  - {getattr(res, 'deleted_count', 0):>4}  {label}")
    res = await User.find(User.id != owner.id).delete()
    print(f"  - {getattr(res, 'deleted_count', 0):>4}  users (owner kept)")


# --- Seeding -----------------------------------------------------------------


async def seed_insurers() -> dict[str, Insurer]:
    print("\n--- Insurers ---")
    out: dict[str, Insurer] = {}
    for name, short, active in INSURERS:
        existing = await Insurer.find_one(Insurer.name == name)
        if existing:
            out[short] = existing
            print(f"  = {name} (exists)")
            continue
        ins = Insurer(code=await next_code("insurer"), name=name,
                      short_name=short, active=active,
                      phone=f"98765{random.randint(10000, 99999)}",
                      notes=SEED_TAG)
        await ins.insert()
        out[short] = ins
        print(f"  + {name} [{short}]" + ("" if active else "   DEACTIVATED"))
    return out


async def seed_brokers() -> dict[str, Broker]:
    print("\n--- Brokers ---")
    out: dict[str, Broker] = {}
    for name, short, tds, _a, _p in BROKERS:
        existing = await Broker.find_one(Broker.name == name)
        if existing:
            out[short] = existing
            print(f"  = {name} (exists)")
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
        existing = await PolicyCategory.find_one(
            PolicyCategory.key == spec["key"])
        if existing:
            out[spec["key"]] = existing
            print(f"  = {spec['label']} (exists)")
            continue
        cat = PolicyCategory(
            key=spec["key"], label=spec["label"], sort_order=spec["sort_order"],
            description=f"{spec['label']} business {SEED_TAG}",
            children=[CategoryNode(key=k, label=lbl)
                      for k, lbl in spec["children"]],
            custom_fields=[
                CustomFieldSpec(
                    key=k, label=lbl, type=t, required=req,
                    is_reward_base=base,
                    options=["Yes", "No"] if t == "select" else [])
                for k, lbl, t, req, base in spec["custom_fields"]],
            required_documents=[
                RequiredDocSpec(key=k, label=lbl, required=False)
                for k, lbl in spec["docs"]],
            active=True)
        await cat.insert()
        out[spec["key"]] = cat
        print(f"  + {spec['label']}  ({len(spec['children'])} sub-types, "
              f"{len(spec['custom_fields'])} custom fields incl. a date)")
    return out


async def seed_rate_rules(brokers: dict[str, Broker],
                          cats: dict[str, PolicyCategory],
                          insurers: dict[str, Insurer]) -> None:
    print("\n--- Rate cards ---")
    for name, short, _tds, agency, partner in BROKERS:
        if agency is None:
            print(f"  - {name}: none on purpose (rates typed per policy)")
            continue
        b = brokers.get(short)
        if b is None:
            continue
        for key, cat in cats.items():
            existing = await RateRule.find_one(
                RateRule.broker_id == str(b.id),
                RateRule.category_key == key,
                RateRule.insurer_id == None)          # noqa: E711 (beanie)
            if existing:
                continue
            await RateRule(
                broker_id=str(b.id), category_key=key,
                agency_basis=RewardBasis.PERCENT, agency_value=agency,
                partner_basis=RewardBasis.PERCENT, partner_value=partner,
                label=f"{short} default - {cat.label}",
            ).insert()
            print(f"  + {short} / {cat.label}: agency {agency / 100:.0f}% "
                  f"partner {partner / 100:.0f}%")
        # One insurer-specific override, so "most specific rule wins" has
        # something to demonstrate on the rate-card screen.
        star = insurers.get("STAR")
        if star and short == "PRB":
            exists = await RateRule.find_one(
                RateRule.broker_id == str(b.id),
                RateRule.category_key == "health",
                RateRule.insurer_id == str(star.id))
            if not exists:
                await RateRule(
                    broker_id=str(b.id), category_key="health",
                    insurer_id=str(star.id),
                    agency_basis=RewardBasis.PERCENT, agency_value=2200,
                    partner_basis=RewardBasis.PERCENT, partner_value=1400,
                    label="PRB / Health / Star Health (override)",
                ).insert()
                print("  + PRB / Health / Star Health: agency 22% partner 14%"
                      "  (insurer-specific override)")


async def seed_employees(owner: User) -> list[User]:
    print("\n--- Employees ---")
    out: list[User] = []
    for i, (full_name, designation, perms) in enumerate(EMPLOYEES, start=1):
        if full_name.strip().lower() in RESERVED_PEOPLE:
            continue
        email = f"emp{i:02d}@{SEED_EMAIL_DOMAIN}"
        existing = await User.find_one(User.email == email,
                                       {"is_deleted": {"$ne": True}})
        if existing:
            out.append(existing)
            print(f"  = {full_name} (exists)")
            continue
        u = User(
            code=await next_code("user"),
            full_name=full_name,
            email=email,
            mobile=f"96000000{i:02d}",
            account_type=AccountType.EMPLOYEE,
            hashed_password=hash_password(SEED_PASSWORD),
            # No forced change and no onboarding wizard: you want to be INSIDE
            # the app as this person in one step, not filling in a KYC form.
            must_change_password=False,
            onboarded=True,
            status=AccountStatus.ACTIVE,
            permissions=list(perms),
            extra_permissions=list(perms),
            reports_to_id=str(owner.id),
            created_by=str(owner.id),
            # The profile defaults to None, so it has to be built - assigning
            # through u.employee_profile would silently do nothing.
            employee_profile=EmployeeProfile(designation=designation,
                                             department="Sales"),
        )
        await u.insert()
        out.append(u)
        print(f"  + {full_name:<14} {email}   ({designation})")
    return out


async def seed_partners(owner: User) -> list[User]:
    print("\n--- Channel partners ---")
    out: list[User] = []
    made = 0
    for i, full_name in enumerate(PARTNERS, start=1):
        if full_name.strip().lower() in RESERVED_PEOPLE:
            continue
        mobile = f"97000000{i:02d}"
        if mobile in RESERVED_MOBILES:
            continue
        email = f"cp{i:02d}@{SEED_EMAIL_DOMAIN}"
        existing = await User.find_one(User.email == email,
                                       {"is_deleted": {"$ne": True}})
        if existing:
            out.append(existing)
            continue
        u = User(
            code=await next_code("partner"),
            full_name=full_name,
            email=email,
            mobile=mobile,
            account_type=AccountType.CHANNEL_PARTNER,
            # The portal is paused, so this password is never used - it only has
            # to exist. No welcome email is sent either.
            hashed_password=hash_password(secrets.token_urlsafe(16)),
            must_change_password=True,
            onboarded=False,
            status=AccountStatus.ACTIVE,
            relationship_manager_id=str(owner.id),
            created_by=str(owner.id),
        )
        await u.insert()
        out.append(u)
        made += 1
    print(f"  + {made} channel partners (mobiles 97000000xx)")
    return out


async def seed_customers(owner: User) -> list[Customer]:
    print("\n--- Customers ---")
    out: list[Customer] = []
    made = 0
    for i, name in enumerate(CUSTOMERS, start=1):
        if name.strip().lower() in RESERVED_PEOPLE:
            continue
        mobile = f"98000000{i:02d}"
        if mobile in RESERVED_MOBILES:
            continue
        existing = await Customer.find_one(Customer.mobile == mobile)
        if existing:
            out.append(existing)
            continue
        c = Customer(
            code=await next_customer_code(),
            name=name,
            mobile=mobile,
            email=f"cust{i:02d}@{SEED_EMAIL_DOMAIN}",
            owner_user_id=str(owner.id),
            created_by_name=owner.full_name,
            notes=SEED_TAG,
        )
        await c.insert()
        out.append(c)
        made += 1
    print(f"  + {made} customers (mobiles 98000000xx)")
    return out


async def seed_leads(owner: User) -> None:
    print("\n--- Leads ---")
    stages = [LeadStage.NEW, LeadStage.CONTACTED, LeadStage.QUOTED,
              LeadStage.NEW, LeadStage.CONTACTED, LeadStage.LOST]
    made = 0
    for (name, mobile, interest, est), stage in zip(LEADS, stages):
        if await Lead.find_one(Lead.mobile == mobile):
            continue
        await Lead(
            code=await next_code("lead"), name=name, mobile=mobile,
            email=f"{name.split()[0].lower()}@{SEED_EMAIL_DOMAIN}",
            interested_in=interest, estimated_premium=est, stage=stage,
            owner_user_id=str(owner.id), created_by=str(owner.id),
            created_by_name=owner.full_name, note=SEED_TAG,
        ).insert()
        made += 1
    print(f"  + {made} leads across the stages")


async def seed_policies(owner: User, insurers: dict[str, Insurer],
                        brokers: dict[str, Broker],
                        cats: dict[str, PolicyCategory],
                        customers: list[Customer],
                        partners: list[User],
                        employees: list[User]) -> list[Policy]:
    """Book 30 policies over the last six months, through the real services.

    Every one goes: insert -> resolve_reward_terms -> sync_reward ->
    credit_reward (when a partner is attributed) -> book_policy_finance. That
    last call is what creates the premium-due row and the agency premium
    payment, which is why the party balances and the Balance Sheet agree with
    the policy list afterwards.
    """
    print("\n--- Policies (booked through the real finance path) ---")
    existing = await Policy.find({"notes": SEED_TAG}).to_list()
    if existing:
        print(f"  = {len(existing)} seeded policies already exist, skipping")
        return existing

    active_insurers = [i for i in insurers.values() if i.active]
    rated_brokers = [brokers[s] for _n, s, _t, a, _p in BROKERS
                     if a is not None and s in brokers]
    if not (active_insurers and rated_brokers and cats and customers):
        print("  ! missing prerequisites, skipping policies")
        return []

    type_paths = [("health", ["individual"]), ("health", ["family_floater"]),
                  ("life", ["term"]), ("life", ["endowment"])]
    made: list[Policy] = []
    now = utcnow()

    for n in range(30):
        cust = customers[n % len(customers)]
        insurer = active_insurers[n % len(active_insurers)]
        broker = rated_brokers[n % len(rated_brokers)]
        cat_key, path = type_paths[n % len(type_paths)]
        if cat_key not in cats:
            continue
        gross = rupees(PREMIUM_POOL[n % len(PREMIUM_POOL)])
        # Every third policy is attributed to a channel partner, so both the
        # partner-payable and the pure-house-profit paths carry data.
        partner = partners[n % len(partners)] if (n % 3 == 0 and partners) \
            else None
        # Spread over ~6 months so the monthly graphs have shape.
        started = now - timedelta(days=random.randint(5, 175))
        booker = employees[n % len(employees)] if employees else owner

        pol = Policy(
            code=await next_code("policy"),
            policy_number=f"SEED-{1000 + n}",
            category_key=cat_key,
            subcategory_path=list(path),
            subcategory_key=path[-1] if path else None,
            insurer_id=str(insurer.id),
            broker_id=str(broker.id),
            customer_id=str(cust.id),
            status=PolicyStatus.ACTIVE,
            approved_by=str(owner.id),
            approved_at=started,
            premium_amount=gross,
            commissionable_premium=commissionable_from_premium(gross),
            sum_insured=gross * 40,
            issue_date=started,
            start_date=started,
            expiry_date=started + timedelta(days=365),
            payer=PayerType.AGENCY,
            buyer_type=(BuyerType.CHANNEL_PARTNER if partner
                        else BuyerType.DIRECT),
            details={"sum_assured": gross * 40},
            reward_base_field="commissionable",
            owner_user_id=str(booker.id),
            partner_id=str(partner.id) if partner else None,
            created_by=str(owner.id),
            created_at=started,
            notes=SEED_TAG,
        )
        pol.reward = await resolve_reward_terms(pol)
        await pol.insert()

        reward = await sync_reward(pol)
        if pol.partner_id:
            await wallet_svc.credit_reward(reward)
        await finance_svc.book_policy_finance(pol, reward)
        made.append(pol)

    total = sum(p.premium_amount for p in made)
    with_partner = sum(1 for p in made if p.partner_id)
    print(f"  + {len(made)} policies, gross premium {money(total)}")
    print(f"    {with_partner} via a channel partner, "
          f"{len(made) - with_partner} direct")
    return made


async def seed_money(owner: User, policies: list[Policy]) -> None:
    """Record the cash: premium in from customers, reward in from brokers (which
    withhold TDS), and a few house expenses.

    Signs follow routers/finance._signed_amount: money RECEIVED or paid out is
    NEGATIVE (it reduces what the party owes us); money we front is POSITIVE.
    Getting this backwards is the classic way to make a Balance Sheet lie.
    """
    print("\n--- Payments, rewards, TDS, expenses ---")
    if await LedgerTxn.find_one({"reference": SEED_TAG}):
        print("  = seeded payments already exist, skipping")
        return

    collected = rewarded = 0
    for i, pol in enumerate(policies):
        reward = await Reward.find_one(Reward.policy_id == str(pol.id))
        paid_on = (pol.start_date or utcnow()) + timedelta(days=3)

        # 80% of policies have had their premium collected. The rest stay
        # outstanding so the pending/aging panels are not empty.
        if i % 5 != 4:
            await finance_svc.record_ledger_txn(
                txn_type=LedgerTxnType.PREMIUM_COLLECTED,
                party_type=PartyType.CUSTOMER, party_id=pol.customer_id,
                amount_paise=-pol.premium_amount,
                policy_id=str(pol.id), occurred_at=paid_on,
                reference=SEED_TAG, note="Premium received",
                created_by=str(owner.id))
            collected += pol.premium_amount

        # 60% have had the reward settled by the broker.
        if reward and reward.agency_amount > 0 and i % 5 < 3 and pol.broker_id:
            await finance_svc.record_ledger_txn(
                txn_type=LedgerTxnType.REWARD_RECEIVED,
                party_type=PartyType.BROKER, party_id=pol.broker_id,
                amount_paise=-reward.agency_amount,
                policy_id=str(pol.id),
                occurred_at=paid_on + timedelta(days=10),
                reference=SEED_TAG, note="Reward received",
                created_by=str(owner.id))
            rewarded += reward.agency_amount
            broker = await Broker.get(pol.broker_id)
            if broker and broker.tds_percent > 0:
                await finance_svc.record_reward_tds(
                    broker_id=pol.broker_id, tds_percent=broker.tds_percent,
                    gross_reward_paise=reward.agency_amount,
                    policy_id=str(pol.id), ledger_txn_id=None,
                    reference=SEED_TAG, note="TDS on reward",
                    created_by=str(owner.id))

    print(f"  + premium collected {money(collected)}")
    print(f"  + reward received   {money(rewarded)}   (TDS auto-computed)")

    # House expenses, so realised net profit is not just income.
    expenses = [("salary", rupees(45000), "Staff salary"),
                ("rent", rupees(25000), "Office rent"),
                ("marketing", rupees(8000), "Lead campaign"),
                ("software", rupees(3500), "CRM subscription"),
                ("utilities", rupees(1800), "Electricity and internet"),
                ("travel", rupees(2400), "Client visits"),
                ("office_supplies", rupees(950), "Stationery"),
                ("taxes_fees", rupees(4000), "Professional fees")]
    now = utcnow()
    for k, (category, amount, note) in enumerate(expenses):
        await LedgerTxn(
            txn_type=LedgerTxnType.EXPENSE, party_type=PartyType.EXPENSE,
            party_id="house", amount_paise=-amount,
            note=note, reference=SEED_TAG,
            occurred_at=now - timedelta(days=15 * k),
            expense_category=category, created_by=str(owner.id),
        ).insert()
    print(f"  + {len(expenses)} house expenses "
          f"{money(sum(a for _c, a, _n in expenses))}")


async def seed_targets(employees: list[User]) -> None:
    """Targets for this month and the two before it, so the dashboard tile and
    its month dropdown have something in every position."""
    print("\n--- Targets ---")
    if not employees:
        print("  - no employees to assign to")
        return
    now = utcnow()
    made = 0
    for emp in employees:
        anchor = now
        for _back in range(3):
            lo, hi = target_svc.normalise_period(TargetPeriod.MONTH, anchor)
            if not await Target.find_one(Target.assignee_id == str(emp.id),
                                         Target.period_start == lo):
                await Target(
                    assignee_type=AccountType.EMPLOYEE.value,
                    assignee_id=str(emp.id),
                    period=TargetPeriod.MONTH,
                    period_start=lo, period_end=hi,
                    metrics={
                        TargetMetric.POLICIES.value: 8,
                        TargetMetric.HOUSE_PROFIT.value: rupees(25000),
                    },
                ).insert()
                made += 1
            # Step back into the previous calendar month.
            anchor = lo - timedelta(days=1)
    print(f"  + {made} monthly targets across {len(employees)} employees "
          f"(8 policies, house profit Rs 25,000)")


# --- Entry point -------------------------------------------------------------


async def main(args) -> None:
    print(f"\n=== {settings.app_name}: seed test data ===")
    print(f"    database: {settings.mongo_db_name}")
    await init_db()

    owner = await User.find_one(User.account_type == AccountType.OWNER)
    if owner is None:
        print("\nNo owner account found. Run create_owner.py first.\n")
        await close_db()
        return
    print(f"    owner:    {owner.full_name} <{owner.email}>")

    if args.reset or args.wipe:
        if not args.yes:
            print("\n*** THIS DELETES EVERY RECORD EXCEPT THE OWNER ACCOUNT ***")
            if input("    Type RESET to continue: ").strip() != "RESET":
                print("Cancelled.\n")
                await close_db()
                return
        await wipe(owner)
        if args.wipe:
            print("\nWiped. Nothing seeded (--wipe).\n")
            await close_db()
            return

    conflicts = await _reserved_conflicts()
    if conflicts:
        print("\n! Records the test cases expect to create already exist:")
        for c in conflicts:
            print(f"    - {c}")
        print("  They are left untouched. Those cases will say 'already"
              " exists' -\n  delete them by hand, or re-run with --reset.")

    insurers = await seed_insurers()
    brokers = await seed_brokers()
    cats = await seed_policy_types()
    await seed_rate_rules(brokers, cats, insurers)
    employees = await seed_employees(owner)
    partners = await seed_partners(owner)
    customers = await seed_customers(owner)
    await seed_leads(owner)
    policies = await seed_policies(owner, insurers, brokers, cats,
                                   customers, partners, employees)
    await seed_money(owner, policies)
    await seed_targets(employees)

    print(f"""
================================================================================
 DONE. Open extras/test_cases_v5.txt and start at Section 0.

 SEEDED EMPLOYEE LOGINS - password for all three: {SEED_PASSWORD}
   emp01@{SEED_EMAIL_DOMAIN}   Vikram Rao     policies only, NO finance
   emp02@{SEED_EMAIL_DOMAIN}   Priya Menon    + transactions + finance,
                                                   but NOT profit
   emp03@{SEED_EMAIL_DOMAIN}   Anita Desai    manager: profit AND targets

 Use emp01 for the profit-visibility check (case 8.13) if you do not want to
 wait for Suresh Patel to finish onboarding. emp03 is the opposite control -
 she SHOULD see profit, which proves the gate is a gate and not a wall.

 STILL YOURS TO CREATE BY HAND - these are the tests, not the setup:
   HDFC Ergo (HE) . Bajaj Allianz (BA) . PolicyBazaar (PB)
   Motor > Car and its rate card . Ramesh Kumar . the 11,800 policy
   Suresh Patel . Anil Shah
================================================================================
""")
    await close_db()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reset", action="store_true",
                    help="delete everything except the owner, then seed")
    ap.add_argument("--wipe", action="store_true",
                    help="delete everything except the owner and stop")
    ap.add_argument("--yes", action="store_true",
                    help="skip the confirmation prompt for --reset / --wipe")
    try:
        asyncio.run(main(ap.parse_args()))
    except KeyboardInterrupt:
        print("\nCancelled.")
