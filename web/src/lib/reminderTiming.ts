import type { Reminder } from "./types";

/**
 * How a reminder's due date reads in a list cell.
 *
 * "in 2 days" is what someone scanning a pipeline wants; "05-08-2026, 10:00 AM"
 * makes them do the arithmetic themselves. The exact timestamp is still one
 * click away on the lead's own page.
 *
 * IMPORTANT: whether a reminder is OVERDUE or DUE TODAY is decided by the
 * SERVER, against the Indian day boundary, and passed in. This module only
 * phrases the gap — it must never re-derive those two facts from the browser
 * clock, because a laptop in another timezone would then disagree with the bell
 * and the 8am digest about what "today" means.
 */

export interface ReminderTiming {
  /** What the cell says. */
  label: string;
  /** Tone for the text. */
  tone: "overdue" | "today" | "soon" | "later" | "none";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Phrase the distance between now and `dueIso`.
 *
 * `isOverdue` / `isDueToday` come from the server. When the server says
 * overdue, we phrase how long ago regardless of what the local clock thinks —
 * the server is the authority on the fact, we are only wording it.
 */
export function reminderTiming(
  dueIso: string | null | undefined,
  opts: { isOverdue?: boolean; isDueToday?: boolean; now?: Date } = {},
): ReminderTiming {
  if (!dueIso) return { label: "No reminders", tone: "none" };
  const due = new Date(dueIso);
  if (isNaN(due.getTime())) return { label: "No reminders", tone: "none" };

  const now = opts.now ?? new Date();
  const diff = due.getTime() - now.getTime();

  if (opts.isOverdue) {
    const late = Math.max(0, -diff);
    if (late < HOUR) return { label: "Overdue", tone: "overdue" };
    if (late < DAY) {
      return { label: `Overdue by ${plural(Math.floor(late / HOUR), "hour")}`,
        tone: "overdue" };
    }
    return { label: `Overdue by ${plural(Math.floor(late / DAY), "day")}`,
      tone: "overdue" };
  }

  // Due today but not yet passed: say the remaining hours rather than "today",
  // which is less useful at 4pm than "in 2 hours".
  if (opts.isDueToday) {
    if (diff < MINUTE) return { label: "Due now", tone: "today" };
    if (diff < HOUR) {
      return { label: `In ${plural(Math.round(diff / MINUTE), "minute")}`,
        tone: "today" };
    }
    return { label: `In ${plural(Math.round(diff / HOUR), "hour")}`,
      tone: "today" };
  }

  if (diff < HOUR) return { label: "Due now", tone: "today" };
  if (diff < DAY) {
    return { label: `In ${plural(Math.round(diff / HOUR), "hour")}`,
      tone: "soon" };
  }

  const days = Math.round(diff / DAY);
  if (days === 1) return { label: "Tomorrow", tone: "soon" };
  if (days < 7) return { label: `In ${plural(days, "day")}`, tone: "soon" };
  if (days < 14) return { label: "Next week", tone: "later" };
  if (days < 60) {
    return { label: `In ${plural(Math.round(days / 7), "week")}`,
      tone: "later" };
  }
  return { label: `In ${plural(Math.round(days / 30), "month")}`,
    tone: "later" };
}

/** Text colour for a timing tone. Overdue red, due-today amber, rest neutral. */
export const TIMING_TONE_CLASS: Record<ReminderTiming["tone"], string> = {
  overdue: "text-money-out font-medium",
  today: "text-due font-medium",
  soon: "text-slate-700",
  later: "text-slate-500",
  none: "text-slate-400",
};

/**
 * A reminder is a promise about the FUTURE (owner 2026-08-04), so a due date
 * that has already been and gone cannot be saved — it would be born overdue and
 * the bell for it has no moment left to ring in.
 *
 * The same rule is enforced by the API (routers/reminders._ensure_future); this
 * is the copy that stops someone reaching the error in the first place. The
 * 60-second grace matches the server's, so a form that sat open for a beat
 * before Save does not fail on the round trip.
 *
 * `local` is the "yyyy-mm-ddThh:mm" string the date-time field holds.
 */
export const DUE_GRACE_MS = 60_000;

export function isDueInFuture(local: string, now: Date = new Date()): boolean {
  if (!local) return false;
  const due = new Date(local);
  if (isNaN(due.getTime())) return false;
  return due.getTime() > now.getTime() - DUE_GRACE_MS;
}

/** Today, as the yyyy-mm-dd the date picker wants for its `min`. */
export function todayForPicker(now: Date = new Date()): string {
  const d = new Date(now);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

/** Same phrasing, from a full Reminder object. */
export function timingOf(reminder: Reminder, now?: Date): ReminderTiming {
  return reminderTiming(reminder.due_at, {
    isOverdue: reminder.is_overdue,
    isDueToday: reminder.is_due_today,
    now,
  });
}
