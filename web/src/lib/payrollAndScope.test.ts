// The three things built on 2026-08-24, on the client.
//
//   1. PAYROLL — payslips came back after being dropped four days earlier. The
//      rules here are almost all about what the CLIENT must not do: it displays
//      pay, it never computes it.
//   2. PENDING TRANSACTIONS — "skip" became "pending", and a parked statement
//      line is now a real record in a queue rather than something thrown away
//      with the browser tab.
//   3. POLICY SCOPE + JIT ACCESS — an employee reads their own book, and can
//      discover and ask for what is not theirs.
//
// Every one of these fails SILENTLY if it drifts, which is why they are pinned
// against the source rather than left to be noticed.

import { describe, expect, it } from "vitest";
import { NAV, canAccess, gateForPath, lockedFeatureAt } from "./access";
import {
  PERMISSION_GROUPS, PERMISSION_IMPLIES, expandPermissions,
} from "./types";
import {
  PAYSLIP_STATUS_LABELS, deductionSummary, isLocked, payDays, payslipBadge,
  payslipMonthLabel, payslipRail, payslipWarning,
} from "./payroll";
import type { Payslip } from "./types";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function src(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such file: ${rel}`);
  return text;
}

/** Source with comments stripped, so a rule cannot be "met" by a note about it.
 *  This repo has been bitten the other way too — a sweep that reads comments
 *  fires at the person who just wrote the explanation. */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function payslip(over: Partial<Payslip> = {}): Payslip {
  return {
    id: "p1", code: "PSL-1", user_id: "u1", user_name: "Asha",
    user_code: "USR-1", month: "2026-08",
    monthly_salary_paise: 1_500_000, per_day_paise: 50_000, days_divisor: 30,
    calendar_days: 31, present_days: 26, wfh_days: 0, half_days: 0,
    absent_days: 0, paid_leave_days: 0, unpaid_leave_days: 0,
    week_off_days: 5, holiday_days: 0, not_marked_days: 0, late_marks: 0,
    late_penalty_days: 0, pre_joining_days: 0, worked_minutes: 12_480,
    payable_days: 31, unresolved_days: 0,
    lop_days: 0, deduction_paise: 0, adjustment_paise: 0,
    net_payable_paise: 1_500_000, lines: [],
    status: "draft", generated_at: "2026-09-01T02:30:00Z",
    updated_at: "2026-09-01T02:30:00Z",
    // The correction window (2026-09-06). A fixture payslip is a clean draft
    // that nothing is waiting on, so it locks itself when the window closes.
    auto_finalised: false, blockers: [],
    ...over,
  };
}

/* ================================================================ payroll === */

describe("payroll on the client", () => {
  it("routes the payslips page and unlocks its nav entry", () => {
    // A page written, typed and never routed ships as a 404 — which is exactly
    // what happened to `quotesApi.markBooked`, called from nowhere for weeks.
    expect(code("App.tsx")).toContain("PayslipsPage");
    expect(code("App.tsx")).toContain('path="/hr/payslips"');
    expect(lockedFeatureAt("/hr/payslips")).toBeUndefined();
  });

  it("lets every employee reach their OWN, with no flag", () => {
    // The rule attendance, leave and targets already follow: being told what
    // you are owed is not a privilege. `view_payslips` opens somebody else's.
    const gate = gateForPath("/hr/payslips")!;
    expect(gate.employeeAny).toBe(true);
    expect(gate.anyPerm).toBeUndefined();
    expect(canAccess(gate, "employee", () => false)).toBe(true);
  });

  it("scopes the PAGE rather than issuing a request it knows will 403", () => {
    // The lesson /targets had to learn on 2026-08-21. `GET /run/{month}`
    // refuses a caller without `view_payslips` and is right to, so the page
    // branches instead of asking.
    const page = code("pages/hr/PayslipsPage.tsx");
    expect(page).toContain('const canSeeAll = has("view_payslips")');
    expect(page).toMatch(/enabled:\s*view === "run" && canSeeAll/);
  });

  it("opens the pay run on LAST month, not this one", () => {
    // A pay run is about the month that has FINISHED. Opening on the current
    // one would put a half-built figure in the largest type on the page.
    expect(code("pages/hr/PayslipsPage.tsx"))
      .toContain("shiftMonth(monthKey(new Date()), -1)");
  });

  it("makes every payslip row a real link, not an onClick", () => {
    // "Every row needs a keyboard route" (2026-08-07). Which payslip is open
    // lives in the URL, so it is focusable, opens on Enter, middle-clicks into
    // a tab, and can be sent to somebody.
    const page = code("pages/hr/PayslipsPage.tsx");
    expect(page).toContain("function slipLink");
    expect(page).toContain("to={slipLink(p)}");
    expect(page).toContain('params.get("slip")');
  });

  it("names the people blocking a pay run, and offers the fix", () => {
    // STRENGTHENED on 2026-09-06, not dropped. The original claim was that the
    // page NAMES the blocked people rather than counting them — "3 employees
    // have no salary on record" sends somebody hunting, three names is a to-do
    // list — and it was met by two joined-up sentences built from
    // `missing_salary` / `unresolved_people`.
    //
    // Those sentences said the right thing and then left somebody to go and
    // find the profile or the register themselves, which is how a pay run that
    // is "nearly ready" stays nearly ready for a week. `totals.blocked` now
    // carries a NAME, its REASONS and the ids behind them, so each row can
    // carry the control that fixes it. The claim is the same one, one step
    // further on: named, and actionable.
    const page = code("pages/hr/PayslipsPage.tsx");
    expect(page).toContain("function BlockedList");
    expect(page).toContain("totals.blocked");
    // The name and the reason, on the row.
    expect(page).toContain("{b.name}");
    expect(page).toContain("{b.reasons.join");
    // And a way to act on it without leaving the month.
    expect(page).toContain("Set salary");
    expect(page).toContain("/hr/attendance?view=corrections");
  });

  it("computes no deadline on the client", () => {
    // The date a month locks itself is WORKING days after the month ended, with
    // declared holidays skipped — the server works it out
    // (`payroll.auto_finalise_on`) and the client renders what arrives. A
    // second implementation here would be a deadline the page shows and the job
    // does not honour, which is the one way this feature could lie.
    const rules = code("lib/payroll.ts");
    expect(rules).toContain("t.auto_finalise_on");
    expect(rules).not.toMatch(/getDay\(\)|setDate\(|working_?days/i);
  });

  it("says the date a month locks, never a relative phrase", () => {
    // "in 2 days" is read on Monday and acted on on Wednesday, by which time it
    // is wrong.
    const rules = code("lib/payroll.ts");
    expect(rules).not.toMatch(/in \$\{|days left|tomorrow/i);
  });

  it("renders the lock date as a DAY KEY, not as an instant", () => {
    // `formatDate` takes an instant, and `new Date("2026-09-03")` — a bare day
    // key — is parsed as UTC midnight, which renders as the PREVIOUS day
    // anywhere west of Greenwich. `dayFullLabel` parses local midnight, exactly
    // as the register's own `dayLabel` has always done.
    //
    // A pay deadline shown a day early is the one off-by-one here that costs
    // somebody money: they would think corrections closed before they had.
    const rules = code("lib/payroll.ts");
    expect(rules).toContain("dayFullLabel(t.auto_finalise_on)");
    expect(rules).toContain("dayFullLabel(p.lock_on)");
    expect(rules).not.toContain("formatDate(t.auto_finalise_on)");
    expect(rules).not.toContain("formatDate(p.lock_on)");
    // Timestamps are still instants and still go through formatDate — this is
    // a rule about day keys, not a ban on the shared formatter.
    expect(rules).toContain("formatDate(p.finalised_at)");
  });

  it("tells an employee WHO locked their payslip", () => {
    // Most payslips are now locked by a job rather than a person, and "who
    // decided this?" is the first thing anybody asks about a figure. A blank
    // where a name goes reads as nobody having checked it.
    const rules = code("lib/payroll.ts");
    expect(rules).toContain("Locked automatically on");
    expect(rules).toContain("p.finalised_by_name");
    expect(code("components/hr/PayslipDetail.tsx")).toContain("lockSentence");
  });

  it("never renders a missing salary as ₹0", () => {
    // `formatINR(x ?? 0)` is banned for exactly this reason: a zero here is a
    // record nobody has filled in, and "₹0" claims somebody is unpaid.
    const page = code("pages/hr/PayslipsPage.tsx");
    expect(page).toContain("Not set");
    expect(page).not.toMatch(/formatINR\([^)]*\?\?\s*0\)/);
  });

  it("puts the breakdown next to the figure, never the figure alone", () => {
    // Owner: "a detailed payslip... total payable amount based on total
    // attendance, attended days, total leaves taken, etc." A net figure with no
    // rows is a number an employee has to take on trust.
    const detail = code("components/hr/PayslipDetail.tsx");
    expect(detail).toContain("p.lines.map");
    expect(detail).toContain("How this was worked out");
    expect(detail).toContain("The month");
  });

  it("keeps the transaction detail off the employee's payslip", () => {
    // Owner: "it won't have any specific detail like so-and-so is the
    // transaction used". The pay desk sees the reference; the employee sees
    // that it was paid and when.
    const detail = code("components/hr/PayslipDetail.tsx");
    expect(detail).toContain("canManage && !mine && p.payment_reference");
  });

  it("demands a reason for a manual adjustment", () => {
    // A computed deduction can be traced to a day on the register; a hand-typed
    // adjustment can be traced to nothing at all unless somebody wrote down
    // why — and it is the number an employee asks about first.
    const detail = code("components/hr/PayslipDetail.tsx");
    expect(detail).toContain("note.trim().length < 3");
  });

  it("generates one idempotency key per open pay form", () => {
    // Paying a payslip posts a REAL expense. A double-click, a dropped response
    // and a retry must not pay somebody twice.
    expect(code("components/hr/PayslipDetail.tsx"))
      .toContain("useState(() => crypto.randomUUID())");
  });

  it("says out loud that paying posts a ledger row", () => {
    // It is not a bookkeeping flag on the payslip — it books a salary expense
    // through the same path the Add-transaction form uses, and the person
    // pressing the button should know that before they press it.
    expect(code("components/hr/PayslipDetail.tsx"))
      .toContain("records a salary expense");
  });

  it("offers one pair for payslips, and keeps salary standing alone", () => {
    const keys = PERMISSION_GROUPS.flatMap((g) =>
      g.sections.flatMap((s) => [s.view, s.manage]));
    expect(keys).toContain("view_payslips");
    expect(keys).toContain("manage_payslips");
    expect(keys).toContain("view_salary");
    // `view_salary` is the CONTRACTED figure; `view_payslips` is what somebody
    // was actually paid last month. Different disclosures, different grants.
    expect(PERMISSION_IMPLIES.manage_payslips).toEqual(["view_payslips"]);
    expect(expandPermissions(["manage_payslips"])).toContain("view_payslips");
  });

  it("puts a signpost to the payslip on the employee's own dashboard", () => {
    // A feature nobody can find is a feature nobody has — the lesson the
    // employee Team tab (2026-08-19) and /targets (2026-08-21) both taught.
    const dash = code("pages/DashboardPage.tsx");
    expect(dash).toContain("MyPayslipStrip");
    // And it is silent until there IS one, so a new joiner's dashboard is not
    // carrying an empty box about pay they have not earned.
    expect(dash).toContain("if (!latest) return null");
  });
});

describe("the payroll display rules", () => {
  it("labels every status", () => {
    for (const s of ["draft", "finalised", "paid", "cancelled"] as const) {
      expect(PAYSLIP_STATUS_LABELS[s]).toBeTruthy();
    }
    // "Ready to pay" rather than "Finalised": the word an employee reads should
    // say what happens next, not what a state machine calls it.
    expect(PAYSLIP_STATUS_LABELS.finalised).toBe("Ready to pay");
  });

  it("colours a badge only where it means money or time", () => {
    // A badge earns colour by meaning MONEY or meaning TIME (2026-08-06).
    // A draft is not a claim about anything yet; a cancelled one is an absence
    // rather than a problem.
    expect(payslipBadge("finalised")).toBe("badge-due");
    expect(payslipBadge("paid")).toBe("badge-in");
    expect(payslipBadge("draft")).toBe("badge-neutral");
    expect(payslipBadge("cancelled")).toBe("badge-neutral");
  });

  it("puts urgency on the left edge, and only where somebody must act", () => {
    // Forty rows with three amber edges read instantly; forty rows with a chip
    // on each do not.
    expect(payslipRail("finalised")).toBe("due");
    expect(payslipRail("draft")).toBeUndefined();
    expect(payslipRail("paid")).toBeUndefined();
  });

  it("names a month the way a person says it", () => {
    expect(payslipMonthLabel("2026-08")).toBe("August 2026");
    // A malformed key is returned as-is rather than rendered "Invalid Date".
    expect(payslipMonthLabel("nonsense")).toBe("nonsense");
  });

  it("writes a day count without a trailing .0", () => {
    expect(payDays(31)).toBe("31");
    expect(payDays(30.5)).toBe("30.5");
    expect(payDays(undefined)).toBe("0");
  });

  it("explains a deduction in one clause, and says nothing when there is none", () => {
    // Thirty rows each need a reason and none has room for a table. Printing
    // "no deductions" on twenty-eight of them is how a column stops being read.
    expect(deductionSummary(payslip())).toBe("");
    expect(deductionSummary(payslip({ absent_days: 2, half_days: 1 })))
      .toBe("2 absent · 1 half");
  });

  it("warns about a missing salary and an unsettled register, and nothing else", () => {
    // The two things that ruin a pay run, and both are invisible unless said.
    expect(payslipWarning(payslip())).toBeNull();
    expect(payslipWarning(payslip({ monthly_salary_paise: 0 })))
      .toContain("No salary");
    expect(payslipWarning(payslip({ unresolved_days: 2 })))
      .toContain("unresolved");
  });

  it("locks a finalised or paid payslip", () => {
    // Finalised means somebody committed to the figure; paid means money moved.
    expect(isLocked(payslip({ status: "finalised" }))).toBe(true);
    expect(isLocked(payslip({ status: "paid" }))).toBe(true);
    expect(isLocked(payslip({ status: "draft" }))).toBe(false);
  });
});

/* ==================================================== pending transactions == */

describe("pending transactions", () => {
  const queue = () => code("pages/finance/PendingTransactionsPage.tsx");
  const row = () => code("components/finance/StatementRow.tsx");

  it("is routed, gated and registered before the dynamic transaction route", () => {
    // STATIC BEFORE DYNAMIC — this codebase's oldest routing scar. "/pending"
    // declared after "/:id" would be looked up as a transaction id.
    const app = code("App.tsx");
    expect(app).toContain('path="/finance/transactions/pending"');
    expect(app.indexOf('path="/finance/transactions/pending"'))
      .toBeLessThan(app.indexOf('path="/finance/transactions/:id"'));
    expect(gateForPath("/finance/transactions/pending")?.anyPerm)
      .toContain("view_transactions");
  });

  it("puts the way in on the Transactions page, with the count", () => {
    // Owner: "make sure there is a proper view somewhere on the transactions
    // page where the owner can see the pending actions to take."
    const page = code("pages/TransactionsPage.tsx");
    expect(page).toContain("pendingTxnsApi.count");
    expect(page).toContain("/finance/transactions/pending");
    // Drawn only when something is waiting — a permanent "Pending 0" is a
    // button people stop seeing.
    expect(page).toContain("(pendingCount.data?.open_count ?? 0) > 0");
  });

  it("draws the SAME row card the importer draws", () => {
    // Same question about the same kind of line, booked by the same server
    // function. Two renderings is how the two screens start offering different
    // options for one row.
    expect(queue()).toContain("StatementRowCard");
    expect(code("pages/finance/StatementImportPage.tsx"))
      .toContain("StatementRowCard");
  });

  it("opens on the rows that are WAITING", () => {
    // It is a to-do list, and one that opens on everything you have ever done
    // is one nobody opens twice.
    expect(queue()).toContain('useState<View>("open")');
  });

  it("asks WHY before removing a row, and never deletes it", () => {
    // Owner: "removing any transaction from this import list should also send
    // one pop-up and ask for confirmation because we don't want to delete any
    // of the transactions actually." The dialog collects the explanation rather
    // than merely asking twice.
    const text = queue();
    expect(text).toContain("promptDialog");
    expect(text).toContain("Why is this not ours?");
    // And it can be undone.
    expect(text).toContain("Put it back");
  });

  it("shows money in and out separately, never netted", () => {
    // A Rs 50,000 receipt and a Rs 50,000 payment net to zero, which would read
    // as "nothing outstanding" while two real transactions are missing.
    const text = queue();
    expect(text).toContain("in_paise");
    expect(text).toContain("out_paise");
    expect(text).not.toContain("net_paise > 0");
  });

  it("says where a row came from, on the row", () => {
    // "Which statement was this?" is the first question anybody asks about a
    // line they are seeing three weeks after it was parked.
    const text = queue();
    expect(text).toContain("bank_account_name");
    expect(text).toContain("source_file");
  });

  it("keeps the cross out of the way of the controls", () => {
    // Top-right, which is where the owner asked for it and where it cannot be
    // hit while reaching for the party picker.
    expect(row()).toContain("absolute right-2 top-2");
  });

  it("offers Pending on the importer and not in the queue", () => {
    // A row that is already pending cannot be made more pending. The prop is
    // explicit rather than inferred, so the difference is readable.
    expect(row()).toContain("showPending = true");
    expect(queue()).toContain("showPending={false}");
  });
});

/* ========================================================== policy scope === */

describe("policy scope and JIT access", () => {
  const page = () => code("pages/PoliciesPage.tsx");
  const access = () => code("components/policies/PolicyAccess.tsx");

  it("says what the list is showing, from the SERVER", () => {
    // A scoped list that does not say it is scoped reads as a list with rows
    // missing, and the first assumption is that the software lost them. The
    // sentence comes from the server so the page cannot claim a different
    // scope from the one the query applied.
    expect(access()).toContain("policiesApi.scope()");
    expect(access()).toContain("scope.data.label");
    // And it is silent for anybody who sees everything.
    expect(access()).toContain("if (!scope.data?.scoped) return null");
  });

  it("shows what matched on somebody ELSE's desk, below the results", () => {
    // It answers a different question from the results — "is it not there, or
    // is it not mine?" — and it has to appear on the EMPTY state, which is
    // exactly when that question gets asked.
    expect(page()).toContain("RestrictedMatches");
    expect(page()).toContain("footer={");
    expect(code("components/ListPage.tsx")).toContain("{footer}");
  });

  it("reveals the code, the number and the holder — and nothing else", () => {
    // THE security decision of the feature. This is the one surface in the app
    // that confirms a record exists to somebody who cannot open it.
    const text = access();
    expect(text).toContain("held_by");
    for (const leak of ["customer_name", "premium", "insurer", "reward",
      "sum_insured"]) {
      expect(text, `${leak} must not reach the restricted list`)
        .not.toContain(leak);
    }
  });

  it("points at the person before it points at the queue", () => {
    // The fastest resolution is usually a two-minute conversation. A feature
    // that quietly discourages people from talking to each other is not an
    // improvement on people talking to each other.
    expect(access()).toContain("often faster than waiting for an approval");
  });

  it("does not offer to ask twice for the same policy", () => {
    // Four presses is four rows in an approver's queue about one policy, which
    // is how an approver learns to stop reading it. A REFUSED request stays
    // refused on screen rather than resetting to "Request access".
    const text = access();
    expect(text).toContain('case "pending"');
    expect(text).toContain('case "rejected"');
  });

  it("demands a reason on a request", () => {
    // A request with no reason is one the approver has to chase before they can
    // decide, which makes the whole flow slower than walking over.
    expect(access()).toContain("reason.trim().length < 3");
  });

  it("reads `is_live` from the server rather than doing the arithmetic", () => {
    // A laptop eleven minutes fast would claim access it does not have. The
    // same reasoning as the punch clock reading `server_now`.
    const text = access();
    expect(text).toContain("r.is_live");
    expect(text).not.toMatch(/Date\.now\(\)\s*[<>]/);
  });

  it("keeps access requests a VIEW of the Policies page, not a page", () => {
    // The owner's standing "no random pages for each and every shit thing" —
    // the same call Attendance and Employees already got.
    expect(page()).toContain('sp.get("view") === "access-requests"');
    expect(gateForPath("/policies/access-requests")).toBeUndefined();
  });

  it("carries a locked hit through the top-bar search", () => {
    // Somebody searching a policy number finds out it exists in the place they
    // were already looking, rather than having to know to go somewhere else.
    const results = code("components/SearchResults.tsx");
    expect(results).toContain("h.locked");
    expect(results).toContain("Ask for it");
  });

  it("lands a locked hit on a Policies page that is actually searching", () => {
    // The link carries `?q=` as well as `?request=`, and the page follows the
    // URL when it CHANGES rather than only on mount. Without both halves,
    // clicking a locked hit while already on /policies leaves the search box
    // holding its old value: the restricted panel never renders and the person
    // lands on their own list with nothing explaining why they were sent there.
    const page = code("pages/PoliciesPage.tsx");
    expect(page).toContain("const urlQ = sp.get(\"q\")");
    expect(page).toContain("if (urlQ !== lastUrlQ)");
  });

  it("warns before a reassignment moves an entire book", () => {
    // One dropdown moves every policy a partner ever booked onto somebody
    // else's screens. "12 policies move to Rahul" is a sentence somebody can
    // sanity-check; a toast saying "Saved" afterwards is not.
    const body = code("components/PersonDetailBody.tsx");
    expect(body).toContain("ReassignNotice");
    expect(body).toContain("reassignApi.preview");
    // And it says what does NOT change, which is the half people get wrong.
    expect(body).toContain("Nobody loses credit for what they booked");
  });

  it("puts a partner's own policies on their own record", () => {
    // Owner: "when they go to their channel partner's profile, they should be
    // able to see all the policies that this channel partner has."
    const body = code("components/PersonDetailBody.tsx");
    expect(body).toContain("PartnerPolicies");
    expect(body).toContain('key: "policies"');
    // Reading the ORDINARY list endpoint, so there is no second scope and
    // therefore no second answer to "may I see this".
    expect(code("components/policies/PartnerPolicies.tsx"))
      .toContain("policiesApi.list");
  });

  it("offers both new policy flags in the editor", () => {
    const keys = PERMISSION_GROUPS.flatMap((g) =>
      g.sections.flatMap((s) => [s.view, s.manage]));
    expect(keys).toContain("view_all_policies");
    expect(keys).toContain("manage_policy_access");
    // Seeing the whole book is meaningless without the page it widens.
    expect(expandPermissions(["view_all_policies"])).toContain("view_policies");
    // An approver who cannot open the policy is rubber-stamping a code.
    expect(expandPermissions(["manage_policy_access"]))
      .toContain("view_all_policies");
  });

  it("leaves the Policies nav entry on view_policies", () => {
    // `view_all_policies` widens the page; it does not gate it. Gating the nav
    // on it would hide Policies from every employee on the day this shipped.
    const item = NAV.flatMap((s) => s.items).find((i) => i.to === "/policies")!;
    expect(item.anyPerm).toEqual(["view_policies"]);
  });
});
