"""Business operations tying policies to their reward ledger records."""

from __future__ import annotations

import re

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from app.core.enums import AccountType, RewardStatus
from app.models.base import utcnow
from app.models.policy import Policy, RewardTerms
from app.models.reward import Reward
from app.models.user import User
from app.services.money import commissionable_from_premium, compute_reward
from app.services.rates import find_rate_rule


async def ensure_policy_number_unique(number: str,
                                      exclude_id: str | None = None) -> None:
    """Policy numbers are globally unique — no duplicates across any insurer or
    broker. Case-insensitive exact match on the trimmed value.

    Lives here rather than in routers/policies because a partner submitting
    through the portal has to be held to the SAME rule. Two copies of a
    uniqueness check is how you end up with the duplicate the index was
    supposed to stop (see the `policy_number_unique` index note in CLAUDE.md —
    that index has been wrong in production before, so this application-level
    check is doing real work).
    """
    number = (number or "").strip()
    if not number:
        return
    existing = await Policy.find_one(
        {"policy_number": {"$regex": f"^{re.escape(number)}$", "$options": "i"}})
    if existing is not None and str(existing.id) != (exclude_id or ""):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Policy number '{number}' already exists. Policy numbers must be "
            f"unique.")


async def stamp_manager(policy: Policy, owner_user_id: str) -> None:
    """Freeze the relationship manager this policy is credited to.

    Two cases, and the ORDER matters:

      * the policy is credited to a channel partner -> that partner's
        relationship manager gets it. Not the employee who typed it in: a
        manager's book is the business their partners bring, whoever keys it.
      * no partner (an in-house sale) -> the booking employee gets it, so the
        roll-up still adds up to the company total instead of dropping direct
        business into an "unassigned" hole (owner T7).

    Frozen at booking. Reassigning a partner to another manager must not rewrite
    what their old manager brought in last quarter — that is the whole reason
    this is a copy and not a live lookup. Replaces the old `stamp_team`, which
    froze the booking user's team for exactly the same reason.

    A policy that resolves to nobody (a partner with no manager, a deleted user,
    a malformed id) is simply left unstamped and shows up as "Unassigned" in the
    roll-up rather than being guessed at or dropped.

    Shared with the portal: a partner-submitted policy has to be attributed the
    same way a staff-booked one is, or the roll-up quietly loses a channel of
    business.
    """
    credited_to = policy.partner_id or owner_user_id
    if not credited_to:
        return
    try:
        user = await User.get(PydanticObjectId(credited_to))
    except Exception:  # noqa: BLE001 — malformed id: leave it unstamped
        return
    if user is None:
        return

    if user.account_type == AccountType.CHANNEL_PARTNER:
        manager_id = user.relationship_manager_id
        if not manager_id:
            return
        try:
            manager = await User.get(PydanticObjectId(manager_id))
        except Exception:  # noqa: BLE001
            return
        if manager is None:
            return
    else:
        manager = user

    policy.manager_id = str(manager.id)
    policy.manager_name = manager.full_name


async def resolve_reward_terms(policy: Policy) -> RewardTerms:
    """Fill in reward terms the policy doesn't already specify from the rate card.

    Only rates the user did NOT set are auto-filled — an explicit value entered on
    the policy always wins (per-policy override). The rate comes solely from the
    matching rate rule under the policy's Broker (best match for its insurer company
    + sub-type path). There is no other fallback: if nothing matches, terms are left
    as entered (possibly zero).
    """
    terms = policy.reward or RewardTerms()
    if not policy.broker_id:
        return terms

    rule = await find_rate_rule(
        policy.broker_id, policy.category_key, policy.subcategory_path,
        insurer_id=policy.insurer_id)
    if rule is None:
        return terms

    if not terms.agency_value and rule.agency_value:
        terms.agency_basis = rule.agency_basis
        terms.agency_value = rule.agency_value
    # Channel Partner side: only relevant when a partner is attributed.
    if policy.partner_id and not terms.partner_value and rule.partner_value:
        terms.partner_basis = rule.partner_basis
        terms.partner_value = rule.partner_value
    return terms


def effective_commissionable(policy: Policy) -> int:
    """The reward base (in paise) for a policy.

    When the policy's `reward_base_field` points at an `amount` custom field (e.g.
    "OD Amount" — the ledger's "Comm On OD" case) and that field carries a positive
    value, that amount is the base. Otherwise the base is the explicit
    commissionable premium, or a GST-net default derived from the gross premium.
    """
    base_field = getattr(policy, "reward_base_field", "commissionable") \
        or "commissionable"
    if base_field != "commissionable":
        val = (policy.details or {}).get(base_field)
        if isinstance(val, (int, float)) and val > 0:
            return int(val)
    if policy.commissionable_premium and policy.commissionable_premium > 0:
        return policy.commissionable_premium
    return commissionable_from_premium(policy.premium_amount, policy.gst_percent)


async def sync_reward(policy: Policy) -> Reward:
    """Create or update the Reward ledger record for a policy.

    Amounts are recomputed from the current commissionable premium + terms. The
    settlement status (pending/received/paid_out) and wallet flags are preserved
    across updates.
    """
    base = effective_commissionable(policy)
    has_partner = bool(policy.partner_id)
    agency, partner, house = compute_reward(
        base,
        policy.reward.agency_basis,
        policy.reward.agency_value,
        policy.reward.partner_basis,
        policy.reward.partner_value,
        has_partner,
    )

    existing = await Reward.find_one(Reward.policy_id == str(policy.id))
    if existing is None:
        record = Reward(
            policy_id=str(policy.id),
            insurer_id=policy.insurer_id,
            customer_id=policy.customer_id,
            category_key=policy.category_key,
            subcategory_key=policy.subcategory_key,
            premium_amount=policy.premium_amount,
            commissionable_premium=base,
            agency_amount=agency,
            partner_amount=partner,
            house_amount=house,
            status=RewardStatus.PENDING,
            owner_user_id=policy.owner_user_id,
            partner_id=policy.partner_id,
            created_by=policy.created_by,
        )
        await record.insert()
        return record

    existing.premium_amount = policy.premium_amount
    existing.commissionable_premium = base
    existing.agency_amount = agency
    existing.partner_amount = partner
    existing.house_amount = house
    existing.category_key = policy.category_key
    existing.subcategory_key = policy.subcategory_key
    existing.partner_id = policy.partner_id
    existing.updated_at = utcnow()
    await existing.save()
    return existing
