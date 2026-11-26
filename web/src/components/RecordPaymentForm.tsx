import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Info } from "lucide-react";
import {
  brokersApi,
  financeApi,
  usersApi,
  withdrawalsApi,
} from "../api/endpoints";
import { apiError } from "../api/client";
import { FileUpload } from "./ui";
import { FormPage } from "./RecordPage";
import { FormField } from "./shared/FormSection";
import { DateTimeInput } from "./DateInput";
import { PartyPicker, PolicyPicker, type Party } from "./pickers";
import { NetAmount } from "./finance/NetBalance";
import {
  BankAccountSelect,
  useBankAccountRequired,
} from "./finance/BankAccountSelect";
import { toast } from "./Toast";
import { formatINR, rupeesToPaise } from "../lib/format";
import { refreshFinance } from "../lib/live";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const EXPENSE_CATEGORIES: { value: string; label: string }[] = [
  { value: "salary", label: "Salary" },
  { value: "rent", label: "Rent" },
  { value: "utilities", label: "Utilities" },
  { value: "marketing", label: "Marketing" },
  { value: "software", label: "Software / Tools" },
  { value: "travel", label: "Travel" },
  { value: "office_supplies", label: "Office Supplies" },
  { value: "taxes_fees", label: "Taxes / Fees" },
  { value: "reward_payout", label: "Reward / Incentive" },
  { value: "other", label: "Other" },
];

function PartyBalance({ party }: { party: Party }) {
  const dues = useQuery({
    queryKey: ["party-dues", party.id],
    enabled: party.kind === "channel_partner",
    queryFn: async () =>
      (await financeApi.partnerDues()).data.find(
        (d) => d.partner_id === party.id
      ) ?? null,
  });
  const acct = useQuery({
    queryKey: ["party-balance", party.kind, party.id],
    enabled: party.kind === "customer",
    queryFn: async () =>
      (await financeApi.parties({ party_type: party.kind })).data.find(
        (a) => a.party_id === party.id
      ) ?? null,
  });
  const brokerNet = useQuery({
    queryKey: ["party-balance-broker", party.id],
    enabled: party.kind === "broker",
    queryFn: async () =>
      (
        await financeApi.balanceSheetDetail("broker", party.id, {
          period: "till_date",
        })
      ).data,
  });

  let owe = 0;
  if (party.kind === "channel_partner") {
    const reward =
      (dues.data?.reward_available_paise ?? 0) +
      (dues.data?.reward_pending_paise ?? 0);
    const premium = dues.data?.premium_balance_paise ?? 0;
    owe = premium - reward;
  } else if (party.kind === "broker") {
    owe = brokerNet.data?.net_balance ?? 0;
  } else {
    owe = acct.data?.balance_paise ?? 0;
  }
  const netParty =
    party.kind === "broker"
      ? "broker"
      : party.kind === "channel_partner"
        ? "partner"
        : "customer";
  const label =
    owe === 0
      ? "Settled — nothing outstanding"
      : owe > 0
        ? party.kind === "broker"
          ? "To receive from broker"
          : "They owe you"
        : "You owe them";

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <span>Current net balance:</span>
      <NetAmount receivable={owe} party={netParty} className="font-semibold" />
      <span>· {label}</span>
    </div>
  );
}

function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export type { Party as PaymentParty } from "./pickers";

export function RecordPaymentForm({
  onDone,
  initialParty,
}: {
  onDone: () => void;
  initialParty?: Party | null;
}) {
  const qc = useQueryClient();
  const [dir, setDir] = useState<"received" | "paid">("received");
  const [mode, setMode] = useState<"party" | "expense">("party");
  const [party, setParty] = useState<Party | null>(initialParty ?? null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [occurred, setOccurred] = useState(nowLocal());
  const [policyId, setPolicyId] = useState("");
  const [policyLabel, setPolicyLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState("salary");
  const [employeeId, setEmployeeId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [touched, setTouched] = useState(false);
  const accountRequired = useBankAccountRequired();
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  const employees = useQuery({
    queryKey: ["employees-for-expense"],
    enabled: mode === "expense" && dir === "paid",
    queryFn: async () =>
      (await usersApi.list({ account_type: "employee", page_size: 100 })).data
        .items,
  });

  const reset = () => {
    setDir("received");
    setMode("party");
    setParty(initialParty ?? null);
    setAmount("");
    setReference("");
    setNote("");
    setPolicyId("");
    setPolicyLabel("");
    setFile(null);
    setCategory("salary");
    setEmployeeId("");
    setOccurred(nowLocal());
    setAccountId("");
    setTouched(false);
    setIdemKey(crypto.randomUUID());
  };
  const close = () => {
    reset();
    onDone();
  };

  const selectedBroker = useQuery({
    queryKey: ["broker-tds", party?.id],
    enabled: dir === "received" && party?.kind === "broker",
    queryFn: async () =>
      (await brokersApi.list({ active_only: 1 })).data.find(
        (b) => b.id === party!.id
      ) ?? null,
  });

  const isExpense = dir === "paid" && mode === "expense";
  const needsEmployee =
    isExpense && (category === "salary" || category === "reward_payout");
  const salaryRequiresEmployee = isExpense && category === "salary";
  const amt = parseFloat(amount || "0");

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!amount.trim() || Number.isNaN(amt) || amt <= 0) {
      e.amount = "Enter a valid amount greater than ₹0.";
    }
    if (accountRequired && !accountId) {
      e.account = "Select the bank or cash account this moved through.";
    }
    if (isExpense) {
      if (!category) e.category = "Choose an expense category.";
      if (salaryRequiresEmployee && !employeeId) {
        e.employee = "Select the employee receiving this salary.";
      }
    } else {
      if (!party) e.party = "Select a customer, partner, broker, or party.";
    }
    return e;
  }, [
    amount,
    amt,
    accountRequired,
    accountId,
    isExpense,
    category,
    salaryRequiresEmployee,
    employeeId,
    party,
  ]);

  const canSave = Object.keys(errors).length === 0;

  const save = useMutation({
    mutationFn: async () => {
      const paise = rupeesToPaise(amt);
      const occurredIso = occurred
        ? new Date(occurred).toISOString()
        : undefined;

      if (isExpense) {
        const res = await financeApi.recordExpense({
          amount_paise: paise,
          category,
          note: note.trim() || undefined,
          reference: reference.trim() || undefined,
          occurred_at: occurredIso,
          paid_to_employee_id: employeeId || undefined,
          bank_account_id: accountId || undefined,
          idempotency_key: idemKey,
        });
        if (file) await financeApi.uploadTxnAttachment(res.data.id, file);
        return;
      }

      if (!party) throw new Error("Pick a party.");

      if (dir === "paid" && party.kind === "channel_partner") {
        const res = await withdrawalsApi.agencyPayout({
          partner_id: party.id,
          amount_paise: paise,
          reference: reference.trim() || undefined,
          note: note.trim() || undefined,
          occurred_at: occurredIso,
          bank_account_id: accountId || undefined,
          idempotency_key: idemKey,
        });
        if (res.data.advance_paise > 0)
          toast.info(
            `${formatINR(res.data.advance_paise)} was above the reward owed — booked as an advance the partner owes back.`
          );
        return;
      }

      const txnType =
        dir === "received"
          ? party.kind === "broker"
            ? "reward_received"
            : "premium_collected"
          : party.kind === "broker"
            ? "premium_to_insurer"
            : "refund";

      const res = await financeApi.recordPayment({
        txn_type: txnType,
        party_type: party.kind,
        party_id: party.id,
        amount_paise: paise,
        policy_id: policyId || undefined,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
        occurred_at: occurredIso,
        bank_account_id: accountId || undefined,
        idempotency_key: idemKey,
      });
      if (file) await financeApi.uploadTxnAttachment(res.data.id, file);
    },
    onSuccess: () => {
      toast.success("Transaction recorded.");
      refreshFinance(qc);
      close();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const handleSubmit = () => {
    setTouched(true);
    if (!canSave) {
      const firstErr = Object.values(errors)[0];
      if (firstErr) toast.error(firstErr);
      return;
    }
    save.mutate();
  };

  const tdsHint =
    dir === "received" &&
    party?.kind === "broker" &&
    selectedBroker.data &&
    amt > 0
      ? (() => {
          const gross = rupeesToPaise(amt);
          const tds = Math.round(
            (gross * selectedBroker.data!.tds_percent) / 10000
          );
          return (
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs text-blue-950">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600" />
              <span>
                Enter the <strong>gross</strong> reward. TDS @{" "}
                {(selectedBroker.data!.tds_percent / 100).toFixed(2)}% ={" "}
                <strong>{formatINR(tds)}</strong>; net cash in{" "}
                <strong>{formatINR(gross - tds)}</strong>. The broker&apos;s
                balance clears at the gross; TDS shows in the TDS report.
              </span>
            </div>
          );
        })()
      : null;

  return (
    <FormPage
      backTo="/finance/transactions"
      backLabel="Back to transactions"
      title="Add transaction"
      subtitle="Record a receipt, payout, salary, or house expense"
      onSubmit={handleSubmit}
      submitLabel="Save transaction"
      submitting={save.isPending}
    >
      <div className="space-y-5">
        {/* Step 1 — Direction & Type */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid grid-cols-2 gap-2">
            {(["received", "paid"] as const).map((d) => {
              const active = dir === d;
              return (
                <button
                  type="button"
                  key={d}
                  onClick={() => {
                    setDir(d);
                    if (d === "received") setMode("party");
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? d === "received"
                        ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                        : "border-red-600 bg-red-50 text-red-800"
                      : "border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {d === "received" ? (
                    <ArrowDownLeft className="h-4 w-4" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4" />
                  )}
                  {d === "received" ? "Money Received" : "Money Paid"}
                </button>
              );
            })}
          </div>

          {dir === "paid" && (
            <div className="grid grid-cols-2 gap-2">
              {(["party", "expense"] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                    mode === m
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {m === "party" ? "To a Party" : "House Expense / Salary"}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Step 2 — Party or Expense + Employee */}
        {!isExpense ? (
          <div className="space-y-2.5">
            <FormField
              label={dir === "received" ? "Received from" : "Paid to"}
              required
              error={touched ? errors.party : undefined}
            >
              <PartyPicker value={party} onChange={setParty} />
            </FormField>
            {party && <PartyBalance party={party} />}
            {tdsHint}
            {dir === "paid" && party?.kind === "channel_partner" && (
              <p className="text-xs text-muted-foreground">
                Pays from the partner&apos;s reward balance first. Any excess is
                booked as an advance they owe back.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Expense Category"
              required
              error={touched ? errors.category : undefined}
            >
              <Select
                value={category}
                onValueChange={(v) => {
                  setCategory(v);
                  if (v !== "salary" && v !== "reward_payout") {
                    setEmployeeId("");
                  }
                }}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Choose category…" />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {needsEmployee && (
              <FormField
                label="Paid to Employee"
                tooltip="Select the staff member receiving this salary or incentive payout so it appears on their payroll records."
                required={salaryRequiresEmployee}
                error={touched ? errors.employee : undefined}
              >
                <Select value={employeeId} onValueChange={setEmployeeId}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select employee…" />
                  </SelectTrigger>
                  <SelectContent>
                    {employees.data?.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.full_name}
                        {u.code ? ` · ${u.code}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
          </div>
        )}

        {/* Step 3 — Amount, Date & Bank Account */}
        <div className="grid gap-4 sm:grid-cols-12">
          <div className="sm:col-span-3">
            <FormField
              label="Amount (₹)"
              required
              error={touched ? errors.amount : undefined}
            >
              <Input
                type="number"
                step="0.01"
                min="0.01"
                className="h-9 text-sm tabular-nums"
                value={amount}
                placeholder="e.g. 10000"
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
          </div>

          <div className="sm:col-span-5">
            <FormField
              label="Transaction Date & Time"
              tooltip="When the money actually moved. Reports and statements use this date."
            >
              <DateTimeInput value={occurred} onChange={setOccurred} />
            </FormField>
          </div>

          <div className="space-y-1.5 sm:col-span-4">
            <BankAccountSelect
              value={accountId}
              onChange={setAccountId}
              label={dir === "received" ? "Received into" : "Paid from"}
              hint={
                dir === "received" && party?.kind === "broker"
                  ? "Net amount after TDS lands here."
                  : undefined
              }
            />
            {touched && errors.account && (
              <p className="text-xs text-destructive">{errors.account}</p>
            )}
          </div>
        </div>

        {/* Step 4 — Policy link, Reference, Note */}
        <div className="grid gap-4 sm:grid-cols-3">
          {!isExpense && party?.kind !== "broker" && (
            <FormField label="Link Policy (optional)">
              <PolicyPicker
                value={policyId}
                displayLabel={policyLabel}
                onSelect={(id, label) => {
                  setPolicyId(id);
                  setPolicyLabel(label);
                }}
              />
            </FormField>
          )}
          <FormField label="Reference (UTR / Cheque)">
            <Input
              className="h-9 text-sm"
              value={reference}
              placeholder="e.g. UTR12345678"
              onChange={(e) => setReference(e.target.value)}
            />
          </FormField>
          <FormField label="Note">
            <Input
              className="h-9 text-sm"
              value={note}
              placeholder="Optional description"
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
        </div>

        {!(dir === "paid" && party?.kind === "channel_partner") && (
          <FormField label="Attachment (optional)">
            <FileUpload
              file={file}
              onChange={setFile}
              accept="application/pdf,image/*"
              hint="Payment screenshot or receipt (PDF or image up to 20 MB)"
            />
          </FormField>
        )}
      </div>
    </FormPage>
  );
}
