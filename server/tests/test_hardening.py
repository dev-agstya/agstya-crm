"""Pure-logic tests for Phase 1 hardening: the in-process rate limiter and the
error-reference generator."""

import re

from app.core.rate_limit import _hit
from app.services.errorlog import new_ref


def test_rate_limiter_allows_up_to_limit_then_blocks():
    key = "unit-test-bucket:1.2.3.4"
    limit, window = 3, 60
    # First `limit` hits are allowed (return 0 = no wait).
    assert [_hit(key, limit, window) for _ in range(limit)] == [0, 0, 0]
    # The next one is blocked with a positive retry-after.
    retry = _hit(key, limit, window)
    assert retry > 0


def test_rate_limiter_is_per_key():
    a = _hit("bucketA:9.9.9.9", 1, 60)
    b = _hit("bucketB:9.9.9.9", 1, 60)
    assert a == 0 and b == 0        # different buckets don't share a budget


def test_error_ref_format():
    ref = new_ref()
    assert re.fullmatch(r"ERR-[0-9A-F]{6}", ref)
    # Fresh each call.
    assert new_ref() != new_ref()
