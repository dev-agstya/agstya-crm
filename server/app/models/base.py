"""Shared model helpers."""

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Timezone-aware current UTC time. Use everywhere instead of datetime.now()."""
    return datetime.now(timezone.utc)
