"""Lightweight in-process IP rate limiting.

A sliding-window counter kept in memory — correct for the current single Render
instance and needs no Redis. The store is deliberately isolated behind
`_hit()` so it can be swapped for a shared backend (Redis) later without
touching call sites.

Usage:
  - global default: `RateLimitMiddleware` (see app.core.middleware).
  - per-route:      `Depends(rate_limit("login", limit, window_seconds))`.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status

from app.config import settings

# key -> deque[timestamp]. Keys look like "login:1.2.3.4".
_hits: dict[str, deque[float]] = defaultdict(deque)
_last_sweep = 0.0


def client_ip(request: Request) -> str:
    """The client IP, taken from the RIGHT of X-Forwarded-For.

    A proxy APPENDS the peer it saw to whatever the client already sent, so the
    header reads "<client-supplied junk>, <real client>, <proxy hops>". Reading
    the LEFTMOST entry — the usual mistake — hands the caller full control of
    their own identity: rotating a spoofed header resets every per-IP limit,
    the login lockout, the CAPTCHA gate and the audit trail's IP.

    So we count from the right instead, skipping `trusted_proxy_hops` entries
    that our own infrastructure added (Render = 1). Everything to the left of
    that is caller-supplied and ignored. With no header at all we use the socket
    peer, which cannot be forged.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            # hops=1 -> parts[-1] is the peer our proxy saw = the real client.
            idx = len(parts) - max(1, settings.trusted_proxy_hops)
            return parts[max(0, idx)]
    return request.client.host if request.client else "unknown"


# Hard ceiling on tracked keys. Dropping empty buckets every 5 minutes is not a
# bound: a caller cycling through addresses adds a live bucket per address, and
# live buckets are exactly the ones the sweep keeps. Past this many keys the
# oldest are evicted so the limiter can't become the memory leak.
_MAX_KEYS = 50_000


def _sweep(now: float) -> None:
    """Drop stale buckets so memory can't grow without bound."""
    global _last_sweep
    if now - _last_sweep < 300:
        return
    _last_sweep = now
    for key in [k for k, dq in _hits.items() if not dq]:
        _hits.pop(key, None)
    if len(_hits) > _MAX_KEYS:
        # Evict the buckets whose most recent hit is oldest — they are the
        # closest to expiring anyway, so the limit they carry is nearly spent.
        stale = sorted(_hits.items(), key=lambda kv: kv[1][-1] if kv[1] else 0)
        for key, _ in stale[:len(_hits) - _MAX_KEYS]:
            _hits.pop(key, None)


def _hit(key: str, limit: int, window: float) -> int:
    """Record a hit for `key`. Returns 0 if allowed, else seconds to wait."""
    now = time.monotonic()
    # Sweep BEFORE the limit check, not after the append. It used to run only on
    # the allowed path, so a key that is continuously over its limit never
    # triggered one from its own hits — precisely the traffic that grows the
    # store. Any request now pays the (rate-limited, every-300s) sweep.
    _sweep(now)
    dq = _hits[key]
    cutoff = now - window
    while dq and dq[0] < cutoff:
        dq.popleft()
    if len(dq) >= limit:
        return max(1, int(dq[0] + window - now) + 1)
    dq.append(now)
    return 0


def enforce(request: Request, bucket: str, limit: int, window: float) -> None:
    if not settings.rate_limit_enabled:
        return
    retry = _hit(f"{bucket}:{client_ip(request)}", limit, window)
    if retry:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Too many requests. Please try again in {retry} second"
            f"{'s' if retry != 1 else ''}.",
            headers={"Retry-After": str(retry)},
        )


def rate_limit(bucket: str, limit: int, window_seconds: float):
    """FastAPI dependency enforcing a per-IP limit on a single route."""
    async def _dep(request: Request) -> None:
        enforce(request, bucket, limit, window_seconds)
    return _dep


# Pre-built dependencies for the sensitive auth routes (values from settings).
login_rate_limit = rate_limit(
    "login", settings.rate_limit_login_per_min, 60)
refresh_rate_limit = rate_limit(
    "refresh", settings.rate_limit_refresh_per_min, 60)
forgot_rate_limit = rate_limit(
    "forgot", settings.rate_limit_forgot_per_hour, 3600)
# Submitting a reset code is the step that actually guesses it, so it gets its
# own ceiling rather than inheriting only the global one.
reset_rate_limit = rate_limit(
    "reset", settings.rate_limit_reset_per_hour, 3600)
