import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { ArrowLeftRight, Check } from "lucide-react";
import { financeApi, usersApi } from "../../api/endpoints";
import { FormPage } from "../../components/RecordPage";
import { DateInput } from "../../components/DateInput";
import { FormField } from "../../components/shared/FormSection";
import { PartyPicker, type Party } from "../../components/pickers";
import { BankAccountSelect } from "../../components/finance/BankAccountSelect";
import { toast } from "../../components/Toast";
import { refreshFinance } from "../../lib/live";
import { toDateInput } from "../../lib/format";
import { PARTY_LABEL, TypeTag } from "./txnDisplay";
import { Button } from "@/components/ui/button";
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
  const missing =
    isAxiosError(loaded.error) && loaded.error.response?.status === 404;

  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [occurred, setOccurred] = useState("");
  const [accountId, setAccountId] = useState("");
  const [party, setParty] = useState<Party | null>(null);
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

  const canRefile = !!txn && txn.party_type !== "expense";
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
        ...(accountId !== (txn?.bank_account_id ?? "")
          ? { bank_account_id: accountId }
          : {}),
        ...(party && party.id !== txn?.party_id
          ? { party_type: party.kind, party_id: party.id }
          : {}),
      });
      if (file) await financeApi.uploadTxnAttachment(id, file);
    },
    onSuccess: () => {
      refreshFinance(qc);
      qc.invalidateQueries({ queryKey: ["finance", "ledger-detail", id] });
      toast.success("Transaction updated.");
      navigate(`/finance/transactions/${id}`);
    },
    onError: (e: unknown) => {
      const msg =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || "Could not save changes.";
      setErr(msg);
    },
  });

  const valid = Number(amount) > 0;

  return (
    <FormPage
      backTo={`/finance/transactions/${id}`}
      backLabel="Back to transaction"
      title="Edit transaction"
      wide
      onSubmit={() => {
        setErr("");
        save.mutate();
      }}
      submitLabel="Save changes"
      submitting={save.isPending}
      disabled={!valid}
      loading={loaded.isLoading}
      error={missing ? undefined : loaded.error}
      onRetry={() => loaded.refetch()}
      notFound={missing}
    >
      <div className="space-y-4">
        {txn && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
            <TypeTag t={txn.txn_type} party={txn.party_type} />
            <span className="text-muted-foreground">
              {txn.party_name || PARTY_LABEL[txn.party_type]}
            </span>
          </div>
        )}

        <div className="grid gap-3.5 sm:grid-cols-2">
          <FormField label="Amount (Rs)" required>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </FormField>
          <FormField label="Date">
            <DateInput value={occurred} onChange={setOccurred} />
          </FormField>
        </div>

        <BankAccountSelect
          value={accountId}
          onChange={setAccountId}
          autoSelect={false}
          label="Money moved through"
          hint="Correct this if the payment was recorded against the wrong account — the balances on both accounts are fixed on save."
        />

        {isExpense && (
          <div className="grid gap-3.5 sm:grid-cols-2">
            <FormField
              label="Category"
              required
              hint="What this spend is, for the per-category totals."
            >
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-9">
                  <SelectValue />
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
            <FormField
              label="Paid to (employee)"
              hint="Links a salary or incentive to a staff member."
            >
              <Select
                value={employeeId || "__none__"}
                onValueChange={(v) => setEmployeeId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— None —</SelectItem>
                  {employees.data?.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        )}

        <div className="grid gap-3.5 sm:grid-cols-2">
          <FormField label="Reference">
            <Input
              value={reference}
              placeholder="UTR / cheque no."
              onChange={(e) => setReference(e.target.value)}
            />
          </FormField>
          <FormField label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
        </div>

        <FormField
          label="Attachment"
          hint={
            txn?.attachment_doc_id
              ? "Uploading REPLACES the file already on this transaction."
              : "Payment screenshot or receipt (PDF/image, max 20 MB)."
          }
        >
          <Input
            type="file"
            className="h-9 py-1.5 text-xs"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <Check className="h-3.5 w-3.5" /> {file.name}
            </span>
          )}
        </FormField>

        {canRefile && (
          <div className="rounded-md border border-border p-3">
            {!refiling ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setRefiling(true)}
              >
                <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" /> Recorded
                against the wrong person?
              </Button>
            ) : (
              <div className="space-y-2">
                <FormField
                  label="Move this transaction to"
                  hint="Both balances are recalculated — the one it leaves and the one it lands on."
                >
                  <PartyPicker value={party} onChange={setParty} />
                </FormField>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() => {
                    setRefiling(false);
                    setParty(null);
                  }}
                >
                  Leave it where it is
                </button>
              </div>
            )}
          </div>
        )}

        {err && <p className="text-xs font-medium text-destructive">{err}</p>}
      </div>
    </FormPage>
  );
}
