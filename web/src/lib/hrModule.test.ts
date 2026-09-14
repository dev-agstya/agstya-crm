// Workplace HR on the client (2026-08-20).
//
// Three things are pinned here, and each one fails SILENTLY if it drifts:
//
//   1. NO MONEY. The owner dropped automated payroll in the same conversation
//      that specified the rest — "remove the salary and the amount being
//      calculated here... no money anywhere in it". A rupee formatter creeping
//      back into an HR screen is the kind of thing nobody notices until it is
//      on somebody's screen claiming a figure the agency never agreed.
//   2. THE DISPLAY RULES LIVE IN ONE PLACE. Five surfaces read a status and
//      were on the way to five copies of "what colour is a half day". This repo
//      has that scar three times over (tone.ts had five implementations of the
//      money sign rule, TargetProgress two of the rounding).
//   3. THE MODULE IS ACTUALLY REACHABLE. A page written, typed and never routed
//      is a feature that ships as a 404 — which is exactly what happened to
//      `quotesApi.markBooked`, which existed, worked, and was called from
//      nowhere in the entire frontend for weeks.

import { describe, expect, it } from "vitest";
import {
  PERMISSION_GROUPS, PERMISSION_IMPLIES, expandPermissions,
} from "./types";
import { NAV, canAccess, gateForPath, lockedFeatureAt } from "./access";
import {
  STATUS_LABELS, balanceTone, formatDays, formatDuration, isOffDay,
  leaveRangeLabel, monthKey, shiftMonth, statusBadge, statusRail,
} from "./hr";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function code(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such file: ${rel}`);
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const HR_FILES = Object.entries(SOURCES).filter(([path]) =>
  (path.includes("/hr/") || path.endsWith("/lib/hr.ts"))
  && !/\.test\.tsx?$/.test(path));

/* ============================================ 1. the money lives in ONE place */
//
// INVERTED ON 2026-08-24, not deleted.
//
// This block used to assert that Workplace HR carried no money at all — the
// owner's instruction on 2026-08-20 ("remove the salary and the amount being
// calculated here... no money anywhere in it"). They reversed it four days
// later and asked for payroll back: "at the end of month, a salary should be
// calculated... so that the owner knows how much to pay each employee."
//
// A test asserting removed behaviour is worse than no test — this repo has the
// scar already (`policyRecordAug04.test.ts` pinned paused-portal copy and
// therefore pinned the BUG in place). So the claim was NARROWED rather than
// dropped, and the narrower claim is the useful one:
//
//   * the REGISTER — attendance, leave, the calendar — still carries no money,
//     so an employee disputing a payslip is disputing a DAY, on a screen they
//     can open;
//   * the payslip screens carry the figures, and nothing else does;
//   * NOBODY ON THE CLIENT COMPUTES PAY. Every rupee on a payslip is a stored
//     figure the server put there. A client-side pay rule would be a second
//     definition of the most consequential number in the app.

describe("Workplace HR keeps the money in one place", () => {
  it("ships the HR screens", () => {
    // If this fails the sweeps below are checking nothing, which is the failure
    // mode a "no X appears anywhere" test always has.
    expect(HR_FILES.length).toBeGreaterThanOrEqual(6);
  });

  // The HR surfaces allowed to render a rupee figure, and why each one is.
  //
  //   PersonHrPanel  the stored salary beside the payable-days count — the one
  //                  screen where "what do they earn" and "how many days did
  //                  they work" are two halves of one question.
  //   PayslipDetail  the payslip itself. It IS a rupee figure.
  //   PayslipsPage   the pay run, and somebody's own list of payslips.
  //   lib/payroll    the display rules for the above (labels, badges, the
  //                  warning sentences). It formats; it does not calculate —
  //                  the arithmetic sweep below applies to it like every other.
  const MONEY_ALLOWED = [
    "/src/components/hr/PersonHrPanel.tsx",
    "/src/components/hr/PayslipDetail.tsx",
    "/src/pages/hr/PayslipsPage.tsx",
    "/src/lib/payroll.ts",
  ];

  it("shows a rupee figure on no HR screen but the payroll ones", () => {
    const offenders = HR_FILES
      .filter(([path]) => !MONEY_ALLOWED.includes(path))
      .filter(([, text]) => /formatINR|formatINRShort|rupeesToPaise|₹/
        .test(text.replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "")))
      .map(([path]) => path);
    expect(offenders, "The attendance and leave register records days and "
      + "hours; money belongs on the payslip screens. Remove it from:\n"
      + offenders.join("\n"))
      .toEqual([]);
  });

  it("never does ARITHMETIC on money, anywhere in the module", () => {
    // UNCHANGED, and now the load-bearing one. The server owns every rupee of
    // the calculation (`services/payroll`); these screens display what arrives.
    // A `salary * days` appearing on the client would be a second pay rule, and
    // the two would disagree within a release — which on a payslip means the
    // figure somebody is shown and the figure they are paid are different.
    //
    // Looks for a money-ish name on either side of a * or / — `salary * days`,
    // `payable_days * rate`, `monthly_salary_paise / 30`.
    const ARITHMETIC =
      /(salary|paise|per_?day|rate)\w*\s*[*/]|[*/]\s*\w*(salary|paise|per_?day)/i;
    const offenders = HR_FILES
      .filter(([, text]) => ARITHMETIC.test(
        text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")))
      .map(([path]) => path);
    expect(offenders, "The client displays pay; the server computes it "
      + "(services/payroll):\n" + offenders.join("\n")).toEqual([]);
  });

  it("ships the payslip page, routed and unlocked", () => {
    // INVERTED: this asserted payslips did not exist. A page written, typed and
    // never routed is a feature that ships as a 404 — which is exactly what
    // happened to `quotesApi.markBooked`, which existed, worked, and was called
    // from nowhere in the entire frontend for weeks.
    expect(Object.keys(SOURCES)).toContain("/src/pages/hr/PayslipsPage.tsx");
    expect(lockedFeatureAt("/hr/payslips")).toBeUndefined();
    expect(gateForPath("/hr/payslips")?.employeeAny).toBe(true);
  });

  it("puts the payroll display rules in ONE file", () => {
    // Four surfaces read a payslip — the employee's own list, the pay run, the
    // HR tab and the dashboard strip — and were on the way to four answers to
    // "what colour is a finalised payslip". `lib/tone.ts` once had five
    // implementations of the money sign rule, in three different greens.
    const payroll = code("lib/payroll.ts");
    expect(payroll).toContain("PAYSLIP_STATUS_LABELS");
    expect(payroll).toContain("payslipBadge");
    for (const consumer of ["pages/hr/PayslipsPage.tsx",
      "components/hr/PayslipDetail.tsx",
      "components/hr/PersonHrPanel.tsx"]) {
      expect(code(consumer), consumer + " must read lib/payroll")
        .toContain("lib/payroll");
    }
  });
  it("keeps the ATTENDANCE summary in days and hours", () => {
    // The type IS the contract with the server. A money field appearing here
    // would mean one appeared there.
    const types = code("lib/types.ts");
    const summary = types.slice(
      types.indexOf("export interface AttendanceSummary"),
      types.indexOf("export interface AttendanceMonth"));
    expect(summary).toContain("payable_days");
    for (const banned of ["paise", "salary", "amount", "deduction_"]) {
      expect(summary.toLowerCase(),
        `${banned} is back in the attendance summary`).not.toContain(banned);
    }
  });

  it("stores a salary on the employee profile", () => {
    // The INPUT to a payslip since 2026-08-24. It was a reference figure for
    // four days; it is now what the per-day rate is derived from, which is why
    // the Add-employee form requires it and the pay run names anybody who is
    // missing one.
    const types = code("lib/types.ts");
    expect(types).toContain("monthly_salary_paise");
    // The dead annual field, which no editor in the app ever wrote.
    expect(types).not.toContain("salary_ctc?:");
  });
});

/* ================================================== 2. one set of rules === */

describe("the HR display rules have exactly one home", () => {
  it("gives every attendance status a label", () => {
    // A status with no label renders as `undefined` in a badge — no error, no
    // crash, just a chip saying nothing on somebody's register.
    for (const s of ["present", "half_day", "absent", "on_leave",
      "leave_unpaid", "week_off", "holiday", "wfh", "not_marked"] as const) {
      expect(STATUS_LABELS[s], s).toBeTruthy();
    }
  });

  it("never calls an unresolved day 'absent'", () => {
    // THE distinction the whole module rests on. "We have not been told" and
    // "they did not come" are different facts, and only the second costs
    // somebody a day.
    expect(STATUS_LABELS.not_marked.toLowerCase()).not.toContain("absent");
    expect(statusRail("not_marked")).toBeUndefined();
  });

  it("colours a badge only where the day means something", () => {
    expect(statusBadge("present")).toBe("badge-in");
    expect(statusBadge("wfh")).toBe("badge-in");
    expect(statusBadge("absent")).toBe("badge-out");
    expect(statusBadge("leave_unpaid")).toBe("badge-out");
    expect(statusBadge("half_day")).toBe("badge-due");
    // The important greys: the office being shut is not an achievement and not
    // a failure, and colouring it leaves a calendar where nothing stands out.
    expect(statusBadge("week_off")).toBe("badge-neutral");
    expect(statusBadge("holiday")).toBe("badge-neutral");
  });

  it("puts urgency on the left edge, and only where somebody must act", () => {
    // The ledger rule (2026-08-07): forty rows with three amber edges reads
    // instantly; forty rows with a chip on each does not.
    expect(statusRail("absent")).toBe("out");
    expect(statusRail("leave_unpaid")).toBe("out");
    expect(statusRail("half_day")).toBe("due");
    expect(statusRail("present")).toBeUndefined();
    expect(statusRail("week_off")).toBeUndefined();
    // A missed punch-out outranks whatever the day computed to — it is the one
    // thing that needs a decision before the month can be trusted.
    expect(statusRail("present", { missedPunchOut: true })).toBe("due");
  });

  it("knows which days the office was never open", () => {
    expect(isOffDay("week_off")).toBe(true);
    expect(isOffDay("holiday")).toBe(true);
    expect(isOffDay("absent")).toBe(false);
  });

  it("writes a duration the way a person says it", () => {
    expect(formatDuration(492)).toBe("8h 12m");
    expect(formatDuration(480)).toBe("8h");
    expect(formatDuration(45)).toBe("45m");
    // An absent value is an em-dash, never a confident zero — the same rule
    // formatINR follows and that thirteen call sites once defeated.
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(0)).toBe("—");
  });

  it("prints leave in halves, and gets the plural right", () => {
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(2)).toBe("2 days");
    expect(formatDays(0.5)).toBe("0.5 days");
    expect(formatDays(1.5)).toBe("1.5 days");
    // Zero is a real answer, and "0 days" is what somebody with none left has.
    expect(formatDays(0)).toBe("0 days");
    expect(formatDays(null)).toBe("—");
  });

  it("treats a zero balance as a warning, not a failure", () => {
    // The same trap `moneyTone` exists for: a two-branch `< 0 ? out : in`
    // sends zero down the good branch. Here zero means "your next leave is
    // unpaid", which is worth knowing BEFORE you apply.
    expect(balanceTone(3)).toBe("in");
    expect(balanceTone(0)).toBe("due");
    expect(balanceTone(-1)).toBe("out");
  });

  it("says a single-day leave once, not twice", () => {
    expect(leaveRangeLabel("2026-08-13", "2026-08-13", "full"))
      .not.toContain("–");
    expect(leaveRangeLabel("2026-08-13", "2026-08-13", "first_half"))
      .toContain("First half");
    expect(leaveRangeLabel("2026-08-13", "2026-08-17", "full"))
      .toContain("–");
  });

  it("walks months across a year boundary", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthKey(new Date(2026, 7, 13))).toBe("2026-08");
  });

  it("keeps the status vocabulary in lib/hr and nowhere else", () => {
    // Five surfaces read a status. The moment a second file writes its own
    // switch on "half_day", the two disagree about a colour and only one of
    // them gets fixed.
    const offenders = HR_FILES
      .filter(([path]) => !path.endsWith("/lib/hr.ts"))
      .filter(([, text]) => /badge-(in|out|due)["`\s]/.test(
        text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      ) && /case\s+"(present|half_day|absent)"/.test(text))
      .map(([path]) => path);
    expect(offenders, "Import statusBadge from lib/hr instead of switching on "
      + "the status again in:\n" + offenders.join("\n")).toEqual([]);
  });
});

/* ================================================= 3. actually reachable === */

describe("the HR pages are reachable", () => {
  const app = code("App.tsx");

  it("routes all three live pages", () => {
    // A page written and never routed is a 404 with a component behind it.
    for (const path of ["/hr/attendance", "/hr/leave", "/hr/holidays"]) {
      expect(app, `${path} has no <Route>`).toContain(`path="${path}"`);
    }
  });

  it("shows them in the sidebar to every employee", () => {
    const items = NAV.flatMap((s) => s.items);
    for (const to of ["/hr/attendance", "/hr/leave", "/hr/holidays"]) {
      const item = items.find((i) => i.to === to)!;
      expect(item, `${to} is not in the nav`).toBeTruthy();
      expect(item.locked, `${to} is still locked`).toBeFalsy();
      expect(canAccess(item, "employee", () => false)).toBe(true);
    }
  });

  it("keeps channel partners out of every HR page", () => {
    // They are external, are not paid a salary by the agency, and are not
    // covered by the module at all (owner A10). The server refuses them at
    // router level; this is the UX half.
    for (const path of ["/hr/attendance", "/hr/leave", "/hr/holidays",
      "/settings/attendance"]) {
      expect(canAccess(gateForPath(path)!, "channel_partner", () => true),
        `${path} is open to a partner`).toBe(false);
    }
  });

  it("gates the policy screen to the owner and routes it", () => {
    // Reached from Settings, not the sidebar — but a typed URL must not open a
    // form that will 403 on save.
    const gate = gateForPath("/settings/attendance")!;
    expect(gate.ownerOnly).toBe(true);
    expect(canAccess(gate, "employee", () => true)).toBe(false);
    expect(app).toContain('path="/settings/attendance"');
    expect(code("pages/SettingsPage.tsx")).toContain("/settings/attendance");
  });

  it("calls every HR endpoint it defines", () => {
    // `quotesApi.markBooked` existed, worked, and was called from NOWHERE in
    // the entire frontend — so accepted quotes sat there for weeks and nobody
    // saw an error. This sweeps for the same shape.
    const endpoints = code("api/endpoints.ts");
    const apis = ["attendanceApi", "leaveApi", "holidaysApi"];
    const app_src = Object.entries(SOURCES)
      .filter(([p]) => !p.endsWith("api/endpoints.ts")
        && !/\.test\.tsx?$/.test(p))
      .map(([, t]) => t).join("\n");

    for (const api of apis) {
      expect(endpoints, `${api} is not defined`).toContain(`export const ${api}`);
      const block = endpoints.slice(endpoints.indexOf(`export const ${api}`));
      const body = block.slice(0, block.indexOf("\n};"));
      const methods = [...body.matchAll(/^\s{2}(\w+):\s*\(/gm)].map((m) => m[1]);
      expect(methods.length, `${api} has no methods`).toBeGreaterThan(2);
      const unused = methods.filter((m) => !app_src.includes(`${api}.${m}`));
      expect(unused, `${api} defines methods nothing calls: ${unused.join(", ")}`)
        .toEqual([]);
    }
  });
});

/* ====================================================== the permissions === */

describe("the HR permissions", () => {
  it("offers one pair per HR page, plus salary standing alone", () => {
    const keys = PERMISSION_GROUPS.flatMap((g) =>
      g.sections.flatMap((s) => [s.view, s.manage].filter(Boolean) as string[]));
    for (const flag of ["view_attendance", "manage_attendance", "view_leave",
      "manage_leave", "view_holidays", "manage_holidays",
      "view_payslips", "manage_payslips", "view_salary"]) {
      expect(keys, `${flag} is not grantable`).toContain(flag);
    }
    expect(keys).not.toContain("manage_salary");
  });

  it("applies the same implications the server does", () => {
    // The editor is only honest if the client expands a set exactly as
    // core/permissions.py does. If these drift, somebody ticks one thing and a
    // different set gets saved.
    expect(PERMISSION_IMPLIES.manage_attendance).toEqual(["view_attendance"]);
    expect(PERMISSION_IMPLIES.manage_leave).toEqual(["view_leave"]);
    expect(PERMISSION_IMPLIES.manage_holidays).toEqual(["view_holidays"]);
    expect(expandPermissions(["manage_leave"]).sort())
      .toEqual(["manage_leave", "view_leave"]);
  });

  it("says in the group hint that your own needs no flag", () => {
    // Without it the flag names read as though nobody can clock in until an
    // owner ticks something — which would be the wrong thing to grant, and the
    // owner would grant it.
    const group = PERMISSION_GROUPS.find((g) => g.group === "Workplace HR")!;
    expect(group).toBeTruthy();
    expect(group.hint.toLowerCase()).toContain("own");
  });

  it("draws the manage-only controls from the manage flag", () => {
    // Opening a page is not owning it: `PersonDetailBody` already draws no
    // Edit/Delete button without the flag rather than one that 403s, and the
    // HR pages follow the same rule.
    const attendance = code("pages/hr/AttendancePage.tsx");
    expect(attendance).toContain('has("manage_attendance")');
    expect(attendance).toContain('has("view_attendance")');
    const leave = code("pages/hr/LeavePage.tsx");
    expect(leave).toContain('has("manage_leave")');
    expect(leave).toContain('has("view_leave")');
    const holidays = code("pages/hr/HolidaysPage.tsx");
    expect(holidays).toContain('has("manage_holidays")');
  });
});

/* ============================================== the punch panel's clock === */

describe("the punch clock reads the SERVER's time", () => {
  it("takes server_now from the payload rather than trusting the browser", () => {
    // A laptop eleven minutes fast would otherwise display eleven minutes of
    // work the register does not have — and the first person to notice the tile
    // and the month disagreeing would be right to distrust the whole screen.
    const types = code("lib/types.ts");
    const punch = types.slice(types.indexOf("export interface PunchState"),
      types.indexOf("export interface AttendanceDay"));
    expect(punch).toContain("server_now");

    const panel = code("components/hr/PunchPanel.tsx");
    expect(panel).toContain("server_now");
    expect(panel).toContain("offset");
  });

  it("never offers a punch for a date or a person", () => {
    // A backdated or delegated self-punch is an attendance system that records
    // nothing (owner C3/C6). The API surface having no parameter is the
    // safeguard — a check in the body could be removed by somebody who did not
    // know why it was there.
    const endpoints = code("api/endpoints.ts");
    const block = endpoints.slice(endpoints.indexOf("export const attendanceApi"));
    const punches = block.slice(0, block.indexOf("month:"));
    expect(punches).not.toContain("user_id");
    // A PARAMETER named `day`, not the substring — `today:` ends in "day:" and
    // a bare `toContain` fires on the endpoint whose whole job is "my own
    // today". A guard that cries wolf on correct code is one people edit around.
    expect(punches, "a punch endpoint takes a date")
      .not.toMatch(/\bday\s*\??\s*:/);
  });
});

/* ==================================================== 4. where, not just when */

describe("location-based attendance", () => {
  /*
    Owner 2026-08-21: "HMWQ+FQ Udaipur, Rajasthan is the location of this
    office, so if the user clicks on login from this location it should be
    marked as present, if user is not in this location and marks the attendance
    it should be marked as work from home attendance… allowed radius from this
    should be 150m."

    The rule itself is server-side and pinned by tests/test_hr_geofence.py.
    What is pinned HERE is the client's half of the contract, which has three
    ways to go quietly wrong.
  */

  it("reports a position and never a verdict", () => {
    /*
      THE SECURITY-SHAPED ONE. The browser says where it thinks it is; the
      server decides what that means. A client that computes "I am at the
      office" and posts a status is not a control, it is a suggestion box — so
      lib/geo must contain no office coordinate, no radius, and no comparison.
    */
    const geo = code("lib/geo.ts");
    expect(geo).not.toMatch(/office|radius|distance|haversine/i);
    expect(geo).not.toMatch(/\bremote\b|\bwfh\b/i);
    // What it DOES send: a position and how sure it is.
    expect(geo).toContain("lat");
    expect(geo).toContain("lng");
    expect(geo).toContain("accuracy_m");
  });

  it("never lets a location failure block the punch", () => {
    /*
      Denied permission, no GPS, a timeout, an insecure context — all resolve to
      null and the punch goes ahead. An attendance system that will not let
      somebody clock in because a browser ate a permission prompt is worse than
      one that records the day and flags it.
    */
    const geo = code("lib/geo.ts");
    expect(geo).not.toContain("reject(");
    expect(geo).not.toContain("throw ");
    // The error callback resolves rather than raising.
    expect(geo).toMatch(/done\(null\)/);
  });

  it("has a timeout of its own, not just the browser's", () => {
    // A denied permission on some Android WebViews never calls back at all;
    // without a belt the clock-in button would spin for ever.
    const geo = code("lib/geo.ts");
    expect(geo).toContain("setTimeout");
    expect(geo).toContain("timeout:");
  });

  it("only asks for a location when the agency actually uses one", () => {
    // A permission prompt with nothing behind it teaches people to press Block,
    // and then the feature is dead on the day it IS switched on.
    expect(code("components/hr/PunchTile.tsx"))
      .toMatch(/geofence\.enabled\s*\?\s*await currentFix\(\)/);
  });

  it("tells the employee where the day was recorded", () => {
    // Finding out at month end, from a register they cannot edit, is how this
    // feature would CREATE correction requests instead of removing them.
    const tile = code("components/hr/PunchTile.tsx");
    expect(tile).toContain("work from home");
    expect(tile).toContain("LOCATION_LABELS");
  });

  it("warns before the button, not after the fact", () => {
    expect(code("components/hr/PunchTile.tsx"))
      .toMatch(/!d\.clock_in && d\.geofence\.enabled/);
  });

  it("keeps the location labels in lib/hr with every other display rule", () => {
    // Same rule as every other HR label: one home, or "Work from home" becomes
    // "WFH" on the screen next door. `cellTone` already left this scar once.
    const local = HR_FILES.filter(([path, text]) =>
      !path.endsWith("/lib/hr.ts")
      && /LOCATION_LABELS\s*[:=]\s*\{/.test(text));
    expect(local.map(([p]) => p), "a second copy of the location labels")
      .toEqual([]);
  });

  it("colours a work location grey, because it is neither money nor time", () => {
    // A badge earns colour by meaning money or meaning time (2026-08-06).
    // Remote in amber would read as a warning about a full, ordinary, paid day.
    expect(code("lib/hr.ts")).toMatch(
      /export function locationBadge[\s\S]{0,220}?badge-neutral/);
  });

  it("adds no money to the module on the way in", () => {
    // The geofence speaks in metres. The no-money sweep above covers lib/hr.ts
    // and the hr/ components; this states the intent for the new file too.
    expect(code("lib/geo.ts")).not.toMatch(/formatINR|paise|salary|₹/);
  });

  it("lets the owner check the pin before switching the check on", () => {
    /*
      The single most dangerous setting on the page. A centre wrong by a few
      hundred metres marks the entire office work-from-home and nothing on any
      screen would explain why — so the page has to offer a way to LOOK at the
      point rather than trusting six decimal places typed into a box.
    */
    const page = code("pages/settings/AttendanceSettingsPage.tsx");
    expect(page).toContain("google.com/maps");
    expect(page).toContain("office_lat");
    expect(page).toContain("office_lng");
    expect(page).toContain("office_radius_m");
  });

  it("says the location setting is NOT retroactive, unlike the rest", () => {
    // Everything else on that page applies to past months because statuses are
    // derived. `work_location` is stamped at clock-in and is not — and a switch
    // that silently re-labelled three months of office days would be
    // unrecoverable.
    const page = code("pages/settings/AttendanceSettingsPage.tsx");
    expect(page).toMatch(/only affects days\s*\n?\s*from now on/);
  });
});
