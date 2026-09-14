// Popups became pages (owner 2026-08-03).
//
// These read the source rather than rendering, because what they protect is
// structural: that a record view is reachable by URL, that the list navigates
// instead of holding the record in state, and — the one that actually bites —
// that route order still puts static segments ahead of /:id.
//
// The deliberate exceptions are pinned too. Not every popup should be a page,
// and the reasons are easy to forget and undo.

import { describe, expect, it } from "vitest";

// Read through Vite rather than node:fs — the same way the other source-reading
// tests do it, so no @types/node is needed and the paths resolve identically
// under both `vitest` and `tsc`.
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such source file: ${rel}`);
  return text;
}

const app = () => source("App.tsx");

/** Route paths in App.tsx, in declaration order. */
function routeOrder(): string[] {
  return [...app().matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
}

describe("every record view is addressable", () => {
  const RECORD_ROUTES = [
    "/leads/:id",
    "/customers/:id",
    "/policies/:id",
    "/finance/transactions/:id",
    "/people/employees/:id",
    "/people/partners/:id",
    "/audit/:id",
  ];

  it("registers a route for each one", () => {
    const routes = routeOrder();
    for (const path of RECORD_ROUTES) {
      expect(routes, `${path} is not routed`).toContain(path);
    }
  });

  it("guards each one with the same gate as its list", () => {
    // A record page is a second door to the same data; an unguarded one is a
    // permission hole that no list would show you.
    const text = app();
    for (const path of RECORD_ROUTES) {
      const decl = text.slice(text.indexOf(`<Route path="${path}"`));
      expect(decl.slice(0, 220), `${path} is not guarded`).toContain("<Guard");
    }
  });
});

describe("static segments are declared before the dynamic one", () => {
  // /leads/:id will happily match "new" as an id. Order is the only thing
  // stopping the add form resolving to a 404 for a lead called "new".
  const CASES: [string, string][] = [
    ["/leads/new", "/leads/:id"],
    ["/leads/import", "/leads/:id"],
    ["/customers/new", "/customers/:id"],
    ["/customers/import", "/customers/:id"],
  ];

  it.each(CASES)("%s comes before %s", (staticPath, dynamicPath) => {
    const routes = routeOrder();
    const s = routes.indexOf(staticPath);
    const d = routes.indexOf(dynamicPath);
    expect(s, `${staticPath} is missing`).toBeGreaterThanOrEqual(0);
    expect(d, `${dynamicPath} is missing`).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(d);
  });
});

describe("list pages navigate instead of holding a record in state", () => {
  const LISTS = [
    ["pages/leads/LeadsListPage.tsx", "/leads/"],
    ["pages/customers/CustomersListPage.tsx", "/customers/"],
    ["pages/PoliciesPage.tsx", "/policies/"],
    ["pages/TransactionsPage.tsx", "/finance/transactions/"],
    ["pages/AuditPage.tsx", "/audit/"],
  ] as const;

  it.each(LISTS)("%s opens a route", (file, prefix) => {
    expect(source(file)).toContain(prefix);
  });

  it.each(LISTS)("%s no longer renders a detail dialog", (file) => {
    const text = source(file);
    // The state that used to hold the open record.
    expect(text).not.toMatch(/setDetailFor\(|setViewing\(|setView\(/);
  });
});

describe("the record pages share one shell", () => {
  const PAGES = [
    "pages/leads/LeadDetailPage.tsx",
    "pages/customers/CustomerDetailPage.tsx",
    "pages/policies/PolicyDetailPage.tsx",
    "pages/finance/TransactionDetailPage.tsx",
    "pages/people/PersonDetailPage.tsx",
    "pages/audit/AuditDetailPage.tsx",
  ];

  it.each(PAGES)("%s uses RecordPage", (file) => {
    expect(source(file)).toContain("RecordPage");
  });

  it.each(PAGES)("%s names where Back goes", (file) => {
    // backTo is a destination, never history.back() — a pasted link has no
    // history and a dead Back button is worse than none.
    expect(source(file)).toContain("backTo=");
  });

  it.each(PAGES)("%s handles a record that is not there", (file) => {
    // A page commits the URL before the data arrives, so 404 is a state it has
    // to render. A dialog could just decline to open.
    expect(source(file)).toContain("notFound");
  });
});

/** Source with comments removed — the comments in RecordPage explain WHY it
 *  avoids history.back(), and a naive substring check trips over its own
 *  documentation. */
function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the shell never uses browser history for Back", () => {
  it("renders a Link, not a history call", () => {
    const shell = code("components/RecordPage.tsx");
    expect(shell).toContain("<Link");
    expect(shell).not.toContain("history.back");
    expect(shell).not.toContain("navigate(-1)");
  });
});

describe("the form screens are routes too", () => {
  // Owner Q5.1(b): forms become pages, not just record views.
  const FORM_ROUTES = [
    "/leads/new", "/leads/:id/edit",
    "/customers/new", "/customers/:id/edit",
    "/policies/new",
    "/insurers/new", "/insurers/:id/edit",
    "/brokers/new", "/brokers/:id/edit",
    // Teams are gone; a manager's roster is a record page reached by id.
    "/people/managers/:id",
    "/finance/banks/new", "/finance/banks/:id/edit",
    "/finance/banks/transfer",
    "/organization/roles/new", "/organization/roles/:id/edit",
    "/settings/profile", "/settings/email", "/settings/password",
    "/renewals/:id",
  ];

  it("registers every one", () => {
    const routes = routeOrder();
    for (const path of FORM_ROUTES) {
      expect(routes, `${path} is not routed`).toContain(path);
    }
  });

  it("puts /finance/banks/transfer ahead of /finance/banks/:id", () => {
    // "transfer" would otherwise be read as an account id.
    const routes = routeOrder();
    expect(routes.indexOf("/finance/banks/transfer"))
      .toBeLessThan(routes.indexOf("/finance/banks/:id/edit"));
  });
});

describe("per-person screens hang off the person", () => {
  it("routes targets and performance under each kind", () => {
    const routes = routeOrder();
    for (const base of ["/people/employees", "/people/partners"]) {
      expect(routes).toContain(`${base}/:id/targets`);
      expect(routes).toContain(`${base}/:id/performance`);
    }
  });

  it("sends Back to the person, not to the list", () => {
    // You arrived from their record; their record is what you want next.
    for (const f of ["pages/people/PersonTargetsPage.tsx",
      "pages/people/PersonPerformancePage.tsx"]) {
      expect(source(f)).toContain("backTo={`${base}/${id}`}");
    }
  });
});

describe("the conversion is finished", () => {
  // Every <Modal> left in the app, and why. If this list grows, either a popup
  // came back or a new one was added without a reason.
  const ALLOWED = [
    // Confirmations — owner Q5.1: these stay.
    "components/Confirm.tsx",
    // Overlays by nature — owner Q5.5.
    "components/notifications/NotificationBell.tsx",
    // Quick-add inside the policy form: a page would navigate away from the
    // half-filled form these exist to protect.
    "pages/policies/QuickAdd.tsx",
    // Same exception, partner side: "add a customer" sits inside the policy
    // submission form and must not navigate away from it.
    "pages/portal/PortalPolicyFormPage.tsx",
    // Approve / reject a policy: a confirmation with one field.
    "pages/PoliciesPage.tsx",
    // The partner portal's own small dialogs.
    "pages/portal/PortalPages.tsx",
    // FinanceReportsPage is deliberately NOT here any more: its download popup
    // became an inline section at the foot of the page (owner 2026-08-04).
    // Two TILE EXPANSIONS on Finance Overview ("Top 5 —", "Pending to
    // collect/pay"). Not converted, deliberately: they have no identity of
    // their own — what they show is a function of the period, target metric
    // and target-person filters held in page state, so a URL for them would
    // have to encode the entire filter set. They also read from the dashboard
    // query, which the app polls every 15s and which the finance notes call
    // out as performance-sensitive; a separate route with a different query
    // key would fetch it a second time. Revisit if the filters ever move into
    // the URL, at which point both become free.
    "pages/FinanceOverviewPage.tsx",
    // The notice composer. A broadcast has NO identity until it is sent —
    // there is no record to give a URL to — and the whole point of the screen
    // is that you see the audience count and press send without leaving the
    // list you were checking. A route would be a page for a thing that does
    // not exist yet.
    "pages/people/NoticesPage.tsx",
    // Setting one partner's target from the Team tab (2026-08-06). A target
    // is not a record you navigate to: the manager is comparing ten rows and
    // adjusting the one that is behind, and a page would throw away the
    // comparison they opened the tab to make. The full per-person target
    // screen still exists at /people/partners/:id/targets — this is the
    // in-context edit of the row in front of you, and it renders the SAME
    // form (components/TargetGoalsForm) that the page does.
    "components/ManagerRosterPanel.tsx",
    // Setting one person's target from the Targets roster (2026-08-07). The
    // SAME reasoning as the row above, which is the point: this page exists to
    // show thirty people side by side so you can find the two who are behind,
    // and navigating away to a route would discard exactly the comparison you
    // opened it to make. The per-person page still exists at
    // /people/{kind}/:id/targets for arriving from someone's record, and both
    // render the same components/TargetGoalsForm.
    "pages/TargetsPage.tsx",
    // Reconciling an account against the real bank balance (2026-08-07). It is
    // a THREE-FIELD SUBTRACTION against a figure that is on the screen you
    // opened it from — the card's balance, or the balance on the account form.
    // A route would navigate away from the number being disputed and then have
    // to re-state it, which is how the two figures start disagreeing. It is
    // also not a record: nothing is being created that anyone will navigate
    // back to, only one adjustment row that lands in the transaction list.
    "components/finance/ReconcileDialog.tsx",
    // Workplace HR's four dialogs (2026-08-20). All four edit ONE DAY or ONE
    // REQUEST that the user is looking at in a list, and all four would throw
    // away the thing they were opened from if they navigated:
    //
    //   * the manager's day edit and the employee's correction — the register
    //     is a month of thirty-one rows and the whole job is fixing the two
    //     that are wrong WITHOUT losing your place in the other twenty-nine.
    //     They are also not records: a corrected day is the same day it
    //     already was, with no identity of its own to give a URL to.
    //   * applying for leave and adjusting a balance — the form's entire value
    //     is the live cost preview shown against the balance beside it, which
    //     is on the page underneath.
    "components/hr/DayEditors.tsx",
    "components/hr/LeaveForm.tsx",
    // Adding or editing one holiday. Two fields and a date against a list you
    // are reading top to bottom in January; a route per holiday would be a
    // page for a row.
    "pages/hr/HolidaysPage.tsx",
    // The shared shell itself.
    "components/ui.tsx",
    // ONE PAYSLIP, opened from a list of thirty. A payslip is READ, not
    // navigated around: you check the figure, look at the breakdown that
    // explains it, and go back to the next person. A route per payslip would
    // put a page between a pay desk and the next row — and the row it opens
    // from is already a real <Link> carrying `?slip=<id>`, so it is
    // deep-linkable and keyboard-reachable without being a page.
    "components/hr/PayslipDetail.tsx",
    // "Set this person's salary", raised from the pay run's blocked list
    // (2026-09-06). ONE FIELD, and the whole value of it is that it does not
    // leave: the missing salary is discovered ON the pay run, and sending
    // somebody to the employee record to fix it loses the month they were
    // working and the eight other names on the list. It writes through the
    // ordinary `PATCH /api/users/{id}` — the same one the employee record's
    // Edit form uses — so this is a shortcut to an existing page's action,
    // never a second way to set a salary.
    "pages/hr/PayslipsPage.tsx",
    // "Ask to see this policy." Three fields on top of a list you are already
    // reading, raised from a search result — a page would lose the search that
    // produced it. The approval queue it feeds is a VIEW of the Policies page,
    // not a dialog.
    "components/policies/PolicyAccess.tsx",
  ];

  it("leaves no unexplained dialog", () => {
    // Test files are skipped: a test asserting a popup is GONE mentions
    // "<Modal" to say so, and reading that as a popup being present would make
    // this check fire at exactly the person who just removed one.
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([path, text]) => text.includes("<Modal")
        && !ALLOWED.some((a) => path.endsWith(a)))
      .map(([path]) => path);
    expect(offenders, `unexplained <Modal> in:\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  it("deleted the dead policy-finance dialog rather than converting it", () => {
    // It had zero callers. Converting dead code would have been busywork that
    // left a page nothing links to.
    expect(SOURCES["/src/components/PolicyFinanceModal.tsx"]).toBeUndefined();
  });

  it("replaced the two info cards with pages that already existed", () => {
    // A contact card and a partner-profile card, both duplicating a page that
    // was already there. Linking beats building a second version.
    expect(SOURCES["/src/components/PartyContactModal.tsx"]).toBeUndefined();
    expect(SOURCES["/src/components/PartnerProfileModal.tsx"]).toBeUndefined();
    expect(source("pages/FinanceOverviewPage.tsx"))
      .toContain("/finance/entity/");
    expect(source("pages/BalanceSheetPage.tsx"))
      .toContain("/people/partners/");
  });
});

describe("what deliberately stayed a dialog", () => {
  it("keeps confirmations as dialogs", () => {
    // Owner Q5.1: confirmations stay. A full page for "Are you sure?" is worse
    // than what it replaces.
    expect(source("components/Confirm.tsx")).toContain("alertdialog");
  });

  it("keeps the quick-add popups inside the policy form", () => {
    // These exist SO THAT a half-filled policy form is not lost. Turning them
    // into pages would navigate away from the very state they protect — the
    // one place in this conversion where a dialog is the right answer even
    // though a page was possible.
    const form = source("pages/policies/PolicyFormPage.tsx");
    expect(form).toContain("AddCustomerModal");
    expect(form).toContain("AddPartnerQuickModal");
    expect(source("pages/policies/QuickAdd.tsx")).toContain("<Modal");
  });

  it("still books a policy from its own page", () => {
    // The longest form in the app, and the one most likely to be interrupted.
    expect(source("pages/policies/PolicyFormPage.tsx")).toContain("FormPage");
    expect(app()).toContain('<Route path="/policies/new"');
  });

  it("keeps the notification panel as an overlay", () => {
    // Owner Q5.5. It is summoned from anywhere and dismissed without leaving
    // what you were doing — that is what an overlay is for.
    expect(source("components/notifications/NotificationBell.tsx"))
      .toContain("Modal");
  });

  it("search is a field with a dropdown, not a dialog (owner 2026-08-07)", () => {
    // The ⌘K palette is GONE, not hidden. It dimmed the page and rendered a
    // SECOND search box below the one you had just clicked, so the app showed
    // two search fields and the live one was not the one under your cursor.
    // Read through SOURCES, not source(), which throws on a missing file.
    expect(SOURCES["/src/components/GlobalSearch.tsx"]).toBeUndefined();
    const field = source("components/layout/TopBarSearch.tsx");
    expect(field).toBeTruthy();
    // A real input in the bar, and a panel anchored to it rather than a
    // fixed-position overlay with a backdrop.
    expect(field).toContain("<input");
    expect(field).toContain("top-full");
    expect(field).not.toContain("fixed inset-0");
    // Still reachable from the keyboard, which is what the palette was for.
    expect(field).toContain("ArrowDown");
  });
});
