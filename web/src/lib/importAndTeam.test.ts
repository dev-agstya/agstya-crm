// The two screens built on 2026-08-19, and the rules they must not lose.
//
//   * IMPORTING A BANK STATEMENT — a bulk money write, so almost every rule
//     here is about what the screen must NOT do on its own.
//   * AN EMPLOYEE'S TEAM — rebuilt after the owner reported there was nowhere
//     to see one, which there was. A tab nobody can find is a feature nobody
//     has, so half of these pin the SIGNPOSTS rather than the panel.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function src(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such file: ${rel}`);
  return text;
}

/** Source with comments stripped, so a rule cannot be "met" by a note about it. */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/* ------------------------------------------------- the statement importer -- */

describe("importing a bank statement", () => {
  const page = () => code("pages/finance/StatementImportPage.tsx");
  // The row card moved out of the page on 2026-08-24 so the pending queue
  // could draw the identical one.
  const row = () => code("components/finance/StatementRow.tsx");

  it("asks for the account ONCE, not per row", () => {
    // A statement does not name the account inside its rows — the account is
    // what the FILE is. Asking per row would be asking two hundred times, and
    // getting one wrong would put money in an account it never reached.
    const text = page();
    expect(text).toContain("BankAccountSelect");
    expect(text).toContain("Which account is this statement for?");
  });

  it("makes the column mapping checkable, not merely confirmable", () => {
    // Every Indian bank names its columns differently, so the server guesses.
    // Showing the guess next to the file's OWN first rows is what lets somebody
    // see that the column picked as the date really does hold dates — a
    // mis-mapped amount column would book real money wrongly with nothing on
    // screen to notice it by.
    const text = page();
    expect(text).toContain("preview.sample");
    expect(text).toContain("First {preview.sample.length} rows of your file");
  });

  it("never lets the direction be edited", () => {
    // The statement is evidence, not a draft. If the bank says the money left,
    // it left. What a person chooses is who it concerns.
    const text = page();
    expect(text).not.toMatch(/onChange=\{[^}]*direction/);
    expect(text).not.toContain('value={row.direction}');
  });

  it("starts every row PENDING, and a suspected duplicate SKIPPED", () => {
    // INVERTED on 2026-08-24. It used to assert that every row started SKIPPED,
    // which was right when a skipped row was the only alternative to importing
    // it — and wrong once "pending" existed, because a skipped row was counted
    // and then thrown away with the tab.
    //
    // The owner: "instead of skip, I want you to add one thing called pending
    // ... it will push those two pending transactions into a pending
    // transaction list, so that the owner can come back later and fix those."
    //
    // Nothing still posts without an explicit choice — that half is unchanged
    // and is what the `toPost` guard below covers. What changed is where an
    // UNDECIDED row goes, and the safe answer is "somebody looks at this", not
    // "it never existed".
    //
    // The one exception is a row the server believes is ALREADY RECORDED. That
    // is a decision rather than an open question, so parking it would put a
    // known duplicate into a list of real work.
    expect(page()).toContain('action: (r.duplicate_of ? "skip" : "pending")');
  });

  it("offers Pending as a real destination and says where it goes", () => {
    // A row parked into a queue nobody is told about is a row thrown away with
    // extra steps. The screen names the queue, and the commit lands on it.
    const text = page();
    expect(text).toContain("Every row starts as <b>Pending</b>");
    expect(text).toContain("/finance/transactions/pending");
  });

  it("asks before dropping a row from the import altogether", () => {
    // Owner 2026-08-24: "removing any transaction from this import list should
    // also send one pop-up and ask for confirmation because we don't want to
    // delete any of the transactions actually."
    const text = page();
    expect(text).toContain("Remove this transaction?");
    expect(text).toContain("confirmDialog");
    // And it points at the safer answer rather than only warning.
    expect(text).toContain("leave it as Pending instead");
  });

  it("offers a party suggestion and never applies it", () => {
    // A bank narration is machine-written free text; matching it to a customer
    // is a guess, and a guess that assigns itself posts real money against the
    // wrong person.
    //
    // Asserted against the shared ROW component since 2026-08-24 — the card
    // moved there so the pending queue draws the identical thing. See the
    // sharing test below.
    const text = row();
    expect(text).toContain("suggested_terms");
    expect(text).toContain("From the description:");
    // The suggestion is rendered ONLY while nothing is picked — it is a hint
    // for the search box, not a pre-selection.
    expect(text).toContain("!decision.party && facts.suggested_terms.length");
  });

  it("draws the SAME row card as the pending queue", () => {
    // The importer and the queue ask the same question about the same kind of
    // line, and the server books both through the same function
    // (`statement_import._commit_row`). Two renderings of one question is how
    // the two screens end up offering different options for the same row —
    // this repo has that scar in `lib/tone.ts` (five copies of the money sign
    // rule) and in `TargetProgress` (two roundings of one percentage).
    expect(page()).toContain("StatementRowCard");
    expect(code("pages/finance/PendingTransactionsPage.tsx"))
      .toContain("StatementRowCard");
    // And the expense list is defined ONCE, beside the card that offers it,
    // rather than copied into both screens.
    expect(row()).toContain("EXPENSE_CATEGORIES");
    expect(page()).not.toContain('{ value: "salary", label: "Salary" }');
  });

  it("gives every row its own idempotency key", () => {
    // A retried commit — a refreshed tab, a dropped response — re-sends the
    // same keys, so a half-finished import can be repeated instead of doubling
    // everything that got through.
    expect(page()).toContain("crypto.randomUUID()");
  });

  it("never offers a house expense on money coming IN", () => {
    // The server refuses it, and a control that 403s is worse than no control.
    expect(row()).toContain("inbound ? [] : [{ value: \"expense\"");
  });

  it("never lets the direction be edited on the shared card either", () => {
    // The statement is evidence, not a draft — and the card is now where the
    // direction is drawn, so the rule has to be asserted where it lives.
    const text = row();
    expect(text).not.toMatch(/onChange=\{[^}]*direction/);
    expect(text).toContain("inbound ? \"Received\" : \"Paid\"");
  });

  it("confirms before writing, and says what will happen", () => {
    const text = page();
    expect(text).toContain("confirmDialog");
    expect(text).toMatch(/Record \$\{toPost\.length\} transaction/);
  });

  it("reports a partial failure instead of hiding it", () => {
    // The rows that posted are real money movements. Naming the lines that did
    // not is the only way they get fixed.
    expect(page()).toContain("res.failed.length");
    expect(page()).toContain("could not be recorded");
  });

  it("says when the file was longer than one import", () => {
    expect(page()).toContain("preview.truncated");
  });

  it("is registered static-before-dynamic", () => {
    // /finance/transactions/import must come above /finance/transactions/:id
    // or the detail route matches "import" as a transaction id.
    const app = code("App.tsx");
    expect(app.indexOf('"/finance/transactions/import"'))
      .toBeLessThan(app.indexOf('"/finance/transactions/:id"'));
  });

  it("is reachable from the transactions page", () => {
    expect(code("pages/TransactionsPage.tsx")).toContain(
      "/finance/transactions/import");
  });
});

/* ------------------------------------------- correcting a transaction (F2/F3) -- */

describe("a transaction can be corrected, not just re-entered", () => {
  const page = () => code("pages/finance/EditTransactionPage.tsx");

  it("can be moved to a different bank account", () => {
    expect(page()).toContain("BankAccountSelect");
  });

  it("does not auto-pick an account for a legacy row", () => {
    // A row that genuinely has no account must not silently acquire the default
    // one — that moves a balance the person opened the form to CORRECT.
    expect(page()).toContain("autoSelect={false}");
  });

  it("can be re-filed against a different party", () => {
    expect(page()).toContain("PartyPicker");
  });

  it("puts re-filing behind a disclosure", () => {
    // Changing an amount is routine; moving a transaction onto a different
    // customer is a correction that shifts two balances. A picker always on
    // screen is a picker somebody eventually nudges by accident.
    expect(page()).toContain("refiling");
    expect(page()).toContain("Recorded against the wrong person?");
  });

  it("hides re-filing on an expense, which the server refuses", () => {
    expect(page()).toContain('txn.party_type !== "expense"');
  });

  it("edits an EXPENSE through the expense endpoint", () => {
    // The generic ledger patch has no field for the expense CATEGORY or the
    // PAYEE, so a salary keyed under "Rent" could be corrected on its amount
    // and its date and on nothing that made it an expense. The expense
    // endpoint handled both the whole time and nothing routed to it.
    const text = page();
    expect(text).toContain("financeApi.editExpense");
    expect(text).toContain('txn?.txn_type === "expense"');
    expect(text).toContain("EXPENSE_CATEGORIES");
    expect(text).toContain("Paid to (employee)");
  });

  it("only sends a field that actually changed", () => {
    // "" is meaningful on the account (detach), so an unchanged empty value
    // must not be sent as a deliberate clear.
    expect(page()).toContain('accountId !== (txn?.bank_account_id ?? "")');
  });
});

/* --------------------------------------------------------------- the team -- */

describe("an employee's team is findable", () => {
  it("shows the roster size on the directory row", () => {
    // THE fix for the owner's report. Nothing about the old table said a team
    // was behind any particular row, so opening one to check was a gamble.
    expect(code("components/PeopleTable.tsx")).toContain("partners_under");
  });

  it("makes that count the link into the team", () => {
    expect(code("pages/EmployeesPage.tsx")).toContain("?tab=team");
  });

  it("hides the link from anyone who could not open the tab", () => {
    // PersonDetailBody draws no Team tab without view_partners, so offering the
    // button anyway lands on a record with no tab — which looks broken rather
    // than closed.
    expect(code("pages/EmployeesPage.tsx")).toContain('has("view_partners")');
  });

  it("keeps the league table pointing at the same place", () => {
    expect(code("components/ManagerLeague.tsx")).toContain("?tab=team");
  });

  it("is still a TAB, not a page of its own", () => {
    // The owner was explicit about not wanting "random pages for each and every
    // shit thing", and that managers "could have been somewhere on the
    // employee's profile". A separate page walks that back.
    const app = code("App.tsx");
    expect(app).not.toContain("/team");
    expect(code("components/PersonDetailBody.tsx"))
      .toContain("ManagerRosterPanel");
  });
});

describe("what the team view answers", () => {
  const panel = () => code("components/ManagerRosterPanel.tsx");

  it("splits into three views for three different questions", () => {
    const text = panel();
    for (const view of ["overview", "policies", "targets"]) {
      expect(text).toContain(`value: "${view}"`);
    }
  });

  it("shows the manager's own goal above the split", () => {
    expect(panel()).toContain("TargetCard");
  });

  it("says how much of that goal is actually handed out", () => {
    // Both figures were already on this screen and the GAP between them was
    // not, so the one piece of arithmetic that matters had to be done by eye
    // across ten rows.
    const text = panel();
    expect(text).toContain("Allocation");
    expect(text).toContain("unallocated");
    expect(text).toContain("fully allocated");
  });

  it("reports over-allocation without calling it an error", () => {
    // A manager who wants headroom over-allocates on purpose. Flagging it red
    // would be this screen second-guessing them.
    const text = panel();
    expect(text).toContain("over");
    expect(text).not.toMatch(/over-allocated.*text-money-out/);
  });

  it("draws attainment as a RING on the card", () => {
    // A ring is a shape you recognise across a grid of thirty; "62%" is a
    // number you have to read. Same rule, second rendering — never a second
    // rounding: TargetProgress still owns pctLabel and toneFor.
    const card = code("components/team/PartnerCard.tsx");
    expect(card).toContain("TargetRing");
    expect(card).toContain('from "../TargetProgress"');
    expect(card).not.toContain("Math.round(");
  });

  it("distinguishes NO TARGET from 0%", () => {
    // An empty ring claiming "0%" reads as failure when nobody has asked them
    // for anything.
    const card = code("components/team/PartnerCard.tsx");
    expect(card).toContain("row.has_target ?");
    expect(card).toContain("no target");
  });

  it("gives every partner card a keyboard route", () => {
    // Cards navigated from onClick on a div are not focusable, take no Enter
    // and cannot be middle-clicked into a second tab — the same rule
    // LedgerCell follows on every list in the app.
    expect(code("components/team/PartnerCard.tsx")).toContain("<Link to={to}");
  });

  it("shows the actual policies behind the totals", () => {
    // Without it the view could say what a partner was GIVEN and what they
    // TOTALLED and show no line of the business, so "why is that number what it
    // is" meant leaving for /policies and filtering by partner, one at a time.
    const list = code("components/team/TeamPolicies.tsx");
    expect(list).toContain("Ledger");
    expect(list).toContain("their_reward");
  });

  it("keeps the agency's own margin off the team view", () => {
    // `their_reward` is what the PARTNER earns — operational. House profit has
    // its own permission and its own screens.
    const list = code("components/team/TeamPolicies.tsx");
    for (const banned of ["house_profit", "agency_reward", "reward_earned"]) {
      expect(list).not.toContain(banned);
    }
  });

  it("says when the policy list was capped", () => {
    // A footer summing 500 rows under a count of 900 is a spreadsheet that
    // lies quietly.
    expect(code("components/team/TeamPolicies.tsx")).toContain("truncated");
  });

  it("lets the quiet flag be acted on", () => {
    // It was amber text leading nowhere: no way to record that you had rung
    // them, so the same partner was flagged again tomorrow with no memory of
    // yesterday.
    const text = panel();
    expect(text).toContain("remindersApi.create");
    expect(text).toContain('entity_type: "channel_partner"');
  });

  it("defaults a follow-up to a FUTURE time", () => {
    // The bell only looks forward from the moment it runs, so a past due date
    // is born overdue with no moment left to ring in. The server enforces it;
    // defaulting to tomorrow means nobody meets that rule by accident.
    expect(panel()).toContain("tomorrowMorning");
  });

  it("keeps the windowed / current split visible", () => {
    // A partner cannot stop being "quiet" because you switched the filter to
    // This month, and that is invisible unless it is written down.
    expect(panel()).toContain("Balances and renewals are where things stand");
  });

  it("still writes targets through the ONE form", () => {
    // A second form is a second place to get the paise conversion and
    // "blank is not zero" wrong.
    expect(panel()).toContain("TargetGoalsForm");
  });
});
