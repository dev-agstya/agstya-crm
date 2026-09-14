// The Channel Partner portal, v2 (owner 2026-08-05) — the client half.
//
// The server owns the rules (tests/test_partner_portal_v2.py). These pin that
// the screens do not contradict them, and that the portal is genuinely built
// for a phone rather than being the staff app with a narrower sidebar.
//
// Source-reading, like the other sweeps here: what these protect is a set of
// DECISIONS — this figure is never shown, this write no longer exists, this
// list becomes cards on a phone — which a render test would have to stand up
// most of the app to observe.

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
const portalFiles = allFiles.filter((f) => f.startsWith("/src/pages/portal/"));
const app = () => code("App.tsx");

/* --------------------------------------------- the old surface is gone ----- */

describe("a partner can no longer book a policy", () => {
  it("removes the submission form entirely", () => {
    expect(allFiles).not.toContain("/src/pages/portal/PortalPolicyFormPage.tsx");
    expect(app()).not.toContain("PortalPolicyFormPage");
  });

  it("removes the four-pages-in-one-file screen it replaced", () => {
    expect(allFiles).not.toContain("/src/pages/portal/PortalPages.tsx");
  });

  it("leaves no client for the endpoints that went with it", () => {
    const api = code("api/endpoints.ts");
    for (const gone of ["submitPolicy", "updatePolicy", "uploadPolicyDocument",
      "createCustomer", "createLead", "commentOnLead", "walletApi"]) {
      expect(api, `${gone} survived`).not.toContain(gone);
    }
  });

  it("leaves no route or nav entry pointing at a deleted page", () => {
    for (const dead of ["/portal/policies/new", "/portal/customers",
      "/portal/wallet", "/portal/leads"]) {
      expect(app(), `${dead} route survived`).not.toContain(`"${dead}"`);
      expect(gateForPath(dead), `${dead} is still in the nav`).toBeUndefined();
    }
  });
});

/* --------------------------------------------------- what they can reach --- */

describe("the portal a partner actually gets", () => {
  // /portal/claims is deliberately absent: claims were PAUSED on 2026-08-19 and
  // the entry is locked, so there is no page to reach. Its gate is still
  // partnerOnly — see "a locked entry is still partner-only" below.
  const PARTNER_PAGES = ["/portal/policies", "/portal/renewals",
    "/portal/quotes", "/portal/earnings", "/portal/notices"];

  it("shows them every portal page and nothing else", () => {
    for (const path of PARTNER_PAGES) {
      const gate = gateForPath(path);
      expect(gate, `${path} is missing from the nav`).toBeDefined();
      expect(canAccess(gate!, "channel_partner", () => false), path).toBe(true);
    }
  });

  it("keeps every one of them away from staff", () => {
    for (const path of PARTNER_PAGES) {
      const gate = gateForPath(path)!;
      expect(canAccess(gate, "owner", () => true), path).toBe(false);
      expect(canAccess(gate, "employee", () => true), path).toBe(false);
    }
  });

  it("registers the write form static-before-dynamic", () => {
    // Claims had the same pair until 2026-08-19; both its routes are gone now,
    // which is what "locked" has to mean — see the claims-paused block below.
    const routes = [...app().matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
    for (const [staticPath, dynamic] of [
      ["/portal/quotes/new", "/portal/quotes/:id"],
    ]) {
      expect(routes).toContain(staticPath);
      expect(routes.indexOf(staticPath),
        `${staticPath} must be registered before ${dynamic}`)
        .toBeLessThan(routes.indexOf(dynamic));
    }
  });

  it("gives a partner ONE home, not a trimmed staff dashboard", () => {
    expect(code("pages/DashboardPage.tsx")).toContain("<PortalHome />");
    expect(allFiles).toContain("/src/pages/portal/PortalHome.tsx");
  });
});

/* ------------------------------------------------------- what they see ----- */

describe("what the portal shows about money", () => {
  it("never renders a RATE anywhere in the portal", () => {
    // Owner E1: rupees only. A rate on a screen they can screenshot is a
    // negotiation waiting to happen, and it gives away what the agency keeps.
    //
    // `attainment_pct` is the one allowed exception (2026-08-06) and it is
    // asserted separately below. It is progress against a goal the agency
    // handed the partner on purpose (owner E2/E3) — the opposite of a rate,
    // which is a number they were never meant to work backwards from.
    for (const file of portalFiles) {
      const src = SOURCES[file]
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/attainment_pct/g, "");
      expect(src, `${file} mentions a rate`)
        .not.toMatch(/agency_value|partner_value|reward_percent|_pct\b/);
    }
  });

  it("shows the partner their target, and never the agency's margin on it", () => {
    // Owner E1-E3. A target nobody can see is a spreadsheet, not a target.
    const home = code("pages/portal/PortalHome.tsx");
    expect(home).toContain("portalApi.target");
    expect(home).toContain("Your target");
    // House profit is stripped server-side (allow_profit=False); the portal
    // must not reintroduce the word by asking for it or labelling it.
    for (const file of portalFiles) {
      expect(SOURCES[file], `${file} mentions house profit`)
        .not.toMatch(/house_profit|agency_reward/);
    }
  });

  it("puts the target under the money, not above it", () => {
    // Owner E1: money is still why they opened the app. A goal above the
    // earnings would read like the agency's priorities in the wrong order.
    const home = code("pages/portal/PortalHome.tsx");
    const money = home.indexOf("<NetPosition");
    const target = home.indexOf("<TargetCard />");
    expect(money).toBeGreaterThan(-1);
    expect(target).toBeGreaterThan(money);
  });

  it("says the net position in WORDS, not just a sign", () => {
    // "Rs 18,300" with a minus in front is read wrong by half the people who
    // see it.
    const shared = code("pages/portal/shared.tsx");
    expect(shared).toContain("Agastya owes you");
    expect(shared).toContain("You owe Agastya");
  });

  it("shows BOTH sides of the position", () => {
    const earnings = code("pages/portal/PortalEarningsPage.tsx");
    expect(earnings).toContain("reward_earned_unpaid");
    expect(earnings).toContain("premium_owed");
  });

  it("offers no way to request a payout", () => {
    // Payouts are made by the team and appear as transactions (owner A1).
    for (const file of portalFiles) {
      expect(SOURCES[file], `${file} offers a withdrawal`)
        .not.toMatch(/withdraw|payout request/i);
    }
  });

  it("says who makes the payout, so nobody waits for a button", () => {
    expect(code("pages/portal/PortalEarningsPage.tsx"))
      .toContain("Payouts are made by the Agastya team");
  });
});

/* ------------------------------------------------------------- the writes -- */

describe("the two things a partner can write", () => {
  const quoteForm = () => code("pages/portal/PortalQuotesPage.tsx");

  it("asks for nothing the agency decides", () => {
    for (const banned of ["policy_number", "insurer_id", "premium_amount",
      "broker", "discount"]) {
      expect(quoteForm(), `the quote form collects ${banned}`)
        .not.toContain(`${banned}:`);
    }
  });

  it("reuses the agency's own policy types rather than a second taxonomy", () => {
    expect(quoteForm()).toContain("portalApi.quoteOptions");
  });

  it("makes every type-specific field optional", () => {
    // A request is an enquiry. Refusing one over a missing field is how a
    // partner stops sending them.
    expect(quoteForm()).toContain("fill in what you know");
  });

  it("tells them which documents help, from the type's own checklist", () => {
    expect(quoteForm()).toContain("Helpful for this type");
  });

  it("does not lose the request when a photo fails to upload", () => {
    expect(quoteForm()).toContain("You can add it from the ");
  });

  it("no longer offers a claim off a policy — claims are paused", () => {
    // The button was here and it was right while claims were live. Inverting
    // the assertion rather than deleting it is the rule from 2026-08-05: a test
    // that still asserts removed copy PINS THE BUG IN PLACE, and a deleted test
    // leaves nothing to stop the dead link coming back.
    expect(code("pages/portal/PortalPoliciesPage.tsx"))
      .not.toContain("/portal/claims/new?policy=");
  });
});

/* ------------------------------------------------------------------ mobile -- */

describe("the portal is built for a phone", () => {
  it("renders lists as cards on a phone and a table from sm: up", () => {
    // `ListShell` MOVED to components/ui.tsx on 2026-08-07. The behaviour is
    // unchanged — two renderings chosen by breakpoint — but the staff app
    // needed it too (30 staff tables had no phone rendering at all), and the
    // portal cannot be the only half of the product that owns a good
    // primitive. `pages/portal/shared.tsx` re-exports it, so the portal pages
    // are untouched.
    //
    // The BREAKPOINT MECHANISM changed on 2026-08-07 and the behaviour did not.
    // It used to render both trees and hide one with `sm:hidden` /
    // `hidden sm:block`, so every list mounted its rows twice. It now picks one
    // branch from `useIsWide()` — the same 640px boundary, half the DOM.
    const ui = code("components/ui.tsx");
    expect(ui).toContain("export function useIsWide");
    expect(ui).toContain('matchMedia("(min-width: 640px)")');
    // One branch, not two: the card list and the table are never both mounted.
    expect(ui).toContain("if (!desktop) return");
    // The portal still reaches it by its own name.
    expect(code("pages/portal/shared.tsx"))
      .toContain('export { ListShell, MobileCard } from "../../components/ui"');
  });

  it("uses the card/table shell on every list rather than one squeezed table",
    () => {
      for (const page of ["PortalPoliciesPage", "PortalRenewalsPage",
        "PortalQuotesPage", "PortalClaimsPage"]) {
        expect(code(`pages/portal/${page}.tsx`), page).toContain("ListShell");
      }
    });

  it("gives the primary actions a thumb-sized target", () => {
    // 44px. The app's default .btn is 36, which is fine at a desk.
    //
    // This was a per-call `h-12`, which is the same override the rest of the
    // app was sweeping out — so it read as drift when it is actually a
    // requirement. `.btn-lg` is the NAMED variant index.css already defined for
    // precisely this ("Thumb-sized, for the partner portal's primary actions on
    // a phone"), so the intent is now in the class rather than in a number.
    // (`.btn-lg` is pinned at h-11 by designSystem.test.ts, which is the file
    // that reads index.css.)
    expect(code("pages/portal/PortalHome.tsx")).toMatch(/btn-primary btn-lg/);
  });

  it("makes customer numbers tap-to-call", () => {
    expect(code("pages/portal/PortalRenewalsPage.tsx")).toContain("href={`tel:");
    expect(code("pages/portal/PortalPoliciesPage.tsx")).toContain("href={`tel:");
  });

  it("accepts a camera photo on both upload forms", () => {
    for (const page of ["PortalQuotesPage", "PortalClaimsPage"]) {
      expect(code(`pages/portal/${page}.tsx`), page).toContain("image/*");
    }
  });
});

/* --------------------------------------------------------- the staff side -- */

describe("the staff side of the portal", () => {
  it("puts the quote queue and claims behind their own permission", () => {
    for (const path of ["/quotes", "/claims"]) {
      const gate = gateForPath(path)!;
      // Their own pairs since the 2026-08-07 split: handling the partner
      // relationship is a different job from booking policies. Claims keeps its
      // flag while paused — the pause is a nav/route decision, and stripping
      // the permission would mean re-deriving who may see it when it returns.
      expect(gate.anyPerm, path).toEqual(
        [path === "/quotes" ? "view_quotes" : "view_claims"]);
      expect(canAccess(gate, "channel_partner", () => true), path).toBe(false);
    }
  });

  it("puts broadcasting behind its own permission", () => {
    // A notice cannot be unsent, so sending one is a deliberate grant rather
    // than a side effect of being able to add an employee.
    const gate = gateForPath("/people/notices")!;
    expect(gate.anyPerm).toEqual(["view_announcements"]);
  });

  it("locks Claims on BOTH sides, with no route left behind either", () => {
    // Paused by the owner on 2026-08-19. Claims was unlocked here on
    // 2026-08-05 and this test asserted so; the assertion is inverted rather
    // than deleted, because the failure this guards against is the one that
    // has already happened twice in this product — a feature switched off in
    // one layer and left live in another.
    //
    // A lock has to be all three of these at once, or it is decorative:
    //   the nav entry is `locked`, on the staff side AND the partner side
    //   NO <Route> renders either page
    //   nothing still links to the pages
    const items = NAV.flatMap((s) => s.items);
    for (const path of ["/claims", "/portal/claims"]) {
      const item = items.find((i) => i.to === path);
      expect(item, `${path} left the nav entirely`).toBeDefined();
      expect(item!.locked, `${path} is not locked`).toBe(true);
    }
    const routes = [...app().matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
    for (const dead of ["/claims", "/claims/:id", "/portal/claims",
      "/portal/claims/new", "/portal/claims/:id"]) {
      expect(routes, `${dead} still has a route behind a locked entry`)
        .not.toContain(dead);
    }
    // A locked entry is still partner-only / staff-only: pausing a feature must
    // not quietly widen who it would be visible to when it comes back.
    expect(canAccess(gateForPath("/portal/claims")!, "owner", () => true))
      .toBe(false);
  });

  it("keeps the claims CODE intact so the pause is one line to undo", () => {
    // The pages, the router, the models and the permission pair all survive.
    // Deleting them would turn "paused" into "rebuild it", and there is live
    // claim data behind them.
    expect(code("pages/claims/ClaimsPage.tsx")).toContain("Staff only");
    expect(code("pages/portal/PortalClaimsPage.tsx")).toContain("ListShell");
  });

  it("shows the audience before a broadcast can be sent", () => {
    // The composer is a full PAGE now, not a modal (2026-08-05): a notice
    // cannot be unsent, and the dialog put that one irreversible fact below
    // the fold of a scrolling box, directly above the Send button.
    const composer = code("pages/people/NoticeComposerPage.tsx");
    expect(composer).toContain("announcementsApi.preview");
    expect(composer).toContain("preview.data.count");
    expect(composer).toContain("cannot be unsent");
    // The count is on the send button itself — you cannot press it without
    // having read how many people it reaches.
    expect(composer).toMatch(/Send to \{preview\.data\?\.count/);
  });

  it("previews what the partner will actually read", () => {
    expect(code("pages/people/NoticeComposerPage.tsx")).toContain("Preview");
  });

  it("is honest that withdrawing does not recall an email", () => {
    expect(code("pages/people/NoticesPage.tsx"))
      .toContain("CANNOT be recalled");
  });

  it("hands booking off to the real policy form rather than inventing one", () => {
    // The broker choice is what prices the reward, and it is a human decision.
    expect(code("pages/quotes/QuoteDetailPage.tsx"))
      .toContain("/policies/new?quote=");
  });

  it("flags a queue that is not being answered", () => {
    const queue = code("pages/quotes/QuotesPage.tsx");
    expect(queue).toContain("AMBER_HOURS");
    expect(queue).toContain("RED_HOURS");
  });

  it("keeps internal notes labelled as staff-only on both queues", () => {
    expect(code("pages/quotes/QuoteDetailPage.tsx"))
      .toContain("The partner never sees this");
    expect(code("pages/claims/ClaimsPage.tsx")).toContain("Staff only");
  });

  it("says on the claim screen that the settled amount is not a ledger row", () => {
    expect(code("pages/claims/ClaimsPage.tsx"))
      .toContain("does not touch the ledger");
  });
});
