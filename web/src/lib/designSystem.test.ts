// The design system, pinned (owner 2026-08-05: "make it match the latest level
// of modern UI", references Notion + Stripe).
//
// What is protected here is a set of DECISIONS, most of which fail SILENTLY:
// a font that is specified but never fetched, a token that drifts back to a
// blue-tinted grey, a fourth copy of the stat tile. None of those throw, none
// of them fail a render test, and all of them look like "the app is just a bit
// ugly" months later.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// index.css is read with `fs`, NOT with import.meta.glob. Vitest stubs CSS
// modules (css:false by default), so a ?raw glob hands back an empty string —
// and `expect("").not.toContain(x)` passes happily, which is a green test that
// checks nothing. That trap is why the CSS went unasserted for a pass; reading
// the bytes off disk is the fix, and a positive `toContain` would have caught
// the stub anyway by failing.
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

const ROOT = import.meta.glob("/*.{html,js}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

const CSS: Record<string, string> = {
  "/src/index.css": readFileSync("src/index.css", "utf8"),
};

function src(rel: string): string {
  const text = SOURCES[`/src/${rel}`] ?? ROOT[`/${rel}`] ?? CSS[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such file: ${rel}`);
  return text;
}

function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}


/* ------------------------------------------------------------------ type --- */

describe("the typeface is actually loaded", () => {
  // THE bug this whole pass started from. tailwind.config.js has named Inter as
  // the app font since the design system was written, and index.html never
  // fetched it — so every screen rendered in the OS default (Segoe UI on
  // Windows) and inherited its wider, softer, more clerical look. Nothing
  // errored. It just looked wrong for months.
  it("fetches Inter, which the Tailwind config has always specified", () => {
    const html = src("index.html");
    expect(html).toMatch(/fonts\.googleapis\.com.*family=Inter/);
    expect(src("tailwind.config.js")).toContain('"Inter"');
  });

  it("preconnects, so the font is not a render-blocking round trip", () => {
    const html = src("index.html");
    expect(html).toContain('rel="preconnect"');
    expect(html).toContain("display=swap");
  });

});

/* ---------------------------------------------------------------- colour --- */

describe("the palette is a true neutral, and money still owns its colours", () => {
  const config = () => src("tailwind.config.js");

  it("redefines slate rather than leaving Tailwind's blue-tinted ramp", () => {
    // The app writes text-slate-* on roughly every element it has. Overriding
    // the ramp re-tunes all of them at once; the alternative was ~25,000 lines
    // of churn and a half-converted app.
    const cfg = config();
    expect(cfg).toContain("slate: {");
    expect(cfg).toContain('500: "#71717a"');
    // Comment-stripped: the config EXPLAINS the old blue-tinted value, so a
    // raw search for it always matches the prose that documents the change.
    expect(code("tailwind.config.js")).not.toContain("#64748b");
  });

  it("keeps the money colours exactly as they were", () => {
    // Load-bearing: green in, red out, everywhere, forever.
    const cfg = config();
    expect(cfg).toContain('in: "#16a34a"');
    expect(cfg).toContain('out: "#dc2626"');
  });

  it("stays light-only with no dark variant", () => {
    expect(config()).not.toContain("darkMode:");
  });
});

/* ------------------------------------------------------- shared primitives -- */

describe("primitives live in the design system, not in pages", () => {
  it("has ONE stat card, and the portal re-exports it rather than copying", () => {
    // There were four different "Tile" components across the app and no two of
    // them agreed on label casing or number size.
    expect(code("components/ui.tsx")).toContain("export function StatCard");
    expect(code("pages/portal/shared.tsx"))
      .toContain("StatCard as StatTile");
  });

  it("draws proportions instead of writing them out", () => {
    // "12 / 30" is a progress bar spelled in characters.
    const ui = code("components/ui.tsx");
    expect(ui).toContain("export function Meter");
    expect(ui).toContain("export function SplitBar");
    expect(code("pages/people/NoticesPage.tsx")).toContain("<Meter");
  });

  it("filters lists with a segmented control, never with a Toggle", () => {
    // A switch means "change a setting". Two switches offer four states where
    // the user wanted one of three.
    expect(code("components/ui.tsx")).toContain("export function Segmented");
    const quotes = code("pages/quotes/QuotesPage.tsx");
    expect(quotes).toContain("Segmented");
    expect(quotes).not.toContain("<Toggle");
  });

  it("puts a face on every list of people", () => {
    const ui = code("components/ui.tsx");
    expect(ui).toContain("export function PersonCell");
    for (const page of ["pages/people/PartnerRoster.tsx",
      "components/ManagerLeague.tsx", "pages/quotes/QuotesPage.tsx"]) {
      expect(code(page), `${page} lists people as bare text`)
        .toContain("PersonCell");
    }
  });

  it("defines the urgency rail once, in CSS", () => {
    // A queue with no clock is a pile — and the clock has to be visible before
    // you read any text on the row.
    //
    // AMENDED 2026-08-07: the ledger pages now express the rail through
    // `<LedgerRow rail="out">` rather than by writing the class themselves,
    // which is the same decision one level up. Either spelling counts; having
    // NO rail on a queue does not.
    expect(src("index.css")).toContain(".rail-due");
    expect(code("pages/quotes/QuotesPage.tsx")).toMatch(/rail-out|rail=/);
    expect(code("pages/people/PartnerRoster.tsx")).toMatch(/rail-due|rail=/);
  });

  it("keeps long tables navigable rather than squashing them", () => {
    // The owner's answer to "what about more data in a year" was to build for
    // it now, so density went UP and the header stays on screen.
    //
    // AMENDED 2026-08-07: `.ledger thead th` is sticky by definition — a
    // ledger is long, that is what it is for — so a page using `<Ledger>` gets
    // this without asking. `.table-sticky` is still how a table inside a card
    // opts in.
    for (const page of ["pages/people/PartnerRoster.tsx",
      "components/ManagerLeague.tsx", "pages/quotes/QuotesPage.tsx",
      "pages/people/NoticesPage.tsx"]) {
      expect(code(page), page).toMatch(/table-sticky|<Ledger/);
    }
    expect(src("index.css")).toMatch(/\.ledger thead th \{[\s\S]{0,200}sticky/);
  });
});

/* ------------------------------------------------------------------ shell -- */

describe("the shell", () => {
  it("gives phones a real top bar instead of a floating button", () => {
    // The old one was pinned OVER the content, and every page paid 64px of
    // blank space to sit under it.
    const layout = code("components/layout/AppLayout.tsx");
    expect(layout).toContain("lg:hidden");
    expect(layout).not.toContain("fixed left-4 top-4");
  });

  it("uses the canvas token rather than a hard-coded hex", () => {
    expect(code("components/layout/AppLayout.tsx")).toContain("bg-canvas");
  });
});

/* ------------------------------------------------------- glyphs vs icons --- */

// The no-emoji rule is NOT re-implemented here. lib/uiCopy.test.ts already owns
// it, with an explicit allow-list of the typographic characters the product
// legitimately uses (— … ₹ · → ✓ ▲ ▼). A second, subtly different copy of that
// rule in this file is exactly the drift this whole pass exists to remove.
//
// What belongs here is the narrower design question: an arrow that is a
// CONTROL should be an icon, because a text glyph cannot take a size, a stroke
// weight or a hover state, and it renders differently in every font.

describe("controls are icons, not text glyphs", () => {
  it("draws reorder and trend arrows with the icon set", () => {
    for (const page of ["pages/catalog/PolicyTypeFormPage.tsx",
      "pages/FinanceReportsPage.tsx", "pages/DashboardPage.tsx"]) {
      const s = code(page);
      expect(s, `${page} still draws an arrow as a text glyph`)
        .not.toMatch(/[\u{25B2}\u{25BC}]/u);
    }
  });
});

/* ==========================================================================
   The 2026-08-06 pass. Everything below is a rule the app had ALREADY broken
   once — not a hypothetical. Each of these was a real count in the codebase
   before it was swept, and every one of them fails silently: nothing throws,
   nothing renders wrong, the product just slowly stops looking like one
   product.
   ========================================================================== */

// Every page and component, minus tests — the tests themselves NAME the
// forbidden classes in order to forbid them, and reading that as a violation
// would fire this at exactly the person who just removed one.
const APP_FILES = Object.entries(SOURCES)
  .filter(([p]) => !/\.test\.tsx?$/.test(p))
  .filter(([p]) => p.startsWith("/src/pages/") || p.startsWith("/src/components/"));

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("there is ONE green, one red and one amber", () => {
  // Before: 330+ off-token colour utilities, and FOUR greens, THREE reds and
  // FOUR ambers in circulation (-400/-500/-600/-700/-900). The palette had
  // semantic colours but no TINT for them, so every success panel and warning
  // strip in the app invented its own out of raw Tailwind.
  it("no page reaches into the raw Tailwind palette for a hue", () => {
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      const hits = stripComments(text).match(
        /\b(?:text|bg|border|ring|divide|decoration|from|to|via)-(?:green|red|amber|blue|indigo|violet|purple|sky|cyan|teal|emerald|lime|yellow|orange|rose|pink|fuchsia)-\d{2,3}\b/g);
      if (hits) offenders.push(`${path}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders, "Use money-in / money-out / due, or a .badge-*/.note-* "
      + "class. A second green is a second green nobody notices until two "
      + "screens disagree:\n" + offenders.join("\n")).toEqual([]);
  });

  it("derives tints from the same token as the text, via opacity", () => {
    const css = src("index.css");
    expect(css).toContain("bg-money-in/10");
    expect(css).toContain("bg-money-out/10");
    expect(css).toContain("bg-due/10");
  });
});

describe("the money sign/colour rule has ONE implementation", () => {
  // It had FIVE, and no two agreed: BalanceSheet red-600/green-600/blue-500,
  // Overview red-500/green-500/blue-400, Reports the same lighter pair,
  // Dashboard and NetBalance a third combination. The same net profit was
  // drawn in a different green on two screens that link to each other.
  it("lives in lib/tone and nowhere else", () => {
    expect(code("lib/tone.ts")).toContain("export function moneyTone");
    for (const page of ["pages/BalanceSheetPage.tsx",
      "pages/FinanceOverviewPage.tsx", "pages/FinanceReportsPage.tsx",
      "pages/DashboardPage.tsx"]) {
      expect(code(page), `${page} does not use the shared rule`)
        .toContain("moneyTone");
    }
  });

  it("owns the zero case, so `info` means exactly one thing", () => {
    // `info` is the third state of the money rule and NOTHING else. It had
    // drifted into the portal as a decorative "in progress" blue — the fourth
    // accent the palette does not have — on quote stages, claim stages and a
    // notice category. In-progress is neither money nor a deadline, so it is
    // neutral like every other ordinary state.
    //
    // Deliberately NOT a ban on every money ternary: `BanksPage.balanceTone`
    // (a credit card inverts the meaning of a positive balance) and the house
    // profit row on a policy are genuinely DIFFERENT rules, and forcing them
    // through moneyTone would change what they say.
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      if (/\b(?:text|bg|border|ring)-info\b/.test(stripComments(text))) {
        offenders.push(path);
      }
    }
    expect(offenders, "`info` is reserved for a net position of exactly zero "
      + "(lib/tone). Use slate for anything merely informational:\n"
      + offenders.join("\n")).toEqual([]);
  });

  it("does not paint a zero as a profit", () => {
    // Zero is neither a gain nor a loss. Green claims a profit that did not
    // happen; grey reads as "no data", and zero is a real answer.
    const tone = code("lib/tone.ts");
    expect(tone).toMatch(/if \(v > 0\) return "text-money-in"/);
    expect(tone).toMatch(/return "text-info"/);
  });
});

describe("headings come off the type scale", () => {
  // 28 headings picked their own size with `text-2xl font-bold` and friends —
  // five sizes doing three jobs, and disagreeing between screens showing the
  // same kind of thing.
  const ALLOWED = [
    // An OTP field, letter-spaced so six digits read as six digits.
    "pages/auth/ResetPasswordPage.tsx",
    // Avatar initials and icon glyphs are sized to their disc, not to the
    // text scale.
    "pages/SettingsPage.tsx",
    // A portal figure that scales UP on a phone (sm:text-3xl) — a deliberate
    // responsive step the fixed scale has no token for.
    "pages/portal/PortalPoliciesPage.tsx",
  ];

  it("no page invents a heading size", () => {
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      if (ALLOWED.some((a) => path.endsWith(a))) continue;
      const hits = stripComments(text)
        .match(/\btext-(?:lg|xl|2xl|3xl|4xl|5xl)\b/g);
      if (hits) offenders.push(`${path}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders, "Use display / page-title / section / card-title, or "
      + "metric-lg / metric / metric-sm for figures:\n" + offenders.join("\n"))
      .toEqual([]);
  });

  it("has exactly three steps for figures, not five", () => {
    const cfg = src("tailwind.config.js");
    for (const step of ["metric-lg", "metric", "metric-sm"]) {
      expect(cfg).toContain(`"${step}"`);
    }
  });
});

describe("shape stays on the two radii", () => {
  it("no page uses a radius the system does not have", () => {
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      const hits = stripComments(text).match(/\brounded-(?:lg|xl|2xl|3xl)\b/g);
      if (hits) offenders.push(`${path}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders, "8px is rounded-control, 12px is rounded-card:\n"
      + offenders.join("\n")).toEqual([]);
  });

  it("borders use the token, so re-tuning it moves the whole app", () => {
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      // slate-300 survives as the HOVER border — it is in .btn-secondary and
      // .input, so it is part of the system rather than drift.
      const hits = stripComments(text)
        .match(/\bborder-slate-(?:50|100|200|400|500)\b/g);
      if (hits) offenders.push(`${path}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders, "Use border-line / border-line-soft:\n"
      + offenders.join("\n")).toEqual([]);
  });
});

describe("one filter bar, inside the card", () => {
  // Five pages used `.filter-bar`; six floated a `mb-4 flex gap-3` row above
  // the card instead, so the search box hung in the canvas aligned with
  // nothing — and vanished on the empty and loading states, which is exactly
  // when you want to change the filter.
  it("no page floats its own filter row above the list", () => {
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      if (/className="mb-\d flex flex-wrap items-center gap-3">\s*\n\s*<(?:Search|Segmented)/
        .test(stripComments(text))) offenders.push(path);
    }
    expect(offenders, "Put it in a .filter-bar inside the card (PeopleTable "
      + "takes a `toolbar` prop):\n" + offenders.join("\n")).toEqual([]);
  });

  it("the shared list table carries the filter row itself", () => {
    const table = code("components/PeopleTable.tsx");
    expect(table).toContain("toolbar");
    expect(table).toContain('className="filter-bar"');
    // One card whatever the state, so the filter never moves or disappears.
    expect(table).toContain("const shell =");
  });

  it("the pages that had one now pass it through", () => {
    for (const page of ["pages/EmployeesPage.tsx",
      "pages/ChannelPartnersPage.tsx"]) {
      expect(code(page), page).toContain("toolbar={");
    }
    // AMENDED 2026-08-07. `.filter-bar` belongs INSIDE a card, which is still
    // right for every card-based list. A ledger page has no card, so it uses
    // `.ledger-bar` — the same controls and the same rhythm, aligned to the
    // content column instead of to a card's interior padding. What the rule
    // actually forbids is a page inventing its own `mb-4 flex gap-3` row, and
    // that is what the sweep above catches.
    for (const page of ["pages/claims/ClaimsPage.tsx",
      "pages/quotes/QuotesPage.tsx"]) {
      expect(code(page), page).toMatch(/className="(filter|ledger)-bar"/);
    }
  });
});

describe("badges are neutral until they earn a colour", () => {
  it("colours only money and time", () => {
    const ui = code("components/ui.tsx");
    // The four states that legitimately carry a hue.
    expect(ui).toContain('received: "badge-in"');
    expect(ui).toContain('cancelled: "badge-out"');
    expect(ui).toContain('pending: "badge-due"');
    expect(ui).toContain('owner: "badge-ink"');
    // ...and the ordinary ones that used to.
    for (const quiet of ["active", "new", "contacted", "employee", "partner"]) {
      expect(ui, `${quiet} should be quiet`)
        .toContain(`${quiet}: "badge-neutral"`);
    }
  });

  it("does not write its tints inline any more", () => {
    // Scoped to the status map: `Avatar` legitimately uses an inset ring for
    // its disc, and banning the utility outright would forbid that too.
    const ui = code("components/ui.tsx");
    const map = ui.slice(ui.indexOf("const badgeColors"),
                         ui.indexOf("const NEUTRAL_BADGE"));
    expect(map).not.toContain("ring-1 ring-inset ring-");
    expect(map).not.toContain("bg-slate-100 text-slate-600");
  });
});

describe("the app feels like it is listening", () => {
  it("gives every table row a hover, not just the clickable ones", () => {
    // The widest tables in the app — balance sheet, statements, TDS — are
    // read-only, and had no row feedback at all. Your eye had nothing to hold
    // on to across twelve columns.
    const css = src("index.css");
    expect(css).toMatch(/\.card table tbody tr:hover/);
    expect(css).toMatch(/\.card table tbody tr\.cursor-pointer:hover,/);
  });

  it("presses icon buttons as well as buttons", () => {
    expect(src("index.css")).toMatch(/\.icon-btn[\s\S]{0,400}active:scale-95/);
  });

  it("does not draw two focus rings on one input", () => {
    // The base :focus-visible rule sets ring-offset-2; .input wins on width
    // but inherits the offset, so a keyboard-focused field drew a white gap
    // with a hairline outside it while a mouse-focused one did not.
    expect(src("index.css")).toMatch(/\.input[\s\S]{0,500}focus:ring-offset-0/);
  });

  it("still collapses every animation under reduced motion", () => {
    expect(src("index.css")).toContain("prefers-reduced-motion");
  });
});

/*
  THE PROSE SPEC IS GONE, DELIBERATELY (2026-08-07).

  `extras/ui_prompt.txt` and `extras/claude_design_brief.md` were deleted by the
  owner — a second document describing the system had stopped earning its keep,
  because `index.css` and `tailwind.config.js` EXECUTE and a paragraph does not.
  A prose file that disagrees with them is wrong by definition, so the only
  thing it can add is a second place to be out of date.

  The guard test that lived here asserted the file existed. It is gone with the
  file, in the same pass, on purpose: a deleted spec with a live guard is the
  worst of both — a permanently red suite that teaches people to ignore red.

  What replaced it is every other test in this file. They assert against the
  code itself, so they cannot describe a system that is not there.
*/

/* ==========================================================================
   Found by RUNNING the app (2026-08-06). Every one of these was invisible to
   the type checker, the test suite and the production build — they only
   surfaced when 60 screens were screenshotted and looked at.
   ========================================================================== */

describe("policy approval is gone from the client too", () => {
  // The backend deleted `ApprovalStatus`, `approval_status` and `set_approval`
  // on 2026-08-05. The frontend kept 20+ references across 8 files: an
  // "Awaiting approval · 30" filter chip whose count was the SERVER IGNORING an
  // unknown query param and returning every policy, approve/reject buttons, and
  // `policiesApi.setApproval()` calling `PATCH /api/policies/{id}/approval` —
  // an endpoint that does not exist.
  //
  // This is the second time a deleted backend flag left live client readers
  // (see lib/deleteAffordances and the 2026-08-05 note). Hence a test.
  it("calls no endpoint the server does not have", () => {
    expect(code("api/endpoints.ts")).not.toContain("/approval");
    expect(code("api/endpoints.ts")).not.toContain("setApproval");
  });

  it("has no approval filter, badge or row action", () => {
    const policies = code("pages/PoliciesPage.tsx");
    for (const dead of ["Awaiting approval", "approvalF", "setApproval",
      "ApprovePolicyModal", "RejectPolicyModal", "approval_status"]) {
      expect(policies, `PoliciesPage still has ${dead}`).not.toContain(dead);
    }
  });

  it("keeps the fields off the Policy type", () => {
    const types = code("lib/types.ts");
    expect(types).not.toContain("ApprovalStatus");
    expect(types).not.toContain("approval_status");
    expect(types).not.toContain("pending_approvals");
  });

  it("does not tell a partner their policy needs approving", () => {
    expect(code("pages/policies/PolicyFormPage.tsx"))
      .not.toContain("Submit for approval");
    expect(code("pages/renewals/RenewPolicyPage.tsx"))
      .not.toContain("submitted for approval");
  });

  it("leaves CLAIM approval alone — that one is live", () => {
    // Claims genuinely have approved / rejected stages. The removal was
    // policy-specific, and a sweep that took both would have deleted a feature.
    expect(code("pages/claims/ClaimsPage.tsx")).toContain("approved_amount");
    expect(code("components/ui.tsx")).toContain('approved: "badge-in"');
  });
});

describe("a list opens on the whole list", () => {
  it("does not hide the book behind a date filter", () => {
    // Policies defaulted to `current_month`, so opening the page on a book of
    // 30 policies rendered "No policies yet — Create your first policy." A
    // period default belongs on a period REPORT, not on a record list.
    const policies = code("pages/PoliciesPage.tsx");
    expect(policies).toContain('useState<PeriodValue>({ period: "till_date" })');
  });

  it("says 'nothing matches' rather than 'nothing exists' when filtered", () => {
    // The DISTINCTION is what matters and it is now guaranteed for every list
    // rather than re-typed on each: `ListPage` takes `filtered` and picks
    // between the two empty states, and owns the "Clear filters" escape hatch.
    // A page supplies the wording; it cannot forget the branch.
    const shell = code("components/ListPage.tsx");
    expect(shell).toContain("Clear filters");
    expect(shell).toContain("filteredEmpty");
    // Policies still tells the caller which is which.
    const policies = code("pages/PoliciesPage.tsx");
    expect(policies).toContain("No policies match these filters");
    expect(policies).toContain("filtered={filtered}");
    expect(policies).toContain("onClearFilters={clearFilters}");
  });

  it("puts the error branch BEFORE loading and empty, once, for every list",
    () => {
      // Both of those are claims about data that was actually fetched. On one
      // Render instance a cold start is routine, so "No policies yet" over a
      // failed request is a lie about the business. The order lives in the
      // shell now, so a new list page cannot get it wrong.
      const shell = code("components/ListPage.tsx");
      const error = shell.indexOf("query.isError");
      const loading = shell.indexOf("query.isLoading");
      const empty = shell.indexOf("items.length === 0");
      expect(error).toBeGreaterThan(-1);
      expect(error).toBeLessThan(loading);
      expect(loading).toBeLessThan(empty);
    });
});

describe("no second palette hides in JavaScript", () => {
  // The class-level sweep on 2026-08-06 declared "one green, one red, one
  // amber" and was right about Tailwind CLASSES — while the charts and four
  // pages carried hex strings no class check could see: indigo #6366f1, pink
  // #db2777, sky #0ea5e9, a second amber, a second red, and #64748b — the
  // blue-tinted stock slate that tailwind.config.js explicitly retired.
  const HEX = /#(?:[0-9a-fA-F]{3}){1,2}\b/g;
  // The tokens, and only the tokens.
  const ALLOWED = new Set([
    "#18181b", "#27272a", "#1a1b1f", "#3f3f46", "#52525b", "#71717a",
    "#9d9da5", "#d3d3d7", "#e8e8ea", "#f0f0f2", "#f4f4f5", "#fafafa",
    "#16a34a", "#dc2626", "#d97706", "#2563eb",
    // The categorical chart ramp (colors.chart.1..8, 2026-08-19). These are on
    // the list for the same reason the money colours are: they are DEFINED in
    // tailwind.config.js. What this test bans is a hex nobody decided on — an
    // eighth amber invented inline on one page — not colour itself.
    "#4f46e5", "#0d9488", "#db2777", "#7c3aed",
    "#0891b2", "#ea580c", "#65a30d",
  ].map((h) => h.toLowerCase()));

  it("uses only palette values, even inside chart code and print styles", () => {
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      const hits = (stripComments(text).match(HEX) ?? [])
        .map((h) => h.toLowerCase())
        .filter((h) => !ALLOWED.has(h));
      if (hits.length) offenders.push(`${path}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders, "Hex colours must come from the palette — import C from "
      + "components/finance/charts, or use a token:\n" + offenders.join("\n"))
      .toEqual([]);
  });

  it("draws the categorical ramp from the config, not from the page", () => {
    // INVERTED 2026-08-19. This test asserted the ramp was MONOCHROME, which
    // was the right pin for the problem being solved in August (eight ad-hoc
    // hues maintained in JavaScript to colour one bar chart) and the wrong one
    // for the product: six categories in six greys cannot be told apart, and
    // the owner said so.
    //
    // The rule that actually mattered was never "no colour" — it was "no
    // palette that lives outside the tokens". So the pin moves to that: every
    // entry in CAT must be a colour tailwind.config.js defines. Add a hue to
    // one and not the other and this fails, which is the drift the original
    // test existed to catch.
    const charts = code("components/finance/charts.tsx");
    const cfg = src("tailwind.config.js");
    expect(charts).toContain("export const CAT");

    const ramp = charts.slice(charts.indexOf("export const CAT"),
      charts.indexOf("export const catColor"));
    const hues = [...ramp.matchAll(/#[0-9a-f]{6}/gi)]
      .map((m) => m[0].toLowerCase());
    expect(hues.length, "the ramp lost its hues").toBeGreaterThanOrEqual(6);
    for (const hue of hues) {
      expect(cfg.toLowerCase(),
        `${hue} is in CAT but not in tailwind.config.js colors.chart`)
        .toContain(hue);
    }

    // The four semantic colours are NOT category colours. A slice that happens
    // to be `money-in` green sitting in a mix chart claims a profit the slice
    // does not mean — the same confusion `info` blue caused when it drifted
    // into the portal as a decorative "in progress".
    for (const semantic of ["#16a34a", "#dc2626", "#d97706", "#2563eb"]) {
      expect(hues, `${semantic} is a money colour and cannot be categorical`)
        .not.toContain(semantic);
    }
  });

  it("keeps money colours meaning money, on charts too", () => {
    // The colourful ramp is allowed to exist BECAUSE this still holds. A
    // reward-health bar is semantic (received / pending / rejected) and reads
    // green / amber / red; a category mix is identity and reads from CAT.
    const charts = code("components/finance/charts.tsx");
    expect(charts).toContain('green: "#16a34a"');
    expect(charts).toContain('red: "#dc2626"');
    expect(charts).toContain('amber: "#d97706"');
    const reports = code("pages/FinanceReportsPage.tsx");
    // Net profit is money and stays green; policies are a COUNT and no longer
    // have to be graphite to prove it.
    expect(reports).toContain('valueLabel="Net profit" color={C.green}');
    expect(reports).toContain('valueLabel="Policies" color={C.count}');
  });
});

describe("money reads as money", () => {
  it("shows paise only when there are paise", () => {
    // Every figure in the product carried a hard `.00` — two characters of
    // nothing on every number, including on a 390px phone. Dropping them
    // outright would have hidden the genuine fractional paise that
    // reward-on-GST-net produces, so the minimum is 0 and the maximum is 2.
    const fmt = code("lib/format.ts");
    expect(fmt).toContain("minimumFractionDigits: 0");
    expect(fmt).toContain("maximumFractionDigits: 2");
  });

  it("never paints a zero as a profit", () => {
    // `< 0 ? out : in` sends a ZERO down the green branch — which is how
    // "₹0.00" rendered green on Employees > Performance and in the portal.
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      const source = stripComments(text);
      const twoBranch =
        /<\s*0\s*\?\s*"text-money-out"\s*:\s*"text-money-in"/.test(source);
      // A file that returns early on `=== 0` has already handled the zero, so
      // the two-branch shape below it is correct — BanksPage.balanceTone, where
      // a credit card inverts what a positive balance means, is a genuinely
      // different rule rather than a copy of this one.
      const guardsZero = /=== 0\) return/.test(source);
      if (twoBranch && !guardsZero) offenders.push(path);
    }
    expect(offenders, "Use moneyTone()/moneyToneQuiet() — they have the "
      + "three-way branch:\n" + offenders.join("\n")).toEqual([]);
  });
});

/* ==========================================================================
   THE LEDGER, and the two failures that ran alongside it (2026-08-07).

   The 2026-08-06 pass fixed the TOKEN layer and left the PAGE layer free to
   bypass it — which it did, in one specific and mechanical way. These pin the
   fixes so the same drift cannot come back through the same door.
   ========================================================================== */

describe("the page layer cannot out-vote the token layer", () => {
  it("never writes its own <thead> classes", () => {
    // SEVENTEEN files carried the identical string
    //   <thead className="text-left text-xs uppercase tracking-wide
    //                     text-slate-400">
    // Tailwind utilities beat the element selector `.card table thead th`, so
    // on those pages the token header never applied. Two consequences: a
    // SECOND header treatment (12px/400 vs the token's 11px/600), and
    // text-slate-400 — #9d9da5, which measures 2.69:1 on white and fails WCAG
    // AA. The token colour slate-500 (#71717a) measures 4.83:1 and passes.
    const offenders = APP_FILES
      .filter(([, text]) => /<thead\s+className=/.test(text))
      .map(([path]) => path);
    expect(offenders, "Delete the className — `.card table thead th` and "
      + "`.ledger thead th` already supply alignment, casing, padding, border "
      + "and a colour that passes contrast:\n" + offenders.join("\n"))
      .toEqual([]);
  });

  it("does not put font-medium on a table header", () => {
    // `font-medium` (500) beats `text-caption`'s 600, so a header that kept it
    // was a different weight from every header that did not.
    const offenders = APP_FILES
      .filter(([, text]) => /<th className="[^"]*font-medium/.test(text))
      .map(([path]) => path);
    expect(offenders, "The caption token carries its own weight:\n"
      + offenders.join("\n")).toEqual([]);
  });

  it("keeps slate-400 for icons and placeholders, never for text", () => {
    // The system has always said this; 231 usages said otherwise, including
    // `DetailItem`, which labels every value on every record page.
    expect(code("components/ui.tsx"))
      .toMatch(/DetailItem[\s\S]{0,400}text-caption uppercase text-slate-500/);
  });
});

describe("a list is a ledger", () => {
  it("defines the ledger in the token layer, not in a page", () => {
    const css = src("index.css");
    for (const cls of [".ledger-wrap", ".ledger thead th", ".ledger tbody td",
      ".ledger-primary", ".ledger-sub", ".ledger-figure", ".ledger-bar"]) {
      expect(css, `${cls} must live in index.css`).toContain(cls);
    }
  });

  it("gives every row a real keyboard route to its record", () => {
    // Lists navigated from `onClick` on a bare <tr>: not focusable, no Enter
    // handler, no middle-click. A keyboard user could not open a policy AT
    // ALL, and nobody could open two records in two tabs.
    expect(code("components/ui.tsx"))
      .toMatch(/LedgerCell[\s\S]{0,900}<Link/);
    const offenders = APP_FILES
      .filter(([path]) => /pages\/(PoliciesPage|RenewalsPage|quotes\/QuotesPage|claims\/ClaimsPage|customers\/CustomersListPage|leads\/LeadsListPage)\.tsx$/.test(path))
      .filter(([, text]) => !/LedgerCell/.test(stripComments(text)))
      .map(([path]) => path);
    expect(offenders, "Use LedgerCell — it renders the row's <Link>:\n"
      + offenders.join("\n")).toEqual([]);
  });

  it("does not give a clickable row the quiet non-clickable hover", () => {
    // index.css defines two hover strengths on purpose: bg-slate-50/60 for a
    // read-only row, bg-slate-50 for one that navigates. Policies had the
    // quiet one on rows that DID navigate, which inverts the only distinction
    // the rule exists to make.
    const offenders = APP_FILES
      .filter(([, text]) =>
        /cursor-pointer[^"]*hover:bg-slate-50\/60|hover:bg-slate-50\/60[^"]*cursor-pointer/
          .test(stripComments(text)))
      .map(([path]) => path);
    expect(offenders, "A row that navigates uses `.row-link` or `<LedgerRow "
      + "onClick>`:\n" + offenders.join("\n")).toEqual([]);
  });
});

describe("the staff app works on a phone too", () => {
  it("shares ONE card/table shell with the portal", () => {
    // `ListShell` lived in pages/portal/shared.tsx, so the portal had a phone
    // rendering and all 30 staff tables had `overflow-x-auto` and nothing
    // else. It moved to the kit; the portal re-exports it.
    const ui = code("components/ui.tsx");
    expect(ui).toContain("export function ListShell");
    expect(ui).toContain("export function MobileCard");
    expect(code("pages/portal/shared.tsx"))
      .toContain('export { ListShell, MobileCard } from "../../components/ui"');
  });

  it("uses it on the lists somebody would open away from a desk", () => {
    // A page reaches the phone rendering either directly (`ListShell`) or —
    // preferably — through `ListPage`, which renders one for it and cannot be
    // forgotten. Both count; neither is optional.
    for (const page of ["PoliciesPage", "RenewalsPage", "TransactionsPage",
      "BrokersPage", "InsurersPage"]) {
      const src = code(`pages/${page}.tsx`);
      expect(/ListShell|ListPage/.test(src), page).toBe(true);
    }
  });

  it("gives every list page the same skeleton, from one shell", () => {
    // The owner's actual complaint: "each page should have the same type of
    // layouts". Twenty pages independently re-implemented header -> filter bar
    // -> error -> loading -> empty -> rows -> pagination, and they drifted.
    // `ListPage` owns that sequence so sameness is structural, not reviewed.
    const shell = code("components/ListPage.tsx");
    for (const piece of ["PageHeader", "ledger-bar", "ErrorState",
      "TableSkeleton", "EmptyState", "ListShell", "Pagination"]) {
      expect(shell, piece).toContain(piece);
    }
  });

  it("filters with pills that state their own value, not a wall of selects",
    () => {
      // Policies opened on a search box plus FOUR native selects plus a
      // SearchSelect — six controls, every one reading "All …", which is the
      // most template-looking thing a CRM can put at the top of its main
      // screen. A pill shows `Status: Active ×` when set and clears in a click.
      const pill = code("components/FilterPill.tsx");
      expect(pill).toContain("export function FilterPill");
      // The set state is ink-filled, so an active filter is visible across the
      // room; the unset state is a quiet outline.
      expect(pill).toContain("border-ink bg-ink text-white");
      expect(code("pages/PoliciesPage.tsx")).toContain("<FilterPill");
    });

  it("keeps control heights in the system, not in call sites", () => {
    // `.btn` owns 36px and `.input` owns 40px, and the whole point is that a
    // row of mixed controls cannot look ragged. 31 call sites overrode them
    // anyway (h-8 / h-9 / h-11 / h-12), which is how a filter bar ends up with
    // three heights in it.
    const css = src("index.css");
    expect(css).toMatch(/\.btn\s*\{[\s\S]*?h-9/);
    expect(css).toMatch(/\.input\s*\{[\s\S]*?h-10/);
    // `.btn-lg` is the ONE sanctioned larger size — the portal's 44px phone
    // target. A page wanting a big button uses this, not a number.
    expect(css).toMatch(/\.btn-lg\s*\{[\s\S]*?h-11/);

    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      const src = stripComments(text);
      // `(?<![\w-])` so `icon-btn-danger` does not match on its `btn-` — the
      // icon button is its own 32px control and is not what this rule is about.
      if (/className="[^"]*(?<![\w-])(?:input|btn-(?:primary|secondary|danger|ghost))\b[^"]*\sh-\d/
        .test(src)) offenders.push(path);
    }
    expect(offenders, "use .btn-sm / .btn-lg, never a per-call height:\n"
      + offenders.join("\n")).toEqual([]);
  });

  it("gives a ledger row one overflow menu rather than a strip of icons", () => {
    // TransactionsPage had four bare icon buttons in a trailing cell and every
    // other ledger had no row actions at all — so the last column was a
    // different width on every page and renewing a policy meant opening it
    // first.
    const ui = code("components/ui.tsx");
    expect(ui).toContain("export function RowMenu");
    expect(ui).toContain("export function RowMenuItem");
  });

  it("lets you jump to a page instead of clicking next eight times", () => {
    // Pagination was prev / "3 / 16" / next: reaching page 11 of a 240-policy
    // book was eight clicks with no way to reach the end.
    const ui = code("components/ui.tsx");
    expect(ui).toContain("function pageWindow");
    expect(ui).toContain('aria-current={p === page ? "page" : undefined}');
  });
});

describe("the app has a frame, not just a sidebar", () => {
  it("draws a top bar at every width, not only on phones", () => {
    // There was none above `lg`. The only header was `lg:hidden`, so on the
    // screen everybody actually uses there was no breadcrumb, no search field,
    // no bell and no account chip — search was a button in the sidebar and
    // notifications were an item inside the sidebar's user dropdown.
    const bar = code("components/layout/TopBar.tsx");
    expect(bar).toContain("export function TopBar");
    // The BAR is visible at every width. `lg:hidden` still appears inside it —
    // on the drawer toggle and the phone-only logo, which are correct — so the
    // assertion is about the <header> element's own classes, not the file.
    const header = /<header className="([^"]*)"/.exec(bar)?.[1] ?? "";
    expect(header, "the top bar itself must not be breakpoint-hidden")
      .not.toMatch(/hidden|lg:hidden/);
    expect(header).toContain("sticky");
    // It carries all four things.
    expect(bar).toContain('aria-label="Breadcrumb"');
    // The search FIELD, not an event fired at a dialog. It was a button that
    // dimmed the page and opened a palette carrying a second search box; the
    // input now lives in the bar and drops its results underneath itself.
    expect(bar).toContain("<TopBarSearch />");
    // The bell is a real component with its own anchored panel, not an event
    // fired at a widget floating in the bottom-right corner.
    expect(bar).toContain("<NotificationBell />");
    expect(bar).toContain('aria-label="Account menu"');
  });

  it("derives the breadcrumb from the nav config, not from a second list", () => {
    // Two copies of "what is this page called" is how the browser-tab title
    // went stale. The crumb reads NAV, so renaming a section renames both.
    const access = code("lib/access.ts");
    expect(access).toContain("export function crumbsForPath");
    expect(access).toContain("for (const section of NAV)");
    expect(code("components/layout/TopBar.tsx")).toContain("crumbsForPath");
  });

  it("leaves the sidebar as navigation and nothing else", () => {
    // The account tile, the search trigger and the bell all moved out. That is
    // what lets the collapsed rail read as a rail rather than a squeezed
    // control panel.
    const shell = code("components/layout/AppLayout.tsx");
    expect(shell).not.toContain("userTile");
    expect(shell).not.toContain("setMenuOpen");
  });
});

describe("a failure never renders as a fact", () => {
  it("never falls back to zero rupees", () => {
    // BanksPage read `data?.totals.cash_in_hand ?? 0`, so a failed request —
    // routine on ONE Render instance after an idle period — rendered
    // "Cash + bank in hand ₹0" in the largest type on the page. A finance
    // product must not invent a figure; the fallback IS the bug.
    // The pattern was `\w+(\?\.\w+)+`, which required an optional-chain link
    // IMMEDIATELY after the first identifier — so it only ever caught
    // `formatINR(d?.x ?? 0)`. It missed plain dotted access
    // (`formatINR(d.tds_deducted ?? 0)`) and any chain where the `?.` is not in
    // second position (`formatINR(stats.data?.total ?? 0)`). Six live
    // violations sat behind a green suite, including "Total Earnings ₹0" on the
    // Balance Sheet — precisely the bug this test was written for. A guard
    // narrower than its rule is worse than no guard: it certifies the thing it
    // is missing.
    //
    // Now: any member expression, `.` or `?.`, at any depth.
    const ZERO_FALLBACK =
      /formatINR(Short)?\(\s*[\w$]+(\s*\??\.\s*[\w$]+)+\s*\?\?\s*0\s*\)/;
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      const source = stripComments(text);
      if (ZERO_FALLBACK.test(source)) {
        offenders.push(path);
      }
    }
    expect(offenders, "Render an em-dash or ErrorState — never a made-up "
      + "zero:\n" + offenders.join("\n")).toEqual([]);
  });

  it("offers a retry on every list and report", () => {
    for (const page of ["pages/BanksPage.tsx", "pages/TdsPage.tsx",
      "pages/BalanceSheetPage.tsx", "pages/FinanceReportsPage.tsx",
      "pages/TargetsPage.tsx", "pages/DashboardPage.tsx",
      "pages/EntityFinancePage.tsx", "pages/finance/BankStatementPage.tsx"]) {
      expect(code(page), page).toMatch(/isError/);
    }
  });

  it("keeps the empty state a claim about DATA, not about the network", () => {
    // PeopleTable and PartnerRoster knew only "loading" and "no rows", so a
    // dropped connection said "No channel partners yet — add your first one"
    // over a roster of forty.
    expect(code("components/PeopleTable.tsx")).toMatch(/if \(error\)/);
    expect(code("pages/people/PartnerRoster.tsx")).toMatch(/if \(error\)/);
  });
});

describe("motion and semantics", () => {
  it("has no decorative animation on the dashboard search", () => {
    const dash = code("pages/DashboardPage.tsx");
    expect(dash).not.toContain("useTypingPlaceholder");
    expect(dash).not.toContain("Search anything!");
  });

  it("does not nest an interactive element inside another", () => {
    // `<span role="button" tabIndex={0}>` inside a `<button>` is invalid HTML;
    // the inner control is not reliably reachable however the tabIndex reads.
    expect(code("components/notifications/NotificationBell.tsx"))
      .not.toMatch(/role="button"/);
  });
});

/* ------------------------------------------------------------- layering --- */

describe("a dialog covers the app, wherever it was opened from", () => {
  /*
    THE BUG (owner, 2026-08-21): "when I click on a notification, the pop-up of
    notification detailed view opens behind the page".

    It opened behind the notification PANEL, which is an opaque white box in
    exactly the spot the dialog appears. Two causes, and only the second is
    interesting:

      1. the panel was z-50 and the shared Modal z-40;
      2. the top bar is `sticky z-nav`, and a positioned element with a z-index
         creates a STACKING CONTEXT — every descendant is sealed into that one
         layer of the page. The bell lives in the top bar, so its dialog was
         sealed in with it. A full-screen `position: fixed` overlay covers the
         viewport GEOMETRICALLY while still painting inside its ancestor's
         layer, so no z-index could ever have lifted it out.

    Bumping the number would have fixed the symptom and left the trap: the next
    dialog opened from the top bar, or from inside a sticky table head, breaks
    the same way. So the fix is a portal, and these tests guard the portal —
    not the number.
  */

  const zScale = () => {
    const cfg = src("tailwind.config.js");
    const block = cfg.match(/zIndex:\s*\{([\s\S]*?)\n {6}\}/);
    expect(block, "tailwind.config.js must declare a zIndex scale").toBeTruthy();
    const out: Record<string, number> = {};
    for (const [, name, value] of block![1].matchAll(/(\w+):\s*"(\d+)"/g)) {
      out[name] = Number(value);
    }
    return out;
  };

  it("renders the Modal into <body> instead of where it was called", () => {
    const ui = code("components/ui.tsx");
    expect(ui).toContain("createPortal");
    expect(ui).toMatch(/createPortal\(/);
    expect(ui).toContain("document.body");
  });

  it("renders the Confirm dialog into <body> too", () => {
    // It can be raised from inside a Modal, which is itself portalled.
    const confirm = code("components/Confirm.tsx");
    expect(confirm).toContain("createPortal");
    expect(confirm).toContain("document.body");
  });

  it("keeps the confirmation above the dialog that asked the question", () => {
    const z = zScale();
    expect(z.confirm).toBeGreaterThan(z.dialog);
  });

  it("puts a dialog above the whole app frame", () => {
    // The values that actually collided: nav (the seal), panel (the
    // notification list) and menu (the sidebar's own floating chrome).
    const z = zScale();
    for (const below of ["nav", "panel", "menu", "scrim", "raised"]) {
      expect(z.dialog, `dialog must outrank ${below}`)
        .toBeGreaterThan(z[below]);
    }
  });

  it("leaves the toast with the last word", () => {
    // A toast reports what a dialog just did, so it has to clear the dialog.
    const z = zScale();
    expect(z.toast).toBeGreaterThan(z.confirm);
  });

  it("gives the notification panel a LOWER layer than the dialog it opens", () => {
    // The regression, stated directly.
    const z = zScale();
    expect(z.panel).toBeLessThan(z.dialog);
    expect(code("components/notifications/NotificationBell.tsx"))
      .toContain("z-panel");
  });

  it("holds the notification panel open while its detail dialog is up", () => {
    /*
      Falls straight out of the portal: the dialog is no longer inside the
      panel's ref, so every click in it reads as an OUTSIDE click and used to
      shut the panel behind the thing you had just opened. Escape was already
      guarded on `active`; the mouse has to be too.
    */
    const bell = code("components/notifications/NotificationBell.tsx");
    const handler = bell.match(/const onDown = [\s\S]*?\n {4}\};/);
    expect(handler, "NotificationBell must own its outside-click handler")
      .toBeTruthy();
    expect(handler![0]).toContain("if (active) return;");
  });

  it("writes NO hand-picked z-index anywhere in a page or component", () => {
    /*
      The real fix. Nine different values had been chosen by hand in different
      months by different passes, in files that never see each other, and two of
      them finally met. Every layer is a NAMED token now, so a new overlay has
      to say which rung it belongs on rather than guessing a number that clears
      whatever it was tested against.
    */
    const scale = Object.keys(zScale());
    const offenders: string[] = [];
    for (const [path, text] of APP_FILES) {
      for (const [, cls] of stripComments(text).matchAll(/\bz-(\[?[\w.]+\]?)/g)) {
        if (!scale.includes(cls)) offenders.push(`${path}: z-${cls}`);
      }
    }
    expect(offenders, `off-scale z-index:\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  it("keeps index.css on the scale as well", () => {
    const scale = Object.keys(zScale());
    const css = src("index.css").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, cls] of css.matchAll(/\bz-(\[?[\w.]+\]?)/g)) {
      expect(scale, `index.css writes z-${cls}`).toContain(cls);
    }
  });
});
