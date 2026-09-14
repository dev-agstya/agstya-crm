// Single source of truth for page-level access.
//
// The same rules drive BOTH the sidebar (which links to show) and the router
// (which pages a URL may actually open). Keeping them in one place means a
// hidden nav link and its route can never disagree — hiding a link is cosmetic;
// the route guard is the real enforcement (a user can always type a URL).
//
// RBAC is still enforced server-side on every request; this is defence-in-depth
// + correct UX, not the only gate.

import type { Icon } from "../components/Icon";
import type { AccountType } from "./types";

/* -------------------------------------------------------------- gate model -- */

// Visibility rules. Owner sees everything (except partner-only items); partners
// see only items explicitly flagged for them (their data is own-scoped);
// employees see items marked employeeAny or where they hold one of `anyPerm`.
export interface Gate {
  ownerOnly?: boolean;    // owner only
  partnerOnly?: boolean;   // partners only (e.g. My Wallet)
  partner?: boolean;       // partners can see (their own scope)
  employeeAny?: boolean;  // any employee, no specific permission required
  anyPerm?: string[];     // employee needs one of these (owner always passes)
  // Not live yet. The nav entry is rendered dimmed with a lock and is NOT
  // clickable — there is no page behind it and no route registered, so a typed
  // URL falls through to the locked-path redirect in App.tsx. Kept visible
  // (owner decision) so users can see what is coming, rather than hidden.
  locked?: boolean;
}

export interface NavChild extends Gate {
  label: string;
  to: string; // full route (may carry a ?tab= for the org page)
}

export interface NavItem extends Gate {
  to: string;
  label: string;
  icon: keyof typeof Icon;
  children?: NavChild[];
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/**
 * Can this account open a gated page / see a nav item?
 * Mirrors the server-side permission rules for the UI.
 */
export function canAccess(
  gate: Gate,
  accountType: AccountType | undefined,
  has: (permission: string) => boolean,
): boolean {
  if (gate.partnerOnly) return accountType === "channel_partner";
  if (accountType === "owner") return true; // owner sees everything else
  if (gate.ownerOnly) return false;
  if (accountType === "channel_partner") return !!gate.partner;
  if (accountType === "employee") {
    if (gate.employeeAny) return true;
    return !!gate.anyPerm && gate.anyPerm.some((p) => has(p));
  }
  return false;
}

/* ------------------------------------------------------------- nav config -- */

export const NAV: NavSection[] = [
  {
    title: "Main",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: "Dashboard",
        partner: true, employeeAny: true },
    ],
  },
  {
    // The Channel Partner portal. These are the ONLY entries a partner sees:
    // every staff page below is closed to them in the sidebar AND refused by
    // the API (core/dependencies.get_inhouse_user), so the two can't drift.
    title: "My Business",
    items: [
      { to: "/portal/policies", label: "My Policies", icon: "Policy",
        partnerOnly: true },
      { to: "/portal/renewals", label: "Renewals", icon: "Refresh",
        partnerOnly: true },
      { to: "/portal/quotes", label: "Quote Requests", icon: "Lead",
        partnerOnly: true },
      // Claims are PAUSED (owner 2026-08-19). Locked on the partner's side as
      // well as on staff's: a partner who can file a claim that no staff screen
      // can open is worse off than one who is told the feature is not live yet.
      { to: "/portal/claims", label: "Claims", icon: "Shield",
        partnerOnly: true, locked: true },
      { to: "/portal/earnings", label: "Earnings", icon: "Wallet",
        partnerOnly: true },
      { to: "/portal/notices", label: "Notices", icon: "Bell",
        partnerOnly: true },
    ],
  },
  {
    title: "Work",
    items: [
      { to: "/leads", label: "Leads", icon: "Lead",
        anyPerm: ["view_leads"] },
      { to: "/customers", label: "Customers", icon: "Customers",
        anyPerm: ["view_customers"] },
      { to: "/policies", label: "Policies", icon: "Policy",
        anyPerm: ["view_policies"] },
      { to: "/renewals", label: "Renewals", icon: "Refresh",
        anyPerm: ["view_renewals"] },
      // "My Partners" was here until 2026-08-06. It showed the signed-in
      // employee's own roster — which is now exactly what /people/partners
      // shows them, scoped server-side (owner G1/G2). Two pages rendering the
      // same roster is how the two start disagreeing about what is on it. The
      // URL still resolves; it redirects.
      // Quote requests a channel partner has raised, and claims on policies.
      // Their own pairs since 2026-08-07: handling the partner relationship is
      // a different job from booking policies, and a claims officer has no
      // reason to hold the whole book.
      { to: "/quotes", label: "Quote Requests", icon: "Lead",
        anyPerm: ["view_quotes"] },
      // PAUSED 2026-08-19 (owner). The permission pair, the API, the models and
      // both page components all survive untouched — only the nav entry and the
      // routes are gone, so switching Claims back on is deleting `locked: true`
      // here and restoring the <Route>s. No claim data is deleted.
      { to: "/claims", label: "Claims", icon: "Shield",
        anyPerm: ["view_claims"], locked: true },
      { to: "/tasks", label: "Follow-ups & Tasks", icon: "CheckSquare",
        employeeAny: true, locked: true },
    ],
  },
  {
    title: "Finance",
    items: [
      { to: "/finance", label: "Overview", icon: "Dashboard",
        anyPerm: ["view_finance_overview"] },
      { to: "/finance/reports", label: "Reports", icon: "Report",
        anyPerm: ["view_reports"] },
      { to: "/finance/transactions", label: "Transactions", icon: "Exchange",
        anyPerm: ["view_transactions"] },
      { to: "/finance/balance-sheet", label: "Balance Sheet", icon: "Receipt",
        anyPerm: ["view_balance_sheet"] },
      { to: "/finance/tds", label: "TDS", icon: "Receipt",
        anyPerm: ["view_tds"] },
      // Its own permission, not view_finance: the ledger says who owes what,
      // this says how much money the house is actually holding.
      { to: "/finance/banks", label: "Bank & Cash", icon: "Wallet",
        anyPerm: ["view_bank_accounts"] },
      // Reward outcomes are now set per-policy from the Policies page (the
      // standalone Rewards page was removed).
    ],
  },
  {
    title: "Workplace HR",
    items: [
      // The parent is `employeeAny` because ONE of its children is: every
      // employee has channel partners to work, even without the staff-directory
      // right. Children carry their own gates and are filtered individually
      // (components/layout/AppLayout), so an employee without view_employees sees
      // this group holding only "Channel Partners".
      { to: "/people/partners", label: "People", icon: "Users",
        employeeAny: true,
        children: [
          { to: "/people/employees", label: "Employees",
            anyPerm: ["view_employees"] },
          // NOT behind view_partners (owner G1, 2026-08-06): that permission is for
          // reading the staff directory, and an employee being able to work the
          // partners they personally manage is not a privilege — it is the job.
          // The server scopes the list to the caller's own roster.
          { to: "/people/partners", label: "Channel Partners",
            employeeAny: true },
          // "Relationship Managers" was a nav entry of its own until
          // 2026-08-05. It is now the Performance VIEW of the Employees page
          // (?view=performance) and the Partners TAB on an employee's record —
          // the owner's point being that a roll-up about employees belongs with
          // the employees, not in a third screen. Both old URLs redirect.
          // Broadcasting to partners has its OWN permission: a notice cannot
          // be unsent, so sending one should be a deliberate grant.
          //
          // Paused 2026-09-12, same arrangement as Third Party Services /
          // Claims: no route behind it any more, nav entry kept visible
          // with a lock so people can see it's coming rather than have it
          // vanish. Re-enabling is deleting `locked: true` here and
          // restoring the two routes in App.tsx —
          // `view/manage_announcements` stay in the permission catalogue,
          // dormant, exactly like the Claims flags.
          { to: "/people/notices", label: "Partner Notices",
            anyPerm: ["view_announcements"], locked: true },
        ] },
      // Unlocked 2026-08-07, rebuilt as a roster you click a person on. It was
      // paused on 2026-07-26 because the page it replaced was a spreadsheet of
      // bare number inputs — the owner's note at the time was that targets
      // "could be assigned by clicking on them and no need of this page", and
      // that is now what this page IS. Setting one from a person's own record
      // still works and uses the same form.
      //
      // `employeeAny` since 2026-08-21, and this entry was the whole bug. The
      // owner asked "where does the employee see their own assigned targets, or
      // give targets to the channel partner under it" — and BOTH already
      // worked: their number was on the dashboard, and the server has allowed a
      // relationship manager to set their own roster's targets without
      // `manage_targets` since owner F1 in July. What did not work was FINDING
      // either. This entry required `view_targets`, so the one thing in the
      // sidebar actually called "Targets" was invisible to the people carrying
      // them, and the answer was three levels down a page called Channel
      // Partners. Same failure as the employee Team tab on 2026-08-19: a
      // feature nobody can find is a feature nobody has.
      //
      // Being told your own number is not a privilege — the rule the HR entries
      // below already follow, and the comment under them has claimed targets
      // followed it since 2026-08-20. It is true now. The page scopes itself
      // (pages/TargetsPage): no flag means your own target and your own roster,
      // which are exactly the two things the server already lets you read.
      { to: "/targets", label: "Targets", icon: "Target",
        employeeAny: true },
      // Workplace HR went live 2026-08-20. All three are `employeeAny` and NOT
      // gated on their own flags, which looks wrong for half a second and is
      // the point: everybody reaches their OWN attendance, their own leave and
      // the holiday list with no permission at all (owner G2, the rule targets
      // already follow — being told your own number is not a privilege). The
      // `view_*` flags decide whose numbers you may read once you are on the
      // page, and the server scopes every query to the caller without them.
      { to: "/hr/attendance", label: "Attendance", icon: "Clock",
        employeeAny: true },
      { to: "/hr/leave", label: "Leave", icon: "Calendar",
        employeeAny: true },
      // LIVE since 2026-08-24. It was locked on 2026-08-20 because the owner
      // dropped automated payroll in the same conversation that specified the
      // rest of Workplace HR — and reversed that four days later: "based on
      // the attendance of the employee and the salary which is set of an
      // employee, at the end of month, a salary should be calculated... so that
      // the owner knows how much to pay each employee."
      //
      // `employeeAny` for the same reason Attendance and Leave are: everybody
      // reaches their OWN payslip with no flag. Being told what you are owed is
      // not a privilege, and it is the clearest case of that rule in the app.
      // `view_payslips` opens somebody else's; the page scopes ITSELF and never
      // issues the pay-run request without the flag (pages/hr/PayslipsPage),
      // which is what /targets had to learn on 2026-08-21.
      { to: "/hr/payslips", label: "Payslips", icon: "Receipt",
        employeeAny: true },
      { to: "/hr/holidays", label: "Holidays", icon: "Sun",
        employeeAny: true },
      { to: "/documents", label: "Documents", icon: "Folder",
        employeeAny: true },
    ],
  },
  {
    title: "Administration",
    items: [
      { to: "/organization?tab=roles", label: "Roles & Permissions",
        icon: "Key", anyPerm: ["manage_roles_permissions"] },
      { to: "/insurers", label: "Catalog", icon: "Insurer",
        anyPerm: ["view_insurers", "view_brokers", "view_policy_types"],
        children: [
          { to: "/insurers", label: "Insurers", anyPerm: ["view_insurers"] },
          { to: "/brokers", label: "Brokers", anyPerm: ["view_brokers"] },
          { to: "/insurance/policy-types", label: "Policy Types",
            anyPerm: ["view_policy_types"] },
        ] },
      { to: "/audit", label: "Audit Logs", icon: "Audit",
        anyPerm: ["view_audit_logs"] },
      { to: "/admin/services", label: "Third Party Services", icon: "Bolt",
        ownerOnly: true, locked: true },
      { to: "/system", label: "System & Usage", icon: "Settings",
        ownerOnly: true, locked: true },
    ],
  },
];

/* -------------------------------------------------------------- help menu -- */

// The Help sub-menu in the profile popover. Lives here (not inline in the
// layout) so its locked entries follow exactly the same rule as the sidebar's.
export interface HelpItem {
  to: string;
  label: string;
  locked?: boolean;
}

export const HELP_ITEMS: HelpItem[] = [
  { to: "/help", label: "Help Center" },
  { to: "/help/contact", label: "Contact Support", locked: true },
  { to: "/help/feedback", label: "Feedback", locked: true },
];

/* ------------------------------------------------------------ route gates -- */

// Available to every signed-in account (owner passes any gate anyway).
const ALL_USERS: Gate = { partner: true, employeeAny: true };

// Routes that exist but aren't sidebar items (opened from the user menu, etc.).
const EXTRA_GATES: Record<string, Gate> = {
  "/settings": ALL_USERS,
  "/help": ALL_USERS,
  "/finance/entity": { anyPerm: ["view_balance_sheet"] },
  "/portal/profile": { partnerOnly: true },
  // Submitting / correcting a policy. Not a nav entry — it is reached from the
  // My Policies page. The server still checks `can_submit_policies` on every
  // call, so this gate is the UX half, not the enforcement.
  "/portal/quotes/new": { partnerOnly: true },
  // Retired paths kept ONLY so the redirect in App.tsx can pass the Guard.
  // They render a <Navigate>, never a page.
  "/people/managers": { anyPerm: ["view_employees"] },
  "/people/my-partners": { employeeAny: true },
  // Adding a partner. Not a nav entry — reached from the Channel Partners page,
  // and only shown to manage_partners holders there. Gated the same way here so a
  // typed URL cannot open a form that will 403 on save.
  "/people/partners/new": { anyPerm: ["manage_partners"] },
  // The Channel Partner portal's settings. Owner-only, and reached from
  // Settings since 2026-08-06 — it used to be a button above the Channel
  // Partners list, which is a list of people rather than a place for a master
  // switch that signs all of them out.
  "/settings/partner-portal": { ownerOnly: true },
  // Attendance & leave policy. Owner-only, reached from Settings — the same
  // arrangement the partner portal's settings use, and for the same reason:
  // a set-once screen does not deserve a sidebar entry, but it must not be
  // reachable by typing a URL either.
  "/settings/attendance": { ownerOnly: true },
  // The lead screens that are not nav entries. Each one is guarded in App.tsx
  // with `path="/leads"`, so these exist for gateForPath() completeness rather
  // than to be looked up by their own URL — but a gate that only lives in one
  // of the two places is exactly the drift this map exists to prevent.
  "/leads/new": { anyPerm: ["view_leads"] },
  "/leads/import": { anyPerm: ["view_leads"] },
  // Statement lines nobody could place yet. Reached from the Transactions page
  // and from the end of an import; same gate as the ledger it belongs to, so a
  // typed URL cannot open a queue the caller may not read.
  "/finance/transactions/pending": { anyPerm: ["view_transactions"] },
  // Payslips are `employeeAny` in NAV — everybody reaches their own. The pay
  // run inside the page is what needs view_payslips, and the page scopes itself
  // rather than issuing a request it knows will 403.
};

// path (without query) -> Gate. Derived from NAV so it can never drift from the
// sidebar. Children override their parent for a shared path (e.g. People ->
// /people/employees needs view_employees, not the parent's OR-gate).
export const PAGE_GATES: Record<string, Gate> = (() => {
  const map: Record<string, Gate> = {};
  for (const section of NAV) {
    for (const item of section.items) {
      map[stripQuery(item.to)] = item;
      for (const child of item.children ?? []) map[stripQuery(child.to)] = child;
    }
  }
  return { ...map, ...EXTRA_GATES };
})();

function stripQuery(to: string): string {
  return to.split("?")[0];
}

/** Gate for a router path, or undefined when the path is public/ungated. */
export function gateForPath(path: string): Gate | undefined {
  return PAGE_GATES[stripQuery(path)];
}

/* ----------------------------------------------------------- locked paths -- */

// Every path that is advertised but not built. These have NO route: a typed URL
// or an old bookmark hits the catch-all, which explains itself and sends the
// user to the Dashboard rather than bouncing silently (owner A3).
export const LOCKED_PATHS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const section of NAV)
    for (const item of section.items) {
      if (item.locked) map[stripQuery(item.to)] = item.label;
      for (const child of item.children ?? [])
        if (child.locked) map[stripQuery(child.to)] = child.label;
    }
  for (const item of HELP_ITEMS)
    if (item.locked) map[stripQuery(item.to)] = item.label;
  return map;
})();

/**
 * Label of the coming-soon feature at `path`, or undefined if it isn't one.
 *
 * Matching is by PREFIX, not by exact path. Every locked entry until 2026-08-19
 * was a leaf with nothing under it, so an exact lookup was enough. Claims is the
 * first locked section that had CHILD routes while it was live — /claims/:id and
 * /portal/claims/:id — and somebody has those bookmarked. An exact match sends
 * them to the 404 page ("this address does not exist"), which is the wrong
 * answer: the address is fine, the feature is paused. A prefix match says so.
 *
 * `isPrefixOf` is used rather than startsWith so "/tasks" can never claim
 * "/tasksomething".
 */
export function lockedFeatureAt(path: string): string | undefined {
  const clean = stripQuery(path);
  let best: { depth: number; label: string } | undefined;
  for (const [base, label] of Object.entries(LOCKED_PATHS)) {
    if (isPrefixOf(base, clean) && (!best || base.length > best.depth))
      best = { depth: base.length, label };
  }
  return best?.label;
}

/* ------------------------------------------------------------ breadcrumbs -- */

/**
 * The trail shown in the top bar: "Finance ▸ Bank & Cash".
 *
 * Derived from NAV rather than hand-written per page, so a section renamed in
 * the sidebar is renamed in the breadcrumb by the same edit. Two copies of "what
 * is this page called" is how the browser-tab title used to go stale.
 *
 * Matching is longest-prefix, so a record page (/policies/abc123) inherits its
 * list's trail and a sub-route (/finance/banks/new) resolves to the deepest nav
 * entry that is a prefix of it. The page's own <PageHeader> supplies the leaf,
 * so the crumb deliberately stops at the section: repeating the H1 immediately
 * above itself is noise.
 */
export interface Crumb {
  label: string;
  /** Absent for a section heading, which is a label and not a destination. */
  to?: string;
}

/**
 * Sections that are NOT nav entries but are still real places.
 *
 * Settings, Help and the onboarding wizard are reached from the account menu,
 * not the sidebar, so NAV knows nothing about them — and the breadcrumb came
 * back EMPTY on every one of them. The top bar then showed a trail on
 * /dashboard and a blank space on /settings, which reads as the bar being
 * broken rather than as the page being different.
 *
 * Every trail starts at the Dashboard, so "go back to where I was" is always
 * one click, which is the other half of what a breadcrumb is for.
 */
const OFF_NAV_CRUMBS: Record<string, Crumb[]> = {
  "/settings": [{ label: "Dashboard", to: "/dashboard" },
    { label: "Settings", to: "/settings" }],
  "/help": [{ label: "Dashboard", to: "/dashboard" },
    { label: "Help", to: "/help" }],
  "/onboarding": [{ label: "Set up your account" }],
};

export function crumbsForPath(path: string): Crumb[] {
  const clean = stripQuery(path);
  let best: { depth: number; crumbs: Crumb[] } | undefined;

  for (const [base, crumbs] of Object.entries(OFF_NAV_CRUMBS)) {
    if (isPrefixOf(base, clean) && (!best || base.length > best.depth)) {
      best = { depth: base.length, crumbs };
    }
  }

  const consider = (target: string, crumbs: Crumb[]) => {
    const base = stripQuery(target);
    if (base === "/" || !isPrefixOf(base, clean)) return;
    if (!best || base.length > best.depth) {
      best = { depth: base.length, crumbs };
    }
  };

  for (const section of NAV) {
    for (const item of section.items) {
      if (item.locked) continue;
      consider(item.to, [
        { label: section.title },
        { label: item.label, to: item.to },
      ]);
      for (const child of item.children ?? []) {
        if (child.locked) continue;
        consider(child.to, [
          { label: section.title },
          { label: item.label, to: item.to },
          { label: child.label, to: child.to },
        ]);
      }
    }
  }
  return best ? best.crumbs : [];
}

/** "/finance" is a prefix of "/finance/banks" but NOT of "/financials". */
function isPrefixOf(base: string, path: string): boolean {
  return path === base || path.startsWith(base.endsWith("/") ? base : base + "/");
}
