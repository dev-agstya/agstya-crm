// Three home pages, not one with things hidden (owner 2026-08-06).
//
// The dashboard was one board with permission checks sprinkled through it, so
// every account got the same shape of screen with holes in it. The owner's
// answer to "what should each person see" was three different lists, in three
// different orders, and that is what these pin:
//
//   owner     money -> book -> growth -> the team's target -> who is carrying it
//   employee  my target -> my team -> my queue -> money (only if permitted)
//   partner   money -> my target -> tiles (pages/portal/PortalHome)
//
// Read the SOURCE rather than rendering, like the other sweep tests: what is
// being protected is an ORDER and an omission, and a render test would have to
// stand up half the app plus a fake server to observe either.

import { describe, expect, it } from "vitest";
import { canAccess, gateForPath } from "./access";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such source file: ${rel}`);
  return text;
}

/** Source with comments stripped — these files EXPLAIN what they leave out. */
function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const dash = () => code("pages/DashboardPage.tsx");

/** The body of one named function, up to the next top-level `function`. */
function block(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  expect(start, `no function ${name}`).toBeGreaterThan(-1);
  const next = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/* ------------------------------------------------------------- the owner --- */

describe("the owner's board", () => {
  const owner = () => block(dash(), "OwnerBoard");

  it("leads with money, then the book, then growth (owner C1)", () => {
    const src = owner();
    const order = ["MoneyTiles", "Policies done", "Renewals due",
      "ProfitTiles"];
    let cursor = -1;
    for (const marker of order) {
      const at = src.indexOf(marker);
      expect(at, `${marker} missing from the owner's board`)
        .toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("is TILES ONLY — no target card, no leaderboard (owner 2026-08-07)", () => {
    // INVERTED, not deleted. This used to assert both blocks sat below the
    // tiles. The owner's verdict on seeing them running was that neither
    // belongs on a home screen: a league table is something you go and study,
    // not something you glance at forty times a day, and the two of them
    // pushed the figures — the actual answer to "how are we doing" — into the
    // top strip of the viewport.
    //
    // Neither is lost. The team's target is the Targets page; the ranking is
    // the Performance view of Employees.
    const src = owner();
    expect(src).not.toContain("<TargetProgressCard />");
    expect(src).not.toContain("<TopPerformers />");
    // The tiles themselves are still the whole board.
    expect(src).toContain("MoneyTiles");
    expect(src).toContain("ProfitTiles");
  });

  it("leads with NUMBERS, not a slogan (owner 2026-08-06, reversed)", () => {
    // REVERSED. On 6 Aug the owner was asked whether numbers should come first
    // and said no, keep the big centred hero. Screenshotting the running app
    // changed the answer: the hero was a RANDOMLY CHOSEN slogan — "Guarding
    // What Matters Most." — set in the largest type on the page, claiming the
    // full viewport height with `flex-1`, so every actual figure sat below the
    // fold and the text changed on each reload. Shown that, the owner's verdict
    // was that it was the worst thing in the app.
    //
    // What replaced it is a one-line header: the page name + date on the left,
    // search on the right. So the assertion inverts — the centred hero must
    // NOT come back, and the slogan array must stay deleted.
    //
    // AMENDED 2026-08-07. This asserted `<h1 ...>{greeting(` and had been RED
    // since the pass it was written in: the greeting went the same day for the
    // same reason as the slogan — somebody who opens this screen forty times a
    // day is not here to be welcomed — and the test kept pinning it. A test
    // asserting removed copy is worse than no test, so it now asserts the
    // heading is the PAGE, not a salutation.
    const src = dash();
    expect(src).not.toContain("flex flex-1 flex-col items-center justify-center");
    expect(src).not.toContain("SLOGANS");
    expect(src).not.toContain("Guarding What Matters Most");
    expect(src).not.toContain("greeting(");
    // The heading names the page, and the line under it says what day it is —
    // which is the "as of" for every figure below.
    expect(src).toMatch(/<h1 className="text-page-title[^"]*">Dashboard<\/h1>/);
    expect(src).toContain("const today = useMemo");
  });

  it("does not put a decorative animation on the search box", () => {
    // 62 lines used to type six phrases out character-by-character, forever,
    // ending on "Search anything!". Motion that communicates no state, on the
    // screen its owner opens most — and it smuggled the slogan back in through
    // the `placeholder` attribute after the slogan itself was removed.
    const src = dash();
    expect(src).not.toContain("useTypingPlaceholder");
    expect(src).not.toContain("SEARCH_PHRASES");
    expect(src).not.toContain("Search anything!");
  });

  it("does not mark a static figure up as a disabled button", () => {
    // Every tile was `<button disabled={!onClick}>`, so a screen reader
    // announced the headline figure of the business as "dimmed button" and it
    // left the tab order. A tile that does not navigate is a div.
    expect(dash()).not.toContain("disabled={!onClick}");
  });

  it("gives every tile the same anatomy", () => {
    // Net Profit and Growth were bespoke cards with their own label casing,
    // value size and padding, so row 3 of the owner's board visibly did not
    // belong to the same set as rows 1-2.
    const src = dash();
    expect(src).toContain("function MetricCard");
    // The two former one-offs now go through it (Growth keeps the frame and
    // swaps only its value row, because it is two figures rather than one).
    expect(block(src, "ProfitTiles")).toContain("<MetricCard label=\"Net profit\"");
    expect(block(src, "ProfitTiles")).toContain("text-caption uppercase");
  });

  it("puts six tiles in a grid that divides by six", () => {
    // Four columns left two orphans on the last row, which reads as a mistake.
    expect(dash()).toContain("grid-cols-2 gap-3 lg:grid-cols-3");
  });

  it("has no top-performers block at all any more (owner 2026-08-07)", () => {
    // Was: "three, not a leaderboard". The answer is now none — see the note
    // on the owner's board above. Ranking people lives on the Employees page.
    expect(dash()).not.toContain("function TopPerformers");
  });

  it("does not put a personal follow-up queue on the owner's home page", () => {
    expect(owner()).not.toContain("Follow-ups");
    expect(owner()).not.toContain("MyTeamBlock");
  });
});

/* ---------------------------------------------------------- the employee --- */

describe("the employee's board", () => {
  const employee = () => block(dash(), "EmployeeBoard");

  it("leads with their own target, then their team (owner D1)", () => {
    const src = employee();
    const target = src.indexOf("<TargetProgressCard />");
    const team = src.indexOf("<MyTeamBlock />");
    const tiles = src.indexOf("My policies");
    expect(target).toBeGreaterThan(-1);
    expect(team).toBeGreaterThan(target);
    expect(tiles).toBeGreaterThan(team);
  });

  it("puts money LAST, and only with the permission for it", () => {
    // An executive who cannot open the finance pages has no use for the
    // agency's receivables at the top of their home screen.
    const src = employee();
    expect(src.indexOf("MoneyTiles"))
      .toBeGreaterThan(src.indexOf("Follow-ups"));
    expect(src).toMatch(/canFinance && <MoneyTiles/);
    expect(src).toMatch(/canProfit && <ProfitTiles/);
  });

  it("lists five partners, worst first (owner D2)", () => {
    expect(dash()).toContain("const TEAM_PREVIEW = 5");
    const team = block(dash(), "MyTeamBlock");
    expect(team).toContain("slice(0, TEAM_PREVIEW)");
    // Ascending attainment = worst first; no target at all sorts above all of
    // them, because a partner nobody has given a number to is the bigger gap.
    expect(team).toContain("a.attainment_pct - b.attainment_pct");
    expect(team).toContain("a.has_target !== b.has_target");
  });

  it("hides the team block entirely when they manage nobody (owner D3)", () => {
    // An empty card on a home page teaches people to stop looking at the page.
    expect(block(dash(), "MyTeamBlock")).toContain("d.partners === 0) return null");
  });

  it("says so when no target has been set, rather than vanishing (owner D4)", () => {
    expect(block(dash(), "TargetProgressCard"))
      .toContain("No target has been set for");
  });
});

/* ------------------------------------------------- one drawing, five uses --- */

describe("target progress is drawn in exactly one place", () => {
  it("gives every surface the same component", () => {
    for (const file of ["pages/DashboardPage.tsx",
      "pages/portal/PortalHome.tsx",
      "components/ManagerRosterPanel.tsx",
      "pages/people/PartnerRoster.tsx",
      "components/TargetsBody.tsx"]) {
      expect(code(file), file).toMatch(/from "[^"]*\/TargetProgress"/);
    }
  });

  it("rounds a percentage the same way everywhere", () => {
    // 99.6% read as "100%" on one screen and "99%" on the next while two files
    // each had their own Math.round. One helper owns it now.
    expect(code("components/TargetProgress.tsx"))
      .toContain("export const pctLabel");
    for (const file of ["pages/DashboardPage.tsx", "components/TargetsBody.tsx",
      "pages/people/PartnerRoster.tsx", "pages/portal/PortalHome.tsx"]) {
      expect(code(file), `${file} rounds its own percentage`)
        .not.toMatch(/Math\.round\((?:d|t|r|m)\.attainment_pct\)/);
    }
  });

  it("uses one three-state colour rule, not a ramp per file", () => {
    const tp = code("components/TargetProgress.tsx");
    expect(tp).toContain("export function toneFor");
    expect(tp).toMatch(/pct >= 100/);
    expect(tp).toMatch(/pct >= 70/);
  });
});

/* ---------------------------------------------------------- the partner ---- */

describe("the channel partner's home", () => {
  it("is the portal, never a trimmed staff dashboard", () => {
    expect(dash()).toContain('account_type === "channel_partner"');
    expect(dash()).toContain("<PortalHome />");
  });

  it("offers this month and the two before it (owner E3)", () => {
    const home = code("pages/portal/PortalHome.tsx");
    expect(home).toContain('value: "prev1"');
    expect(home).toContain('value: "prev2"');
    // "last3" is a staff window: a partner's target is a MONTH they were given,
    // and a three-month total has no goal to be measured against.
    expect(home).not.toContain('value: "last3"');
  });

  it("stays quiet when they have never been given one", () => {
    const home = code("pages/portal/PortalHome.tsx");
    expect(home).toContain('!d.has_target && win === "current") return null');
  });
});

/* ------------------------------------------------------- the nav follows --- */

describe("the pages the dashboard links to are reachable", () => {
  const employeeOnly = () => false;

  it("lets a plain employee open the team view it links to", () => {
    // The dashboard's "See all" goes to /people/partners?view=team. An
    // employee who cannot open it would be sent to a toast and the dashboard.
    expect(canAccess(gateForPath("/people/partners")!, "employee",
                     employeeOnly)).toBe(true);
    expect(dash()).toContain("/people/partners?view=team");
  });

  it("still routes the employee's own team block to the Team tab", () => {
    // The TOP PERFORMERS block is gone (owner 2026-08-07); MyTeamBlock — the
    // employee's own roster, which is a worklist rather than a ranking —
    // stays, and it is the one that has to link somewhere useful.
    expect(block(dash(), "MyTeamBlock")).toContain("/people/partners");
  });
});

describe("an employee can find their own targets", () => {
  /*
    THE BUG (owner, 2026-08-21): "where does the employee see their own assigned
    targets? or how does the employee give targets to the channel partner under
    it".

    Both already worked. Their number was on the dashboard, and the server has
    let a relationship manager set their own roster's targets without
    `manage_targets` since owner F1 in July. What did not work was FINDING
    either: `/targets` required `view_targets`, so the one entry in the sidebar
    actually called "Targets" was invisible to the people carrying them, and the
    way to set a partner's number was three levels down a page called Channel
    Partners.

    Same failure as the employee Team tab on 2026-08-19 — a feature nobody can
    find is a feature nobody has — so it is pinned the same way.
  */
  const noFlags = () => false;
  const withFlag = (held: string) => (p: string) => p === held;

  it("puts Targets in the sidebar for an employee with no flags at all", () => {
    expect(canAccess(gateForPath("/targets")!, "employee", noFlags)).toBe(true);
  });

  it("does NOT open it to a channel partner", () => {
    // Partners see their target in the portal (GET /api/portal/target). This is
    // a staff page and every staff router is closed to them at router level.
    expect(canAccess(gateForPath("/targets")!, "channel_partner", noFlags))
      .toBe(false);
  });

  it("still opens it for the owner and for flag holders", () => {
    expect(canAccess(gateForPath("/targets")!, "owner", noFlags)).toBe(true);
    expect(canAccess(gateForPath("/targets")!, "employee",
                     withFlag("view_targets"))).toBe(true);
    expect(canAccess(gateForPath("/targets")!, "employee",
                     withFlag("manage_targets"))).toBe(true);
  });

  it("scopes the PAGE rather than showing everyone's numbers to everyone", () => {
    /*
      Opening the nav entry is only half of it. `GET /api/targets/performance`
      refuses a caller without the flag — correctly — so a page that always
      loaded the roster would trade a hidden feature for a broken one. It
      branches instead, and the branch is on the same two flags the nav used to
      gate on.
    */
    const page = code("pages/TargetsPage.tsx");
    expect(page).toContain('has("view_targets")');
    expect(page).toContain('has("manage_targets")');
    expect(page).toMatch(/seesEveryone \? <EveryoneTargets \/> : <MyTargets \/>/);
  });

  it("builds the personal view out of the component that already exists", () => {
    // Not a second implementation: ManagerRosterPanel already opens with "My
    // target" and already carries the per-partner Set button, gated by the
    // server's own can_manage_targets. Rendering it here means this view and
    // the My Team tab cannot disagree.
    expect(code("pages/TargetsPage.tsx")).toContain("<ManagerRosterPanel />");
  });

  it("gives the dashboard's target card somewhere to go", () => {
    // It was the only place an employee saw their number and it led nowhere —
    // no history, no previous month, no sight of the roster it is split across.
    expect(block(dash(), "TargetProgressCard")).toContain('to="/targets"');
  });

  it("never renders a failed target fetch as 'no target set'", () => {
    // `if (!d) return null` collapsed loading, failure and no-data into one
    // blank space, so a cold start read as "nobody gave me a number".
    const card = block(dash(), "TargetProgressCard");
    expect(card).toContain("progress.isError");
    expect(card).toContain("<ErrorState");
  });
});

describe("a finished month is read-only for a relationship manager", () => {
  // Owner C4. Reading back is unrestricted — you cannot decide this month's
  // number for a partner without last month's — but a goal somebody has already
  // been measured against is history, not a target.
  it("locks the form's save when the month has finished", () => {
    const form = code("components/TargetGoalsForm.tsx");
    expect(form).toContain("monthIsPast(month)");
    expect(form).toContain('!has("manage_targets")');
    expect(form).toMatch(/canSave = .*&& !locked/);
  });

  it("says WHY the save is off, against the month that caused it", () => {
    // A disabled button with no explanation is the thing this app keeps
    // deciding not to ship.
    expect(code("components/TargetGoalsForm.tsx"))
      .toContain("has finished, so its target can no longer be");
  });
});
