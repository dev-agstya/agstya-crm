import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { banksApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field, Toggle } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { ReconcileDialog } from "../../components/finance/ReconcileDialog";
import {
  formatINR, fromDateInput, rupeesToPaise, toDateInput, todayInput,
} from "../../lib/format";
import { BANK_ACCOUNT_TYPES, type BankAccount } from "../../lib/types";

/** Add (/finance/banks/new) and edit (/finance/banks/:id/edit). */
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
      // Only send the account number when it was actually typed — an empty box
      // on an edit form means "leave it alone", not "wipe it".
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
      subtitle="Where the agency's own money sits. Every payment you record gets linked to one."
      onSubmit={() => save.mutate()}
      submitLabel={editing ? "Save changes" : "Add account"}
      submitting={save.isPending}
      disabled={name.trim().length < 2}
      loading={editing && list.isLoading}
      notFound={editing && !list.isLoading && !account}
    >
      <div className="space-y-5">
        <Field label="Name" required
          hint="What you call it day to day — 'HDFC Current', 'Cash box'.">
          <input className="input" value={name} autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="HDFC Current" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" required>
            <select className="select" value={type}
              onChange={(e) => setType(e.target.value as BankAccount["account_type"])}>
              {BANK_ACCOUNT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>))}
            </select>
          </Field>
          <Field label="Bank / provider">
            <input className="input" value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="HDFC Bank" />
          </Field>
        </div>

        {type !== "cash" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={isCard ? "Card number" : "Account number"}
              hint={editing
                ? "Leave blank to keep the stored number."
                : "Stored encrypted; only the last 4 digits are shown."}>
              <input className="input" value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder={account?.account_last4
                  ? `****${account.account_last4}` : ""} />
            </Field>
            {type === "upi" ? (
              <Field label="UPI ID">
                <input className="input" value={upi}
                  onChange={(e) => setUpi(e.target.value)}
                  placeholder="agency@upi" />
              </Field>
            ) : (
              <Field label="IFSC">
                <input className="input" value={ifsc}
                  onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                  placeholder="HDFC0001234" />
              </Field>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Opening balance (Rs)" required
            hint={isCard
              ? "What you owed on the card on that date, as a negative number."
              : "What the account held on the date below."}>
            <input className="input" type="number" value={opening}
              onChange={(e) => setOpening(e.target.value)} placeholder="0" />
          </Field>
          <Field label="As on" required
            hint="Transactions before this date are already in the opening balance.">
            <DateInput value={asOf} onChange={setAsOf} />
          </Field>
        </div>

        <Field label="Note">
          <input className="input" value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional" />
        </Field>

        <div className="flex flex-wrap items-center gap-6 border-t border-line/70 pt-4">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <Toggle checked={isDefault} onChange={setIsDefault}
              label="Default account" />
            Preselect on payment forms
          </label>
          {editing && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <Toggle checked={active} onChange={setActive} label="Active" />
              Active
            </label>
          )}
        </div>

        {editing && account && (
          <BalanceTools account={account}
            onRebuild={() => recompute.mutate()}
            rebuilding={recompute.isPending} />
        )}

      </div>
    </FormPage>
  );
}

/*
  WHEN THE APP AND THE BANK DISAGREE (owner 2026-08-07).

  Two different problems, and they need two different actions, because fixing
  one with the other's tool hides a bug:

    Rebuild    The ledger is right and the running total drifted — the crash
               window in services/bank.post() between writing the row and the
               $inc. Costs nothing, invents nothing, always worth trying first.

    Reconcile  The LEDGER is incomplete. A bank charge nobody recorded,
               interest credited, cash counted wrong. No amount of rebuilding
               finds money that was never written down, so the difference has
               to be posted.

  Presented as a CHOICE OF TWO with a sentence each, rather than two bare
  buttons: which one you want depends on a distinction the person reading it
  does not have in their head yet, so the block has to teach it in the moment.
*/
function BalanceTools({ account, onRebuild, rebuilding }: {
  account: BankAccount;
  onRebuild: () => void;
  rebuilding: boolean;
}) {
  const [reconciling, setReconciling] = useState(false);

  return (
    <>
      <section className="rounded-card border border-line bg-white">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-card-title text-slate-900">
            If this balance looks wrong
          </h3>
          <p className="mt-0.5 text-secondary text-slate-500">
            Currently showing{" "}
            <span className="font-medium tabular-nums text-slate-700">
              {formatINR(account.balance_paise)}</span>.
          </p>
        </div>

        <div className="divide-y divide-line-soft">
          <ToolRow
            icon="Refresh"
            title="Rebuild from the transactions"
            body="The transaction list is the record; this balance is only a
              running total of it. Re-adding them costs nothing and changes no
              data. Try this first."
            action={
              <button type="button" className="btn-secondary btn-sm"
                disabled={rebuilding} onClick={onRebuild}>
                {rebuilding ? "Rebuilding…" : "Rebuild"}
              </button>
            } />

          <ToolRow
            icon="Exchange"
            title="It still doesn't match my bank"
            body="Then something is missing from the record — a bank charge,
              interest, miscounted cash. Enter the real balance and the
              difference is posted as a dated adjustment."
            action={
              <button type="button" className="btn-secondary btn-sm"
                onClick={() => setReconciling(true)}>
                Reconcile
              </button>
            } />
        </div>
      </section>

      <ReconcileDialog account={account} open={reconciling}
        onClose={() => setReconciling(false)} />
    </>
  );
}

/** One option in the block above: glyph, what it does, why, and its button. */
function ToolRow({ icon, title, body, action }: {
  icon: keyof typeof Icon;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  const Glyph = Icon[icon];
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center
        rounded-control bg-slate-100 text-slate-500">
        <Glyph size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">{title}</p>
        <p className="mt-0.5 text-secondary leading-relaxed text-slate-500">
          {body}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
