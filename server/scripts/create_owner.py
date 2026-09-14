"""Standalone script to create the single Owner (super-admin) account.

Run locally only:  python create_owner.py

It connects to MongoDB Atlas using server/.env, prompts for the owner's details and
a password, and inserts the Owner document with all permissions.

NOTHING ELSE IS SEEDED. Roles and policy types are created manually in-app — the
owner asked for no auto-created roles (the old Manager / Sales Executive /
Operations seeds are gone). The "Create role" dialog offers editable templates
(core/permissions.py ROLE_TEMPLATES) instead, which write nothing until saved.
"""

from __future__ import annotations

import asyncio
import getpass
import re
import sys

# Allow running as a plain script from the server/ directory.
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

from beanie import init_beanie  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.core.enums import AccountStatus, AccountType  # noqa: E402
from app.core.permissions import ALL_PERMISSIONS  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models.master import PolicyCategory  # noqa: E402
from app.models.counter import Counter  # noqa: E402
from app.models.role import Role  # noqa: E402
from app.models.user import User  # noqa: E402

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _prompt(label: str, required: bool = True) -> str:
    while True:
        value = input(f"{label}: ").strip()
        if value or not required:
            return value
        print("  This field is required.")


def _read_secret(prompt: str) -> str:
    # getpass needs a real console; fall back to input() when stdin is piped.
    if sys.stdin is not None and sys.stdin.isatty():
        return getpass.getpass(prompt)
    print(prompt, end="", flush=True)
    return (sys.stdin.readline() or "").rstrip("\n")


def _prompt_password() -> str:
    while True:
        pw = _read_secret("Owner password (min 8 chars, letters + numbers): ")
        if len(pw) < 8 or not any(c.isalpha() for c in pw) \
                or not any(c.isdigit() for c in pw):
            print("  Password must be at least 8 chars with letters and numbers.")
            continue
        confirm = _read_secret("Confirm password: ")
        if pw != confirm:
            print("  Passwords do not match. Try again.")
            continue
        return pw


async def _next_user_code() -> str:
    from app.services.codes import next_code
    return await next_code("user")


async def main() -> None:
    print(f"\n=== {settings.app_name}: Create Owner account ===\n")
    client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True)
    db = client[settings.mongo_db_name]
    await init_beanie(database=db,
                      document_models=[User, Role, PolicyCategory, Counter])

    # Multiple owners are allowed; each must have a unique (non-deleted) email.
    owner_count = await User.find(User.account_type == AccountType.OWNER).count()
    if owner_count:
        print(f"Note: {owner_count} owner account(s) already exist. "
              f"Creating an additional owner.\n")

    full_name = _prompt("Owner full name")
    email = _prompt("Owner email").lower()
    if not EMAIL_RE.match(email):
        print("Invalid email format. Aborting.")
        client.close()
        return
    if await User.find_one(User.email == email, {"is_deleted": {"$ne": True}}):
        print("A user with this email already exists. Aborting.")
        client.close()
        return
    mobile = _prompt("Owner mobile (optional)", required=False)
    password = _prompt_password()

    owner = User(
        code=await _next_user_code(),
        full_name=full_name,
        email=email,
        mobile=mobile or None,
        account_type=AccountType.OWNER,
        hashed_password=hash_password(password),
        must_change_password=False,      # owner sets their own password here
        status=AccountStatus.ACTIVE,
        permissions=list(ALL_PERMISSIONS),
    )
    await owner.insert()
    print(f"\n[OK] Owner created: {owner.full_name} <{owner.email}> [{owner.code}]")

    print("\nDone. You can now sign in to the CRM as the Owner.")
    print("No roles were created — add them under Roles & Permissions "
          "(the create dialog offers editable templates).\n")
    client.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
