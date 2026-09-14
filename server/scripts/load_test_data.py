"""Generate a LOAD-TEST book: bulk data for measuring how the app performs at
scale. This is not the demo seeder (`insert_test_data.py`) — that one creates 30
policies through the real services so a human can walk the test cases. This one
creates as many as will fit, as fast as possible, so you can time the Balance
Sheet against a realistic book.

    python scripts/load_test_data.py --plan       size the run, write nothing
    python scripts/load_test_data.py              generate
    python scripts/load_test_data.py --stats      report what is in the DB
    python scripts/load_test_data.py --drop       delete the whole test database

SAFETY
------
Everything lands in a SEPARATE database (default `agastyacrm_loadtest`), never
the app's real one. Two reasons: a bad run can't touch live records, and cleanup
is one `dropDatabase` instead of unpicking 800k documents by filter. `--drop`
refuses to run against the database named in MONGO_DB_NAME.

FITTING A FREE TIER
-------------------
Atlas M0 gives 512MB for data AND indexes, and indexes are nearly half the cost
here (policies alone carry 12). Rather than guess at WiredTiger's compression
ratio, the script MEASURES it: it writes a small calibration slice, reads the
real bytes-per-policy back from dbStats, then scales the plan to fit the budget
and reports the scale it actually achieved. Set the budget with --max-mb.

CONSISTENCY
-----------
Rows are bulk-inserted rather than booked through the services (120k policies
one service call at a time takes hours), but every money figure comes from the
SAME pure functions the services use — services/money.py and the pure half of
services/finance.py. Party balances are then derived from the finished ledger in
one pass, exactly as recompute_party_account() would. So the Balance Sheet, TDS
report and party statements agree with each other; the numbers are real, only
the route in is faster.

WHAT IT DOES NOT CREATE
-----------------------
No S3 uploads and no DocumentRecord rows (deliberate — keeps the bucket bill at
zero while load testing). No AuditLog rows either: at this volume they would
dominate storage and tell you nothing about read performance.
"""

from __future__ import annotations

import argparse
import asyncio
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.core.enums import (  # noqa: E402
    LedgerTxnType,
    PartyType,
    PayerType,
    RewardBasis,
    RewardStatus,
)
from app.services.finance import (  # noqa: E402
    agency_premium_ledger_amount,
    compute_finance,
    eligible_snapshot_amounts,
    policy_premium_due,
    premium_receivable,
    settlement_status,
    tds_on_reward,
)
from app.services.money import (  # noqa: E402
    commissionable_from_premium,
    compute_reward,
)

# --- Run shape ----------------------------------------------------------------
DEFAULT_DB = "agastyacrm_loadtest"
DEFAULT_MAX_MB = 280           # leave headroom under a 300MB allowance

TARGET_CUSTOMERS = 75_000
TARGET_POLICIES = 120_000
TARGET_PARTNERS = 600
TARGET_EMPLOYEES = 50

# The book runs from 2020 and grows — a flat distribution would hide exactly the
# "recent months are hot, old months are cold" behaviour we want to measure.
BOOK_START = datetime(2020, 1, 1, tzinfo=timezone.utc)
BOOK_END = datetime(2026, 7, 1, tzinfo=timezone.utc)
YEAR_WEIGHTS = {2020: 0.6, 2021: 0.8, 2022: 1.0, 2023: 1.3,
                2024: 1.6, 2025: 2.0, 2026: 1.2}   # 2026 is a part year

BATCH = 2_000                  # documents per insert_many
CALIBRATION_POLICIES = 2_400   # measured slice used to size the full run

rng = random.Random(20260728)

# --- Reference vocabulary -----------------------------------------------------
INSURERS = [
    ("HDFC Ergo", "HE"), ("ICICI Lombard", "ICICI"), ("Star Health", "STAR"),
    ("Bajaj Allianz", "BA"), ("Tata AIG", "TATA"), ("SBI General", "SBIG"),
    ("Reliance General", "RGI"), ("New India Assurance", "NIA"),
    ("LIC of India", "LIC"), ("Max Life", "MAX"), ("Care Health", "CARE"),
    ("Digit Insurance", "DIGIT"),
]
BROKERS = [
    ("PolicyBazaar", "PB", 200), ("Probus", "PRB", 200), ("Girnar", "GIR", 500),
    ("Square Insurance", "SQR", 0), ("Cars24", "C24", 200),
    ("InsuranceDekho", "IDK", 500), ("Turtlemint", "TMT", 200),
    ("RenewBuy", "RNB", 0),
]
CATEGORIES = [
    ("motor", "Motor", ["4_wheeler", "2_wheeler", "commercial"]),
    ("health", "Health", ["individual", "family_floater", "senior_citizen"]),
    ("life", "Life", ["term", "endowment", "ulip"]),
    ("property", "Property", ["home", "shop"]),
    ("business", "Business", ["liability", "marine", "fire"]),
    ("travel", "Travel", ["domestic", "international"]),
]

FIRST = ["Ramesh", "Suresh", "Anil", "Vijay", "Neelam", "Priya", "Amit",
         "Kavita", "Rahul", "Sunita", "Deepak", "Meena", "Arjun", "Pooja",
         "Sanjay", "Rekha", "Manoj", "Anita", "Vikram", "Shreya", "Nitin",
         "Divya", "Rajesh", "Swati", "Karan", "Nisha", "Alok", "Preeti"]
LAST = ["Sharma", "Verma", "Patel", "Kothari", "Rajawat", "Singh", "Gupta",
        "Mehta", "Joshi", "Nair", "Reddy", "Iyer", "Desai", "Kulkarni",
        "Chauhan", "Bansal", "Malhotra", "Shah", "Rao", "Pillai"]
CITIES = ["Jaipur", "Udaipur", "Jodhpur", "Kota", "Ajmer", "Bikaner"]


def utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def person_name(i: int) -> str:
    return f"{FIRST[i % len(FIRST)]} {LAST[(i // len(FIRST)) % len(LAST)]}"


def mobile_for(i: int) -> str:
    """Unique 10-digit mobile. Customers are deduped on this, so it must not
    collide — derive it from the index rather than randomising."""
    return f"9{i:09d}"


def weighted_date() -> datetime:
    """A date in the book window, weighted so later years carry more volume."""
    years = list(YEAR_WEIGHTS)
    year = rng.choices(years, weights=[YEAR_WEIGHTS[y] for y in years])[0]
    lo = max(BOOK_START, datetime(year, 1, 1, tzinfo=timezone.utc))
    hi = min(BOOK_END, datetime(year, 12, 31, tzinfo=timezone.utc))
    span = int((hi - lo).total_seconds())
    if span <= 0:
        return lo
    return lo + timedelta(seconds=rng.randrange(span))


# --- Size accounting ----------------------------------------------------------
async def db_megabytes(db) -> tuple[float, float, float]:
    """(data, index, budget) megabytes.

    `dataSize` is maintained in metadata and is accurate the instant a write
    lands. `storageSize` and `indexSize` are on-disk figures that stay at their
    last checkpoint — on a fresh collection they read 4096 no matter how much
    you just inserted, which silently makes any calibration read ~zero.

    So the budget figure is dataSize + indexSize: dataSize is UNCOMPRESSED, and
    Atlas bills the compressed on-disk size, which makes this deliberately
    conservative. Better to stop early with room to spare than to fill an M0.
    """
    stats = await db.command("dbStats")
    data = stats.get("dataSize", 0) / 1_048_576
    index = stats.get("indexSize", 0) / 1_048_576
    return data, index, data + index


async def settled_megabytes(db) -> tuple[float, float]:
    """True on-disk (compressed) size, after waiting out a checkpoint."""
    await asyncio.sleep(70)
    stats = await db.command("dbStats")
    return (stats.get("storageSize", 0) / 1_048_576,
            stats.get("indexSize", 0) / 1_048_576)


# --- Catalog ------------------------------------------------------------------
async def seed_catalog(db) -> dict:
    """Insurers, brokers, policy types and a rate card. Fixed, small cost."""
    now = utc(datetime.now(timezone.utc))

    insurers = [{
        "_id": ObjectId(), "code": f"AG-INS-{i:06d}", "name": name,
        "short_name": short, "active": True,
        "created_at": now, "updated_at": now,
    } for i, (name, short) in enumerate(INSURERS, start=1)]

    brokers = [{
        "_id": ObjectId(), "code": f"BRK-{i:07d}", "short_code": short,
        "name": name, "tds_percent": tds, "active": True,
        "reg_mobile": f"98{i:08d}",
        "created_at": now, "updated_at": now,
    } for i, (name, short, tds) in enumerate(BROKERS, start=1)]

    categories = [{
        "_id": ObjectId(), "key": key, "label": label,
        "children": [{"key": c, "label": c.replace("_", " ").title(),
                      "active": True, "children": []} for c in subs],
        "custom_fields": [], "required_documents": [],
        "reward_base_field": "commissionable", "active": True,
        "sort_order": 100 + n, "created_at": now, "updated_at": now,
    } for n, (key, label, subs) in enumerate(CATEGORIES)]

    # One rate rule per broker x category, plus a few insurer-pinned overrides so
    # the most-specific-wins matcher has something to actually resolve.
    rules = []
    for b in brokers:
        for c in categories:
            rules.append({
                "_id": ObjectId(), "broker_id": str(b["_id"]),
                "insurer_id": None, "category_key": c["key"],
                "subcategory_path": [],
                "agency_basis": "percent",
                "agency_value": rng.choice([500, 750, 1000, 1250, 1500, 2000]),
                "partner_basis": "percent",
                "partner_value": rng.choice([250, 400, 500, 750, 1000]),
                "active": True, "created_at": now, "updated_at": now,
            })
    for b in brokers[:4]:
        for c in categories[:3]:
            ins = rng.choice(insurers)
            rules.append({
                "_id": ObjectId(), "broker_id": str(b["_id"]),
                "insurer_id": str(ins["_id"]), "category_key": c["key"],
                "subcategory_path": [c["children"][0]["key"]],
                "agency_basis": "percent",
                "agency_value": rng.choice([1500, 1750, 2250]),
                "partner_basis": "percent", "partner_value": 750,
                "active": True, "created_at": now, "updated_at": now,
            })

    await db.insurers.insert_many(insurers)
    await db.brokers.insert_many(brokers)
    await db.policy_categories.insert_many(categories)
    await db.rate_rules.insert_many(rules)

    # Rate lookup keyed the way a policy resolves it.
    rate_by = {}
    for r in rules:
        rate_by.setdefault((r["broker_id"], r["category_key"]), r)

    return {"insurers": insurers, "brokers": brokers,
            "categories": categories, "rates": rate_by}


async def seed_people(db, employees: int, partners: int) -> dict:
    """Employees and channel partners.

    All 650 share ONE bcrypt hash of a known test password: hashing each would
    add ~a minute for no benefit, and a single hash still verifies correctly for
    every account. Run scripts/loadtest_accounts.py afterwards to add the
    owner/manager logins you actually sign in with.

    Emails must use a resolvable-looking domain: reserved TLDs like `.invalid`
    are rejected by EmailStr, which makes rows readable on disk but not through
    the ODM.
    """
    from app.core.security import hash_password
    now = utc(datetime.now(timezone.utc))
    dummy_hash = hash_password("LoadTest@2026")

    emp_docs, partner_docs = [], []
    for i in range(employees):
        emp_docs.append({
            "_id": ObjectId(), "code": f"USR-E{i:05d}",
            "full_name": person_name(i),
            "email": f"loadtest.emp{i}@loadtestmail.com",
            "mobile": f"90{i:08d}", "account_type": "employee",
            "hashed_password": dummy_hash, "must_change_password": False,
            "token_version": 0, "onboarded": True, "status": "active",
            "is_deleted": False, "failed_login_count": 0,
            "permissions": ["view_policies", "manage_policies",
                            "view_transactions", "view_finance_overview",
                            "view_balance_sheet", "view_reports",
                            "view_employees", "view_partners",
                            "view_targets"],
            "extra_permissions": [],
            "created_at": now, "updated_at": now,
        })
    for i in range(partners):
        partner_docs.append({
            "_id": ObjectId(), "code": f"CP-{i:05d}",
            "full_name": person_name(i + 7),
            "email": f"loadtest.cp{i}@loadtestmail.com",
            "mobile": f"91{i:08d}", "account_type": "channel_partner",
            "hashed_password": dummy_hash, "must_change_password": False,
            "token_version": 0, "onboarded": True, "status": "active",
            "is_deleted": False, "failed_login_count": 0,
            "permissions": [], "extra_permissions": [],
            "partner_profile": {
                "default_partner_basis": "percent",
                "default_partner_value": rng.choice([250, 500, 750]),
            },
            "created_at": now, "updated_at": now,
        })

    for chunk in (emp_docs, partner_docs):
        for n in range(0, len(chunk), BATCH):
            await db.users.insert_many(chunk[n:n + BATCH])

    return {"employees": emp_docs, "partners": partner_docs}


# --- Customers ----------------------------------------------------------------
async def insert_customers(db, start: int, count: int,
                           owner_ids: list[str]) -> list[ObjectId]:
    """Insert `count` customers starting at index `start`. Returns their ids."""
    ids = []
    docs = []
    for i in range(start, start + count):
        created = weighted_date()
        oid = ObjectId()
        ids.append(oid)
        docs.append({
            "_id": oid, "code": f"AG-CX-{i:07d}", "name": person_name(i),
            "email": f"cust{i}@loadtestmail.com", "mobile": mobile_for(i),
            "kyc": {"pan": None, "aadhaar_last4": f"{i % 10000:04d}"},
            "nominees": [], "renewal_reminders_enabled": True,
            "tags": [rng.choice(CITIES)], "is_archived": False,
            "origin": "inhouse", "owner_user_id": rng.choice(owner_ids),
            "partner_id": None, "created_by": owner_ids[0],
            "created_at": created, "updated_at": created,
        })
        if len(docs) >= BATCH:
            await db.customers.insert_many(docs)
            docs = []
    if docs:
        await db.customers.insert_many(docs)
    return ids


# --- Policies and their money -------------------------------------------------
def build_policy_bundle(idx: int, catalog: dict, customer_id: ObjectId,
                        owner_id: str, partner: dict | None) -> dict:
    """One policy plus every document its money implies.

    Mirrors what the API does on create + approve + payment: a Reward snapshot, a
    PolicyFinance snapshot, the buyer's PREMIUM_DUE row, the balance-neutral
    "agency paid the premium" mirror, and whatever cash has since moved.
    """
    now = weighted_date()
    cat = rng.choice(catalog["categories"])
    sub = rng.choice(cat["children"])
    insurer = rng.choice(catalog["insurers"])
    broker = rng.choice(catalog["brokers"])
    rate = catalog["rates"].get((str(broker["_id"]), cat["key"]))

    policy_id = ObjectId()
    partner_id = str(partner["_id"]) if partner else None

    # Premium: log-ish spread so the book has both 2k motor and 400k life.
    premium = rng.choice([
        rng.randrange(200_000, 1_500_000),       # 2k - 15k
        rng.randrange(1_500_000, 6_000_000),     # 15k - 60k
        rng.randrange(6_000_000, 40_000_000),    # 60k - 400k
    ])
    gst = 1800
    commissionable = commissionable_from_premium(premium, gst)

    agency_basis = RewardBasis.PERCENT
    agency_value = rate["agency_value"] if rate else 1000
    partner_basis = RewardBasis.PERCENT
    partner_value = rate["partner_value"] if rate else 500

    agency_amt, partner_amt, house_amt = compute_reward(
        commissionable, agency_basis, agency_value,
        partner_basis, partner_value, has_partner=bool(partner_id))

    # Every payer route, weighted the way a real book sits.
    payer = rng.choices(
        [PayerType.AGENCY, PayerType.CUSTOMER, PayerType.CHANNEL_PARTNER],
        weights=[0.65, 0.20, 0.15])[0]
    buyer_type = "channel_partner" if partner_id else "direct"

    # Most policies carry no discount; some do, always house-borne.
    discount_value = rng.choices([0, 100, 250, 500], weights=[0.8, 0.1, 0.06, 0.04])[0]

    # Reward outcome mix, including the reversal states.
    status = rng.choices(
        [RewardStatus.RECEIVED, RewardStatus.PENDING, RewardStatus.NOT_ELIGIBLE,
         RewardStatus.REJECTED, RewardStatus.ZERO_PCT],
        weights=[0.55, 0.33, 0.06, 0.03, 0.03])[0]

    eligible = status not in {
        RewardStatus.NOT_ELIGIBLE, RewardStatus.REJECTED,
        RewardStatus.ZERO_PCT, RewardStatus.REFUNDED, RewardStatus.CANCELLED}

    snap_agency, snap_partner, _ = eligible_snapshot_amounts(
        status, agency_amt, partner_amt, 1)
    finance = compute_finance(
        gross_premium=premium,
        commissionable=commissionable if eligible else 0,
        agency_reward=snap_agency, partner_share=snap_partner,
        discount_basis=RewardBasis.PERCENT,
        discount_value=discount_value if eligible else 0,
    )

    expiry = now + timedelta(days=365)
    pol_status = "active" if expiry > BOOK_END else "expired"

    policy = {
        "_id": policy_id, "code": f"AG-POL-{idx:07d}",
        "policy_number": f"LT/{cat['key'][:3].upper()}/{idx:07d}",
        "category_key": cat["key"], "subcategory_path": [sub["key"]],
        "subcategory_key": sub["key"],
        "insurer_id": str(insurer["_id"]), "broker_id": str(broker["_id"]),
        "customer_id": str(customer_id),
        "status": pol_status, "approval_status": "approved",
        "premium_amount": premium, "commissionable_premium": commissionable,
        "gst_percent": gst, "sum_insured": premium * rng.randrange(10, 60),
        "issue_date": now, "start_date": now, "expiry_date": expiry,
        "reminders_sent": [],
        "reward": {"agency_basis": "percent", "agency_value": agency_value,
                   "partner_basis": "percent", "partner_value": partner_value},
        "buyer_type": buyer_type, "payer": payer.value,
        "discount_basis": "percent", "discount_value": discount_value,
        "details": {}, "reward_base_field": "commissionable",
        "owner_user_id": partner_id or owner_id, "partner_id": partner_id,
        "created_by": owner_id, "created_at": now, "updated_at": now,
    }

    reward = {
        "_id": ObjectId(), "policy_id": str(policy_id),
        "insurer_id": str(insurer["_id"]), "customer_id": str(customer_id),
        "category_key": cat["key"], "subcategory_key": sub["key"],
        "premium_amount": premium, "commissionable_premium": commissionable,
        "agency_amount": agency_amt, "partner_amount": partner_amt,
        "house_amount": house_amt, "status": status.value,
        "received_at": now + timedelta(days=rng.randrange(10, 90))
        if status == RewardStatus.RECEIVED else None,
        "wallet_credited": bool(partner_id) and eligible,
        "wallet_available": bool(partner_id) and status == RewardStatus.RECEIVED,
        "owner_user_id": partner_id or owner_id, "partner_id": partner_id,
        "created_by": owner_id, "created_at": now, "updated_at": now,
    }

    receivable = premium_receivable(payer, premium, finance.discount)
    due = policy_premium_due(payer, premium, finance.discount)

    # Buyer = the attributed partner if any, else the customer (finance.py).
    if partner_id:
        buyer_type_p, buyer_id = PartyType.CHANNEL_PARTNER, partner_id
    else:
        buyer_type_p, buyer_id = PartyType.CUSTOMER, str(customer_id)

    txns = []

    def txn(kind, party_t, party_id, amount, note, when, policy_ref=True):
        txns.append({
            "_id": ObjectId(), "txn_type": kind.value,
            "party_type": party_t.value, "party_id": party_id,
            "policy_id": str(policy_id) if policy_ref else None,
            "amount_paise": amount, "note": note,
            "occurred_at": when, "created_at": when, "created_by": owner_id,
        })

    if due != 0:
        txn(LedgerTxnType.PREMIUM_DUE, buyer_type_p, buyer_id, due,
            "Policy premium due", now)

    mirror = agency_premium_ledger_amount(payer, str(broker["_id"]), premium)
    if mirror is not None:
        txn(LedgerTxnType.PREMIUM_PAID_BY_AGENCY, PartyType.BROKER,
            str(broker["_id"]), mirror, "Agency paid the premium", now)

    # Collection: fully paid, part paid, or nothing yet — so settlement_status
    # spans SETTLED / PARTIAL / PENDING across the book.
    collected = 0
    if receivable > 0:
        mode = rng.choices(["full", "part", "none"], weights=[0.62, 0.23, 0.15])[0]
        if mode == "full":
            collected = receivable
        elif mode == "part":
            collected = int(receivable * rng.uniform(0.25, 0.75))
        if collected:
            paid_on = now + timedelta(days=rng.randrange(1, 60))
            txn(LedgerTxnType.PREMIUM_COLLECTED, buyer_type_p, buyer_id,
                -collected, "Premium received", paid_on)

    tds_entry = None
    if status == RewardStatus.RECEIVED and agency_amt > 0:
        got_on = now + timedelta(days=rng.randrange(10, 90))
        txn(LedgerTxnType.REWARD_RECEIVED, PartyType.BROKER,
            str(broker["_id"]), -agency_amt, "Reward received", got_on)
        tds = tds_on_reward(agency_amt, broker["tds_percent"])
        if tds:
            txn(LedgerTxnType.TDS_DEDUCTED, PartyType.BROKER,
                str(broker["_id"]), -tds, "TDS withheld on reward", got_on)
            tds_entry = {
                "_id": ObjectId(), "broker_id": str(broker["_id"]),
                "policy_id": str(policy_id), "gross_reward_paise": agency_amt,
                "tds_percent": broker["tds_percent"], "tds_paise": tds,
                "occurred_at": got_on, "created_at": got_on,
                "created_by": owner_id,
            }

    if not eligible and agency_amt:
        txn(LedgerTxnType.REWARD_CANCELLED, PartyType.BROKER,
            str(broker["_id"]), -abs(agency_amt), "Reward not eligible", now)

    finance_doc = {
        "_id": ObjectId(), "policy_id": str(policy_id),
        "broker_id": str(broker["_id"]), "partner_id": partner_id,
        "customer_id": str(customer_id),
        "gross_premium": finance.gross_premium,
        "commissionable": finance.commissionable,
        "agency_reward": finance.agency_reward,
        "partner_share": finance.partner_share,
        "discount": finance.discount, "house_profit": finance.house_profit,
        "payer": payer.value,
        "settlement_status": settlement_status(receivable, collected).value,
        "premium_paid_to_insurer": premium if payer == PayerType.AGENCY else 0,
        "premium_collected": collected,
        "computed_at": now, "created_at": now, "updated_at": now,
    }

    return {"policy": policy, "reward": reward, "finance": finance_doc,
            "txns": txns, "tds": tds_entry,
            "partner_id": partner_id, "partner_amount": partner_amt,
            "eligible": eligible, "reward_status": status}


async def insert_policies(db, start: int, count: int, catalog: dict,
                          customer_ids: list, owner_ids: list[str],
                          partners: list[dict], wallet_acc: dict) -> None:
    policies, rewards, finances, txns, tds = [], [], [], [], []

    async def flush():
        if policies:
            await db.policies.insert_many(policies)
            await db.rewards.insert_many(rewards)
            await db.policy_finance.insert_many(finances)
        if txns:
            await db.ledger_txns.insert_many(txns)
        if tds:
            await db.tds_entries.insert_many(tds)
        policies.clear(); rewards.clear(); finances.clear()
        txns.clear(); tds.clear()

    for i in range(start, start + count):
        # ~22% of the book comes through a channel partner.
        partner = rng.choice(partners) if rng.random() < 0.22 else None
        bundle = build_policy_bundle(
            i, catalog, rng.choice(customer_ids), rng.choice(owner_ids), partner)

        policies.append(bundle["policy"])
        rewards.append(bundle["reward"])
        finances.append(bundle["finance"])
        txns.extend(bundle["txns"])
        if bundle["tds"]:
            tds.append(bundle["tds"])

        pid = bundle["partner_id"]
        if pid and bundle["eligible"] and bundle["partner_amount"]:
            acc = wallet_acc.setdefault(pid, {"available": 0, "pending": 0,
                                              "earned": 0})
            acc["earned"] += bundle["partner_amount"]
            if bundle["reward_status"] == RewardStatus.RECEIVED:
                acc["available"] += bundle["partner_amount"]
            else:
                acc["pending"] += bundle["partner_amount"]

        if len(policies) >= BATCH:
            await flush()

    await flush()


# --- House expenses -----------------------------------------------------------
async def insert_expenses(db, owner_id: str, months: int = 78) -> None:
    """A monthly run of house expenses so net profit is not just gross reward."""
    cats = ["salary", "rent", "utilities", "marketing", "software", "travel"]
    docs = []
    cursor = BOOK_START
    while cursor < BOOK_END:
        for cat in cats:
            amount = {"salary": 25_000_00, "rent": 4_000_00,
                      "utilities": 900_00, "marketing": 3_500_00,
                      "software": 1_200_00, "travel": 2_000_00}[cat]
            docs.append({
                "_id": ObjectId(), "txn_type": "expense",
                "party_type": "expense", "party_id": "agency",
                "policy_id": None,
                "amount_paise": -(amount + rng.randrange(0, 50_000)),
                "expense_category": cat, "note": f"{cat.title()} expense",
                "occurred_at": cursor, "created_at": cursor,
                "created_by": owner_id,
            })
        cursor += timedelta(days=30)
    if docs:
        await db.ledger_txns.insert_many(docs)


# --- Derived state ------------------------------------------------------------
BALANCE_NEUTRAL = {"premium_paid_by_agency", "reward_cancelled",
                   "partner_payout"}


async def derive_party_accounts(db) -> int:
    """Rebuild every PartyAccount from the finished ledger in one aggregation —
    the bulk equivalent of recompute_party_account() per party."""
    pipeline = [
        {"$match": {"txn_type": {"$nin": list(BALANCE_NEUTRAL)},
                    "party_type": {"$ne": "expense"}}},
        {"$group": {
            "_id": {"t": "$party_type", "id": "$party_id"},
            "balance": {"$sum": "$amount_paise"},
            "charged": {"$sum": {"$cond": [{"$gte": ["$amount_paise", 0]},
                                           "$amount_paise", 0]}},
            "settled": {"$sum": {"$cond": [{"$lt": ["$amount_paise", 0]},
                                           {"$abs": "$amount_paise"}, 0]}},
            "last": {"$max": "$occurred_at"},
        }},
    ]
    now = utc(datetime.now(timezone.utc))
    docs, total = [], 0
    async for row in db.ledger_txns.aggregate(pipeline, allowDiskUse=True):
        docs.append({
            "_id": ObjectId(), "party_type": row["_id"]["t"],
            "party_id": row["_id"]["id"], "balance_paise": row["balance"],
            "total_charged_paise": row["charged"],
            "total_settled_paise": row["settled"],
            "last_txn_at": row["last"], "created_at": now, "updated_at": now,
        })
        if len(docs) >= BATCH:
            await db.party_accounts.insert_many(docs)
            total += len(docs)
            docs = []
    if docs:
        await db.party_accounts.insert_many(docs)
        total += len(docs)
    return total


async def insert_wallets(db, wallet_acc: dict) -> int:
    now = utc(datetime.now(timezone.utc))
    docs = [{
        "_id": ObjectId(), "partner_id": pid,
        "available_paise": v["available"], "pending_paise": v["pending"],
        "lifetime_earned_paise": v["earned"], "lifetime_withdrawn_paise": 0,
        "created_at": now, "updated_at": now,
    } for pid, v in wallet_acc.items()]
    for n in range(0, len(docs), BATCH):
        await db.wallets.insert_many(docs[n:n + BATCH])
    return len(docs)


# --- Orchestration ------------------------------------------------------------
async def run(args) -> None:
    if args.db == settings.mongo_db_name:
        sys.exit(f"Refusing to use '{args.db}' — that is the app's real "
                 f"database. Pick another --db.")

    client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True,
                                uuidRepresentation="standard")
    db = client[args.db]

    if not (args.drop or args.stats):
        # Build the REAL indexes before writing a byte. Rows go in via raw Motor
        # for speed, but the test database has to carry the same ~12 indexes on
        # policies that production does — otherwise the size estimate misses
        # roughly half the cost, and every query you time afterwards runs as a
        # collection scan and tells you nothing about the real app.
        from beanie import init_beanie
        from app.db import _document_models
        await init_beanie(database=db, document_models=_document_models())

    if args.drop:
        await client.drop_database(args.db)
        print(f"Dropped database '{args.db}'.")
        client.close()
        return

    if args.stats:
        await report(db, args.db)
        client.close()
        return

    existing = await db.policies.estimated_document_count()
    if existing and not args.append:
        sys.exit(f"'{args.db}' already holds {existing:,} policies. Use --drop "
                 f"first, or --append to add more.")

    print(f"Target database : {args.db}")
    print(f"Storage budget  : {args.max_mb} MB")
    print(f"Book window     : {BOOK_START:%Y-%m-%d} to {BOOK_END:%Y-%m-%d}\n")

    print("[1/6] catalog (insurers, brokers, types, rate card)")
    catalog = await seed_catalog(db)

    print(f"[2/6] people ({args.employees} employees, {args.partners} partners)")
    people = await seed_people(db, args.employees, args.partners)
    owner_ids = [str(u["_id"]) for u in people["employees"]] or ["system"]
    partners = people["partners"]

    _, _, base_mb = await db_megabytes(db)
    print(f"      baseline {base_mb:.1f} MB\n")

    # --- Calibration: measure real cost before committing to a scale ---------
    print(f"[3/6] calibration slice ({CALIBRATION_POLICIES:,} policies)")
    cal_customers = max(1, int(CALIBRATION_POLICIES * args.customers
                               / max(1, args.policies)))
    cust_ids = await insert_customers(db, 0, cal_customers, owner_ids)
    wallet_acc: dict = {}
    await insert_policies(db, 0, CALIBRATION_POLICIES, catalog, cust_ids,
                          owner_ids, partners, wallet_acc)

    # Wait out a checkpoint so indexSize is real, not the 4096 placeholder — the
    # indexes are ~half the cost here and calibrating without them under-counts
    # badly.
    print("      waiting for checkpoint so index size is real...")
    await asyncio.sleep(70)

    _, _, cal_mb = await db_megabytes(db)
    used = cal_mb - base_mb
    per_policy_kb = (used * 1024) / CALIBRATION_POLICIES
    remaining = args.max_mb - cal_mb
    fits = int((remaining * 1024) / per_policy_kb) if per_policy_kb > 0 else 0

    planned = min(args.policies - CALIBRATION_POLICIES, max(0, fits))
    total_policies = CALIBRATION_POLICIES + planned
    ratio = args.customers / max(1, args.policies)
    total_customers = max(cal_customers, int(total_policies * ratio))

    print(f"      measured {per_policy_kb:.2f} KB per policy "
          f"(policy + reward + finance + ledger + indexes)")
    print(f"      {cal_mb:.1f} MB used, {remaining:.1f} MB left")
    print(f"      fits ~{total_policies:,} policies / "
          f"{total_customers:,} customers within budget")
    if total_policies < args.policies:
        pct = 100 * total_policies / args.policies
        print(f"      NOTE: that is {pct:.0f}% of the {args.policies:,} "
              f"requested - storage-bound, not a failure\n")
    else:
        print()

    if args.plan:
        # Only safe to roll back by dropping when this run created the database.
        # With --append there was pre-existing data we must not destroy.
        if args.append:
            print("--plan with --append: leaving the calibration slice in "
                  "place (dropping would take the existing data with it).")
        else:
            print("--plan: stopping before the full run. Rolling back the "
                  "calibration slice.")
            await client.drop_database(args.db)
        client.close()
        return

    # --- Full run ------------------------------------------------------------
    more_customers = total_customers - cal_customers
    if more_customers > 0:
        print(f"[4/6] customers (+{more_customers:,})")
        cust_ids += await insert_customers(db, cal_customers, more_customers,
                                           owner_ids)

    if planned > 0:
        print(f"[5/6] policies (+{planned:,}) with rewards, finance and ledger")
        done = 0
        step = max(BATCH, planned // 20 or BATCH)
        while done < planned:
            n = min(step, planned - done)
            await insert_policies(db, CALIBRATION_POLICIES + done, n, catalog,
                                  cust_ids, owner_ids, partners, wallet_acc)
            done += n
            _, _, now_mb = await db_megabytes(db)
            pct = 100 * done / planned
            print(f"      {done:,}/{planned:,} ({pct:.0f}%) — {now_mb:.1f} MB")
            if now_mb >= args.max_mb:
                print("      budget reached, stopping early")
                break

    print("\n[6/6] expenses, party balances, wallets")
    await insert_expenses(db, owner_ids[0])
    parties = await derive_party_accounts(db)
    wallets = await insert_wallets(db, wallet_acc)
    print(f"      {parties:,} party accounts, {wallets:,} wallets")

    print()
    await report(db, args.db)
    client.close()


async def report(db, name: str) -> None:
    counts = {}
    for coll in ("customers", "users", "policies", "policy_finance", "rewards",
                 "ledger_txns", "tds_entries", "party_accounts", "wallets",
                 "brokers", "insurers", "policy_categories", "rate_rules"):
        counts[coll] = await db[coll].estimated_document_count()

    data, index, total = await db_megabytes(db)
    print(f"--- {name} ---")
    width = max(len(k) for k in counts)
    for k, v in counts.items():
        print(f"  {k:<{width}}  {v:>10,}")
    print(f"\n  data {data:.1f} MB + indexes {index:.1f} MB "
          f"= {total:.1f} MB total")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--db", default=DEFAULT_DB,
                   help=f"target database (default {DEFAULT_DB})")
    p.add_argument("--max-mb", type=float, default=DEFAULT_MAX_MB,
                   help=f"storage budget in MB (default {DEFAULT_MAX_MB})")
    p.add_argument("--policies", type=int, default=TARGET_POLICIES)
    p.add_argument("--customers", type=int, default=TARGET_CUSTOMERS)
    p.add_argument("--partners", type=int, default=TARGET_PARTNERS)
    p.add_argument("--employees", type=int, default=TARGET_EMPLOYEES)
    p.add_argument("--plan", action="store_true",
                   help="calibrate and report the achievable scale, then roll back")
    p.add_argument("--stats", action="store_true", help="report and exit")
    p.add_argument("--drop", action="store_true",
                   help="delete the test database and exit")
    p.add_argument("--append", action="store_true",
                   help="add to an existing test database")
    asyncio.run(run(p.parse_args()))


if __name__ == "__main__":
    main()
