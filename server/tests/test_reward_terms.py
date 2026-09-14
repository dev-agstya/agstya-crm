"""Tests for resolve_reward_terms — the rate-card fallback behind the policy form's
placeholder %s.

Contract the frontend relies on now that the reward fields show the rate card as a
placeholder instead of pre-filling it:
  * a blank field (value 0) is filled from the matched rate card;
  * a value entered on the policy always wins (per-policy override);
  * the agency and partner sides are resolved INDEPENDENTLY;
  * the partner rate is only pulled in when a partner is attributed;
  * with no broker or no matching rate, terms are left as entered.
"""

import asyncio
from types import SimpleNamespace

import app.services.policy_ops as policy_ops
from app.core.enums import RewardBasis
from app.models.policy import RewardTerms


def _policy(*, reward, partner_id=None, broker_id="brk1"):
    return SimpleNamespace(
        reward=reward,
        broker_id=broker_id,
        insurer_id="ins1",
        category_key="motor",
        subcategory_path=["4w"],
        partner_id=partner_id,
    )


def _rule(*, agency_value=3300, partner_value=2500):
    return SimpleNamespace(
        agency_basis=RewardBasis.PERCENT,
        agency_value=agency_value,
        partner_basis=RewardBasis.PERCENT,
        partner_value=partner_value,
    )


def _resolve(monkeypatch, policy, rule):
    async def fake_find_rate_rule(*args, **kwargs):
        return rule
    monkeypatch.setattr(policy_ops, "find_rate_rule", fake_find_rate_rule)
    return asyncio.run(policy_ops.resolve_reward_terms(policy))


def test_blank_fields_filled_from_rate_card(monkeypatch):
    # No partner attributed -> only the agency side is filled.
    terms = _resolve(monkeypatch, _policy(reward=RewardTerms()), _rule())
    assert terms.agency_value == 3300
    assert terms.partner_value == 0


def test_partner_rate_filled_when_partner_attributed(monkeypatch):
    terms = _resolve(
        monkeypatch, _policy(reward=RewardTerms(), partner_id="p1"), _rule())
    assert terms.agency_value == 3300
    assert terms.partner_value == 2500


def test_entered_value_overrides_rate_card(monkeypatch):
    # Agency % typed on the policy; partner left blank -> only partner is filled.
    entered = RewardTerms(agency_value=4000)
    terms = _resolve(
        monkeypatch, _policy(reward=entered, partner_id="p1"), _rule())
    assert terms.agency_value == 4000       # override wins
    assert terms.partner_value == 2500      # blank side still from rate card


def test_no_broker_keeps_entered_terms(monkeypatch):
    entered = RewardTerms(agency_value=4000)
    terms = _resolve(
        monkeypatch, _policy(reward=entered, broker_id=None), _rule())
    assert terms.agency_value == 4000
    assert terms.partner_value == 0


def test_no_matching_rate_leaves_terms_untouched(monkeypatch):
    terms = _resolve(monkeypatch, _policy(reward=RewardTerms()), None)
    assert terms.agency_value == 0
    assert terms.partner_value == 0
