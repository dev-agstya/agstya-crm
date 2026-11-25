import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, Pencil, RefreshCw, Wallet } from "lucide-react";
import { payslipsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { DateInput } from "../DateInput";
import { BankAccountSelect } from "../finance/BankAccountSelect";
import { FormField } from "../shared/FormSection";
import { toast } from "../Toast";
import { confirmDialog } from "../Confirm";
import { moneyTone } from "../../lib/tone";
import {
  formatDate,
  formatINR,
  paiseToRupeeStr,
  rupeesToPaise,
  todayInput,
} from "../../lib/format";
import { formatDuration } from "../../lib/hr";
import {
  PAYSLIP_STATUS_LABELS,
  lockSentence,
  payDays,
  payslipBadge,
  payslipMonthLabel,
  payslipWarning,
} from "../../lib/payroll";
import { refreshFinance } from "../../lib/live";
import { useAuth } from "../../store/auth";
import type { Payslip } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function PayslipDetail({
  payslip,
  onClose,
  onChanged,
  canManage,
}: {
  payslip: Payslip;
  onClose: () => void;
  onChanged: () => void;
  canManage: boolean;
}) {
  const p = payslip;
  const [showMonth, setShowMonth] = useState(
    payslip.absent_days + payslip.unpaid_leave_days + payslip.late_marks > 0
  );
  const warning = payslipWarning(p);
  const locking = lockSentence(p);
  const mine = useAuth().user?.id === p.user_id;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="flex-row items-center justify-between gap-2 pr-6">
          <DialogTitle className="text-base">
            {payslipMonthLabel(p.month)} — {p.user_name}
          </DialogTitle>
          <span className={`badge ${payslipBadge(p.status)}`}>
            {PAYSLIP_STATUS_LABELS[p.status]}
          </span>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {p.status === "paid" ? "Paid" : "Net payable"}
            </p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums text-foreground">
              {formatINR(p.net_payable_paise)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {payDays(p.payable_days)} payable days of {p.calendar_days} ·{" "}
              {formatINR(p.per_day_paise)} a day
            </p>
            {p.status === "paid" && p.paid_at && (
              <p className="mt-1.5 flex items-center text-xs font-medium text-emerald-700">
                <Check className="mr-1 h-3.5 w-3.5" />
                Paid on {formatDate(p.paid_at)}
                {canManage && !mine && p.payment_reference
                  ? ` · ${p.payment_reference}`
                  : ""}
              </p>
            )}
          </div>

          {warning && (
            <p className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
              {warning}
            </p>
          )}

          {locking && (
            <p
              className={`rounded-md border px-3 py-2 text-xs ${
                p.blockers?.length
                  ? "border-destructive/30 bg-destructive/5 text-destructive"
                  : "border-border bg-muted/30 text-muted-foreground"
              }`}
            >
              {locking}
            </p>
          )}

          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              How this was worked out
            </h3>
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full">
                <tbody>
                  {p.lines.map((line, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 text-[13px] text-foreground">
                        {line.label}
                        {line.detail && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {line.detail}
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right text-[13px] tabular-nums ${
                          line.amount_paise < 0
                            ? "text-destructive"
                            : "text-foreground"
                        }`}
                      >
                        {line.amount_paise < 0 ? "−" : ""}
                        {formatINR(Math.abs(line.amount_paise))}
                      </td>
                    </tr>
                  ))}
                  {p.adjustment_paise !== 0 && (
                    <tr className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 text-[13px] text-foreground">
                        Adjustment
                        {p.adjustment_note && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {p.adjustment_note}
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right text-[13px] tabular-nums ${moneyTone(
                          p.adjustment_paise
                        )}`}
                      >
                        {p.adjustment_paise < 0 ? "−" : "+"}
                        {formatINR(Math.abs(p.adjustment_paise))}
                      </td>
                    </tr>
                  )}
                  <tr className="bg-muted/40">
                    <td className="px-3 py-2 text-[13px] font-semibold text-foreground">
                      Net payable
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-semibold tabular-nums text-foreground">
                      {formatINR(p.net_payable_paise)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              A day costs {formatINR(p.per_day_paise)} — the monthly salary
              divided by {p.days_divisor}, so the same absence costs the same in
              every month, long or short. Week offs, holidays and leave covered
              by your balance are not deducted.
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              The month
            </h3>
            {showMonth ? (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
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
                  <Count
                    label="Hours worked"
                    value={formatDuration(p.worked_minutes)}
                  />
                  <Count
                    label="Payable days"
                    value={payDays(p.payable_days)}
                    title="Days actually paid for this month — present, work from home, half days, holidays, week offs and covered leave"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 mt-1 h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => setShowMonth(false)}
                >
                  <ChevronUp className="mr-1 h-3.5 w-3.5" />
                  Hide the day counts
                </Button>
              </>
            ) : (
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                onClick={() => setShowMonth(true)}
                title="Present, leave, absent, late — every count the days above were worked out from"
              >
                <span>
                  {payDays(p.payable_days)} payable days of {p.calendar_days} —
                  see the full day-by-day breakdown
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </button>
            )}
          </div>

          {canManage && (
            <PayDeskActions
              payslip={p}
              onChanged={onChanged}
              onClose={onClose}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Count({
  label,
  value,
  title,
}: {
  label: string;
  value: number | string;
  title?: string;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1"
      title={title}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

function PayDeskActions({
  payslip: p,
  onChanged,
  onClose,
}: {
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
    mutationFn: () =>
      payslipsApi.generate({
        month: p.month,
        user_id: p.user_id,
        regenerate: true,
      }),
    onSuccess: () => {
      toast.success("Rebuilt from the register.");
      onChanged();
    },
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
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {p.status === "draft" && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate()}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Rebuild from register
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setAdjusting(true)}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> Adjust
            </Button>
            <Button
              type="button"
              size="sm"
              className="ml-auto h-8 text-xs"
              disabled={finalise.isPending || p.monthly_salary_paise <= 0}
              title={
                p.monthly_salary_paise <= 0
                  ? "Set this employee's salary first."
                  : undefined
              }
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: `Finalise ${p.user_name}'s payslip?`,
                    message: `${p.user_name} will be told that ${formatINR(
                      p.net_payable_paise
                    )} is ready. The figures lock — reopen it if a correction lands afterwards.`,
                    confirmLabel: "Finalise",
                  })
                )
                  finalise.mutate();
              }}
            >
              <Check className="mr-1.5 h-3.5 w-3.5" /> Finalise
            </Button>
          </>
        )}

        {p.status === "finalised" && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={reopen.isPending}
              onClick={() => reopen.mutate()}
            >
              Reopen
            </Button>
            <Button
              type="button"
              size="sm"
              className="ml-auto h-8 text-xs"
              onClick={() => setPaying(true)}
            >
              <Wallet className="mr-1.5 h-3.5 w-3.5" /> Record payment
            </Button>
          </>
        )}

        {p.status === "paid" && (
          <p className="text-xs text-muted-foreground">
            This payslip is paid and its figures are locked. Correct the payment
            on the Transactions page if it was wrong.
          </p>
        )}
      </div>

      {adjusting && (
        <AdjustDialog
          payslip={p}
          onClose={() => setAdjusting(false)}
          onDone={onChanged}
        />
      )}
      {paying && (
        <PayDialog
          payslip={p}
          onClose={() => setPaying(false)}
          onDone={() => {
            refreshFinance(qc);
            onChanged();
            onClose();
          }}
        />
      )}
    </>
  );
}

function AdjustDialog({
  payslip: p,
  onClose,
  onDone,
}: {
  payslip: Payslip;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rupees, setRupees] = useState(
    p.adjustment_paise ? paiseToRupeeStr(p.adjustment_paise) : ""
  );
  const [note, setNote] = useState(p.adjustment_note ?? "");

  const save = useMutation({
    mutationFn: () =>
      payslipsApi.adjust(
        p.id,
        rupeesToPaise(Number(rupees || 0)),
        note.trim()
      ),
    onSuccess: () => {
      toast.success("Adjusted.");
      onDone();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Adjust this payslip</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <FormField
            label="Amount"
            hint="A bonus, an advance being recovered, or a make-good. Use a minus sign to deduct."
          >
            <div className="flex">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 text-xs text-muted-foreground">
                Rs
              </span>
              <Input
                className="rounded-l-none"
                inputMode="decimal"
                value={rupees}
                placeholder="0"
                onChange={(e) =>
                  setRupees(e.target.value.replace(/[^\d.-]/g, ""))
                }
              />
            </div>
          </FormField>
          <FormField
            label="Why"
            required
            hint="This is the number the employee will ask about first."
          >
            <Input
              value={note}
              required
              minLength={3}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Diwali bonus / advance recovered"
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={save.isPending || note.trim().length < 3}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayDialog({
  payslip: p,
  onClose,
  onDone,
}: {
  payslip: Payslip;
  onClose: () => void;
  onDone: () => void;
}) {
  const [account, setAccount] = useState("");
  const [reference, setReference] = useState("");
  const [when, setWhen] = useState(todayInput());
  const [notify, setNotify] = useState(true);
  const [key] = useState(() => crypto.randomUUID());

  const pay = useMutation({
    mutationFn: () =>
      payslipsApi.pay(p.id, {
        bank_account_id: account || undefined,
        reference: reference || undefined,
        occurred_at: when ? `${when}T12:00:00` : undefined,
        idempotency_key: key,
        notify,
      }),
    onSuccess: () => {
      toast.success(
        `Recorded. ${notify ? `${p.user_name} has been told.` : ""}`
      );
      onDone();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            Pay {p.user_name} {formatINR(p.net_payable_paise)}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            pay.mutate();
          }}
        >
          <p className="rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
            This records a salary expense against {p.user_name} on the ledger,
            exactly as adding it from the Transactions page would.
          </p>
          <BankAccountSelect
            value={account}
            onChange={setAccount}
            label="Which account did it go out of?"
          />
          <FormField label="Reference" hint="UTR or cheque number, if any.">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </FormField>
          <FormField label="Paid on">
            <DateInput value={when} onChange={setWhen} />
          </FormField>
          <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={notify}
              onCheckedChange={(c) => setNotify(Boolean(c))}
              className="mt-0.5"
            />
            <span>
              <strong className="text-foreground">
                Tell {p.user_name} their salary has been paid
              </strong>
              <span className="block text-[11px]">
                A notification in the app, with the amount. No bank details.
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pay.isPending}>
              {pay.isPending ? "Recording…" : "Record payment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
