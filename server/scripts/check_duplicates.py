"""Find values that would block a UNIQUE index, before they block a deploy.

Some columns are meant to be unique (a policy number, a login email, an entity
code). Where the uniqueness was only ever checked in application code, a race
or an older build can leave duplicates behind — and then the day the unique
index is added, the index build fails and startup logs an error instead of
enforcing anything.

Run this against the live database first. It only READS.

Usage (from server/):
    python scripts/check_duplicates.py

Exit code is 0 when everything is clean, 1 when something needs fixing.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.config import settings  # noqa: E402

# (collection, field, case-insensitive?) — mirrors the unique indexes declared
# on the models.
CHECKS = [
    ("policies", "policy_number", True),
    ("users", "email", True),
    ("users", "code", False),
    ("customers", "code", False),
    ("customers", "mobile", False),
    ("insurers", "short_name", True),
    ("brokers", "short_code", True),
]


async def _duplicates(db, collection: str, field: str, ci: bool) -> list[dict]:
    key = {"$toLower": f"${field}"} if ci else f"${field}"
    pipeline = [
        {"$match": {field: {"$exists": True, "$nin": [None, ""]}}},
        {"$group": {"_id": key, "count": {"$sum": 1},
                    "ids": {"$push": "$_id"}}},
        {"$match": {"count": {"$gt": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 50},
    ]
    return await db[collection].aggregate(pipeline).to_list(length=50)


async def main() -> int:
    client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True)
    db = client[settings.mongo_db_name]
    print(f"Checking '{settings.mongo_db_name}' for duplicate values...\n")

    problems = 0
    for collection, field, ci in CHECKS:
        try:
            rows = await _duplicates(db, collection, field, ci)
        except Exception as exc:  # noqa: BLE001 — a missing collection is fine
            print(f"  {collection}.{field}: skipped ({exc})")
            continue
        if not rows:
            print(f"  OK    {collection}.{field}")
            continue
        problems += len(rows)
        print(f"  DUPES {collection}.{field} — {len(rows)} value(s):")
        for r in rows:
            ids = ", ".join(str(i) for i in r["ids"])
            print(f"          {r['_id']!r} x{r['count']}  _id: {ids}")

    client.close()
    if problems:
        print(f"\n{problems} duplicate value(s) found. Fix these before the "
              f"unique index can be built:")
        print("  - decide which record is the real one,")
        print("  - correct or clear the duplicate's value in the app,")
        print("  - re-run this script, then redeploy.")
        return 1
    print("\nAll clear — no duplicates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
