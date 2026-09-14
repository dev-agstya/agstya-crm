import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { payslipsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Icon } from "../Icon";
import { Field, Modal, Section } from "../ui";
import { DateInput } from "../DateInput";
import { BankAccountSelect } from "../finance/BankAccountSelect";
import { toast } from "../Toast";
import { confirmDialog } from "../Confirm";
import { moneyTone } from "../../lib/tone";
import {
  formatDate, formatINR, paiseToRupeeStr, rupeesToPaise, todayInput,
} from "../../lib/format";
import { formatDuration } from "../../lib/hr";
import {
  PAYSLIP_STATUS_LABELS, lockSentence, payDays, payslipBadge,
  payslipMonthLabel, payslipWarning,
} from "../../lib/payroll";
import { refreshFinance } from "../../lib/live";
import { useAuth } from "../../store/auth";
import type { Payslip } from "../../lib/types";

/*
  ONE PAYSLIP, IN FULL.

  The owner asked for "a detailed payslip... where it will be mentioned things
  like total payable amount based on total attendance, attended days, total
  leaves taken, etc." — so the figure is never on its own. Three blocks, in the
  order somebody reads them:

    1  THE FIGURE      what you are getting, and its status
    2  THE BREAKDOWN   the salary, then every deduction as a named line with a
                       day count. The lines ADD UP to the figure above, which is
                       what makes it checkable rather than something to trust.
    3  THE ATTENDANCE  the day counts the deductions came from, so the argument
                       (if there is one) is about a day and not about a rupee.

  WHAT IT DOES NOT SAY, deliberately: how the money was sent. The owner was
  explicit — "it won't have any specific detail like so-and-so is the
  transaction used". The pay desk sees the reference; the employee sees that it
  was paid and when.
*/

export function PayslipDetail({ payslip, onClose, onChanged, canManage }: {
  payslip: Payslip;
  onClose: () => void;
  onChanged: () => void;
  canManage: boolean;
}) {
  const p = payslip;
  // The 12-count breakdown is real information, but it is not what most
  // people open a payslip to see — they open it for the figure and how it
  // was worked out. Collapsed by default (owner 2026-09-12: "too many
  // numbers everywhere"), one click away for whoever wants to check a day
  // count — except when there's actually something to explain (an absence,
  // unpaid leave, a late mark), in which case it opens already expanded,
  // since that is exactly the moment somebody wants the day counts in front
  // of them rather than behind a click.
  const [showMonth, setShowMonth] = useState(
    payslip.absent_days + payslip.unpaid_leave_days
    + payslip.late_marks > 0);
  const warning = payslipWarning(p);
  // The lock date rides on the PAYSLIP (`lock_on`), not on the screen that
  // opened this dialog — so an employee reading their own draft sees the same
  // deadline the pay desk does. It is their deadline more than anyone's: it is
  // the last day a correction can still change what they are paid.
  const locking = lockSentence(p);
  const mine = useAuth().user?.id === p.user_id;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${payslipMonthLabel(p.month)} — ${p.user_name}`}
      size="lg"
      headerRight={
        <span className={`badge ${payslipBadge(p.status)}`}>
          {PAYSLIP_STATUS_LABELS[p.status]}
        </span>
      }
    >
      <div className="space-y-5">
        {/* 1. The figure. `metric-lg` is the ONE number this screen is about. */}
        <div className="rounded-card border border-line bg-slate-50 px-5 py-4">
          <p className="text-caption uppercase text-slate-500">
            {p.status === "paid" ? "Paid" : "Net payable"}
          </p>
          <p className="mt-1 text-metric-lg tabular-nums text-slate-900">
            {formatINR(p.net_payable_paise)}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {payDays(p.payable_days)} payable days of {p.calendar_days} ·{" "}
            {formatINR(p.per_day_paise)} a day
          </p>
          {p.status === "paid" && p.paid_at && (
            <p className="mt-2 text-sm text-money-in">
              <Icon.Check size={13} className="mr-1 inline align-[-1px]" />
              Paid on {formatDate(p.paid_at)}
              {/* The reference is for the pay desk, not the employee — the
                  owner asked for the payslip to carry no transaction detail. */}
              {canManage && !mine && p.payment_reference
                ? ` · ${p.payment_reference}` : ""}
            </p>
          )}
        </div>

        {warning && (
          <p className="note-due">{warning}</p>
        )}

        {/* WHO DECIDED THIS, AND WHEN. A figure that appeared by itself with
            nothing saying how is the thing an employee distrusts — and after
            2026-09-06 most payslips genuinely are locked by a job rather than a
            person, so saying "it locked itself when the correction window
            closed" is the honest answer to a question they will ask. */}
        {locking && (
          <p className={p.blockers?.length ? "note-out" : "note"}>{locking}</p>
        )}

        {/* 2. The breakdown. Every line signed, and they sum to the figure. */}
        <Section title="How this was worked out">
          <div className="overflow-hidden rounded-control border border-line">
            <table className="w-full">
              <tbody>
                {p.lines.map((line, i) => (
                  <tr key={i} className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-2 text-sm text-slate-700">
                      {line.label}
                      {line.detail && (
                        <span className="ml-2 text-xs text-slate-500">
                          {line.detail}
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right text-sm tabular-nums ${
                      line.amount_paise < 0 ? "text-money-out"
                        : "text-slate-800"}`}>
                      {line.amount_paise < 0 ? "−" : ""}
                      {formatINR(Math.abs(line.amount_paise))}
                    </td>
                  </tr>
                ))}
                {p.adjustment_paise !== 0 && (
                  <tr className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-2 text-sm text-slate-700">
                      Adjustment
                      {p.adjustment_note && (
                        <span className="ml-2 text-xs text-slate-500">
                          {p.adjustment_note}
                        </span>
                      )}
                    </td>
                    {/* `moneyTone`, not `< 0 ? out : in` — that two-branch
                        shape sends a ZERO down the green branch, which is how
                        "₹0.00" once rendered as a profit on two screens. The
                        row is only drawn for a non-zero adjustment anyway; the
                        shared rule is used because a local copy of it is
                        exactly what `lib/tone.ts` exists to prevent. */}
                    <td className={`px-3 py-2 text-right text-sm tabular-nums ${
                      moneyTone(p.adjustment_paise)}`}>
                      {p.adjustment_paise < 0 ? "−" : "+"}
                      {formatINR(Math.abs(p.adjustment_paise))}
                    </td>
                  </tr>
                )}
                <tr className="bg-slate-50">
                  <td className="px-3 py-2.5 text-sm font-semibold
                    text-slate-900">Net payable</td>
                  <td className="px-3 py-2.5 text-right text-metric-sm
                    tabular-nums text-slate-900">
                    {formatINR(p.net_payable_paise)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            A day costs {formatINR(p.per_day_paise)} — the monthly salary
            divided by {p.days_divisor}, so the same absence costs the same in
            every month, long or short. Week offs, holidays and leave covered by
            your balance are not deducted.
          </p>
        </Section>

        {/* 3. The attendance behind it. The argument is about a DAY — but
            most people never need to have that argument, so the twelve
            counts it's built from stay one click away rather than always on
            screen (owner 2026-09-12). */}
        <Section title="The month">
          {showMonth ? (
            <>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
                <Count label="Present" value={p.present_days} />
                <Count label="Work from home" value={p.wfh_days} />
                <Count label="Half days" value={p.half_days} />
                <Count label="Paid leave" value={p.paid_leave_days} />
                <Count label="Unpaid leave" value={p.unpaid_leave_days} />
                <Count label="Absent" value={p.absent_days} />
                <Count label="Week offs" value={p.week_off_days} />
                <Count label="Holidays" value={p.holiday_days} />
                <Count label="Late marks" value={p.late_marks} />
                {p.pre_joining_days > 0 && (
                  <Count label="Before joining" value={p.pre_joining_days} />
                )}
                <Count label="Hours worked"
                  value={formatDuration(p.worked_minutes)} />
                <Count label="Payable days" value={payDays(p.payable_days)}
                  title="Days actually paid for this month — present, work from home, half days, holidays, week offs and covered leave" />
              </div>
              <button type="button" className="btn-ghost btn-sm mt-2 -ml-2"
                onClick={() => setShowMonth(false)}>
                <Icon.ChevronDown size={13} className="rotate-180" />
                Hide the day counts
              </button>
            </>
          ) : (
            <button type="button"
              className="flex w-full items-center justify-between rounded-control
                border border-line px-3 py-2 text-sm text-slate-600
                hover:bg-slate-50"
              onClick={() => setShowMonth(true)}
              title="Present, leave, absent, late — every count the days above
                were worked out from">
              <span>{payDays(p.payable_days)} payable days of {p.calendar_days}
                {" "}— see the full day-by-day breakdown</span>
              <Icon.ChevronDown size={14} className="shrink-0 text-slate-400" />
            </button>
          )}
        </Section>

        {canManage && (
          <PayDeskActions payslip={p} onChanged={onChanged}
            onClose={onClose} />
        )}
      </div>
    </Modal>
  );
}

function Count({ label, value, title }: {
  label: string; value: number | string; title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b
      border-line-soft py-1" title={title}>
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-medium tabular-nums text-slate-800">
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- the pay desk -- */

/**
 * Everything only the pay desk sees: adjust, finalise, reopen, pay.
 *
 * Drawn ONLY with `manage_payslips`, rather than drawn and refused — a control
 * that 403s is worse than one that is absent, which is the rule
 * `PersonDetailBody` already follows for Edit.
 */
function PayDeskActions({ payslip: p, onChanged, onClose }: {
  payslip: Payslip;
  onChanged: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [adjusting, setAdjusting] = useState(false);
  const [paying, setPaying] = useState(false);

  const reopen = useMutation({
    mutationFn: () => payslipsApi.reopen(p.id),
    onSuccess: () => {
      toast.success("Reopened. Regenerate it to pick up the corrected days.");
      onChanged();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const regenerate = useMutation({
    mutationFn: () => payslipsApi.generate({
      month: p.month, user_id: p.user_id, regenerate: true }),
    onSuccess: () => { toast.success("Rebuilt from the register."); onChanged(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const finalise = useMutation({
    mutationFn: () => payslipsApi.finalise(p.month, [p.id]),
    onSuccess: () => {
      toast.success(`${p.user_name} has been told their payslip is ready.`);
      onChanged();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-t border-line
        pt-4">
        {p.status === "draft" && (
          <>
            <button className="btn-secondary btn-sm"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate()}>
              <Icon.Refresh size={14} /> Rebuild from the register
            </button>
            <button className="btn-secondary btn-sm"
              onClick={() => setAdjusting(true)}>
              <Icon.Edit size={14} /> Adjust
            </button>
            <button className="btn-primary btn-sm ml-auto"
              disabled={finalise.isPending || p.monthly_salary_paise <= 0}
              title={p.monthly_salary_paise <= 0
                ? "Set this employee's salary first." : undefined}
              onClick={async () => {
                if (await confirmDialog({
                  title: `Finalise ${p.user_name}'s payslip?`,
                  message: `${p.user_name} will be told that ${
                    formatINR(p.net_payable_paise)} is ready. The figures lock `
                    + "— reopen it if a correction lands afterwards.",
                  confirmLabel: "Finalise",
                })) finalise.mutate();
              }}>
              <Icon.Check size={14} /> Finalise
            </button>
          </>
        )}

        {p.status === "finalised" && (
          <>
            <button className="btn-secondary btn-sm"
              disabled={reopen.isPending}
              onClick={() => reopen.mutate()}>
              Reopen
            </button>
            <button className="btn-primary btn-sm ml-auto"
              onClick={() => setPaying(true)}>
              <Icon.Wallet size={14} /> Record the payment
            </button>
          </>
        )}

        {p.status === "paid" && (
          <p className="text-sm text-slate-500">
            This payslip is paid and its figures are locked. Correct the payment
            on the Transactions page if it was wrong.
          </p>
        )}
      </div>

      {adjusting && (
        <AdjustDialog payslip={p} onClose={() => setAdjusting(false)}
          onDone={onChanged} />
      )}
      {paying && (
        <PayDialog payslip={p} onClose={() => setPaying(false)}
          onDone={() => { refreshFinance(qc); onChanged(); onClose(); }} />
      )}
    </>
  );
}

/* ------------------------------------------------------------- adjustments -- */

function AdjustDialog({ payslip: p, onClose, onDone }: {
  payslip: Payslip; onClose: () => void; onDone: () => void;
}) {
  // Rupees in the box, paise on the wire — through the SHARED converters, not
  // a hand-written `/ 100`. Two reasons: `rupeesToPaise` rounds where a bare
  // multiply would leave 1499.9999999999998 paise, and the module's own test
  // bans arithmetic on a money-named value inside Workplace HR precisely so a
  // pay rule cannot grow on the client.
  const [rupees, setRupees] = useState(
    p.adjustment_paise ? paiseToRupeeStr(p.adjustment_paise) : "");
  const [note, setNote] = useState(p.adjustment_note ?? "");

  const save = useMutation({
    mutationFn: () => payslipsApi.adjust(
      p.id, rupeesToPaise(Number(rupees || 0)), note.trim()),
    onSuccess: () => { toast.success("Adjusted."); onDone(); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Modal open onClose={onClose} title="Adjust this payslip" size="sm">
      <form className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Amount"
          hint="A bonus, an advance being recovered, a month somebody agreed to
            make good. Use a minus sign to take money off.">
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg border
              border-r-0 border-slate-300 bg-slate-50 px-3 text-sm
              text-slate-500">Rs</span>
            <input className="input rounded-l-none" inputMode="decimal"
              value={rupees} placeholder="0"
              onChange={(e) => setRupees(
                e.target.value.replace(/[^\d.-]/g, ""))} />
          </div>
        </Field>
        {/* MANDATORY, and the reason it is: a computed deduction can be traced
            to a day on the register; a hand-typed adjustment can be traced to
            nothing at all unless somebody wrote down why. */}
        <Field label="Why" required
          hint="This is the number the employee will ask about first.">
          <input className="input" value={note} required minLength={3}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Diwali bonus / advance recovered" />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary"
            disabled={save.isPending || note.trim().length < 3}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ paying -- */

/**
 * Record that a payslip was paid.
 *
 * This POSTS A REAL EXPENSE — it is not a bookkeeping flag. The server routes
 * it through the same `finance._post_expense` the Add-transaction form uses, so
 * a salary paid from here and one keyed by hand are the same ledger row.
 *
 * The idempotency key is generated ONCE per open form, which is this app's
 * standing rule for every money write: a double-click, a dropped response and a
 * retry must not pay somebody twice.
 */
function PayDialog({ payslip: p, onClose, onDone }: {
  payslip: Payslip; onClose: () => void; onDone: () => void;
}) {
  const [account, setAccount] = useState("");
  const [reference, setReference] = useState("");
  const [when, setWhen] = useState(todayInput());
  const [notify, setNotify] = useState(true);
  const [key] = useState(() => crypto.randomUUID());

  const pay = useMutation({
    mutationFn: () => payslipsApi.pay(p.id, {
      bank_account_id: account || undefined,
      reference: reference || undefined,
      occurred_at: when ? `${when}T12:00:00` : undefined,
      idempotency_key: key,
      notify,
    }),
    onSuccess: () => {
      toast.success(`Recorded. ${notify ? `${p.user_name} has been told.` : ""}`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Modal open onClose={onClose}
      title={`Pay ${p.user_name} ${formatINR(p.net_payable_paise)}`} size="sm">
      <form className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); pay.mutate(); }}>
        <p className="note-in">
          This records a salary expense against {p.user_name} on the ledger,
          exactly as adding it from the Transactions page would. It does not
          move any money by itself.
        </p>
        <BankAccountSelect value={account} onChange={setAccount}
          label="Which account did it go out of?" />
        <Field label="Reference"
          hint="UTR or cheque number, if you have one.">
          <input className="input" value={reference}
            onChange={(e) => setReference(e.target.value)} />
        </Field>
        {/* `DateInput`, never the browser's own date control. Every date in
            this app is day-first (owner 2026-07-26) and the native control is
            locale-dependent, so a salary would be dated 8 March instead of
            3 August on a US-configured machine. */}
        <Field label="Paid on">
          <DateInput value={when} onChange={setWhen} />
        </Field>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={notify} className="mt-0.5"
            onChange={(e) => setNotify(e.target.checked)} />
          <span>
            Tell {p.user_name} their salary has been paid
            <span className="block text-xs text-slate-500">
              A notification in the app, with the amount. No bank details.
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={pay.isPending}>
            {pay.isPending ? "Recording…" : "Record the payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
