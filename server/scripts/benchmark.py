"""Time the read paths that matter, against the load-test database.

    python scripts/benchmark.py                  run every case
    python scripts/benchmark.py --only balance   run cases matching a substring
    python scripts/benchmark.py --runs 5         repeats per case (default 3)

Calls the SERVICE functions directly rather than going through HTTP, so what you
read is database + aggregation cost with no FastAPI, auth or JSON serialisation
noise mixed in. That is the cost we are trying to move; the rest is a rounding
error next to a full collection scan.

Reports median and slowest of N runs. The FIRST run of each case is kept and
counted — a cold cache is the honest case for a user who just opened the page,
and Atlas M0 has no meaningful warm cache to rely on anyway.

Reference points, so the numbers mean something:
    < 100 ms   feels instant
    < 300 ms   fine for a page load
    < 1 s      tolerable, but not while polling every 15s
    > 5 s      broken in practice
     30 s      hard timeout in config.request_timeout_seconds -> 504
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402

LOADTEST_DB = "agastyacrm_loadtest"


async def timed(label: str, fn, runs: int) -> dict:
    """Run `fn` `runs` times, returning timings in milliseconds."""
    times = []
    note = ""
    for _ in range(runs):
        start = time.perf_counter()
        try:
            result = await fn()
        except Exception as exc:  # noqa: BLE001
            return {"label": label, "error": f"{type(exc).__name__}: {exc}"}
        times.append((time.perf_counter() - start) * 1000)
        if note == "":
            note = describe(result)
    return {"label": label, "median": statistics.median(times),
            "worst": max(times), "note": note}


def describe(result) -> str:
    """A short 'what came back' so a fast case can't be a silently empty one."""
    if isinstance(result, list):
        return f"{len(result)} rows"
    if isinstance(result, dict):
        for key in ("policies", "rows", "total_policies", "hits"):
            v = result.get(key)
            if isinstance(v, list):
                return f"{len(v)} {key}"
            if isinstance(v, int):
                return f"{v} {key}"
        return f"{len(result)} keys"
    if isinstance(result, int):
        return f"{result}"
    return ""


async def main(args) -> None:
    client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True,
                                uuidRepresentation="standard")
    db = client[args.db]

    from beanie import init_beanie
    from app.db import _document_models
    await init_beanie(database=db, document_models=_document_models())

    from app.models.broker import Broker
    from app.models.customer import Customer
    from app.models.policy import Policy
    from app.models.user import User
    from app.routers._helpers import search_regex
    from app.services import (
        finance_balance, finance_dashboard, finance_insights,
        finance_reports as fr,
    )

    n_policies = await Policy.find_all().count()
    n_customers = await Customer.find_all().count()
    print(f"database  : {args.db}")
    print(f"book      : {n_policies:,} policies, {n_customers:,} customers")
    if n_policies == 0:
        sys.exit("No policies — run scripts/load_test_data.py first.")

    now = datetime.now(timezone.utc)
    lo, hi, _ = fr.resolve_period("this_year", now, None, None)
    # A whole-book window: this is what "All time" on the date filter does.
    all_lo, all_hi = datetime(2020, 1, 1, tzinfo=timezone.utc), now

    broker = await Broker.find_one({})
    customer = await Customer.find_one({})
    partner = await User.find_one({"account_type": "channel_partner"})
    bid, cid = str(broker.id), str(customer.id)
    pid = str(partner.id) if partner else None

    cases = [
        ("balance-sheet list (broker, this year)",
         lambda: finance_balance.list_section("broker", lo, hi, "premium")),
        ("balance-sheet list (broker, all time)",
         lambda: finance_balance.list_section("broker", all_lo, all_hi, "premium")),
        ("balance-sheet list (customer, all time)",
         lambda: finance_balance.list_section("customer", all_lo, all_hi, "premium")),
        ("balance-sheet list (partner, all time)",
         lambda: finance_balance.list_section("partner", all_lo, all_hi, "premium")),
        ("balance-sheet detail (one broker)",
         lambda: finance_balance.detail_section("broker", bid, all_lo, all_hi)),
        ("balance-sheet detail (one customer)",
         lambda: finance_balance.detail_section("customer", cid, all_lo, all_hi)),
        ("statement build (broker)",
         lambda: finance_balance.build_statement("broker", bid, lo, hi)),
        ("statement build (customer)",
         lambda: finance_balance.build_statement("customer", cid, lo, hi)),
        ("dashboard (this year)",
         lambda: finance_dashboard.compute_dashboard("this_year", now, None, None)),
        ("reports insights (this year)",
         lambda: finance_insights.compute_insights("this_year", now, None, None)),
        ("policy list page 1 (paginated)",
         lambda: Policy.find({}).sort("-created_at").skip(0).limit(20).to_list()),
        ("policy list page 500 (deep skip)",
         lambda: Policy.find({}).sort("-created_at").skip(9980).limit(20).to_list()),
        ("global search: policy number (regex)",
         lambda: Policy.find({"$or": [{"code": search_regex("000123")},
                                      {"policy_number": search_regex("000123")}]}
                            ).limit(6).to_list()),
        ("global search: customer name (regex)",
         lambda: Customer.find({"$or": [{"name": search_regex("Sharma")},
                                        {"code": search_regex("Sharma")},
                                        {"mobile": search_regex("Sharma")}]}
                              ).limit(6).to_list()),
    ]
    if pid:
        cases.append(("statement build (partner)",
                      lambda: finance_balance.build_statement("partner", pid, lo, hi)))

    if args.only:
        cases = [c for c in cases if args.only.lower() in c[0].lower()]
        if not cases:
            sys.exit(f"No case matches '{args.only}'.")

    print(f"runs      : {args.runs} per case\n")
    width = max(len(label) for label, _ in cases)
    print(f"{'case'.ljust(width)}  {'median':>10}  {'worst':>10}   result")
    print("-" * (width + 34))

    results = []
    for label, fn in cases:
        row = await timed(label, fn, args.runs)
        results.append(row)
        if "error" in row:
            print(f"{label.ljust(width)}  {'ERROR':>10}  {'':>10}   {row['error'][:40]}")
            continue
        flag = "  <-- SLOW" if row["median"] > 1000 else ""
        print(f"{label.ljust(width)}  {row['median']:>9.0f}ms  "
              f"{row['worst']:>9.0f}ms   {row['note']}{flag}")

    ok = [r for r in results if "error" not in r]
    if ok:
        slow = [r for r in ok if r["median"] > 1000]
        print(f"\n{len(ok)} cases, {len(slow)} over 1s")
        if slow:
            print("Slowest:")
            for r in sorted(slow, key=lambda r: -r["median"])[:5]:
                scale = 120_000 / max(1, n_policies)
                print(f"  {r['median']:>7.0f}ms  {r['label']}")
                print(f"           projected ~{r['median'] * scale:.0f}ms "
                      f"at 120k policies (linear)")

    client.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--db", default=LOADTEST_DB)
    p.add_argument("--runs", type=int, default=3)
    p.add_argument("--only", default="", help="substring filter on case name")
    asyncio.run(main(p.parse_args()))
