"""Cloudflare Turnstile verification + per-IP login-failure tracking.

Dormant until `settings.turnstile_secret_key` is set: `required()` returns False
and `verify()` short-circuits True, so nothing changes for local/dev.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict

import httpx

from app.config import settings

logger = logging.getLogger("agastyacrm.captcha")

_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

# ip -> (failure_count, last_seen_monotonic). Failures decay after 15 min.
_fails: dict[str, tuple[int, float]] = defaultdict(lambda: (0, 0.0))
_DECAY = 15 * 60


def enabled() -> bool:
    """CAPTCHA is active only when BOTH keys are configured.

    Requiring the site key too (not just the secret) prevents a half-configured
    deadlock: if an admin sets only the secret, the server would demand a token
    the browser can never produce — locking out everyone who trips the failure
    threshold. In that case we stay dormant and `warn_if_misconfigured()` logs
    a loud startup warning instead.
    """
    return bool(settings.turnstile_secret_key and settings.turnstile_site_key)


def warn_if_misconfigured() -> None:
    """Log a warning at startup if CAPTCHA is only partially configured."""
    secret = bool(settings.turnstile_secret_key)
    site = bool(settings.turnstile_site_key)
    if secret and not site:
        logger.warning(
            "TURNSTILE_SECRET_KEY is set but TURNSTILE_SITE_KEY is not — CAPTCHA "
            "is DISABLED to avoid locking users out. Set both keys (and the same "
            "site key as VITE_TURNSTILE_SITE_KEY in web/.env) to enable it.")
    elif site and not secret:
        logger.warning(
            "TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is not — CAPTCHA "
            "is DISABLED (the server cannot verify tokens without the secret).")


def _current_fails(ip: str) -> int:
    count, ts = _fails.get(ip, (0, 0.0))
    if count and time.monotonic() - ts > _DECAY:
        _fails.pop(ip, None)
        return 0
    return count


def record_failure(ip: str) -> None:
    count = _current_fails(ip)
    _fails[ip] = (count + 1, time.monotonic())


def reset(ip: str) -> None:
    _fails.pop(ip, None)


def required(ip: str) -> bool:
    """Should this IP be forced through a CAPTCHA on its next login attempt?"""
    return enabled() and _current_fails(ip) >= settings.captcha_after_failures


# Consecutive transport failures talking to Cloudflare. A brief blip should not
# lock out real users, but failing open FOREVER means anyone who can break the
# verify call (block the host, exhaust the timeout) has simply switched the
# CAPTCHA off. So we fail open a few times, then start refusing.
_verify_errors = 0
_MAX_FAIL_OPEN = 5


async def verify(token: str | None, ip: str | None) -> bool:
    global _verify_errors
    if not enabled():
        return True
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.post(_VERIFY_URL, data={
                "secret": settings.turnstile_secret_key,
                "response": token,
                **({"remoteip": ip} if ip else {}),
            })
        data = resp.json()
        _verify_errors = 0                    # reachable again
        if not data.get("success"):
            logger.info("Turnstile verification failed: %s",
                        data.get("error-codes"))
        return bool(data.get("success"))
    except Exception:  # noqa: BLE001
        _verify_errors += 1
        logger.exception("Turnstile verification error (%d consecutive)",
                         _verify_errors)
        if _verify_errors > _MAX_FAIL_OPEN:
            logger.error(
                "Turnstile unreachable %d times in a row — failing CLOSED. "
                "Logins that require a challenge will be refused until it "
                "recovers.", _verify_errors)
            return False
        # A short outage shouldn't lock everyone out; the rate limiter still
        # applies during the fail-open window.
        return True
