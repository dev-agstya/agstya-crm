"""Atomic sequence counters for human-readable entity codes."""

from __future__ import annotations

from beanie import Document
from pymongo import ReturnDocument


class Counter(Document):
    """One document per sequence, e.g. {_id via name: 'policy', seq: 42}."""

    name: str
    seq: int = 0

    class Settings:
        name = "counters"
        indexes = ["name"]

    @classmethod
    async def next_value(cls, name: str) -> int:
        """Atomically increment and return the next value for a sequence."""
        collection = cls.get_motor_collection()
        doc = await collection.find_one_and_update(
            {"name": name},
            {"$inc": {"seq": 1}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        return int(doc["seq"])
