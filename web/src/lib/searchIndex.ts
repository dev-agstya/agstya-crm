// Client-side search over app destinations: Pages, Settings and Features.
//
// These aren't database records, so they're matched here (not on the server) and
// filtered by the SAME access gate the sidebar/router use — a user only ever
// finds destinations they're allowed to open.

import { NAV, canAccess, type Gate } from "./access";
import type { AccountType } from "./types";

export type DestKind = "page" | "setting" | "feature";

export interface Destination extends Gate {
  label: string;
  to: string;
  kind: DestKind;
  keywords?: string;   // extra terms to match against
}

// Extra destinations that aren't top-level nav items (opened from menus, or
// deep links worth surfacing). Gates mirror the router.
const EXTRA: Destination[] = [
  { label: "Settings", to: "/settings", kind: "setting",
    keywords: "profile account preferences theme password email",
    partner: true, employeeAny: true },
  { label: "Help Center", to: "/help", kind: "feature",
    keywords: "support docs guide faq", partner: true, employeeAny: true },
  { label: "Notifications", to: "/settings", kind: "feature",
    keywords: "alerts bell", partner: true, employeeAny: true },
  { label: "Third Party Services", to: "/admin/services", kind: "setting",
    keywords: "whatsapp email integrations api toggle whatsapp settings",
    ownerOnly: true },
  { label: "System & Usage", to: "/system", kind: "setting",
    keywords: "api usage cost errors logs health", ownerOnly: true },
  { label: "Audit Logs", to: "/audit", kind: "feature",
    keywords: "history activity trail logs", anyPerm: ["view_audit_logs"] },
  { label: "TDS", to: "/finance/tds", kind: "feature",
    keywords: "tax deducted source finance", anyPerm: ["view_tds"] },
  { label: "Balance Sheet", to: "/finance/balance-sheet", kind: "feature",
    keywords: "finance statement broker partner customer",
    anyPerm: ["view_balance_sheet"] },
  { label: "Transactions", to: "/finance/transactions", kind: "feature",
    keywords: "ledger payments finance", anyPerm: ["view_transactions"] },
  // Workplace HR pages come in from the nav automatically. These two do not:
  // one is a Settings sub-page, the other is a VIEW of a page rather than a
  // page — and "who is in today" is a thing somebody types into a search box
  // far more often than they go looking for it in a tab.
  { label: "Attendance & leave settings", to: "/settings/attendance",
    kind: "setting",
    keywords: "shift timing late mark grace half day full day working hours "
      + "week off sunday leave policy accrual holiday year payroll hr",
    ownerOnly: true },
  { label: "Who is in today", to: "/hr/attendance?view=today", kind: "feature",
    keywords: "attendance team board present absent late clocked in register",
    anyPerm: ["view_attendance"] },
];

// Flatten the sidebar nav (parents + children) into destinations.
function navDestinations(): Destination[] {
  const out: Destination[] = [];
  for (const section of NAV) {
    for (const item of section.items) {
      out.push({ ...item, label: item.label, to: item.to, kind: "page",
        keywords: section.title });
      for (const child of item.children ?? []) {
        out.push({ ...child, label: child.label, to: child.to, kind: "page",
          keywords: `${item.label} ${section.title}` });
      }
    }
  }
  return out;
}

const ALL: Destination[] = [...navDestinations(), ...EXTRA];

/**
 * Destinations the user can open, matching the query (label or keywords).
 * Deduped by route so a page appearing in both nav and extras shows once.
 */
export function searchDestinations(
  query: string,
  accountType: AccountType | undefined,
  has: (permission: string) => boolean,
  limit = 6,
): Destination[] {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return [];
  const seen = new Set<string>();
  const scored: { d: Destination; score: number }[] = [];
  for (const d of ALL) {
    if (!canAccess(d, accountType, has)) continue;
    const label = d.label.toLowerCase();
    const hay = `${label} ${(d.keywords ?? "").toLowerCase()}`;
    if (!hay.includes(q)) continue;
    const key = `${d.to}|${d.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Rank exact/prefix label matches above keyword-only matches.
    const score = label === q ? 0 : label.startsWith(q) ? 1
      : label.includes(q) ? 2 : 3;
    scored.push({ d, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.d);
}
