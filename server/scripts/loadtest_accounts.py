"""Make the load-test database usable from the browser: real login accounts, and
a repair for data the bulk generator wrote in a shape the models reject.

    python scripts/loadtest_accounts.py            create accounts + repair
    python scripts/loadtest_accounts.py --list     show the accounts and exit

Runs against the LOAD-TEST database only; it refuses MONGO_DB_NAME.

WHY THIS IS SEPARATE FROM THE GENERATOR
    The generator writes 50 employees with a deliberately unusable password hash
    — hashing hundreds of bcrypt passwords would dominate its runtime and none of
    them ever log in. But you need to actually open the app against this book, so
    this script adds real, signed-in-able accounts on top. It is re-runnable and
    safe to run while (or after) the generator finishes.

WHAT IT REPAIRS
    Customer.email is an EmailStr, and the generator wrote `@example.invalid`.
    email-validator rejects reserved TLDs, so every customer READ raised a
    ValidationError — the rows were fine on disk and unusable through the ODM.
    Rewritten server-side with an aggregation update, no documents pulled down.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.core.permissions import ALL_PERMISSIONS  # noqa: E402
from app.core.security import hash_password  # noqa: E402

LOADTEST_DB = "agastyacrm_loadtest"
PASSWORD = "LoadTest@2026"
BAD_DOMAIN = "example.invalid"
GOOD_DOMAIN = "loadtestmail.com"

# Employees with deliberately different permission sets, so the RBAC gating can
# be exercised against a real book — especially view_agency_profit, which is the
# one that zeroes house profit server-side.
STAFF = [
    ("owner@loadtest.com", "Test Owner", "owner", None),
    ("manager@loadtest.com", "Test Manager", "employee", [
        "view_policies", "manage_policies", "view_transactions",
        "manage_transactions", "view_finance_overview", "view_balance_sheet",
        "view_tds", "view_agency_profit", "view_employees",
        "view_partners", "view_targets", "view_reports",
        "export_data", "view_audit_logs"]),
    ("finance@loadtest.com", "Test Finance (no profit)", "employee", [
        "view_policies", "view_transactions", "manage_transactions",
        "view_finance_overview", "view_balance_sheet", "view_rate_cards",
        "manage_rate_cards", "view_reports", "export_data"]),
    ("sales@loadtest.com", "Test Sales (no finance)", "employee", [
        "view_policies", "manage_policies", "view_targets", "view_reports"]),
]


async def main(args) -> None:
    if args.db == settings.mongo_db_name:
        sys.exit(f"Refusing to touch '{args.db}' — that is the real database.")

    client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True,
                               uuidRepresentation="standard")
    db = client[args.db]
    now = datetime.now(timezone.utc)

    if args.list:
        async for u in db.users.find({"email": {"$regex": "@loadtest.com$"}}):
            print(f"  {u['email']:<28} {u['account_type']:<16} {u['full_name']}")
        print(f"\n  password: {PASSWORD}")
        client.close()
        return

    if await db.policies.estimated_document_count() == 0:
        sys.exit(f"'{args.db}' has no policies — run load_test_data.py first.")

    # One bcrypt call, reused. Every test account shares a password, so hashing
    # per account would just burn ~100ms each to produce equivalent hashes.
    print("hashing password...")
    shared = hash_password(PASSWORD)

    print("creating login accounts...")
    for email, name, kind, perms in STAFF:
        permissions = ALL_PERMISSIONS if kind == "owner" else (perms or [])
        await db.users.update_one(
            {"email": email},
            {"$set": {
                "full_name": name, "email": email, "account_type": kind,
                "hashed_password": shared, "must_change_password": False,
                "token_version": 0, "onboarded": True, "status": "active",
                "is_deleted": False, "failed_login_count": 0,
                "permissions": list(permissions), "extra_permissions": [],
                "updated_at": now,
             },
             "$setOnInsert": {
                "code": f"USR-{email.split('@')[0][:6].upper()}",
                "mobile": f"99{abs(hash(email)) % 100_000_000:08d}",
                "created_at": now,
             }},
            upsert=True)
        print(f"  {email:<28} {kind:<16} {len(permissions)} permissions")

    # The bulk-generated staff/partners share the same password so any of them
    # can be signed in as too (useful for testing "what does employee #37 see").
    res = await db.users.update_many(
        {"email": {"$regex": r"^loadtest\.(emp|cp)\d+@"}},
        {"$set": {"hashed_password": shared, "must_change_password": False}})
    print(f"  {res.modified_count:,} generated staff/partner logins enabled")

    # --- Repair: EmailStr rejects reserved TLDs ------------------------------
    print("\nrepairing customer emails...")
    bad = await db.customers.count_documents(
        {"email": {"$regex": f"{BAD_DOMAIN}$"}})
    if bad:
        # Pipeline update: rewritten inside the server, nothing transferred.
        res = await db.customers.update_many(
            {"email": {"$regex": f"{BAD_DOMAIN}$"}},
            [{"$set": {"email": {"$replaceAll": {
                "input": "$email", "find": BAD_DOMAIN,
                "replacement": GOOD_DOMAIN}}}}])
        print(f"  {res.modified_count:,} customer emails rewritten "
              f"-> @{GOOD_DOMAIN}")
    else:
        print("  none to fix")

    for coll in ("users",):
        n = await db[coll].count_documents({"email": {"$regex": f"{BAD_DOMAIN}$"}})
        if n:
            await db[coll].update_many(
                {"email": {"$regex": f"{BAD_DOMAIN}$"}},
                [{"$set": {"email": {"$replaceAll": {
                    "input": "$email", "find": BAD_DOMAIN,
                    "replacement": GOOD_DOMAIN}}}}])
            print(f"  {n:,} {coll} emails rewritten -> @{GOOD_DOMAIN}")

    print(f"\nSign in with any of the above. Password: {PASSWORD}")
    print(f"Point the API at this book with MONGO_DB_NAME={args.db}")
    client.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--db", default=LOADTEST_DB)
    p.add_argument("--list", action="store_true")
    asyncio.run(main(p.parse_args()))
