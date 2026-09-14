"""Pure helpers for the nested policy-type (category) tree.

Kept DB-free so they can be unit-tested and reused by the master router (validate a
saved tree) and the policy router (validate a booked path).
"""

from __future__ import annotations

from typing import Iterable, Optional

from app.models.master import MAX_SUBCATEGORY_DEPTH, CategoryNode


def tree_depth(nodes: Iterable[CategoryNode]) -> int:
    """Number of nesting levels in a sub-type tree (0 for an empty tree)."""
    nodes = list(nodes)
    if not nodes:
        return 0
    return 1 + max((tree_depth(n.children) for n in nodes), default=0)


def validate_tree(nodes: Iterable[CategoryNode]) -> None:
    """Raise ValueError if the tree is too deep or has duplicate sibling keys."""
    if tree_depth(nodes) > MAX_SUBCATEGORY_DEPTH:
        raise ValueError(
            f"Sub-types can be at most {MAX_SUBCATEGORY_DEPTH} levels deep.")
    _check_unique_keys(nodes)


def _check_unique_keys(nodes: Iterable[CategoryNode]) -> None:
    seen: set[str] = set()
    for n in nodes:
        if not n.key:
            raise ValueError("Every sub-type needs a key.")
        if n.key in seen:
            raise ValueError(f"Duplicate sub-type key '{n.key}' among siblings.")
        seen.add(n.key)
        _check_unique_keys(n.children)


def path_is_valid(nodes: Iterable[CategoryNode], path: list[str]) -> bool:
    """True if `path` (a list of node keys) traces a real branch of the tree.
    An empty path (the top-level type itself) is always valid."""
    current = list(nodes)
    for key in path:
        match = next((n for n in current if n.key == key), None)
        if match is None:
            return False
        current = match.children
    return True


def labels_for_path(nodes: Iterable[CategoryNode], path: list[str]) -> list[str]:
    """Human labels along a path (best-effort; falls back to the raw key)."""
    out: list[str] = []
    current = list(nodes)
    for key in path:
        match = next((n for n in current if n.key == key), None)
        if match is None:
            out.append(key)
            break
        out.append(match.label)
        current = match.children
    return out


def leaf_key(path: Optional[list[str]]) -> Optional[str]:
    """The deepest chosen sub-type key (for display / analytics), or None."""
    return path[-1] if path else None
