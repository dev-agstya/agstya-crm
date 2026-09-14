"""What else points at a record — the guard behind every permanent delete.

Insurers, brokers, policy types, customers and staff accounts are all
RELATIONAL: a policy stores only `insurer_id` / `broker_id` / `category_key` and
looks the NAME up at read time (routers/policies.py `_broker_map`, `ins_map`).
Remove the master row and every historic policy silently loses that name — the
column just renders blank. Reports, statements and the ledger read the same
links.

So the rule the owner set (2026-07-26): the delete button stays on every page,
and the LINKS decide whether it goes through — a record nothing points at can be
removed by anyone who manages it, one that is referenced has to be deactivated
or archived instead. This module is the single place that answers "does anything
point at this?", so the check can't drift between the API that enforces it and
the UI that decides which question to ask.

Counts are returned per relation rather than as a bare bool: "used by 3 policies
and 1 rate card" tells someone what to do next; "cannot delete" does not.
"""

from __future__ import annotations

from typing import Iterable

from app.core.enums import PartyType
from app.models.finance import LedgerTxn, PolicyFinance, TdsEntry
from app.models.lead import Lead
from app.models.policy import Policy
from app.models.rate_rule import RateRule
from app.models.wallet import WalletTxn

# Human wording for each relation, singular/plural. Used to build the message a
# person actually reads when a delete is refused.
_LABELS: dict[str, tuple[str, str]] = {
    "policies": ("policy", "policies"),
    "rate_cards": ("rate card", "rate cards"),
    "transactions": ("transaction", "transactions"),
    "tds_entries": ("TDS entry", "TDS entries"),
    "leads": ("lead", "leads"),
    "wallet_entries": ("wallet entry", "wallet entries"),
    "finance_records": ("finance record", "finance records"),
}


def _phrase(refs: dict[str, int]) -> str:
    """"3 policies and 1 rate card" — only the relations that actually exist."""
    parts = []
    for key, count in refs.items():
        if not count:
            continue
        singular, plural = _LABELS.get(key, (key, key))
        parts.append(f"{count} {singular if count == 1 else plural}")
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return f"{', '.join(parts[:-1])} and {parts[-1]}"


def blocked_message(noun: str, refs: dict[str, int], *,
                    alternative: str = "Deactivate it instead") -> str:
    """The 409 body. Says what is in the way and what to do about it."""
    return (f"This {noun} is used by {_phrase(refs)}. {alternative} — "
            f"everything already recorded against it keeps working.")


def in_use(refs: dict[str, int]) -> bool:
    return any(refs.values())


# --- per-entity reference counts ----------------------------------------------------


async def insurer_refs(insurer_id: str) -> dict[str, int]:
    """An insurer is a tag on policies and a dimension on the rate card."""
    return {
        "policies": await Policy.find(Policy.insurer_id == insurer_id).count(),
        "rate_cards": await RateRule.find(
            RateRule.insurer_id == insurer_id).count(),
    }


async def broker_refs(broker_id: str) -> dict[str, int]:
    """A broker owns the rate card AND is a finance counterparty — premium
    payable, reward receivable, TDS withheld. The most connected of the five."""
    return {
        "policies": await Policy.find(Policy.broker_id == broker_id).count(),
        "rate_cards": await RateRule.find(
            RateRule.broker_id == broker_id).count(),
        "transactions": await LedgerTxn.find(
            LedgerTxn.party_type == PartyType.BROKER,
            LedgerTxn.party_id == broker_id).count(),
        "tds_entries": await TdsEntry.find(
            TdsEntry.broker_id == broker_id).count(),
    }


async def policy_type_refs(category_key: str) -> dict[str, int]:
    """Policy types are referenced by KEY, not by id — a booked policy stores
    `category_key`, and so does every rate-card rule."""
    return {
        "policies": await Policy.find(
            Policy.category_key == category_key).count(),
        "rate_cards": await RateRule.find(
            RateRule.category_key == category_key).count(),
    }


async def customer_refs(customer_id: str) -> dict[str, int]:
    """What stops a customer being deleted: a policy or a money movement.

    Deliberately NOT counted here: the lead they were converted from, and their
    uploaded documents. Those belong to the customer rather than depending on
    them, so deleting cascades instead of refusing — the lead's
    `converted_customer_id` is cleared and the files are purged from S3
    (routers/customers.delete_customer). Blocking on them would mean a customer
    added by mistake off the back of a lead could never be tidied away.
    """
    return {
        "policies": await Policy.find(
            Policy.customer_id == customer_id).count(),
        "transactions": await LedgerTxn.find(
            LedgerTxn.party_type == PartyType.CUSTOMER,
            LedgerTxn.party_id == customer_id).count(),
    }


async def user_refs(user_id: str) -> dict[str, int]:
    """Staff and channel partners. A partner additionally carries a wallet and a
    party balance; an employee is credited on the policies they booked.

    Both `partner_id` (credited) and `created_by` (booked it) count: an account
    that sold nothing but entered the whole book is still load-bearing for the
    audit trail.
    """
    return {
        "policies": await Policy.find(
            {"$or": [{"partner_id": user_id}, {"created_by": user_id}]}).count(),
        "transactions": await LedgerTxn.find(
            LedgerTxn.party_type == PartyType.CHANNEL_PARTNER,
            LedgerTxn.party_id == user_id).count(),
        "leads": await Lead.find(
            {"$or": [{"partner_id": user_id}, {"created_by": user_id}]}).count(),
        "wallet_entries": await WalletTxn.find(
            WalletTxn.partner_id == user_id).count(),
        "finance_records": await PolicyFinance.find(
            PolicyFinance.partner_id == user_id).count(),
    }


# --- bulk lookups for list responses ------------------------------------------------
#
# The list endpoints need an `in_use` flag per row so the UI can offer Delete
# only where it would actually succeed. Done as a handful of distinct() calls
# over the whole collection rather than per-row counts, so a page of 50 brokers
# is a fixed number of queries instead of 200.


async def _ledger_party_ids(party_type: PartyType) -> list[str]:
    """Every party of `party_type` that has a ledger row.

    Beanie puts `distinct` on the DOCUMENT class, taking a filter mapping — a
    find() query object has no such method, so `LedgerTxn.find(...).distinct(...)`
    raises AttributeError at request time and takes the whole list endpoint down
    with it. Wrapped here once so the three callers can't get it wrong again.
    """
    return await LedgerTxn.distinct(
        "party_id", {"party_type": party_type.value})


async def insurers_in_use(ids: Iterable[str]) -> set[str]:
    wanted = set(ids)
    if not wanted:
        return set()
    used = set(await Policy.distinct("insurer_id"))
    used |= set(await RateRule.distinct("insurer_id"))
    return {i for i in wanted if i in used}


async def brokers_in_use(ids: Iterable[str]) -> set[str]:
    wanted = set(ids)
    if not wanted:
        return set()
    used = set(await Policy.distinct("broker_id"))
    used |= set(await RateRule.distinct("broker_id"))
    used |= set(await TdsEntry.distinct("broker_id"))
    used |= set(await _ledger_party_ids(PartyType.BROKER))
    return {i for i in wanted if i in used}


async def policy_types_in_use(keys: Iterable[str]) -> set[str]:
    wanted = set(keys)
    if not wanted:
        return set()
    used = set(await Policy.distinct("category_key"))
    used |= set(await RateRule.distinct("category_key"))
    return {k for k in wanted if k in used}


async def users_in_use(ids: Iterable[str]) -> set[str]:
    wanted = set(ids)
    if not wanted:
        return set()
    used = set(await Policy.distinct("partner_id"))
    used |= set(await Policy.distinct("created_by"))
    used |= set(await Lead.distinct("partner_id"))
    used |= set(await Lead.distinct("created_by"))
    used |= set(await WalletTxn.distinct("partner_id"))
    used |= set(await PolicyFinance.distinct("partner_id"))
    used |= set(await _ledger_party_ids(PartyType.CHANNEL_PARTNER))
    return {i for i in wanted if i in used}


async def customers_in_use(ids: Iterable[str]) -> set[str]:
    wanted = set(ids)
    if not wanted:
        return set()
    used = set(await Policy.distinct("customer_id"))
    used |= set(await Lead.distinct("converted_customer_id"))
    used |= set(await _ledger_party_ids(PartyType.CUSTOMER))
    return {i for i in wanted if i in used}


__all__ = [
    "blocked_message", "in_use",
    "insurer_refs", "broker_refs", "policy_type_refs", "customer_refs",
    "user_refs",
    "insurers_in_use", "brokers_in_use", "policy_types_in_use",
    "users_in_use", "customers_in_use",
]
