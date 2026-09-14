"""Record outbound third-party API calls for usage & cost tracking.

Best-effort and never blocks the caller: `track()` fires the DB write on the
event loop and returns immediately. A synchronous context (e.g. inside a
threadpool) should collect the fields and call `track()` from the async caller.
"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import contextmanager
from typing import Any, Optional

logger = logging.getLogger("agastyacrm.apilog")


async def record(
    service: str, operation: str, *, success: bool = True,
    duration_ms: int = 0, units: int = 1, bytes_transferred: int = 0,
    cost_paise: int = 0, status_code: Optional[int] = None,
    error: Optional[str] = None, actor_id: Optional[str] = None,
    related_type: Optional[str] = None, related_id: Optional[str] = None,
    meta: Optional[dict[str, Any]] = None,
) -> None:
    from app.models.system_logs import ApiCallLog  # local: avoid import cycle
    try:
        await ApiCallLog(
            service=service, operation=operation, success=success,
            status_code=status_code, error=error, duration_ms=duration_ms,
            units=units, bytes_transferred=bytes_transferred,
            cost_paise=cost_paise, actor_id=actor_id,
            related_type=related_type, related_id=related_id, meta=meta or {},
        ).insert()
    except Exception:  # noqa: BLE001 — usage logging must never break a request
        logger.exception("Failed to record ApiCallLog %s/%s", service, operation)


def track(service: str, operation: str, **kwargs) -> None:
    """Fire-and-forget variant for use inside async request handlers."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop (rare) — skip rather than crash
    asyncio.create_task(record(service, operation, **kwargs))


@contextmanager
def timed():
    """`with timed() as t: ...; t()` -> elapsed milliseconds."""
    start = time.perf_counter()
    holder = {}

    def elapsed() -> int:
        return int((time.perf_counter() - start) * 1000)

    holder["ms"] = elapsed
    yield elapsed
