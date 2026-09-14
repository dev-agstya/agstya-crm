"""Cached access to the SystemSettings singleton.

The document is tiny and read on many hot paths (every WhatsApp/email decision),
so we cache it in-process and invalidate on write. There is only one server
process per deploy, so a simple module-level cache is sufficient.
"""

from __future__ import annotations

from app.models.base import utcnow
from app.models.settings import SystemSettings

_cache: SystemSettings | None = None


async def get_settings(*, refresh: bool = False) -> SystemSettings:
    """Return the singleton, creating it with defaults on first use."""
    global _cache
    if _cache is not None and not refresh:
        return _cache
    doc = await SystemSettings.find_one(
        SystemSettings.singleton_key == "system")
    if doc is None:
        doc = SystemSettings(singleton_key="system")
        await doc.insert()
    _cache = doc
    return doc


def invalidate() -> None:
    global _cache
    _cache = None


# Every nested settings block this function will merge.
#
# It is a LIST rather than four hand-written `if` branches because it was four
# hand-written branches and `partner_portal` was missing from them — the Partner
# Portal settings page has been PATCHing `{"partner_portal": {...}}` to
# /api/admin/services, getting a 200 and a fully-populated response back, and
# changing nothing. Nothing errored; the switches simply sprang back on the next
# load. Adding `hr` (2026-08-20) would have been the third chance to make the
# same omission, so the branches are gone and a new block is one entry here.
_BLOCKS = ("whatsapp", "email", "partner_portal", "hr")


async def update(payload: dict, *, actor_id: str | None = None
                 ) -> SystemSettings:
    """Merge a partial settings payload onto the singleton.

    Each block is merged FIELD BY FIELD (`model_copy(update=...)`), so a payload
    naming one switch leaves the other twenty alone — a whole-block replace
    would reset every field the sender did not mention back to its default.
    """
    doc = await get_settings(refresh=True)
    for block in _BLOCKS:
        value = payload.get(block)
        if value:
            setattr(doc, block, getattr(doc, block).model_copy(update=value))
    doc.updated_at = utcnow()
    doc.updated_by = actor_id
    await doc.save()
    invalidate()
    return await get_settings(refresh=True)
