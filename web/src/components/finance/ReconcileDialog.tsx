import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { banksApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Field, Modal } from "../ui";
import { Icon } from "../Icon";
import { toast } from "../Toast";
import { formatINR, rupeesToPaise } from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import { moneyTone } from "../../lib/tone";
import type { BankAccount } from "../../lib/types";

/*
  RECONCILING AN ACCOUNT — the dialog.

  This is a SUBTRACTION, and it took a redesign to admit that. The first
  version was a grey panel at the foot of the account settings form with the
  three figures scattered across a two-column grid: the balance in a definition
  list on the right, the input on the left, the difference somewhere between
  them. Every number was present and the sum was impossible to read.

  It is now laid out the way the calculation actually goes — down the page, one
  line each, figures right-aligned on a common edge, a rule above the total:

      In Agastya                 46,000.00
      Actually in the account  [ 45,800.00 ]
      ───────────────────────────────────
      Difference                  −200.00

  That is a reconciliation statement, which is a form every person who will
  ever open this screen has read a thousand times. The input is the MIDDLE
  LINE of the sum rather than a field in a form, so what you are doing is
  legible before any of the words are.

  The difference is `text-metric` — the one figure this dialog is about — and
  it is toned by `moneyTone`, which owns the three-way sign rule including
  "exactly zero is `info`, because nought is a real answer".

  WHY THIS POSTS AN ADJUSTMENT AND NEVER OVERWRITES THE BALANCE lives on the
  endpoint (routers/banks.reconcile_account) and in schemas/bank.BankReconcile.
  Short version: `balance_paise` is `opening + Σ bank_delta_paise`, so the
  Rebuild button would silently undo an overwrite, and the statement page would
  disagree with the headline in the meantime.
*/

/** One line of the calculation. Figures share a right edge; labels do not. */
function SumRow({ label, children, rule = false, hero = false }: {
  label: string;
  children: React.ReactNode;
  /** Draws the total rule above this line. */
  rule?: boolean;
  hero?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-2
      ${rule ? "mt-1 border-t border-line pt-3" : ""}`}>
      <span className={hero
        ? "text-card-title text-slate-900"
        : "text-sm text-slate-600"}>{label}</span>
      {children}
    </div>
  );
}

export function ReconcileDialog({ account, open, onClose }: {
  account: BankAccount;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [actual, setActual] = useState("");
  const [reason, setReason] = useState("");
  // One key per opening of the dialog, so a double-click or a retry after a
  // dropped response cannot book the difference twice.
  const [key, setKey] = useState(() => crypto.randomUUID());

  const typed = actual.trim() !== "" && !Number.isNaN(Number(actual));
  const actualPaise = typed ? rupeesToPaise(Number(actual)) : null;
  const difference = actualPaise === null
    ? null : actualPaise - account.balance_paise;
  const ready = difference !== null && difference !== 0
    && reason.trim().length >= 3;

  const close = () => {
    setActual("");
    setReason("");
    setKey(crypto.randomUUID());
    onClose();
  };

  const reconcile = useMutation({
    mutationFn: async () => (await banksApi.reconcile(account.id, {
      actual_balance_paise: actualPaise!,
      reason: reason.trim(),
      idempotency_key: key,
    })).data,
    onSuccess: (r) => {
      toast.success(r.adjusted
        ? `${account.name} corrected by ${
          formatINR(Math.abs(r.difference_paise))}. The adjustment is in the `
          + "transaction list."
        : "Already matching — nothing was changed.");
      qc.invalidateQueries({ queryKey: ["banks"] });
      refreshFinance(qc);
      close();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Reconcile ${account.name}`}
      subtitle="Make Agastya agree with what the account really holds."
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn-primary"
            disabled={!ready || reconcile.isPending}
            onClick={() => reconcile.mutate()}>
            {reconcile.isPending ? "Recording…" : "Record adjustment"}
          </button>
        </>
      }
    >
      {/* THE SUM. Down the page, one line each, on a shared right edge. */}
      <div className="rounded-card border border-line bg-slate-50/60 px-4 py-2">
        <SumRow label="In Agastya">
          <span className="text-metric-sm tabular-nums text-slate-500">
            {formatINR(account.balance_paise)}
          </span>
        </SumRow>

        <SumRow label="Actually in the account">
          {/* The middle line of the subtraction, not a field in a form. The
              rupee sign sits inside so the figure lines up with the one above
              it rather than starting further left. */}
          <span className="relative w-44 shrink-0">
            <span className="pointer-events-none absolute left-3 top-1/2
              -translate-y-1/2 text-sm text-slate-500">₹</span>
            <input
              className="input pl-7 pr-3 text-right text-metric-sm
                tabular-nums"
              type="number" inputMode="decimal" autoFocus
              placeholder="0.00" value={actual}
              onChange={(e) => setActual(e.target.value)} />
          </span>
        </SumRow>

        <SumRow label="Difference" rule hero>
          <span className={`text-metric tabular-nums ${
            difference === null ? "text-slate-400" : moneyTone(difference)}`}>
            {difference === null ? "—"
              : difference === 0 ? formatINR(0)
                : `${difference > 0 ? "+" : "−"}${
                  formatINR(Math.abs(difference))}`}
          </span>
        </SumRow>
      </div>

      {/*
        What the figure MEANS, in a sentence, under the figure. A signed number
        on its own is read wrong by half the people who see it — the same
        reason the partner portal says the direction in words.
      */}
      <p className="mt-2.5 min-h-[2.5rem] text-sm leading-relaxed text-slate-500">
        {difference === null
          ? "Enter the balance from your bank statement or the cash box to see "
            + "what will be recorded."
          : difference === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-slate-700">
              <Icon.Check size={15} />
              These already match. Nothing will be recorded.
            </span>
          ) : difference > 0 ? (
            <>Agastya is showing{" "}
              <strong className="font-medium text-slate-700">
                {formatINR(difference)} less</strong>{" "}
              than the account holds. It will be added.</>
          ) : (
            <>Agastya is showing{" "}
              <strong className="font-medium text-slate-700">
                {formatINR(Math.abs(difference))} more</strong>{" "}
              than the account holds. It will be deducted.</>
          )}
      </p>

      <Field className="mt-4" label="Why didn't it match" required
        hint="Kept with the adjustment. In six months this sentence is the only
          explanation anyone will have.">
        <input className="input" value={reason} maxLength={300}
          placeholder="Quarterly bank charges not recorded"
          onChange={(e) => setReason(e.target.value)} />
      </Field>

      {/* The reassurance, because "reset my balance" is a frightening thing to
          click. Says what happens and — the part people actually worry about —
          what does not. */}
      <p className="note mt-4">
        This records one dated adjustment in the transaction list. Every earlier
        transaction and balance stays exactly as it is.
      </p>
    </Modal>
  );
}
