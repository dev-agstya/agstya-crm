import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { financeApi, usersApi } from "../../api/endpoints";
import { FormPage } from "../../components/RecordPage";
import { DateInput } from "../../components/DateInput";
import { Field } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { PartyPicker, type Party } from "../../components/pickers";
import { BankAccountSelect } from "../../components/finance/BankAccountSelect";
import { toast } from "../../components/Toast";
import { refreshFinance } from "../../lib/live";
import { toDateInput } from "../../lib/format";
import { PARTY_LABEL, TypeTag } from "./txnDisplay";

// Mirrors server EXPENSE_CATEGORIES, like RecordPaymentForm's copy.
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

/**
 * Edit a manual ledger row (/finance/transactions/:id/edit).
 *
 * The SIGN — receivable vs payable — is preserved server-side from the original
 * row, which is why this form never offers a direction. What it does now offer,
 * and did not until 2026-08-19, is the two CORRECTIONS people actually need:
 *
 *   * the BANK ACCOUNT. An expense could always be moved between accounts;
 *     nothing else could. A ₹1,00,000 receipt keyed against ICICI when the
 *     money landed in HDFC left both accounts wrong with no way back short of
 *     deleting the row and re-entering it — which loses the audit trail and the
 *     attachment.
 *   * the PARTY. Same story, worse consequence: two people's balances wrong.
 *
 * Both are deliberately behind an "I need to correct this" disclosure rather
 * than sitting open on the form. Changing an amount is routine; re-filing a
 * transaction against a different customer is not, and a picker that is always
 * on screen is a picker somebody eventually nudges by accident.
 */
export default function EditTransactionPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const loaded = useQuery({
    queryKey: ["finance", "ledger-detail", id],
    retry: false,
    queryFn: async () => (await financeApi.ledgerDetail(id)).data,
  });
  const txn = loaded.data;
  const missing = isAxiosError(loaded.error)
    && loaded.error.response?.status === 404;

  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [occurred, setOccurred] = useState("");
  const [accountId, setAccountId] = useState("");
  const [party, setParty] = useState<Party | null>(null);
  // Expense-only: the two fields that make an expense an expense.
  const [category, setCategory] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [refiling, setRefiling] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState("");
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    if (loadedOnce || !txn) return;
    setAmount(String(Math.abs(txn.amount_paise) / 100));
    setReference(txn.reference ?? "");
    setNote(txn.note ?? "");
    setOccurred(toDateInput(txn.occurred_at));
    setAccountId(txn.bank_account_id ?? "");
    setCategory(txn.expense_category ?? "");
    setEmployeeId(txn.paid_to_employee_id ?? "");
    setLoadedOnce(true);
  }, [loadedOnce, txn]);

  // An expense has no counterparty position, so there is nothing to re-file it
  // against — the server refuses it, and the control must agree with that
  // rather than offering something that 403s.
  const canRefile = !!txn && txn.party_type !== "expense";

  /*
    AN EXPENSE IS EDITED BY ITS OWN ENDPOINT.

    Editing anything from the Transactions page came here and called the GENERIC
    ledger patch — which has no field for the expense CATEGORY or the PAYEE. So
    a salary keyed under "Rent", or paid to the wrong employee, could be
    corrected on its amount and its date and on nothing that made it an expense.
    `PATCH /api/finance/expenses/{id}` has handled both the whole time and
    nothing in the app routed to it.

    The two endpoints are not interchangeable in the other direction either: the
    expense one re-derives the bank delta with EXPENSE semantics and keeps the
    outflow sign, which is why this is a branch rather than an extra field.
  */
  const isExpense = txn?.txn_type === "expense";

  const employees = useQuery({
    queryKey: ["employees-for-expense"],
    enabled: isExpense,
    queryFn: async () =>
      (await usersApi.list({ account_type: "employee", page_size: 100 })).data
        .items,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (isExpense) {
        await financeApi.editExpense(id, {
          amount_paise: Math.round(Number(amount) * 100),
          category: category || undefined,
          reference: reference || undefined,
          note: note || undefined,
          occurred_at: occurred ? `${occurred}T00:00:00Z` : undefined,
          // "" detaches the payee, which is a real correction — an expense
          // wrongly linked to a staff member has to be unlinkable.
          paid_to_employee_id: employeeId,
          ...(accountId !== (txn?.bank_account_id ?? "")
            ? { bank_account_id: accountId }
            : {}),
        });
        if (file) await financeApi.uploadTxnAttachment(id, file);
        return;
      }
      await financeApi.editLedger(id, {
        amount_paise: Math.round(Number(amount) * 100),
        reference: reference || undefined,
        note: note || undefined,
        occurred_at: occurred ? `${occurred}T00:00:00Z` : undefined,
        // Sent only when it actually changed. "" is meaningful (detach), so an
        // unchanged empty value must not be sent as a deliberate clear.
        ...(accountId !== (txn?.bank_account_id ?? "")
          ? { bank_account_id: accountId }
          : {}),
        ...(party && party.id !== txn?.party_id
          ? { party_type: party.kind, party_id: party.id }
          : {}),
      });
      // The attachment is REPLACED, not added: the endpoint overwrites the
      // row's single doc id. Uploading was previously only possible while
      // recording, so a receipt photographed badly could never be swapped.
      if (file) await financeApi.uploadTxnAttachment(id, file);
    },
    onSuccess: () => {
      refreshFinance(qc);
      qc.invalidateQueries({ queryKey: ["finance", "ledger-detail", id] });
      toast.success("Transaction updated.");
      navigate(`/finance/transactions/${id}`);
    },
    onError: (e: any) =>
      setErr(e?.response?.data?.detail || "Could not save changes."),
  });

  const valid = Number(amount) > 0;

  return (
    <FormPage
      backTo={`/finance/transactions/${id}`}
      backLabel="Back to transaction"
      title="Edit transaction"
      onSubmit={() => { setErr(""); save.mutate(); }}
      submitLabel="Save changes"
      submitting={save.isPending}
      disabled={!valid}
      loading={loaded.isLoading}
      error={missing ? undefined : loaded.error}
      onRetry={() => loaded.refetch()}
      notFound={missing}
    >
      <div className="space-y-5">
        {txn && (
          <div className="rounded-control bg-slate-50 px-3 py-2 text-sm">
            <TypeTag t={txn.txn_type} party={txn.party_type} />
            <span className="ml-2 text-slate-500">
              {txn.party_name || PARTY_LABEL[txn.party_type]}</span>
          </div>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Amount (Rs)" required>
            <input type="number" min="0" step="0.01" className="input"
              value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Date">
            <DateInput value={occurred} onChange={setOccurred} />
          </Field>
        </div>

        {/* Which of OUR accounts the money moved through. autoSelect is off:
            a legacy row genuinely has no account, and silently attaching the
            default one would move a balance nobody asked to move. */}
        <BankAccountSelect value={accountId} onChange={setAccountId}
          autoSelect={false}
          label="Money moved through"
          hint="Correct this if the payment was recorded against the wrong
            account — the balances on both accounts are fixed on save." />

        {isExpense && (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Category" required
              hint="What this spend is, for the per-category totals.">
              <select className="select" value={category}
                onChange={(e) => setCategory(e.target.value)}>
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Paid to (employee)"
              hint="Links a salary or incentive to a staff member.">
              <select className="select" value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">— None —</option>
                {employees.data?.map((u) => (
                  <option key={u.id} value={u.id}>{u.full_name}</option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <Field label="Reference">
          <input className="input" value={reference}
            placeholder="UTR / cheque no."
            onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Note">
          <input className="input" value={note}
            onChange={(e) => setNote(e.target.value)} />
        </Field>

        <Field label="Attachment"
          hint={txn?.attachment_doc_id
            ? "Uploading REPLACES the file already on this transaction."
            : "Payment screenshot or receipt (PDF/image, max 20 MB)."}>
          <input type="file" className="input py-1.5"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {file && (
            <span className="inline-flex items-center gap-1 text-xs
              font-medium text-money-in">
              <Icon.Check size={13} /> {file.name}</span>
          )}
        </Field>

        {/* Re-filing against a different party. Behind a disclosure because it
            is a correction, not an edit — and it moves two balances. */}
        {canRefile && (
          <div className="rounded-control border border-line px-3 py-3">
            {!refiling ? (
              <button type="button" className="btn-secondary btn-sm"
                onClick={() => setRefiling(true)}>
                <Icon.Exchange size={14} /> Recorded against the wrong person?
              </button>
            ) : (
              <div className="space-y-2">
                <Field label="Move this transaction to"
                  hint="Both balances are recalculated — the one it leaves and
                    the one it lands on.">
                  <PartyPicker value={party} onChange={setParty} />
                </Field>
                <button type="button"
                  className="text-xs text-slate-500 underline"
                  onClick={() => { setRefiling(false); setParty(null); }}>
                  Leave it where it is
                </button>
              </div>
            )}
          </div>
        )}

        {err && <p className="hint-error">{err}</p>}
      </div>
    </FormPage>
  );
}
