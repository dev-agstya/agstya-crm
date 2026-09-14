// The Channel Partner portal's client-side half of the boundary.
//
// The server refuses a partner's token on every staff router
// (core/dependencies.get_inhouse_user, pinned by tests/test_partner_boundary.py).
// This file pins the SIDEBAR side: a partner must not be shown links they will
// only get a 403 from, and — the part that actually matters — a staff page must
// never be gated in a way that lets a partner through.

import { describe, expect, it } from "vitest";
import { NAV, canAccess, gateForPath } from "./access";

const allItems = NAV.flatMap((s) => s.items);
const asPartner = (gate: Parameters<typeof canAccess>[0]) =>
  canAccess(gate, "channel_partner", () => false);
// A partner holds NO permission flags at all (PARTNER_PERMISSIONS is empty
// server-side), so a permission-gated page can never open for them.
const partnerWithFlags = (gate: Parameters<typeof canAccess>[0]) =>
  canAccess(gate, "channel_partner", () => true);

describe("what a channel partner can see in the sidebar", () => {
  it("shows them their own portal pages", () => {
    // /portal/claims is absent from this list: claims were paused on
    // 2026-08-19, so the entry is locked and there is no page behind it. Its
    // gate is still partnerOnly, which the staff sweep below relies on.
    for (const path of ["/portal/policies", "/portal/renewals",
      "/portal/quotes", "/portal/earnings",
      "/portal/notices"]) {
      const gate = gateForPath(path);
      expect(gate, `${path} is missing from the nav`).toBeDefined();
      expect(asPartner(gate!), path).toBe(true);
    }
  });

  it("no longer shows them a Leads page", () => {
    // Owner 2026-08-03: leads are staff-only for now. The nav entry and the
    // route are both gone; the portal API endpoints survive unreachable so
    // turning it back on is not a rebuild.
    expect(gateForPath("/portal/leads")).toBeUndefined();
  });

  it("shows them the dashboard and their own settings", () => {
    expect(asPartner(gateForPath("/dashboard")!)).toBe(true);
    expect(asPartner(gateForPath("/settings")!)).toBe(true);
  });

  it("hides every staff page, even if they somehow held the flag", () => {
    // The second assertion is the important one: partners are gated by ACCOUNT
    // TYPE, not by permissions, so a stray flag must not open a staff page.
    for (const path of ["/policies", "/customers", "/leads", "/renewals",
      "/finance", "/finance/transactions", "/finance/reports",
      "/finance/balance-sheet", "/finance/tds", "/finance/banks",
      "/people/employees", "/people/partners", "/people/managers",
      "/people/my-partners",
      "/insurers", "/brokers", "/audit", "/documents",
      "/organization?tab=roles"]) {
      const gate = gateForPath(path);
      expect(gate, `${path} is missing from the nav`).toBeDefined();
      expect(asPartner(gate!), `${path} is visible to a partner`).toBe(false);
      expect(partnerWithFlags(gate!),
        `${path} opens for a partner holding flags`).toBe(false);
    }
  });

  it("never shows a partner the agency's own money pages", () => {
    // The ones that would leak house profit, rate cards or another party's
    // balance if they ever rendered.
    for (const path of ["/finance", "/finance/banks", "/finance/reports"])
      expect(asPartner(gateForPath(path)!), path).toBe(false);
  });
});

describe("staff are unaffected by the portal", () => {
  it("hides the partner-only pages from employees and the owner", () => {
    for (const path of ["/portal/policies", "/portal/earnings",
      "/portal/quotes"]) {
      const gate = gateForPath(path)!;
      expect(canAccess(gate, "owner", () => true), path).toBe(false);
      expect(canAccess(gate, "employee", () => true), path).toBe(false);
    }
  });

  it("still lets staff reach the work pages with the right permission", () => {
    const policies = gateForPath("/policies")!;
    expect(canAccess(policies, "employee", (p) => p === "view_policies"))
      .toBe(true);
    expect(canAccess(policies, "employee", () => false)).toBe(false);
  });
});

describe("the new staff pages are gated like their neighbours", () => {
  it("puts Bank & Cash behind its own permission, not the overview", () => {
    const gate = gateForPath("/finance/banks")!;
    expect(gate.anyPerm).toEqual(["view_bank_accounts"]);
    // Someone who runs the finance desk does NOT automatically see how much
    // cash the house is holding — that was the point of a separate flag.
    expect(canAccess(gate, "employee",
      (p) => p === "view_finance_overview")).toBe(false);
    expect(canAccess(gate, "employee", (p) => p === "view_bank_accounts"))
      .toBe(true);
  });

  it("puts Relationship Managers behind view_employees, like the People pages",
    () => {
      // Teams became relationship managers (owner 2026-08-05). Comparing
      // ACROSS managers is a management view and keeps the same gate the
      // staff directory has.
      const gate = gateForPath("/people/managers")!;
      expect(gate.anyPerm).toEqual(["view_employees"]);
      expect(canAccess(gate, "employee", (p) => p === "view_employees")).toBe(true);
      expect(canAccess(gate, "employee", () => false)).toBe(false);
    });

  it("lets any employee open their OWN partner roster", () => {
    // Seeing the partners you personally manage is the job, not a privilege —
    // and the server scopes that endpoint to the caller regardless.
    const gate = gateForPath("/people/my-partners")!;
    expect(canAccess(gate, "employee", () => false)).toBe(true);
    expect(canAccess(gate, "channel_partner", () => true)).toBe(false);
  });

  it("keeps both new pages out of the coming-soon list", () => {
    for (const item of allItems)
      if (item.to === "/finance/banks") expect(item.locked).toBeFalsy();
    for (const child of allItems.flatMap((i) => i.children ?? []))
      if (child.to === "/people/managers") expect(child.locked).toBeFalsy();
  });
});
