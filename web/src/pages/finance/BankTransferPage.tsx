import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { banksApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { DateInput } from "../../components/DateInput";
import { SearchSelect } from "../../components/SearchSelect";
import { toast } from "../../components/Toast";
import { refreshFinance } from "../../lib/live";
import {
  formatINR,
  fromDateInput,
  rupeesToPaise,
  todayInput,
} from "../../lib/format";
import { Input } from "@/components/ui/input";

export default function BankTransferPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["banks", false],
    queryFn: async () => (await banksApi.list({})).data,
  });
  const accounts = (list.data?.items ?? []).filter((a) => a.active);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [when, setWhen] = useState(todayInput());
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [key] = useState(() => crypto.randomUUID());

  const send = useMutation({
    mutationFn: async () =>
      (
        await banksApi.transfer({
          from_account_id: from,
          to_account_id: to,
          amount_paise: rupeesToPaise(Number(amount || 0)),
          note: note.trim() || undefined,
          reference: reference.trim() || undefined,
          occurred_at: fromDateInput(when) ?? undefined,
          idempotency_key: key,
        })
      ).data,
    onSuccess: () => {
      toast.success("Transfer recorded.");
      qc.invalidateQueries({ queryKey: ["banks"] });
      refreshFinance(qc);
      navigate("/finance/banks");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const options = accounts.map((a) => ({
    value: a.id,
    label: `${a.name} · ${formatINR(a.balance_paise)}`,
  }));
  const valid = from && to && from !== to && Number(amount) > 0;

  return (
    <FormPage
      backTo="/finance/banks"
      backLabel="Back to bank & cash"
      title="Move money between your accounts"
      wide
      subtitle="A transfer never touches profit and never touches a customer, broker or partner balance — it is the same money, somewhere else."
      onSubmit={() => send.mutate()}
      submitLabel="Record transfer"
      submitting={send.isPending}
      disabled={!valid}
      loading={list.isLoading}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FormField label="From" required>
          <SearchSelect
            value={from}
            onChange={setFrom}
            options={options}
            placeholder="Choose an account"
          />
        </FormField>
        <FormField label="To" required>
          <SearchSelect
            value={to}
            onChange={setTo}
            options={options.filter((o) => o.value !== from)}
            placeholder="Choose an account"
          />
        </FormField>
        <FormField label="Amount (Rs)" required>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
          />
        </FormField>
        <FormField label="Date" required>
          <DateInput value={when} onChange={setWhen} />
        </FormField>
        <FormField label="Reference">
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="UTR / cheque no."
          />
        </FormField>
        <FormField label="Note">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional"
          />
        </FormField>
      </div>
    </FormPage>
  );
}
