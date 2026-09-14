"""Tests for select_rate_rule's insurer dimension + specificity ordering.

A broker's rate card can pin a rate to a specific insurer company and/or a deeper
sub-type path. The engine keeps only rules that match the policy's insurer (or apply
to any insurer) AND whose path is a prefix of the policy's, then picks the MOST
SPECIFIC: insurer-pinned beats insurer-agnostic, then the deepest path wins.
"""

from datetime import datetime, timezone
from types import SimpleNamespace

from app.core.enums import RewardBasis
from app.services.rates import select_rate_rule


def _rule(*, insurer_id=None, path=None, agency=3000, active=True,
          created=datetime(2026, 1, 1, tzinfo=timezone.utc)):
    return SimpleNamespace(
        insurer_id=insurer_id,
        subcategory_path=path or [],
        agency_basis=RewardBasis.PERCENT, agency_value=agency,
        partner_basis=RewardBasis.PERCENT, partner_value=0,
        active=active, effective_from=None, effective_to=None,
        created_at=created,
    )


def test_no_rules_returns_none():
    assert select_rate_rule([], ["4w"], insurer_id="sbi") is None


def test_insurer_agnostic_matches_any_insurer():
    rule = _rule(insurer_id=None, agency=3000)
    got = select_rate_rule([rule], ["4w"], insurer_id="sbi")
    assert got is rule


def test_insurer_pinned_beats_agnostic():
    generic = _rule(insurer_id=None, agency=3000)
    pinned = _rule(insurer_id="sbi", agency=2800)
    got = select_rate_rule([generic, pinned], ["4w"], insurer_id="sbi")
    assert got is pinned
    assert got.agency_value == 2800


def test_pinned_rule_for_other_insurer_is_disqualified():
    pinned_other = _rule(insurer_id="tata", agency=2800)
    generic = _rule(insurer_id=None, agency=3000)
    got = select_rate_rule([pinned_other, generic], ["4w"], insurer_id="sbi")
    assert got is generic          # the tata-only rule can't apply to sbi


def test_deeper_path_wins_within_same_insurer():
    shallow = _rule(insurer_id="sbi", path=["4w"], agency=3000)
    deep = _rule(insurer_id="sbi", path=["4w", "zone_a"], agency=3300)
    got = select_rate_rule([shallow, deep], ["4w", "zone_a"], insurer_id="sbi")
    assert got is deep


def test_path_not_a_prefix_is_disqualified():
    other = _rule(insurer_id="sbi", path=["2w"], agency=3300)
    got = select_rate_rule([other], ["4w"], insurer_id="sbi")
    assert got is None


def test_insurer_specificity_beats_a_deeper_agnostic_path():
    # An insurer-pinned rule outranks an insurer-agnostic one even if the agnostic
    # rule is pinned deeper — insurer specificity is the primary key.
    agnostic_deep = _rule(insurer_id=None, path=["4w", "zone_a"], agency=3000)
    pinned_shallow = _rule(insurer_id="sbi", path=["4w"], agency=2800)
    got = select_rate_rule([agnostic_deep, pinned_shallow],
                           ["4w", "zone_a"], insurer_id="sbi")
    assert got is pinned_shallow
