// Workplace HR — the display rules, in one place.
//
// Every HR surface (the punch panel, the register, the team board, the month
// grid, the employee record's HR tab) needs the same four answers: what colour
// is this status, what does it read as, how long is a duration in words, and
// how do I say a month. Five components each answering them is five places for
// "half day" to be a different grey.
//
// This is the same reasoning behind `lib/tone.ts` owning the money sign rule and
// `components/TargetProgress` owning attainment: a SECOND implementation is not
// a second opinion, it is a bug waiting for somebody to notice the screens
// disagree.
//
// NO MONEY LIVES HERE. The owner dropped automated payroll on 2026-08-20 — this
// module speaks in days, hours and minutes, and `hrModule.test.ts` fails if a
// currency formatter is imported into it.

import type {
  AttendanceStatus, HrRequestStatus, LeaveDayPart, LeaveReasonType,
  WorkLocation,
} from "./types";

/* --------------------------------------------------------------- statuses -- */

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "Present",
  half_day: "Half day",
  absent: "Absent",
  on_leave: "On leave",
  leave_unpaid: "Leave (unpaid)",
  week_off: "Week off",
  holiday: "Holiday",
  wfh: "Work from home",
  // NOT "Absent". A day nobody has resolved yet — today before it finishes, a
  // date in the future, or a missed punch-out waiting on a correction. Calling
  // it absent would be a claim about somebody that has not been established.
  not_marked: "Not marked",
};

/**
 * The badge class for a status.
 *
 * COLOUR IS EARNED, NOT DECORATIVE. The design system's rule is that a badge
 * earns colour by meaning money or meaning time; here the second half applies —
 * green for a day that counted, red for one that did not, amber for one that
 * needs a decision, grey for the office simply being shut. Week off and holiday
 * are the important greys: they are not achievements and not failures, and
 * colouring them would put four coloured chips on every calendar row and leave
 * nothing readable.
 */
export function statusBadge(status: AttendanceStatus): string {
  switch (status) {
    case "present":
    case "wfh":
      return "badge-in";
    case "absent":
    case "leave_unpaid":
      return "badge-out";
    case "half_day":
      return "badge-due";
    case "on_leave":
      return "badge-neutral";
    default:
      return "badge-neutral";
  }
}

/**
 * The row's LEFT EDGE, which is where urgency lives in this app — never a
 * status column (the ledger rule, 2026-08-07).
 *
 * Only two things earn a rail on an attendance row, and both mean "somebody has
 * to do something": a day that did not count, and a day that has not resolved.
 * A register where forty rows all have an edge is a register with no edges.
 */
export function statusRail(
  status: AttendanceStatus,
  opts: { missedPunchOut?: boolean } = {},
): "due" | "out" | undefined {
  if (opts.missedPunchOut) return "due";
  if (status === "absent" || status === "leave_unpaid") return "out";
  if (status === "half_day") return "due";
  return undefined;
}

/**
 * The same rule as `statusBadge`, for a GRID CELL rather than a badge.
 *
 * The month grid draws one letter per day in a 24px square, where a `.badge-*`
 * pill does not fit — but the MEANING has to be identical, or the same Tuesday
 * is green on the grid and grey on the register one click away. So this lives
 * beside `statusBadge` and is switched on the same statuses in the same order,
 * rather than in the component that happens to need it.
 *
 * This is not a hypothetical: it started life as a local `cellTone` inside
 * TeamAttendance.tsx and was caught by `hrModule.test.ts` on the first run.
 */
export function statusCellTone(status: AttendanceStatus): string {
  switch (status) {
    case "present":
    case "wfh":
      return "bg-money-in/10 text-money-in";
    case "absent":
    case "leave_unpaid":
      return "bg-money-out/10 text-money-out";
    case "half_day":
      return "bg-due/10 text-due";
    case "on_leave":
      return "bg-slate-100 text-slate-600";
    default:
      return "text-slate-300";
  }
}

/**
 * One letter per day, for the month grid.
 *
 * Beside the labels for the same reason as the tone above: a grid that calls a
 * half day "H" and a register that calls it "Half day" are the same vocabulary,
 * and they have to change together.
 */
export const STATUS_LETTER: Record<AttendanceStatus, string> = {
  present: "P", half_day: "H", absent: "A", on_leave: "L", leave_unpaid: "LU",
  week_off: "·", holiday: "HO", wfh: "W", not_marked: "–",
};

/** A day the office was never open. Drawn quietly, and never deductible. */
export function isOffDay(status: AttendanceStatus): boolean {
  return status === "week_off" || status === "holiday";
}

/* -------------------------------------------------------------- durations -- */

/**
 * Minutes as "8h 12m" — the way a person says it.
 *
 * Never a decimal ("8.2h" takes arithmetic to read back into a clock) and never
 * bare minutes ("492m" is unreadable past an hour). An em-dash for nothing,
 * matching `formatINR`'s rule that an absent value is never a confident zero.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const m = Math.max(0, Math.round(minutes));
  if (m === 0) return "—";
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  if (rest === 0) return `${h}h`;
  return `${h}h ${rest}m`;
}

/** "10:04" from an ISO instant, in the viewer's local clock. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/** "10:04" -> the HH:MM a time input wants. Blank stays blank. */
export function toTimeInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${
    String(d.getMinutes()).padStart(2, "0")}`;
}

/* ----------------------------------------------------------------- months -- */

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", {
    month: "long", year: "numeric",
  });
}

/** Is `key` the month we are in right now? Drives "this month" affordances. */
export function isCurrentMonth(key: string): boolean {
  return key === monthKey(new Date());
}

/** Today, as the "YYYY-MM-DD" key every HR API speaks in. */
export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")}`;
}

// Monday-first, because the working week here is Monday to Saturday and a
// calendar that starts on Sunday puts the one day off in the middle of the row.
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Thu 13" for a day key — the register's left column. */
export function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  if (isNaN(d.getTime())) return key;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit" });
}

/**
 * "Thu 03 Sep 2026" for a day key — a whole date, for a deadline.
 *
 * NOT `format.formatDate`, and this is the reason: that one takes an INSTANT
 * ("2026-09-03T…Z") and `new Date("2026-09-03")` — a bare day key — is parsed as
 * UTC midnight, which renders as the PREVIOUS day anywhere west of Greenwich.
 * Every day key in this module is an IST calendar day, so it is parsed as local
 * midnight exactly as `dayLabel` above does. A pay deadline shown a day early is
 * the one place that off-by-one would cost somebody money.
 *
 * The weekday is carried deliberately: "before Thursday" is how people talk
 * about a deadline, and it is the half of the sentence that says whether there
 * is a weekend in the way.
 */
export function dayFullLabel(key: string | null | undefined): string {
  if (!key) return "—";
  const d = new Date(`${key}T00:00:00`);
  if (isNaN(d.getTime())) return key;
  return d.toLocaleDateString("en-IN", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric",
  });
}

/* ------------------------------------------------------------------ leave -- */

export const LEAVE_STATUS_LABELS: Record<HrRequestStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Not approved",
  cancelled: "Withdrawn",
};

export function leaveStatusBadge(status: HrRequestStatus): string {
  if (status === "approved") return "badge-in";
  if (status === "rejected") return "badge-out";
  if (status === "pending") return "badge-due";
  return "badge-neutral";
}

export const DAY_PART_LABELS: Record<LeaveDayPart, string> = {
  full: "Full day",
  first_half: "First half",
  second_half: "Second half",
};

export const REASON_LABELS: Record<LeaveReasonType, string> = {
  sick: "Sick",
  personal: "Personal",
  travel: "Travel",
  emergency: "Emergency",
  other: "Other",
};

/**
 * "2 days" / "0.5 days" / "1 day".
 *
 * Halves print as halves rather than as "0.50" — leave is counted in halves and
 * nothing finer, so a trailing zero is noise that also implies a precision the
 * system does not have.
 */
export function formatDays(days: number | null | undefined): string {
  if (days == null) return "—";
  const n = Math.round(days * 2) / 2;
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${text} ${n === 1 ? "day" : "days"}`;
}

/**
 * The tone of a leave BALANCE.
 *
 * A balance is not money, so it does not go through `lib/tone.ts` — but it has
 * the same three-way shape and the same trap: zero is a real answer, not a
 * failure. Green for days in hand, amber for none left (the next leave is
 * unpaid, which is worth knowing before you apply), red only for a genuine
 * negative, which an adjustment can produce.
 */
export function balanceTone(available: number): "in" | "due" | "out" {
  if (available < 0) return "out";
  if (available === 0) return "due";
  return "in";
}

/**
 * The date range a leave covers, said once.
 *
 * A single day prints as one date rather than "13 Aug – 13 Aug", and a half day
 * says which half — that is the difference between the row being scannable and
 * being read twice.
 */
export function leaveRangeLabel(
  start: string, end: string, dayPart: LeaveDayPart,
): string {
  const fmt = (k: string) =>
    new Date(`${k}T00:00:00`).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short",
    });
  if (start === end) {
    return dayPart === "full"
      ? fmt(start)
      : `${fmt(start)} · ${DAY_PART_LABELS[dayPart]}`;
  }
  return `${fmt(start)} – ${fmt(end)}`;
}

/* -------------------------------------------------------------- location -- */

/*
  WHERE a day was worked (owner 2026-08-21).

  Lives here for the same reason every other display rule does: the punch tile,
  the team board and the month register all have to say "at the office" the same
  way. A local `locationLabel` in one component is how "Work from home" becomes
  "WFH" on the screen next door — the exact scar `cellTone` left when the module
  shipped, which was caught on its first run and moved into this file.
*/

export const LOCATION_LABELS: Record<WorkLocation, string> = {
  office: "At the office",
  remote: "Working remotely",
  // NOT "unverified" and never "outside the office". The browser did not tell
  // us, or told us something too vague to place — neither is a claim about
  // where the person actually was, and only one of those readings is even
  // theirs to control.
  unknown: "Location not recorded",
};

/** The short form, for a table cell or a chip where the row already has context. */
export const LOCATION_SHORT: Record<WorkLocation, string> = {
  office: "Office",
  remote: "Remote",
  unknown: "Not recorded",
};

/**
 * The badge class for a work location.
 *
 * Grey for all three, deliberately. A badge earns colour by meaning MONEY or
 * meaning TIME (the 2026-08-06 rule), and where somebody sat is neither. Remote
 * in amber would read as a warning about a full, paid, perfectly ordinary day.
 */
export function locationBadge(_where: WorkLocation): string {
  return "badge-neutral";
}

/** "120 m away" / "1.4 km away" — distance as a person would say it. */
export function formatDistance(metres: number | null | undefined): string {
  if (metres === null || metres === undefined) return "—";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}
