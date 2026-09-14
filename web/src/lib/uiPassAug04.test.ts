// The 2026-08-04 pass, pinned.
//
// Most of these read the SOURCE rather than rendering, for the same reason the
// other sweep tests do: what they protect is a decision (this tile is not for
// the owner, this column holds one card, this figure is gone) which a render
// test would have to reconstruct half the app to observe. Where behaviour is
// actually computable — the future-only due date — it is tested directly.

import { describe, expect, it } from "vitest";
import { isDueInFuture, todayForPicker } from "./reminderTiming";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such source file: ${rel}`);
  return text;
}

/** Source with comments stripped — several of these files EXPLAIN the thing
 *  being asserted absent, and a naive substring check trips over the prose. */
function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/* ---------------------------------------------------------------- dashboard */

describe("the follow-ups tile belongs to employees", () => {
  const dash = () => code("pages/DashboardPage.tsx");

  // REWRITTEN 2026-08-06. The rule is unchanged — the owner runs the desk
  // rather than working the pipeline, so a personal "what do I owe a call on"
  // number is noise on their home page, and the query must not be issued for
  // them either. What changed is HOW: the dashboard used to be one board with
  // a `showFollowUps` flag hiding a tile and disabling a query. It is now two
  // boards (OwnerBoard / EmployeeBoard), so the tile and its query live in the
  // employee's board and the owner's never mounts them at all.
  //
  // A flag-based assertion would now pass on a dashboard that had deleted the
  // tile entirely, which is exactly the kind of test that pins a bug in place.

  it("puts the tile on the employee's board and nowhere else", () => {
    const src = dash();
    const employeeBoard = src.slice(src.indexOf("function EmployeeBoard"));
    const ownerBoard = src.slice(src.indexOf("function OwnerBoard"),
                                src.indexOf("function EmployeeBoard"));
    expect(employeeBoard).toContain("Follow-ups today");
    expect(ownerBoard).not.toContain("Follow-ups");
  });

  it("does not fetch the counts for someone who cannot see them", () => {
    // Hiding the tile but still polling /reminders/counts every 15s would be a
    // request per owner per quarter-minute for a number nothing renders. The
    // query is INSIDE EmployeeBoard, so it is never issued for the owner —
    // a component that does not render does not run its hooks.
    const src = dash();
    const counts = src.indexOf('queryKey: ["reminders", "counts", "mine"]');
    expect(counts).toBeGreaterThan(-1);
    expect(counts).toBeGreaterThan(src.indexOf("function EmployeeBoard"));
  });

  it("splits the owner and the employee into two boards", () => {
    // The whole point of the 2026-08-06 rebuild: three genuinely different home
    // pages, not one with things conditionally hidden.
    expect(dash()).toContain("function OwnerBoard");
    expect(dash()).toContain("function EmployeeBoard");
    expect(dash()).toMatch(
      /isOwner \? <OwnerBoard[\s\S]{0,80}<EmployeeBoard/);
  });

  it("leaves the other tiles alone", () => {
    // Sentence case since 2026-08-06 — the tile labels are `text-caption
    // uppercase`, so Title Case in the string was being uppercased twice.
    for (const label of ["Pending to collect", "Renewals due", "Net profit"]) {
      expect(dash()).toContain(label);
    }
  });
});

/* ---------------------------------------------------------------- lead page */

describe("the lead page has one right-hand column", () => {
  const lead = () => code("pages/leads/LeadDetailPage.tsx");

  it("puts the stage picker in the header actions", () => {
    const text = lead();
    const actions = text.slice(text.indexOf("actions={"),
      text.indexOf("Delete lead"));
    expect(actions).toContain("<select");
    expect(actions).toContain("setStage.mutate");
    // Before Edit, which is what "just before the top edit button" means.
    expect(actions.indexOf("<select"))
      .toBeLessThan(actions.indexOf("/leads/${id}/edit"));
  });

  it("no longer renders a Stage card", () => {
    expect(lead()).not.toContain('<h2 className="card-title">Stage</h2>');
  });

  it("leaves reminders as the only card on the right", () => {
    // Three cards on the whole page now — Details and Comments on the left,
    // Reminders alone on the right. Stage was the fourth.
    const text = lead();
    const cards = [...text.matchAll(/<section className="card">/g)];
    expect(cards).toHaveLength(3);
    expect(text.slice(cards[2].index)).toContain("LeadRemindersPanel");
  });

  it("keeps the stage readable by someone who cannot change it", () => {
    // They get no dropdown, so dropping the pill outright would hide the stage
    // from exactly the people who can only read it.
    expect(lead()).toContain("!d.can_edit && <StatusBadge value={d.stage} />");
  });

  it("keeps the stage-change consequence somewhere on screen", () => {
    expect(lead()).toContain("closes its open reminders");
  });
});

describe("the reminders panel offers Add exactly once", () => {
  const panel = () => code("pages/leads/LeadRemindersPanel.tsx");

  it("drops the second button from the empty state", () => {
    expect(panel()).not.toContain("Set a follow-up");
  });

  it("still routes to the add page from the card head", () => {
    const text = panel();
    expect(text).toContain("/reminders/new");
    expect((text.match(/reminders\/new/g) ?? []).length).toBe(1);
  });
});

/* ----------------------------------------------------------- reminder form */

describe("a reminder can only be set for the future", () => {
  const NOW = new Date("2026-08-04T10:00:00Z");

  it("accepts a later time today", () => {
    expect(isDueInFuture("2026-08-04T18:00", new Date("2026-08-04T09:00:00")))
      .toBe(true);
  });

  it("rejects yesterday", () => {
    expect(isDueInFuture("2026-08-03T10:00", NOW)).toBe(false);
  });

  it("rejects an hour ago", () => {
    expect(isDueInFuture("2026-08-04T09:00", new Date("2026-08-04T10:00:00")))
      .toBe(false);
  });

  it("allows the round-trip grace so a form that sat open still saves", () => {
    // 30 seconds ago, matching the server's 60-second window.
    expect(isDueInFuture("2026-08-04T09:59:30", new Date("2026-08-04T10:00:00")))
      .toBe(true);
  });

  it("treats an empty or unparseable value as not-in-the-future", () => {
    // Not "valid by default": a half-typed date must not enable Save.
    expect(isDueInFuture("", NOW)).toBe(false);
    expect(isDueInFuture("not a date", NOW)).toBe(false);
  });

  it("hands the picker a local yyyy-mm-dd, never a UTC-shifted one", () => {
    // toISOString() on its own would hand back the previous day for any evening
    // in IST, which would let the calendar offer yesterday.
    expect(todayForPicker(new Date("2026-08-04T23:30:00")))
      .toBe("2026-08-04");
    expect(todayForPicker(new Date("2026-08-04T00:15:00")))
      .toBe("2026-08-04");
  });
});

describe("the add-reminder form fits its fields", () => {
  const form = () => code("pages/leads/LeadReminderFormPage.tsx");

  it("uses the wide column", () => {
    expect(form()).toMatch(/\bwide\b/);
  });

  it("stops Save on a past date and says why", () => {
    const text = form();
    expect(text).toContain("isDueInFuture");
    expect(text).toContain("duePast");
    expect(text).toContain("!duePast");
    expect(source("pages/leads/LeadReminderFormPage.tsx"))
      .toContain("Pick a date and time in the future");
  });

  it("limits the calendar to today onwards", () => {
    expect(form()).toContain("minDate={todayForPicker()}");
  });

  it("still lets an already-overdue reminder be edited", () => {
    // Its stored date comes back unchanged; forcing a reschedule to fix a typo
    // would make an overdue follow-up read-only.
    expect(form()).toContain("untouchedDue");
  });

  it("gives the time box room for a 12-hour clock", () => {
    // "10:00 AM" plus the browser's own clock button does not fit in 120px, and
    // no CSS reaches inside a native control to make it.
    const dateInput = code("components/DateInput.tsx");
    expect(dateInput).not.toContain('w-[120px]');
    expect(dateInput).toContain('w-[150px]');
  });
});

/* ------------------------------------------------------------- record tabs */

describe("the record tab strip has no scrollbar of its own", () => {
  const tabs = () => code("components/RecordPage.tsx");

  it("keeps horizontal scrolling for records with many tabs", () => {
    expect(tabs()).toContain("overflow-x-auto");
  });

  it("moves the underline offset off the buttons", () => {
    // overflow-x:auto makes overflow-y compute to auto, so a tab hanging 1px
    // below its scroller draws a VERTICAL scrollbar in the tab strip. The
    // offset belongs to the scroller, which has no parent clipping it.
    const text = tabs();
    const strip = text.slice(text.indexOf("export function RecordTabs"));
    expect(strip).toContain('className="-mb-px flex gap-1 overflow-x-auto');
    // No tab button carries it any more.
    expect(strip).not.toMatch(/-mb-px flex shrink-0 items-center/);
  });

  it("hangs the rule off a wrapper the scroller cannot overflow", () => {
    const strip = tabs().slice(tabs().indexOf("export function RecordTabs"));
    expect(strip).toContain('<div className="border-b border-line">');
  });
});

/* ------------------------------------------------------------ bank accounts */

describe("a bank account card shows one figure", () => {
  const banks = () => code("pages/BanksPage.tsx");

  it("no longer renders lifetime In / Out", () => {
    const text = banks();
    expect(text).not.toContain("total_in_paise");
    expect(text).not.toContain("total_out_paise");
  });

  it("still shows the balance, which is what the page is for", () => {
    expect(banks()).toContain("a.balance_paise");
    expect(banks()).toContain("balanceLabel(a)");
  });

  it("keeps a credit card reading as a liability", () => {
    // is_cash_asset false means the number is money owed; labelling it
    // "Balance" would read as money held.
    expect(banks()).toContain("Outstanding");
    expect(banks()).toContain("is_cash_asset");
  });

  it("uses the money tokens rather than raw tailwind colours", () => {
    const text = banks();
    expect(text).toContain("text-money-out");
    expect(text).not.toContain("text-red-600");
    expect(text).not.toContain("text-green-600");
  });

  it("marks an inactive account rather than only fading it", () => {
    // Opacity alone reads as "still loading".
    expect(banks()).toContain("Inactive");
  });

  it("gives each account type its own glyph", () => {
    const text = banks();
    for (const t of ["bank", "cash", "upi", "credit_card"]) {
      expect(text).toContain(`${t}:`);
    }
  });

  it("keeps the headline totals", () => {
    const text = banks();
    expect(text).toContain("cash_in_hand");
    expect(text).toContain("credit_outstanding");
  });
});
