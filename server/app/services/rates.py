"""The rate engine: pick the reward rate that applies to a policy scenario.

Rules live under a Broker, scoped to a policy type, an OPTIONAL insurer company, and
an optional PATH down that type's nested sub-tree. Given a policy's insurer + chosen
path we keep the rules that MATCH — insurer equal (or the rule pinned to no insurer,
which applies to any) AND the rule's `subcategory_path` a prefix of the policy's path
(a node's rate is inherited by its descendants). Among the survivors the MOST
SPECIFIC wins: an insurer-specific rule beats an insurer-agnostic one, then the
deepest path wins, then the most recently effective. There is NO further fallback —
see policy_ops.resolve_reward_terms.

`select_rate_rule` is a pure function (no DB) so it is unit-tested like money.py.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional

from app.models.base import utcnow
from app.models.rate_rule import RateRule

_MIN_DT = datetime.min.replace(tzinfo=timezone.utc)


def _in_window(rule: RateRule, as_of: datetime) -> bool:
    if rule.effective_from and as_of < rule.effective_from:
        return False
    if rule.effective_to and as_of > rule.effective_to:
        return False
    return True


def _path_matches(rule: RateRule, path: list[str]) -> bool:
    """True if the rule's path is a prefix of (or equal to) the policy's path."""
    rp = rule.subcategory_path or []
    return rp == path[: len(rp)]


def _insurer_matches(rule: RateRule, insurer_id: Optional[str]) -> bool:
    """A rule with no insurer_id applies to any insurer; a pinned rule must equal
    the policy's insurer."""
    return not rule.insurer_id or rule.insurer_id == insurer_id


def _specificity(rule: RateRule) -> tuple[int, int]:
    """How specific the rule is (higher = more specific): insurer-pinned beats
    insurer-agnostic, then a deeper sub-type path wins."""
    return (1 if rule.insurer_id else 0, len(rule.subcategory_path or []))


def select_rate_rule(rules: Iterable[RateRule], subcategory_path: list[str],
                     insurer_id: Optional[str] = None,
                     as_of: Optional[datetime] = None) -> Optional[RateRule]:
    """Return the most specific active, in-window rule matching the scenario."""
    as_of = as_of or utcnow()
    path = list(subcategory_path or [])
    matching = [
        r for r in rules
        if r.active and _in_window(r, as_of)
        and _insurer_matches(r, insurer_id) and _path_matches(r, path)
    ]
    if not matching:
        return None
    # Insurer-specific + deepest path first; then most recently effective; newest.
    return max(matching, key=lambda r: (
        *_specificity(r),
        r.effective_from or _MIN_DT,
        r.created_at or _MIN_DT,
    ))


async def find_rate_rule(
    broker_id: str,
    category_key: str,
    subcategory_path: Optional[list[str]],
    insurer_id: Optional[str] = None,
    as_of: Optional[datetime] = None,
) -> Optional[RateRule]:
    """Fetch candidate rules for a Broker + type and select the best match for the
    policy's insurer company + sub-type path."""
    if not broker_id:
        return None
    rules = await RateRule.find(
        RateRule.broker_id == broker_id,
        RateRule.category_key == category_key,
    ).to_list()
    return select_rate_rule(rules, subcategory_path or [], insurer_id, as_of)
