import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { banksApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormField } from "../shared/FormSection";
import { toast } from "../Toast";
import { formatINR, rupeesToPaise } from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import { moneyTone } from "../../lib/tone";
import type { BankAccount } from "../../lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

function SumRow({
  label,
  children,
  rule = false,
  hero = false,
}: {
  label: string;
  children: React.ReactNode;
  rule?: boolean;
  hero?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 py-2 ${
        rule ? "mt-1 border-t border-border pt-2.5" : ""
      }`}
    >
      <span
        className={
          hero
            ? "text-sm font-semibold text-foreground"
            : "text-xs text-muted-foreground"
        }
      >
        {label}
      </span>
      {children}
    </div>
  );
}

export function ReconcileDialog({
  account,
  open,
  onClose,
}: {
  account: BankAccount;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [actual, setActual] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());

  const typed = actual.trim() !== "" && !Number.isNaN(Number(actual));
  const actualPaise = typed ? rupeesToPaise(Number(actual)) : null;
  const difference =
    actualPaise === null ? null : actualPaise - account.balance_paise;
  const ready =
    difference !== null && difference !== 0 && reason.trim().length >= 3;

  const close = () => {
    setActual("");
    setReason("");
    setKey(crypto.randomUUID());
    onClose();
  };

  const reconcile = useMutation({
    mutationFn: async () =>
      (
        await banksApi.reconcile(account.id, {
          actual_balance_paise: actualPaise!,
          reason: reason.trim(),
          idempotency_key: key,
        })
      ).data,
    onSuccess: (r) => {
      toast.success(
        r.adjusted
          ? `${account.name} corrected by ${formatINR(
              Math.abs(r.difference_paise)
            )}. The adjustment is in the transaction list.`
          : "Already matching — nothing was changed."
      );
      qc.invalidateQueries({ queryKey: ["banks"] });
      refreshFinance(qc);
      close();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reconcile {account.name}</DialogTitle>
          <DialogDescription>
            Make Agastya agree with what the account really holds.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-2">
            <SumRow label="In Agastya">
              <span className="text-sm font-medium tabular-nums text-muted-foreground">
                {formatINR(account.balance_paise)}
              </span>
            </SumRow>

            <SumRow label="Actually in the account">
              <span className="relative w-40 shrink-0">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  ₹
                </span>
                <Input
                  className="pl-6 pr-2.5 text-right text-sm font-semibold tabular-nums"
                  type="number"
                  inputMode="decimal"
                  autoFocus
                  placeholder="0.00"
                  value={actual}
                  onChange={(e) => setActual(e.target.value)}
                />
              </span>
            </SumRow>

            <SumRow label="Difference" rule hero>
              <span
                className={`text-lg font-bold tabular-nums ${
                  difference === null
                    ? "text-muted-foreground"
                    : moneyTone(difference)
                }`}
              >
                {difference === null
                  ? "—"
                  : difference === 0
                    ? formatINR(0)
                    : `${difference > 0 ? "+" : "−"}${formatINR(
                        Math.abs(difference)
                      )}`}
              </span>
            </SumRow>
          </div>

          <p className="min-h-[2rem] text-xs leading-relaxed text-muted-foreground">
            {difference === null ? (
              "Enter the balance from your bank statement or the cash box to see what will be recorded."
            ) : difference === 0 ? (
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <Check className="h-3.5 w-3.5 text-emerald-600" />
                These already match. Nothing will be recorded.
              </span>
            ) : difference > 0 ? (
              <>
                Agastya is showing{" "}
                <strong className="font-medium text-foreground">
                  {formatINR(difference)} less
                </strong>{" "}
                than the account holds. It will be added.
              </>
            ) : (
              <>
                Agastya is showing{" "}
                <strong className="font-medium text-foreground">
                  {formatINR(Math.abs(difference))} more
                </strong>{" "}
                than the account holds. It will be deducted.
              </>
            )}
          </p>

          <FormField
            label="Why didn't it match"
            required
            hint="Kept with the adjustment for future reference."
          >
            <Input
              value={reason}
              maxLength={300}
              placeholder="Quarterly bank charges not recorded"
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>

          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            This records one dated adjustment in the transaction list. Every
            earlier transaction and balance stays exactly as it is.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!ready || reconcile.isPending}
            onClick={() => reconcile.mutate()}
          >
            {reconcile.isPending ? "Recording…" : "Record adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
