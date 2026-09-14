import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { banksApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field } from "../../components/ui";
import { DateInput } from "../../components/DateInput";
import { SearchSelect } from "../../components/SearchSelect";
import { toast } from "../../components/Toast";
import { refreshFinance } from "../../lib/live";
import {
  formatINR, fromDateInput, rupeesToPaise, todayInput,
} from "../../lib/format";

/** Move money between the agency's own accounts (/finance/banks/transfer). */
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
  // Generated once per open: a double-clicked Save sends the SAME key, and the
  // server returns the transfer it already made instead of moving money twice.
  const [key] = useState(() => crypto.randomUUID());

  const send = useMutation({
    mutationFn: async () => (await banksApi.transfer({
      from_account_id: from,
      to_account_id: to,
      amount_paise: rupeesToPaise(Number(amount || 0)),
      note: note.trim() || undefined,
      reference: reference.trim() || undefined,
      occurred_at: fromDateInput(when) ?? undefined,
      idempotency_key: key,
    })).data,
    onSuccess: () => {
      toast.success("Transfer recorded.");
      qc.invalidateQueries({ queryKey: ["banks"] });
      refreshFinance(qc);
      navigate("/finance/banks");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const options = accounts.map((a) => ({
    value: a.id, label: `${a.name} · ${formatINR(a.balance_paise)}` }));
  const valid = from && to && from !== to && Number(amount) > 0;

  return (
    <FormPage
      backTo="/finance/banks"
      backLabel="Back to bank & cash"
      title="Move money between your accounts"
      subtitle="A transfer never touches profit and never touches a customer, broker or partner balance — it is the same money, somewhere else."
      onSubmit={() => send.mutate()}
      submitLabel="Record transfer"
      submitting={send.isPending}
      disabled={!valid}
      loading={list.isLoading}
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From" required>
            <SearchSelect value={from} onChange={setFrom} options={options}
              placeholder="Choose an account" />
          </Field>
          <Field label="To" required>
            <SearchSelect value={to} onChange={setTo}
              options={options.filter((o) => o.value !== from)}
              placeholder="Choose an account" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount (Rs)" required>
            <input className="input" type="number" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field label="Date" required>
            <DateInput value={when} onChange={setWhen} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reference">
            <input className="input" value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="UTR / cheque no." />
          </Field>
          <Field label="Note">
            <input className="input" value={note}
              onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
      </div>
    </FormPage>
  );
}
