// Teams -> relationship managers, the client half (owner 2026-08-05).
//
// The structure was always in the data: `relationship_manager_id` is mandatory
// on every channel partner. What did not exist was anywhere to read it, and
// what did exist was a second, parallel Team object that duplicated it.
//
// The server owns the rules (tests/test_relationship_managers.py). These pin
// that the screens do not contradict them: Teams is gone rather than orphaned,
// the roster reads as a roster and not as a permission boundary, and money
// figures come off the shared fields rather than being recomputed here.

import { describe, expect, it } from "vitest";
import { NAV, canAccess, gateForPath } from "./access";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such source file: ${rel}`);
  return text;
}

function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const allFiles = Object.keys(SOURCES);
const app = () => code("App.tsx");
const nav = () => code("lib/access.ts");

/* ------------------------------------------------------- Teams are gone ----- */

describe("the Teams page is gone, not orphaned", () => {
  it("removes both page files", () => {
    for (const gone of ["/src/pages/TeamsPage.tsx",
      "/src/pages/people/TeamFormPage.tsx"]) {
      expect(allFiles, `${gone} still exists`).not.toContain(gone);
    }
  });

  it("removes the API client with them", () => {
    expect(code("api/endpoints.ts")).not.toContain("teamsApi");
    expect(code("api/endpoints.ts")).toContain("managersApi");
  });

  it("leaves no route pointing at a deleted page", () => {
    expect(app()).not.toContain("TeamsPage");
    expect(app()).not.toContain("TeamFormPage");
    expect(app()).not.toContain('"/people/teams"');
  });

  it("leaves no nav entry pointing at a dead route", () => {
    expect(nav()).not.toContain("/people/teams");
  });

  it("drops the types the old API returned", () => {
    // Matched as DECLARATIONS, not as bare substrings (tightened 2026-08-20).
    //
    // Two of these used to be searched for as loose text, which made the guard
    // fire on any future type whose NAME merely contained one of them —
    // `TeamMemberDay` on the attendance board tripped "TeamMember" while the
    // dead Team API was long gone. A guard that fails on an unrelated,
    // correctly-named type is one people learn to edit around rather than
    // read, which is how a real regression gets waved through next time.
    //
    // What it is actually asserting is unchanged: the Team API's own types are
    // not declared here.
    const types = code("lib/types.ts");
    for (const dead of ["Team", "TeamPerformanceRow", "TeamMember"]) {
      expect(types, `interface ${dead} survived`)
        .not.toContain(`interface ${dead} {`);
      expect(types, `type ${dead} survived`).not.toContain(`type ${dead} =`);
    }
  });

  it("stops collecting the two dead hierarchy fields", () => {
    // `team_id` and `reports_to_id` were the other two answers to "who does
    // this person sit under". Neither is on the model any more, so a form
    // still sending one would 422 — or worse, silently do nothing.
    for (const file of ["lib/types.ts", "components/PersonDetailBody.tsx",
      "pages/people/AddEmployeePage.tsx", "pages/people/AddPartnerPage.tsx"]) {
      const src = code(file);
      expect(src, `${file} still has reports_to_id`)
        .not.toContain("reports_to_id");
      expect(src, `${file} still has team_id`).not.toContain("team_id");
    }
  });
});

/* ------------------------------------------- it is not a page of its own ---- */

describe("relationship managers live WITH the employees", () => {
  // Owner 2026-08-05: "it doesn't need to be a separate page my friend, it
  // could have been somewhere on the employee's profile". So the league table
  // is a VIEW of the Employees page and one manager's roster is a TAB on their
  // record. These pin that it stays that way — the pull towards "just add a
  // page for it" is what produced the nav this replaced.
  it("has no page file and no nav entry of its own", () => {
    expect(allFiles).not.toContain("/src/pages/people/ManagersPage.tsx");
    // The path still resolves to a Gate — the redirect route has to pass the
    // Guard — but nothing in the SIDEBAR may point at it any more.
    const linked = NAV.flatMap((s) => s.items)
      .flatMap((i) => [i.to, ...(i.children ?? []).map((c) => c.to)]);
    expect(linked).not.toContain("/people/managers");
  });

  it("redirects the two retired URLs instead of 404ing them", () => {
    // They were in the sidebar for weeks; somebody has them bookmarked.
    const src = app();
    expect(src).toContain('to="/people/employees?view=performance"');
    expect(src).toContain("ManagerRedirect");
    expect(src).toContain('to={`/people/employees/${id}?tab=team`}');
  });

  it("puts the league table on the Employees page as a view", () => {
    const page = code("pages/EmployeesPage.tsx");
    expect(page).toContain("ManagerLeague");
    expect(page).toContain("performance");
    // Reading everyone's numbers is a management right; the directory is not.
    expect(page).toContain('has("view_employees")');
  });

  it("puts one manager's team on their own record as a tab", () => {
    const body = code("components/PersonDetailBody.tsx");
    expect(body).toContain("ManagerRosterPanel");
    // Renamed from "Partners" to "Team" on 2026-08-06 — it is what the owner
    // calls it, and it now carries the manager's own target too, which
    // "Partners" did not describe.
    expect(body).toContain('"team"');
    expect(body).toContain('label: "Team"');
    // The old deep link (?tab=partners) was in the Performance view for weeks.
    expect(body).toContain('requestedTab === "partners"');
  });

  it("still gives an employee a direct route to their own team", () => {
    // REWRITTEN 2026-08-06. It used to be /people/my-partners, a page of its
    // own. Owner G1/G2 folded it into the Channel Partners page as a VIEW, so
    // one roster is not rendered by two screens. The old URL redirects, because
    // it was in the sidebar for weeks.
    const app_ = app();
    expect(app_).toContain('path="/people/my-partners"');
    expect(app_).toMatch(
      /path="\/people\/my-partners"[\s\S]{0,140}\/people\/partners\?view=team/);
    // And the destination actually renders the panel.
    expect(code("pages/ChannelPartnersPage.tsx"))
      .toContain("<ManagerRosterPanel />");
  });

  it("shares ONE roster panel between the tab and the employee's own view", () => {
    // The owner's view of Rahul and Rahul's own view of himself must not be
    // able to disagree — the server serves them from one serialiser, and the
    // screen follows (owner G6).
    expect(code("pages/ChannelPartnersPage.tsx"))
      .toContain("ManagerRosterPanel");
    expect(code("components/PersonDetailBody.tsx"))
      .toContain("ManagerRosterPanel");
    const panel = code("components/ManagerRosterPanel.tsx");
    expect(panel).toContain("managersApi.myPartners");
    expect(panel).toContain("managersApi.partners");
    expect(panel).toContain("PartnerRoster");
  });

  it("has no second page rendering the same roster", () => {
    // MyPartnersPage was deleted rather than left orphaned: a file that still
    // renders the panel is a screen somebody will wire back into the nav.
    expect(allFiles).not.toContain("/src/pages/people/MyPartnersPage.tsx");
  });

  it("uses the app's shared date filter, not a private one", () => {
    for (const file of ["components/ManagerRosterPanel.tsx",
      "components/ManagerLeague.tsx"]) {
      expect(code(file), file).toContain("DateFilter");
      expect(code(file), file).toContain("periodParams");
    }
  });
});

/* ------------------------------------------------------------ the numbers --- */

describe("the numbers on screen", () => {
  const league = () => code("components/ManagerLeague.tsx");
  const roster = () => code("pages/people/PartnerRoster.tsx");
  const panel = () => code("components/ManagerRosterPanel.tsx");

  it("hides house profit unless the server says it may be shown", () => {
    // Server zeroes it too; this stops an empty column being drawn at all.
    expect(league()).toContain("can_view_profit");
    expect(league()).toMatch(/canProfit && <th/);
  });

  it("shows the partner / own-sales split rather than one lump", () => {
    // It is ONE bar now instead of four columns, each of which used to cram a
    // count and a money figure into a cell joined by a "·".
    const src = league();
    expect(src).toContain("SplitBar");
    expect(src).toContain("partner_premium");
    expect(src).toContain("own_premium");
  });

  it("keeps unassigned business on the page", () => {
    // Dropping it would make the table stop adding up to the dashboard.
    expect(league()).toContain("unassigned");
  });

  it("says plainly that an employee is seeing only their own book", () => {
    expect(league()).toContain("can_view_all");
    expect(league()).toContain("You are seeing your own book");
  });

  it("reads the partner balance off the server field, never recomputing it",
    () => {
      // partner_net_balance is one function server-side, shared with the
      // Balance Sheet and the partner's own statement.
      expect(roster()).toContain("net_balance");
      expect(roster()).not.toContain("available_paise");
    });

  it("colours the balance by direction, using the app's money colours", () => {
    const src = roster();
    expect(src).toContain("text-money-out");
    expect(src).toContain("text-money-in");
    expect(src).toContain("to pay");
    expect(src).toContain("to collect");
  });

  it("flags quiet partners and says what quiet means", () => {
    expect(roster()).toContain("is_quiet");
    expect(panel()).toContain("60 days with no policy");
  });

  it("surfaces renewals due, the thing the page exists to protect", () => {
    expect(roster()).toContain("renewals_due");
    expect(panel()).toContain("Renewals due");
  });

  it("says the filter moves volumes but not positions", () => {
    // Premium and targets follow the date filter; balances and renewals are
    // current. The sentence is on screen because the split is load-bearing and
    // invisible otherwise: a partner cannot stop being "quiet" because you
    // switched the filter to This month.
    expect(panel()).toContain("Balances and renewals are");
  });

  it("sorts what needs a phone call to the top of the roster", () => {
    // The reason to open a roster is to find who to ring. A flat list where
    // the quiet partner looks like the other eleven does not answer that.
    const src = roster();
    expect(src).toContain("Needs a call");
    expect(src).toMatch(/renewals_due > 0 \|\| r\.is_quiet/);
    // Added 2026-08-06: badly behind on a number you were GIVEN is the third
    // way this list earns a call, alongside a renewal and going quiet.
    expect(src).toMatch(/has_target && r\.attainment_pct < 50/);
  });

  it("shows the target each partner was given, and the manager's own", () => {
    // Owner G5. The manager divided their goal to produce these numbers; a
    // roster that cannot show whether anybody is keeping to them cannot answer
    // the question it was opened for.
    expect(roster()).toContain("target_metrics");
    expect(roster()).toContain("attainment_pct");
    const p = panel();
    expect(p).toContain("manager_metrics");
    expect(p).toContain("manager_attainment_pct");
    expect(p).toContain("partners_with_target");
  });

  it("uses ONE target form, not a second one for the roster", () => {
    // A second form writing targets is a second place for the paise
    // conversion, "blank is not zero" and the house-profit carry-through to be
    // got subtly wrong.
    expect(panel()).toContain("TargetGoalsForm");
    expect(code("components/TargetsBody.tsx")).toContain("TargetGoalsForm");
  });

  it("hides the set-target control from someone who may not use it", () => {
    // The server decides (routers/targets._may_assign); the roster is handed
    // `can_manage_targets` and draws the button only when it is true, so the
    // page never shows a control that 403s.
    expect(panel()).toContain("can_manage_targets");
    expect(roster()).toContain("onSetTarget");
  });
});

/* ------------------------------------------------- not a visibility gate ---- */

describe("this is a view, not a restriction", () => {
  it("does not gate the employee's own roster on a staff-directory right",
    () => {
      // view_employees is for reading the staff directory. Seeing the partners you
      // personally manage is the job.
      const src = nav();
      const entry = src.slice(src.indexOf('"/people/my-partners"'));
      const line = entry.slice(0, entry.indexOf("},"));
      expect(line).toContain("employeeAny: true");
      expect(line).not.toContain("view_employees");
    });

  it("still hides all of it from channel partners", () => {
    // They are the data on these screens, not an audience for them — and the
    // server refuses them the whole router anyway.
    for (const path of ["/people/my-partners", "/people/employees"]) {
      const gate = gateForPath(path);
      expect(gate, `${path} is missing from the nav`).toBeDefined();
      expect(canAccess(gate!, "channel_partner", () => true), path)
        .toBe(false);
    }
  });

  it("says on screen that history is frozen, not re-derived", () => {
    expect(code("components/ManagerLeague.tsx"))
      .toContain("never who is credited with what they have already brought in");
  });
});
