import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  brokersApi, financeApi, usersApi, withdrawalsApi,
} from "../api/endpoints";
import { apiError } from "../api/client";
import { Field } from "./ui";
import { FormPage } from "./RecordPage";
import { Icon } from "./Icon";
import { DateTimeInput } from "./DateInput";
import { PartyPicker, PolicyPicker, type Party } from "./pickers";
import { NetAmount } from "./finance/NetBalance";
import {
  BankAccountSelect, useBankAccountRequired,
} from "./finance/BankAccountSelect";
import { toast } from "./Toast";
import { formatINR, rupeesToPaise } from "../lib/format";
import { refreshFinance } from "../lib/live";

// The house-expense sub-categories (mirror server EXPENSE_CATEGORIES).
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

// Live net balance for the picked party, coloured per the owner's convention
// (negative red = they owe us; positive green = we owe them; blue = settled).
function PartyBalance({ party }: { party: Party }) {
  const dues = useQuery({
    queryKey: ["party-dues", party.id],
    enabled: party.kind === "channel_partner",
    queryFn: async () => (await financeApi.partnerDues()).data
      .find((d) => d.partner_id === party.id) ?? null,
  });
  const acct = useQuery({
    queryKey: ["party-balance", party.kind, party.id],
    enabled: party.kind === "customer",
    queryFn: async () => (await financeApi.parties({ party_type: party.kind }))
      .data.find((a) => a.party_id === party.id) ?? null,
  });
  // A broker's receivable is DERIVED (reward expected on booked policies −
  // receipts) — the raw ledger account misses it. Use the same single source
  // as the Balance Sheet so the modal, list and detail always agree.
  const brokerNet = useQuery({
    queryKey: ["party-balance-broker", party.id],
    enabled: party.kind === "broker",
    queryFn: async () => (await financeApi.balanceSheetDetail(
      "broker", party.id, { period: "till_date" })).data,
  });

  let owe = 0; // >0 they owe us, <0 we owe them
  if (party.kind === "channel_partner") {
    const reward = (dues.data?.reward_available_paise ?? 0)
      + (dues.data?.reward_pending_paise ?? 0);
    const premium = dues.data?.premium_balance_paise ?? 0;
    owe = premium - reward; // >0 they owe us
  } else if (party.kind === "broker") {
    owe = brokerNet.data?.net_balance ?? 0;
  } else {
    owe = acct.data?.balance_paise ?? 0;
  }
  const netParty = party.kind === "broker" ? "broker"
    : party.kind === "channel_partner" ? "partner" : "customer";
  const label = owe === 0 ? "Settled — nothing outstanding"
    : owe > 0
      ? (party.kind === "broker" ? "To receive from broker" : "They owe you")
      : "You owe them";
  return (
    <div className="rounded-control bg-slate-50 px-3 py-2 text-sm text-slate-600">
      Current net balance:{" "}
      <NetAmount receivable={owe} party={netParty} className="font-semibold" />
      <span className="ml-1.5 text-xs text-slate-500">{label}</span>
    </div>
  );
}

// Default for the datetime-local input: now, in the user's local timezone.
function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export type { Party as PaymentParty } from "./pickers";

/**
 * Record any money movement — the body of /finance/transactions/new.
 *
 * Rendered inside a FormPage since 2026-08-03; it was a dialog before. The
 * `onDone` callback survives because the page decides where to go afterwards,
 * and the Balance Sheet still pre-selects a party so the user is not made to
 * search for someone they are already looking at.
 */
export function RecordPaymentForm({ onDone, initialParty }: {
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
  // The real-world transaction date & time (owner Q10) — defaults to now.
  const [occurred, setOccurred] = useState(nowLocal());
  const [policyId, setPolicyId] = useState("");
  const [policyLabel, setPolicyLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // Expense-only.
  const [category, setCategory] = useState("salary");
  const [employeeId, setEmployeeId] = useState("");
  // Which of OUR accounts the money moved through.
  const [accountId, setAccountId] = useState("");
  const accountRequired = useBankAccountRequired();
  // One key per open form. A double-clicked Save — or an axios retry after a
  // dropped response — sends the SAME key, so the server returns the row it
  // already wrote instead of taking the money twice. Reset after a success.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  const employees = useQuery({
    queryKey: ["employees-for-expense"],
    enabled: mode === "expense" && dir === "paid",
    queryFn: async () =>
      (await usersApi.list({ account_type: "employee", page_size: 100 })).data
        .items,
  });

  const reset = () => {
    setDir("received"); setMode("party"); setParty(initialParty ?? null);
    setAmount(""); setReference(""); setNote(""); setPolicyId("");
    setPolicyLabel(""); setFile(null); setCategory("salary");
    setEmployeeId(""); setOccurred(nowLocal()); setAccountId("");
    setIdemKey(crypto.randomUUID());
  };
  const close = () => { reset(); onDone(); };

  const selectedBroker = useQuery({
    queryKey: ["broker-tds", party?.id],
    enabled: dir === "received" && party?.kind === "broker",
    queryFn: async () => (await brokersApi.list({ active_only: 1 })).data
      .find((b) => b.id === party!.id) ?? null,
  });

  const isExpense = dir === "paid" && mode === "expense";
  const amt = parseFloat(amount || "0");

  const save = useMutation({
    mutationFn: async () => {
      const paise = rupeesToPaise(amt);
      // datetime-local is timezone-less — send it as an ISO instant.
      const occurredIso = occurred
        ? new Date(occurred).toISOString() : undefined;
      // --- Expense ---
      if (isExpense) {
        const res = await financeApi.recordExpense({
          amount_paise: paise, category, note: note || undefined,
          reference: reference || undefined,
          occurred_at: occurredIso,
          paid_to_employee_id: employeeId || undefined,
          bank_account_id: accountId || undefined,
          idempotency_key: idemKey,
        });
        if (file) await financeApi.uploadTxnAttachment(res.data.id, file);
        return;
      }
      if (!party) throw new Error("Pick a party.");
      // --- Paid to channel partner: reward payout first, excess = advance ---
      if (dir === "paid" && party.kind === "channel_partner") {
        const res = await withdrawalsApi.agencyPayout({
          partner_id: party.id, amount_paise: paise,
          reference: reference || undefined, note: note || undefined,
          occurred_at: occurredIso,
          bank_account_id: accountId || undefined,
          idempotency_key: idemKey });
        if (res.data.advance_paise > 0)
          toast.info(`${formatINR(res.data.advance_paise)} was above the reward`
            + " owed — booked as an advance the partner owes back.");
        return;
      }
      // --- Everything else maps to a single ledger row ---
      const txnType =
        dir === "received"
          ? (party.kind === "broker" ? "reward_received" : "premium_collected")
          : (party.kind === "broker" ? "premium_to_insurer" : "refund");
      const res = await financeApi.recordPayment({
        txn_type: txnType, party_type: party.kind, party_id: party.id,
        amount_paise: paise, policy_id: policyId || undefined,
        reference: reference || undefined, note: note || undefined,
        occurred_at: occurredIso,
        bank_account_id: accountId || undefined,
        idempotency_key: idemKey });
      if (file) await financeApi.uploadTxnAttachment(res.data.id, file);
    },
    onSuccess: () => {
      toast.success("Transaction recorded.");
      refreshFinance(qc);
      close();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canSave = useMemo(() => {
    if (amt <= 0) return false;
    // Once accounts exist, choosing one is mandatory — an optional field here
    // is how the balances stop being trustworthy within a week.
    if (accountRequired && !accountId) return false;
    if (isExpense) return !!category;
    return !!party;
  }, [amt, isExpense, category, party, accountRequired, accountId]);

  const tdsHint = dir === "received" && party?.kind === "broker"
    && selectedBroker.data && amt > 0 ? (() => {
      const gross = rupeesToPaise(amt);
      const tds = Math.round(gross * selectedBroker.data!.tds_percent / 10000);
      return (
        <div className="rounded-md border border-line bg-slate-50 px-3 py-2
          text-xs text-slate-600">
          Enter the <b>gross</b> reward. TDS @{" "}
          {(selectedBroker.data!.tds_percent / 100).toFixed(2)}% ={" "}
          <b>{formatINR(tds)}</b>; net cash in <b>{formatINR(gross - tds)}</b>.
          The broker's balance clears at the gross; TDS shows in the TDS report.
        </div>
      );
    })() : null;

  return (
    <FormPage
      backTo="/finance/transactions"
      backLabel="Back to transactions"
      title="Add transaction"
      subtitle="Any money in or out — a receipt, a payout, or a house expense."
      onSubmit={() => { if (canSave) save.mutate(); }}
      submitLabel="Save transaction"
      submitting={save.isPending}
      disabled={!canSave}
    >
      <div className="space-y-5">
        {/* Step 1 — direction */}
        <div className="grid grid-cols-2 gap-2">
          {(["received", "paid"] as const).map((d) => (
            <button type="button" key={d}
              className={`rounded-card border px-4 py-3 text-sm font-medium
                transition ${dir === d
                  ? "border-ink bg-slate-100 text-slate-900"
                  : "border-line text-slate-600 hover:border-slate-300"}`}
              onClick={() => { setDir(d); if (d === "received") setMode("party"); }}>
              {/* Direction shown with the app's own icons: U+2B07/U+2B06 are
                  drawn as colour emoji by Chrome on Windows, which is exactly
                  the look the owner is removing (2026-07-26). */}
              <span className="inline-flex items-center gap-1.5">
                <Icon.ChevronDown size={15}
                  className={d === "received" ? "" : "-rotate-180"} />
                {d === "received" ? "Received" : "Paid"}
              </span>
            </button>
          ))}
        </div>

        {/* Paid can be to a party or a house expense */}
        {dir === "paid" && (
          <div className="grid grid-cols-2 gap-2">
            {(["party", "expense"] as const).map((m) => (
              <button type="button" key={m}
                className={`rounded-control border px-3 py-2 text-sm ${mode === m
                  ? "border-ink bg-slate-100 text-slate-900"
                  : "border-line text-slate-500 hover:border-slate-300"}`}
                onClick={() => setMode(m)}>
                {m === "party" ? "To a party" : "House expense"}
              </button>
            ))}
          </div>
        )}

        {/* Step 2 — party or expense category */}
        {!isExpense ? (
          <>
            <Field label={dir === "received" ? "Received from" : "Paid to"}
              required>
              <PartyPicker value={party} onChange={setParty} />
            </Field>
            {party && <PartyBalance party={party} />}
            {tdsHint}
            {dir === "paid" && party?.kind === "channel_partner" && (
              <p className="-mt-1 text-xs text-slate-500">
                Pays from the partner's reward balance first. Paying MORE than
                the reward owed is fine — the extra is booked as an advance the
                partner owes back (their net balance goes negative).
              </p>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Category" required>
                <select className="select" value={category}
                  onChange={(e) => setCategory(e.target.value)}>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Paid to (employee)"
                hint="Link a salary/incentive to a staff member.">
                <select className="select" value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}>
                  <option value="">— None —</option>
                  {employees.data?.map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name}</option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        )}

        {/* Step 3 — amount + meta */}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount (₹)" required>
            <input type="number" step="0.01" min="0" className="input"
              value={amount} placeholder="e.g. 10000"
              onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Transaction date & time"
            hint="When the money actually moved — reports use this date.">
            <DateTimeInput value={occurred} onChange={setOccurred} />
          </Field>
        </div>

        <BankAccountSelect value={accountId} onChange={setAccountId}
          label={dir === "received" ? "Received into" : "Paid from"}
          hint={dir === "received" && party?.kind === "broker"
            ? "The NET amount after TDS is what lands in this account."
            : undefined} />

        {!isExpense && party?.kind !== "broker" && (
          <Field label="Link policy">
            <PolicyPicker value={policyId} displayLabel={policyLabel}
              onSelect={(id, label) => {
                setPolicyId(id); setPolicyLabel(label);
              }} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Reference (UTR / cheque)">
            <input className="input" value={reference}
              onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Note">
            <input className="input" value={note}
              onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        {/* Attachment — not supported for partner payouts (no ledger row id) */}
        {!(dir === "paid" && party?.kind === "channel_partner") && (
          <Field label="Attachment"
            hint="Payment screenshot or receipt (PDF/image, max 20 MB).">
            <input type="file" className="input py-1.5"
              accept="application/pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file && (
              <span className="inline-flex items-center gap-1 text-xs
                font-medium text-money-in">
                <Icon.Check size={13} /> {file.name}</span>
            )}
          </Field>
        )}

      </div>
    </FormPage>
  );
}
