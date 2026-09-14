// The nav config is the single source of truth for which pages exist, which are
// locked, and who may open them. These tests pin the parts that are easy to
// break by accident.

import { describe, expect, it } from "vitest";
import { LOCKED_PATHS, NAV, canAccess, gateForPath, lockedFeatureAt } from "./access";

const allItems = NAV.flatMap((s) => s.items);
const targets = allItems.find((i) => i.to === "/targets")!;

describe("Targets is live again (owner 2026-08-07)", () => {
  // Paused on 2026-07-26 because the page it replaced was a spreadsheet of bare
  // number inputs. Rebuilt as a roster you click a person on — which is what
  // the owner's note at the time actually asked for — and unlocked with it.
  it("appears in the sidebar as a real destination", () => {
    expect(targets).toBeDefined();
    expect(targets.locked).toBeFalsy();
    expect(targets.label).toBe("Targets");
  });

  it("is no longer treated as coming-soon by the router catch-all", () => {
    // A locked path has NO route, so leaving it here would send every visitor
    // to the "not built yet" screen over a page that now exists.
    expect(lockedFeatureAt("/targets")).toBeUndefined();
    expect(LOCKED_PATHS["/targets"]).toBeUndefined();
  });

  // INVERTED 2026-08-21, for the same reason as the HR entries below.
  //
  // This asserted `anyPerm: ["view_targets", "manage_targets"]` — and that gate
  // was the bug the owner reported: "where does the employee see their own
  // assigned targets? or how does the employee give targets to the channel
  // partner under it". Both already worked. Their number was on the dashboard,
  // and the server has let a relationship manager set their own roster's
  // targets without `manage_targets` since owner F1 in July. What did not work
  // was FINDING either, because the one entry in the sidebar actually called
  // "Targets" was hidden from exactly the people carrying them.
  //
  // Leaving this test as it was would have pinned the feature OFF — the failure
  // mode this repo has already shipped once, when a test asserting the paused
  // partner-portal copy kept a real bug in place with the suite fully green.
  it("opens to every employee, and scopes itself instead", () => {
    const gate = gateForPath("/targets")!;
    // No permission at all. Being told your own number is not a privilege —
    // the same rule the HR entries follow.
    expect(canAccess(gate, "employee", () => false)).toBe(true);
    expect(canAccess(gate, "owner", () => false)).toBe(true);
    expect(canAccess(gate, "employee", (p) => p === "manage_targets")).toBe(true);
    // The flags did not stop meaning anything: they decide WHOSE numbers you
    // read once you are on the page (pages/TargetsPage branches on them, and
    // GET /api/targets/performance refuses a caller without one).
    expect(gate.anyPerm).toBeUndefined();
    expect(gate.employeeAny).toBe(true);
  });

  it("stays closed to channel partners", () => {
    // A staff page. Partners read their own target in the portal
    // (GET /api/portal/target); every staff router is shut to them at router
    // level, so opening this one to employees must not reach them.
    expect(canAccess(gateForPath("/targets")!, "channel_partner", () => false))
      .toBe(false);
  });

  // INVERTED 2026-08-20. This asserted that Attendance, Leave and Holidays were
  // locked, which was true for as long as they were unbuilt. They shipped, so
  // the test asserts what is true now — leaving it as it was would have been a
  // test pinning the feature OFF, which is exactly the failure mode this repo
  // has already shipped once (a test asserting the paused partner-portal copy
  // kept a real bug in place while the whole suite stayed green).
  it("opens Attendance, Leave and Holidays to every employee", () => {
    for (const path of ["/hr/attendance", "/hr/leave", "/hr/holidays"]) {
      expect(lockedFeatureAt(path), `${path} is still locked`).toBeUndefined();
      const gate = gateForPath(path)!;
      expect(gate).toBeTruthy();
      // No permission at all. Everybody reaches their OWN attendance, their own
      // leave and the holiday list — the rule targets already follow. The
      // `view_*` flags decide whose numbers you may read once you are on the
      // page, and the server scopes every query to the caller without them.
      expect(canAccess(gate, "employee", () => false)).toBe(true);
      expect(canAccess(gate, "owner", () => false)).toBe(true);
      // Channel partners are external and are not covered by the module at all.
      expect(canAccess(gate, "channel_partner", () => false)).toBe(false);
    }
  });

  it("opens Payslips to every employee, with no flag", () => {
    // INVERTED on 2026-08-24, not deleted. This asserted that Payslips stayed
    // LOCKED, from the owner's 2026-08-20 instruction to drop the calculation —
    // and they reversed it four days later: "at the end of month, a salary
    // should be calculated... so that the owner knows how much to pay each
    // employee."
    //
    // A test that goes on asserting the absence of a shipped feature is a
    // permanently red suite, which teaches people to ignore red. This repo has
    // the sharper version of that scar too: `policyRecordAug04.test.ts` was
    // asserting paused-portal copy, so it PINNED THE BUG in place.
    //
    // `employeeAny`, like Attendance and Leave, for the reason those two are:
    // everybody reaches their OWN payslip. Being told what you are owed is not
    // a privilege — and this is the clearest case of that rule in the app.
    expect(lockedFeatureAt("/hr/payslips")).toBeUndefined();
    const gate = gateForPath("/hr/payslips")!;
    expect(gate.employeeAny).toBe(true);
    expect(canAccess(gate, "employee", () => false)).toBe(true);
    expect(canAccess(gate, "owner", () => false)).toBe(true);
    // Channel partners are external, are not paid a salary by the agency, and
    // are not covered by the HR module at all.
    expect(canAccess(gate, "channel_partner", () => false)).toBe(false);
  });
});

describe("the pages targets are actually managed from stay open", () => {
  // Setting a target happens in TargetsModal, opened from these two pages —
  // locking the browsing page must not touch that path.
  it("leaves Employees and Channel Partners unlocked", () => {
    // The People group's own `to` moved to /people/partners on 2026-08-06:
    // an employee without view_employees sees only the Channel Partners child, so
    // the parent had to land somewhere they can actually open.
    //
    // Partner Notices is the one deliberate exception since 2026-09-12 (owner:
    // paused the same way as Third Party Services) — everything ELSE under
    // People must stay open.
    const people = allItems.find((i) => i.label === "People")!;
    expect(people.locked).toBeFalsy();
    for (const child of people.children ?? []) {
      if (child.label === "Partner Notices") continue;
      expect(child.locked).toBeFalsy();
    }
    expect(lockedFeatureAt("/people/employees")).toBeUndefined();
    expect(lockedFeatureAt("/people/partners")).toBeUndefined();
  });

  it("lets an employee with no view_partners reach Channel Partners", () => {
    // Owner G1 (2026-08-06). The page is where a relationship manager works,
    // and view_employees is the STAFF DIRECTORY right — gating one on the other
    // locked employees out of their own roster. The server scopes the list.
    const employeeOnly = () => false;
    expect(canAccess(gateForPath("/people/partners")!, "employee",
                     employeeOnly)).toBe(true);
    // ...and the parent group, or the child is unreachable in the sidebar.
    const people = allItems.find((i) => i.label === "People")!;
    expect(canAccess(people, "employee", employeeOnly)).toBe(true);
    // The staff directory itself stays behind view_employees.
    expect(canAccess(gateForPath("/people/employees")!, "employee",
                     employeeOnly)).toBe(false);
    // And so does ADDING a partner (owner G3): you work your roster, the
    // agency decides who joins it.
    expect(canAccess(gateForPath("/people/partners/new")!, "employee",
                     employeeOnly)).toBe(false);
    expect(canAccess(gateForPath("/people/partners/new")!, "employee",
                     (p) => p === "manage_partners")).toBe(true);
  });

  it("keeps a channel partner out of the staff People pages", () => {
    // `employeeAny` must never read as "anyone signed in".
    for (const path of ["/people/partners", "/people/employees",
      "/people/partners/new"]) {
      expect(canAccess(gateForPath(path)!, "channel_partner", () => true))
        .toBe(false);
    }
  });

  it("leaves the dashboard open — that is where the progress tile lives", () => {
    expect(lockedFeatureAt("/dashboard")).toBeUndefined();
  });
});

describe("Partner Notices is PAUSED (owner 2026-09-12)", () => {
  // Same arrangement as Claims / Third Party Services: no route behind it,
  // nav entry kept visible with a lock so people can see it's coming rather
  // than have it silently vanish.
  it("is locked in the People nav, and by prefix match on both its routes", () => {
    const people = allItems.find((i) => i.label === "People")!;
    const notices = people.children!.find((c) => c.label === "Partner Notices")!;
    expect(notices.locked).toBe(true);
    expect(lockedFeatureAt("/people/notices")).toBe("Partner Notices");
    // The composer is a child route with no NAV entry of its own — it must
    // still be caught by the PREFIX match, or a bookmark to it would slip
    // straight past the lock and open a page with no route behind it.
    expect(lockedFeatureAt("/people/notices/new")).toBe("Partner Notices");
  });

  it("keeps view/manage_announcements dormant rather than removing them", () => {
    // Re-enabling later is deleting `locked: true` — deleting the permission
    // pair too would mean nobody has it granted when that day comes.
    const people = allItems.find((i) => i.label === "People")!;
    const notices = people.children!.find((c) => c.label === "Partner Notices")!;
    expect(notices.anyPerm).toEqual(["view_announcements"]);
  });

  it("does not touch the partner-side portal notices route", () => {
    // "Partner Notices" is the STAFF broadcast composer/list. The partner's
    // own portal inbox (reading notices already sent to them) is a separate
    // route this pause deliberately leaves alone.
    expect(lockedFeatureAt("/portal/notices")).toBeUndefined();
  });
});

describe("nav config sanity", () => {
  it("has no duplicate destinations", () => {
    const paths = allItems.map((i) => i.to.split("?")[0]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gives every item a label, icon and gate", () => {
    for (const item of allItems) {
      expect(item.label).toBeTruthy();
      expect(item.icon).toBeTruthy();
      const gated = item.ownerOnly || item.partnerOnly || item.partner
        || item.employeeAny || item.anyPerm;
      expect(gated, `${item.to} has no gate`).toBeTruthy();
    }
  });

  it("owner sees everything that isn't partner-only", () => {
    for (const item of allItems)
      if (!item.partnerOnly)
        expect(canAccess(item, "owner", () => false), item.to).toBe(true);
  });
});
