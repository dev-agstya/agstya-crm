"""Unit tests for the rate engine's selection logic (no DB needed).

Covers the core promise: the DEEPEST matching rule wins, where a rule matches only
when its sub-type path is a prefix of the policy's chosen path; inactive /
out-of-window rules are ignored; and ties break towards the newest effective rule.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.services.rates import select_rate_rule

NOW = datetime(2026, 7, 8, tzinfo=timezone.utc)


def _rule(agency_value, *, path=None, active=True, effective_from=None,
          effective_to=None, created_at=NOW, partner_value=0):
    """A lightweight stand-in for a RateRule (select_rate_rule is pure and only
    reads attributes, so we avoid needing an initialised Beanie collection)."""
    return SimpleNamespace(
        insurer_id=None,
        subcategory_path=path or [],
        agency_value=agency_value,
        partner_value=partner_value,
        agency_basis="percent",
        partner_basis="percent",
        active=active,
        effective_from=effective_from,
        effective_to=effective_to,
        created_at=created_at,
    )


def test_no_rules_returns_none():
    assert select_rate_rule([], ["4w"], as_of=NOW) is None


def test_generic_rule_matches_any_path():
    r = _rule(1000)  # empty path = the whole policy type
    assert select_rate_rule([r], ["4w", "zone_a"], as_of=NOW) is r


def test_deepest_matching_prefix_wins():
    generic = _rule(1000)                          # []
    by_sub = _rule(1200, path=["4w"])              # ["4w"]
    by_zone = _rule(2000, path=["4w", "zone_a"])   # ["4w","zone_a"]
    chosen = select_rate_rule([generic, by_sub, by_zone], ["4w", "zone_a"],
                              as_of=NOW)
    assert chosen is by_zone
    assert chosen.agency_value == 2000


def test_non_prefix_rule_disqualified():
    # A 2-wheeler rule must NOT apply to a 4-wheeler policy.
    other = _rule(2000, path=["2w"])
    generic = _rule(1000)
    assert select_rate_rule([other, generic], ["4w"], as_of=NOW) is generic


def test_partial_prefix_used_when_deeper_absent():
    by_sub = _rule(1200, path=["4w"])
    assert select_rate_rule([by_sub], ["4w", "zone_a"], as_of=NOW) is by_sub


def test_rule_deeper_than_policy_path_disqualified():
    deeper = _rule(2000, path=["4w", "zone_a"])
    generic = _rule(1000)
    # The policy only chose ["4w"]; a zone-specific rule must not apply.
    assert select_rate_rule([deeper, generic], ["4w"], as_of=NOW) is generic


def test_inactive_rule_ignored():
    inactive = _rule(9999, path=["4w"], active=False)
    generic = _rule(1000)
    assert select_rate_rule([inactive, generic], ["4w"], as_of=NOW) is generic


def test_out_of_window_rule_ignored():
    future = _rule(9999, effective_from=NOW + timedelta(days=10))
    past = _rule(8888, effective_to=NOW - timedelta(days=10))
    current = _rule(1000)
    assert select_rate_rule([future, past, current], ["4w"], as_of=NOW) is current


def test_tie_break_prefers_newer_effective():
    older = _rule(1000, path=["4w"], effective_from=NOW - timedelta(days=30))
    newer = _rule(2000, path=["4w"], effective_from=NOW - timedelta(days=1))
    assert select_rate_rule([older, newer], ["4w"], as_of=NOW) is newer
