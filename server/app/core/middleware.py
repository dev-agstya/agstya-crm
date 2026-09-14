"""Cross-cutting HTTP middleware: a per-IP global rate limit and a hard request
timeout. Both return the app's standard `{"detail": ...}` JSON shape."""

from __future__ import annotations

import asyncio
import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.config import settings
from app.core.rate_limit import _hit, client_ip

logger = logging.getLogger("agastyacrm.middleware")

# Paths that must never be rate-limited or timed out (liveness probes).
_EXEMPT_PATHS = {"/", "/health"}


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Coarse per-IP ceiling across the whole API. Sensitive auth routes add a
    stricter per-route limit on top (see app.core.rate_limit)."""

    async def dispatch(self, request: Request, call_next):
        if (not settings.rate_limit_enabled
                or request.method == "OPTIONS"
                or request.url.path in _EXEMPT_PATHS):
            return await call_next(request)
        retry = _hit(f"global:{client_ip(request)}",
                     settings.rate_limit_global_per_min, 60)
        if retry:
            return JSONResponse(
                status_code=429,
                content={"detail": f"Too many requests. Please slow down and "
                                   f"try again in {retry} seconds."},
                headers={"Retry-After": str(retry)},
            )
        return await call_next(request)


class TimeoutMiddleware(BaseHTTPMiddleware):
    """Abort any request exceeding the configured cap with a clean 504 instead of
    hanging a worker."""

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.url.path in _EXEMPT_PATHS:
            return await call_next(request)
        try:
            return await asyncio.wait_for(
                call_next(request), timeout=settings.request_timeout_seconds)
        except asyncio.TimeoutError:
            logger.warning("Request timed out: %s %s",
                           request.method, request.url.path)
            return JSONResponse(
                status_code=504,
                content={"detail": "The request took too long and was stopped. "
                                   "Please try again."},
            )
