// Payroll display rules — labels, badges and the sentences a payslip says.
//
// ONE PLACE, for the same reason `lib/hr.ts` and `lib/tone.ts` exist. Four
// surfaces read a payslip (the employee's own list, the pay run, the HR tab on
// a person's record, and the dashboard strip) and were on the way to four
// answers to "what colour is a finalised payslip". This repo has that scar
// three times over — `tone.ts` once had five implementations of the money sign
// rule, in three different greens.
//
// NOTHING HERE COMPUTES PAY. Every rupee on a payslip is a stored figure the
// server put there (server/app/services/payroll.py); this file formats what
// arrives. A client-side pay rule would be a second definition of the most
// consequential number in the app, and the two would disagree within a release.

import { formatDate } from "./format";
import { dayFullLabel } from "./hr";
import type { PayRunTotals, Payslip, PayslipStatus } from "./types";

export const PAYSLIP_STATUS_LABELS: Record<PayslipStatus, string> = {
  draft: "Draft",
  finalised: "Ready to pay",
  paid: "Paid",
  cancelled: "Cancelled",
};

/**
 * A payslip's badge class.
 *
 * A badge earns colour by meaning MONEY or meaning TIME (2026-08-06), and these
 * mean both: `finalised` is money the agency owes right now, `paid` is money
 * that has moved. `draft` stays grey because a draft is not a claim about
 * anything yet, and `cancelled` stays grey because it is an absence rather than
 * a problem.
 */
export function payslipBadge(status: PayslipStatus): string {
  switch (status) {
    case "finalised": return "badge-due";
    case "paid": return "badge-in";
    default: return "badge-neutral";
  }
}

/**
 * The left-edge rail on a payslip row.
 *
 * Urgency is a rail, never a status column (2026-08-07): forty rows with three
 * amber edges read instantly, forty rows with a chip on each do not. Amber
 * means "somebody still has to pay this".
 */
export function payslipRail(status: PayslipStatus): "due" | undefined {
  return status === "finalised" ? "due" : undefined;
}

/** "2026-08" -> "August 2026". Used wherever a payslip is named. */
export function payslipMonthLabel(month: string): string {
  const [y, m] = (month || "").split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", {
    month: "long", year: "numeric",
  });
}

/**
 * Why this payslip is not simply the full salary, in one clause.
 *
 * The owner asked for "a detailed payslip... total payable amount based on
 * total attendance, attended days, total leaves taken", and the detail is on
 * the payslip itself. This is the one-line version for a LIST, where thirty
 * rows each need a reason and none of them has room for a table.
 *
 * Returns "" when there is nothing to explain — a full month with no deduction
 * needs no sentence, and printing "no deductions" on twenty-eight rows is how a
 * column stops being read.
 */
export function deductionSummary(p: Payslip): string {
  const parts: string[] = [];
  if (p.absent_days) parts.push(`${p.absent_days} absent`);
  if (p.unpaid_leave_days) parts.push(`${p.unpaid_leave_days} unpaid leave`);
  if (p.half_days) parts.push(`${p.half_days} half`);
  if (p.late_penalty_days) parts.push(`${p.late_marks} late`);
  if (p.pre_joining_days) parts.push(`${p.pre_joining_days} before joining`);
  return parts.join(" · ");
}

/**
 * What still stands between this payslip and being paid, if anything.
 *
 * TWO problems ruin a pay run and both are invisible unless said out loud: an
 * employee with no salary on record (whose payslip would be a zero somebody
 * pays), and a register with unresolved days (whose figure will move once the
 * corrections land). Neither is an error — the payslip is correct given what is
 * known — so this reads as a prompt rather than a failure.
 */
export function payslipWarning(p: Payslip): string | null {
  if (p.monthly_salary_paise <= 0) {
    return "No salary on this employee's record, so nothing can be worked out. "
      + "Set it on their profile and generate again.";
  }
  if (p.unresolved_days > 0) {
    return `${p.unresolved_days} day${p.unresolved_days === 1 ? "" : "s"} in `
      + "the register are still unresolved — a missed clock-out, or a day "
      + "nobody has explained. They are not deducted, so this figure may go "
      + "down once they are sorted out.";
  }
  return null;
}

/** Days, without a trailing ".0" on a whole number. */
export function payDays(days: number | null | undefined): string {
  const n = days ?? 0;
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/**
 * Can this payslip still be changed?
 *
 * Finalised means somebody read the figure and committed to it; paid means
 * money moved. Both are refused server-side too — this only decides whether a
 * button is DRAWN, because a control that 403s is worse than one that is absent
 * (the rule PersonDetailBody already follows for Edit).
 */
export function isLocked(p: Payslip): boolean {
  return p.status === "finalised" || p.status === "paid";
}

/* ======================================= the correction window (2026-09-06) */
//
// A month is generated as drafts on the 1st, stays open for a couple of working
// days so somebody can fix the register, and then locks itself. Every sentence
// the app says about that window is written here, because it is said on four
// screens (the pay run, one payslip, the employee's own list, the settings
// page) and four hand-written versions of "locks on the 3rd" is how one of them
// ends up saying "the 2nd".
//
// THE DATE ITSELF IS SERVER-COMPUTED (`payroll.auto_finalise_on`), working days
// and declared holidays included. Nothing here works it out — same rule as the
// money: the client says what arrives.

/** What state the month's correction window is in. */
export type WindowState = "off" | "open" | "closed";

export function windowState(t: PayRunTotals | undefined): WindowState {
  if (!t?.auto_finalise_on) return "off";
  return t.draft > 0 ? "open" : "closed";
}

/**
 * The one-line status of the window, for the top of the pay run.
 *
 * Says the DATE, never "in 2 days" — a relative phrase is read on Monday and
 * acted on on Wednesday, and by then it is wrong. `null` when there is no month
 * on screen yet.
 */
export function windowSentence(t: PayRunTotals | undefined): string | null {
  if (!t) return null;
  if (!t.auto_finalise_on) {
    return "Automatic locking is off. These payslips stay as drafts until "
      + "somebody finalises them.";
  }
  if (t.draft === 0) {
    return "Every payslip for this month is finalised. Nothing is waiting on "
      + "the register.";
  }
  const on = dayFullLabel(t.auto_finalise_on);
  if (t.blocked.length === 0) {
    const ready = t.ready === 1 ? "1 payslip locks" : `${t.ready} payslips lock`;
    return `${ready} automatically on ${on}. Correct the attendance register `
      + "before then and the figures follow.";
  }
  // NOTHING ready is its own sentence. "0 payslips lock automatically on
  // Thu 03 Sep" is the shape of a number that has not been thought about, and
  // this is the one state where the whole month is stuck — it has to read as
  // the to-do it is, not as a countdown.
  if (t.ready === 0) {
    return `Nothing will lock on ${on}. All ${t.blocked.length} `
      + `${t.blocked.length === 1 ? "draft is" : "drafts are"} waiting on `
      + "something first, and stay as drafts until it is sorted out.";
  }
  const ready = t.ready === 1 ? "1 payslip locks" : `${t.ready} payslips lock`;
  return `${ready} automatically on ${on}. ${t.blocked.length} `
    + `${t.blocked.length === 1 ? "is" : "are"} waiting on something first — `
    + "they stay as drafts until it is sorted out.";
}

/**
 * Tone for that sentence: amber only while somebody still has to act.
 *
 * `note-due` is the app's "a clock is running" panel. A closed window with
 * everything locked is not urgent and must not wear amber, or the colour stops
 * meaning anything on the one screen where it matters most.
 */
export function windowTone(t: PayRunTotals | undefined): string {
  const state = windowState(t);
  if (state === "closed") return "note-in";
  if (state === "off") return "note";
  return t && t.blocked.length > 0 ? "note-out" : "note-due";
}

/**
 * How one payslip's own locking reads, on its detail dialog.
 *
 * Four different sentences because four different things are true, and the
 * difference matters to the person reading: a draft that will lock, a draft
 * that will not, one a person locked, and one that locked itself.
 */
export function lockSentence(p: Payslip): string | null {
  if (p.status === "paid") return null;
  if (p.status === "finalised") {
    if (p.auto_finalised && p.finalised_at) {
      return `Locked automatically on ${formatDate(p.finalised_at)}, the `
        + "correction window for this month having closed.";
    }
    if (p.finalised_by_name && p.finalised_at) {
      return `Finalised by ${p.finalised_by_name} on `
        + `${formatDate(p.finalised_at)}.`;
    }
    return null;
  }
  if (p.status !== "draft") return null;
  if (p.blockers?.length) {
    return `This will not lock itself: ${p.blockers.join(", ")}. Sort that out `
      + "and it locks with the rest, or finalise it by hand.";
  }
  if (p.lock_on) {
    return `Locks automatically on ${dayFullLabel(p.lock_on)}. A correction `
      + "raised before then still changes this figure.";
  }
  return null;
}
