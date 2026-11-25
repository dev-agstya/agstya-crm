import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, RefreshCw } from "lucide-react";
import { banksApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { ReconcileDialog } from "../../components/finance/ReconcileDialog";
import {
  formatINR,
  fromDateInput,
  rupeesToPaise,
  toDateInput,
  todayInput,
} from "../../lib/format";
import { BANK_ACCOUNT_TYPES, type BankAccount } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export default function BankAccountFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;

  const list = useQuery({
    queryKey: ["banks", true],
    enabled: editing,
    queryFn: async () =>
      (await banksApi.list({ include_inactive: true })).data,
  });
  const account = list.data?.items.find((a) => a.id === id) ?? null;
  const [loaded, setLoaded] = useState(!editing);
  const [name, setName] = useState("");
  const [type, setType] = useState<BankAccount["account_type"]>("bank");
  const [bankName, setBankName] = useState("");
  const [number, setNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [upi, setUpi] = useState("");
  const [opening, setOpening] = useState("");
  const [asOf, setAsOf] = useState(todayInput());
  const [isDefault, setIsDefault] = useState(false);
  const [active, setActive] = useState(true);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (loaded || !account) return;
    setName(account.name);
    setType(account.account_type);
    setBankName(account.bank_name ?? "");
    setIfsc(account.ifsc ?? "");
    setUpi(account.upi_id ?? "");
    setOpening(String(account.opening_balance_paise / 100));
    setAsOf(toDateInput(account.opening_as_of));
    setIsDefault(account.is_default);
    setActive(account.active);
    setNote(account.note ?? "");
    setLoaded(true);
  }, [loaded, account]);

  const recompute = useMutation({
    mutationFn: () => banksApi.recompute(id!),
    onSuccess: () => {
      toast.success("Balance rebuilt from the transactions.");
      qc.invalidateQueries({ queryKey: ["banks"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        account_type: type,
        bank_name: bankName.trim() || null,
        ifsc: ifsc.trim() || null,
        upi_id: upi.trim() || null,
        opening_balance_paise: rupeesToPaise(Number(opening || 0)),
        opening_as_of: fromDateInput(asOf),
        is_default: isDefault,
        note: note.trim() || null,
      };
      if (number.trim()) body.account_number = number.trim();
      if (editing) body.active = active;
      return editing
        ? (await banksApi.update(id!, body)).data
        : (await banksApi.create(body)).data;
    },
    onSuccess: () => {
      toast.success(editing ? "Account updated." : "Account added.");
      qc.invalidateQueries({ queryKey: ["banks"] });
      navigate("/finance/banks");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const isCard = type === "credit_card";

  return (
    <FormPage
      backTo="/finance/banks"
      backLabel="Back to bank & cash"
      title={editing ? `Edit ${account?.name ?? "account"}` : "Add an account"}
      wide
      subtitle="Where the agency's own money sits. Every payment you record gets linked to one."
      onSubmit={() => save.mutate()}
      submitLabel={editing ? "Save changes" : "Add account"}
      submitting={save.isPending}
      disabled={name.trim().length < 2}
      loading={editing && list.isLoading}
      notFound={editing && !list.isLoading && !account}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FormField
            label="Name"
            required
            hint="What you call it day to day — 'HDFC Current', 'Cash box'."
          >
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="HDFC Current"
            />
          </FormField>

          <FormField label="Type" required>
            <Select
              value={type}
              onValueChange={(v) => setType(v as BankAccount["account_type"])}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BANK_ACCOUNT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="Bank / provider">
            <Input
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="HDFC Bank"
            />
          </FormField>

          {type !== "cash" && (
            <>
              <FormField
                label={isCard ? "Card number" : "Account number"}
                hint={
                  editing
                    ? "Leave blank to keep the stored number."
                    : "Stored encrypted; only last 4 digits shown."
                }
              >
                <Input
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  placeholder={
                    account?.account_last4 ? `****${account.account_last4}` : ""
                  }
                />
              </FormField>
              {type === "upi" ? (
                <FormField label="UPI ID">
                  <Input
                    value={upi}
                    onChange={(e) => setUpi(e.target.value)}
                    placeholder="agency@upi"
                  />
                </FormField>
              ) : (
                <FormField label="IFSC">
                  <Input
                    value={ifsc}
                    onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                    placeholder="HDFC0001234"
                  />
                </FormField>
              )}
            </>
          )}

          <FormField
            label="Opening balance (Rs)"
            required
            hint={
              isCard
                ? "What you owed on the card on that date, as a negative number."
                : "What the account held on the date below."
            }
          >
            <Input
              type="number"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              placeholder="0"
            />
          </FormField>

          <FormField
            label="As on"
            required
            hint="Transactions before this date are already in opening balance."
          >
            <DateInput value={asOf} onChange={setAsOf} />
          </FormField>

          <FormField label="Note">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional"
            />
          </FormField>
        </div>

        <div className="flex flex-wrap items-center gap-6 border-t border-border pt-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={isDefault} onCheckedChange={setIsDefault} />
            <span>Preselect on payment forms (Default account)</span>
          </label>
          {editing && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={active} onCheckedChange={setActive} />
              <span>Active</span>
            </label>
          )}
        </div>

        {editing && account && (
          <BalanceTools
            account={account}
            onRebuild={() => recompute.mutate()}
            rebuilding={recompute.isPending}
          />
        )}
      </div>
    </FormPage>
  );
}

function BalanceTools({
  account,
  onRebuild,
  rebuilding,
}: {
  account: BankAccount;
  onRebuild: () => void;
  rebuilding: boolean;
}) {
  const [reconciling, setReconciling] = useState(false);

  return (
    <>
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-semibold text-foreground">
            If this balance looks wrong
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Currently showing{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatINR(account.balance_paise)}
            </span>
            .
          </p>
        </div>

        <div className="divide-y divide-border/60">
          <div className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <RefreshCw className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">
                Rebuild from the transactions
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                The transaction list is the record; this balance is only a
                running total of it. Re-adding them costs nothing and changes no
                data. Try this first.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 text-xs"
              disabled={rebuilding}
              onClick={onRebuild}
            >
              {rebuilding ? "Rebuilding…" : "Rebuild"}
            </Button>
          </div>

          <div className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <ArrowLeftRight className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">
                It still doesn&apos;t match my bank
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Then something is missing from the record — a bank charge,
                interest, miscounted cash. Enter the real balance and the
                difference is posted as a dated adjustment.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 text-xs"
              onClick={() => setReconciling(true)}
            >
              Reconcile
            </Button>
          </div>
        </div>
      </Card>

      <ReconcileDialog
        account={account}
        open={reconciling}
        onClose={() => setReconciling(false)}
      />
    </>
  );
}
