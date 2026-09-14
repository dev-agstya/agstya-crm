// Helpers for the nested policy-type (category) tree, shared by the rate-card
// editor and the policy form so both drill down the same way. Mirrors the
// backend's max depth (services/categories.MAX_SUBCATEGORY_DEPTH).

import type { CategoryNode } from "./types";

export const MAX_SUBCATEGORY_DEPTH = 5;

// The nodes available directly under `path` within a tree (empty if the path is
// invalid or the node is a leaf).
export function childrenAt(root: CategoryNode[], path: string[]): CategoryNode[] {
  let cur = root;
  for (const key of path) {
    const match = cur.find((n) => n.key === key);
    if (!match) return [];
    cur = match.children;
  }
  return cur;
}

// Build the sequence of drill-down "levels" for a path selector. Each level lists
// the active options at that depth and the currently-selected key ("" = none).
// Renders a select for every chosen level, plus one more empty select while the
// deepest chosen node still has children (so the user can go deeper).
export function pathLevels(
  root: CategoryNode[], path: string[],
): { options: CategoryNode[]; value: string }[] {
  const levels: { options: CategoryNode[]; value: string }[] = [];
  let cur = root;
  let depth = 0;
  while (cur.length > 0 && depth <= path.length && depth < MAX_SUBCATEGORY_DEPTH) {
    const value = path[depth] ?? "";
    levels.push({ options: cur.filter((n) => n.active), value });
    if (!value) break;
    const match = cur.find((n) => n.key === value);
    if (!match) break;
    cur = match.children;
    depth += 1;
  }
  return levels;
}

// Human label for a chosen path, e.g. "Car / Zone A" (best-effort; falls back to
// the raw key). Empty path -> "Whole type".
export function describePath(root: CategoryNode[], path: string[]): string {
  const out: string[] = [];
  let cur = root;
  for (const key of path) {
    const match = cur.find((n) => n.key === key);
    if (!match) { out.push(key); break; }
    out.push(match.label);
    cur = match.children;
  }
  return out.length ? out.join(" / ") : "Whole type";
}
