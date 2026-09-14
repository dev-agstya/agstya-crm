// The Reminders column on the Leads list.
//
// THE RULE THIS PROTECTS: whether a reminder is overdue or due-today is decided
// by the SERVER against the Indian day boundary. This module only phrases the
// gap. If it ever started deciding for itself from the browser clock, a laptop
// in another timezone would disagree with the bell and the 8am digest about
// what "today" means — which is the exact bug the server-side flags exist to
// prevent.

import { describe, expect, it } from "vitest";
import { reminderTiming, timingOf } from "./reminderTiming";
import type { Reminder } from "./types";

const NOW = new Date("2026-08-03T10:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const timing = (iso: string | null | undefined,
  opts: { isOverdue?: boolean; isDueToday?: boolean } = {}) =>
  reminderTiming(iso, { ...opts, now: NOW });

describe("no reminder", () => {
  it("says so rather than leaving the cell blank", () => {
    // An empty cell reads as "not loaded"; the owner asked for words.
    expect(timing(null)).toEqual({ label: "No reminders", tone: "none" });
    expect(timing(undefined).label).toBe("No reminders");
  });

  it("survives a malformed date instead of rendering Invalid Date", () => {
    expect(timing("not-a-date").label).toBe("No reminders");
  });
});

describe("overdue — the server decides, we only word it", () => {
  it("says overdue with no unit under an hour", () => {
    const t = timing(at(-30 * MINUTE), { isOverdue: true });
    expect(t).toEqual({ label: "Overdue", tone: "overdue" });
  });

  it("counts hours, then days", () => {
    expect(timing(at(-3 * HOUR), { isOverdue: true }).label)
      .toBe("Overdue by 3 hours");
    expect(timing(at(-2 * DAY), { isOverdue: true }).label)
      .toBe("Overdue by 2 days");
  });

  it("uses the singular for one", () => {
    expect(timing(at(-1 * HOUR - MINUTE), { isOverdue: true }).label)
      .toBe("Overdue by 1 hour");
    expect(timing(at(-1 * DAY - MINUTE), { isOverdue: true }).label)
      .toBe("Overdue by 1 day");
  });

  it("trusts the server flag even when the local clock disagrees", () => {
    // Due in the future by this browser's clock, but the server — which owns
    // the IST day boundary — says it is overdue. The server wins.
    const t = timing(at(2 * HOUR), { isOverdue: true });
    expect(t.tone).toBe("overdue");
  });

  it("does NOT call something overdue just because the date has passed", () => {
    // No flag from the server: a past timestamp on a reminder the server has
    // not marked overdue must not be coloured red by the browser.
    expect(timing(at(-2 * DAY)).tone).not.toBe("overdue");
  });
});

describe("due today", () => {
  it("counts down in hours, which beats the word 'today' at 4pm", () => {
    expect(timing(at(2 * HOUR), { isDueToday: true }).label).toBe("In 2 hours");
  });

  it("counts minutes in the last hour", () => {
    expect(timing(at(20 * MINUTE), { isDueToday: true }).label)
      .toBe("In 20 minutes");
  });

  it("says due now when it is on top of us", () => {
    expect(timing(at(30_000), { isDueToday: true }).label).toBe("Due now");
  });

  it("is amber, not red", () => {
    expect(timing(at(2 * HOUR), { isDueToday: true }).tone).toBe("today");
  });
});

describe("upcoming", () => {
  it("names tomorrow instead of counting 1 day", () => {
    expect(timing(at(DAY)).label).toBe("Tomorrow");
  });

  it("counts days inside the week", () => {
    expect(timing(at(3 * DAY)).label).toBe("In 3 days");
  });

  it("rolls up to weeks and months so the cell stays short", () => {
    expect(timing(at(10 * DAY)).label).toBe("Next week");
    expect(timing(at(21 * DAY)).label).toBe("In 3 weeks");
    expect(timing(at(90 * DAY)).label).toBe("In 3 months");
  });

  it("greys out the distant ones so the urgent rows stand out", () => {
    expect(timing(at(3 * DAY)).tone).toBe("soon");
    expect(timing(at(30 * DAY)).tone).toBe("later");
  });
});

describe("timingOf, from a whole reminder", () => {
  const reminder = (over: boolean, today: boolean, due: string): Reminder =>
    ({
      id: "r1", entity_type: "lead", entity_id: "l1", title: "Call back",
      due_at: due, assignees: [], assignee_ids: [], status: "open",
      is_overdue: over, is_due_today: today, created_at: due,
    } as Reminder);

  it("reads the server's flags off the object", () => {
    expect(timingOf(reminder(true, false, at(-2 * DAY)), NOW).tone)
      .toBe("overdue");
    expect(timingOf(reminder(false, true, at(2 * HOUR)), NOW).tone)
      .toBe("today");
    expect(timingOf(reminder(false, false, at(3 * DAY)), NOW).label)
      .toBe("In 3 days");
  });
});
