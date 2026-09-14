import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { financeApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { Icon } from "../../components/Icon";
import { Field, Segmented, Spinner } from "../../components/ui";
import {
  BankAccountSelect,
} from "../../components/finance/BankAccountSelect";
import {
  StatementRowCard, UnreadableRow, type RowDecision,
} from "../../components/finance/StatementRow";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatDate, formatINR } from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import type {
  StatementCommitRow, StatementPreview,
} from "../../lib/types";

/*
  IMPORT A BANK STATEMENT (/finance/transactions/import).

  Three steps, and each one exists because the step before it cannot be trusted
  to have got it right on its own:

    1  UPLOAD    pick the account the file belongs to, and the file
    2  MAP       confirm which column is the date, which is the amount, …
    3  ASSIGN    say who each row is with, then commit

  WHY STEP 2 IS NOT SKIPPED. Every Indian bank writes different headers — HDFC
  has "Withdrawal Amt.", SBI has "Debit", Bank of Baroda has one amount column
  and a Dr/Cr flag — so the server guesses and this screen shows the guess with
  the file's first five rows underneath it. A mis-mapped amount column would
  book real money wrongly, and there would be nothing on screen to notice it by.
  The guess is right most of the time; being able to SEE that it is right is the
  point.

  WHY STEP 3 IS ROW BY ROW. A bank narration is machine-written
  ("UPI/DR/451234567890/RAMESH K/HDFC") and matching it to a customer is a
  guess. The suggested search terms are offered, the row stays unassigned until
  a person picks, and nothing posts without an explicit choice.

  THE DIRECTION IS NOT EDITABLE anywhere on this screen. If the statement says
  the money left, it left. What you choose is who it concerns.

  EVERY ROW STARTS AS **PENDING** (owner 2026-08-24), not skipped. A skipped row
  used to be counted in the result and then thrown away with this tab, which is
  right for a line that genuinely is not ours and wrong for the far more common
  "I do not know what this Rs 12,400 was, I will find out". A pending row is
  PARKED — it becomes a real record, waits in the Pending list on Transactions,
  and is finished there through the same posting path these rows use.

  THE CROSS IN EACH ROW'S CORNER drops a line from this import altogether, and
  it asks first. The owner's words: "we don't want to delete any of the
  transactions actually." So the confirmation names the row, says what will
  happen to it, and points at Pending as the safer answer.
*/

type Step = "upload" | "map" | "assign";

// The row card, the decision shape and the expense list all live in
// components/finance/StatementRow, shared with the pending queue — the two
// screens ask the same question about the same kind of line and the server
// books both through the same function.
type Decision = RowDecision;

// The mapping fields, in the order the form asks for them. `required` drives
// whether the file can be read at all.
const MAP_FIELDS: {
  key: string; label: string; hint: string; group: "core" | "split" | "single";
}[] = [
  { key: "date_col", label: "Date", group: "core",
    hint: "The transaction date. Read day-first, as Indian statements are." },
  { key: "description_col", label: "Description / narration", group: "core",
    hint: "Used to suggest who the transaction was with." },
  { key: "reference_col", label: "Reference / cheque no.", group: "core",
    hint: "Optional. Stored against each transaction." },
  { key: "debit_col", label: "Debit / withdrawal", group: "split",
    hint: "Money that LEFT the account." },
  { key: "credit_col", label: "Credit / deposit", group: "split",
    hint: "Money that CAME IN." },
  { key: "amount_col", label: "Amount", group: "single",
    hint: "One column holding every amount." },
  { key: "dr_cr_col", label: "Dr / Cr flag", group: "single",
    hint: "The column that says which way the money went." },
];

export default function StatementImportPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("upload");
  const [accountId, setAccountId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [shape, setShape] = useState<"split" | "single">("split");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  // Rows that were crossed out. Kept as a SET rather than removed from
  // `preview.rows`, so the summary can still say "3 removed" and so the
  // decision is reversible until the commit — the owner's whole point about
  // not wanting transactions deleted.
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  // One id for the whole file. It is what groups these rows in the pending
  // queue afterwards: a person works a FILE, not forty unrelated to-dos.
  const [batchId] = useState(() => crypto.randomUUID());

  const rows = (preview?.rows ?? []).filter((r) => !removed.has(r.line));

  /* ------------------------------------------------------------- preview -- */

  const load = useMutation({
    mutationFn: async (confirmed: Record<string, string> | undefined) => {
      if (!file) throw new Error("Choose a file.");
      return (await financeApi.statementPreview(
        file, accountId, confirmed ?? {})).data;
    },
    onSuccess: (data, confirmed) => {
      setPreview(data);
      // Adopt whatever the server ended up using, so the dropdowns show the
      // guess on the first pass and the person's own choice afterwards.
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.mapping)) {
        if (v) next[`${k}_col`] = v;
      }
      setMapping(next);
      setShape(next.amount_col && !next.debit_col ? "single" : "split");

      if (!data.rows.length) {
        // The server could not read the file with the mapping it had. That is
        // the NORMAL first result for an unfamiliar bank, not an error — the
        // columns and the sample it sent back are exactly what step 2 needs.
        setStep("map");
        if (confirmed) {
          toast.error("Those columns did not produce any readable rows. Check "
            + "the date and amount columns against the sample below.");
        }
        return;
      }

      // WHAT A ROW STARTS AS (owner 2026-08-24).
      //
      // PENDING, not skipped. Every row used to start SKIPPED and a skipped row
      // was counted and then thrown away with the tab — right for a line that
      // genuinely is not ours, wrong for the far more common "I do not know
      // what this was, I will find out". A pending row is parked and finished
      // later from the queue on Transactions.
      //
      // The one exception is a row the server believes is ALREADY RECORDED.
      // That is a decision, not an open question, so it starts skipped and
      // parking it would put a known duplicate into a list of real work.
      setDecisions(Object.fromEntries(data.rows.map((r) => [
        r.line,
        {
          action: (r.duplicate_of ? "skip" : "pending") as Decision["action"],
          key: crypto.randomUUID(),
        },
      ])));
      setStep("assign");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  /* -------------------------------------------------------------- commit -- */

  const commit = useMutation({
    mutationFn: async () => {
      const payload: StatementCommitRow[] = rows
        .filter((r) => !r.problem)
        .map((r) => {
          const d = decisions[r.line];
          const base = {
            line: r.line,
            occurred_on: r.occurred_on!,
            amount_paise: r.amount_paise,
            direction: r.direction,
            reference: r.reference || undefined,
            note: r.description || undefined,
            // Carried so a PARKED row keeps everything the statement said about
            // it. The file is gone the moment this tab closes, and a pending
            // row that says "Rs 12,400, 14 August" and nothing else is a row
            // nobody can ever answer.
            description: r.description || undefined,
            duplicate_of: r.duplicate_of ?? undefined,
            duplicate_note: r.duplicate_note ?? undefined,
            suggested_terms: r.suggested_terms,
            idempotency_key: d?.key,
          };
          if (d?.action === "party" && d.party) {
            return { ...base, action: "party" as const,
              party_type: d.party.kind, party_id: d.party.id };
          }
          if (d?.action === "expense" && d.category) {
            return { ...base, action: "expense" as const,
              expense_category: d.category };
          }
          if (d?.action === "skip") return { ...base, action: "skip" as const };
          // Anything left is PARKED, with whatever note was typed against it.
          return { ...base, action: "pending" as const,
            note: d?.note?.trim() || r.description || undefined };
        });
      return (await financeApi.statementCommit({
        bank_account_id: accountId, rows: payload,
        source_file: file?.name,
        import_batch_id: batchId })).data;
    },
    onSuccess: (res) => {
      refreshFinance(qc);
      if (res.failed.length) {
        // Partial success is the design, so it is REPORTED rather than hidden:
        // the rows that posted are real money movements, and the ones that did
        // not are named by line so they can be fixed.
        toast.error(`${res.detail} Lines ${
          res.failed.map((f) => f.line).join(", ")} could not be recorded.`);
      } else {
        toast.success(res.detail);
      }
      qc.invalidateQueries({ queryKey: ["finance"] });
      qc.invalidateQueries({ queryKey: ["pending-txns"] });
      // Land on the QUEUE when rows were parked, and on the ledger otherwise.
      // Ending on the transactions list after holding six rows would leave the
      // work somewhere the person has not been shown.
      navigate(res.pending > 0
        ? "/finance/transactions/pending" : "/finance/transactions");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  /* --------------------------------------------------------------- state -- */

  const usable = rows.filter((r) => !r.problem);
  const toPost = usable.filter((r) => {
    const d = decisions[r.line];
    return d && ((d.action === "party" && d.party)
      || (d.action === "expense" && d.category));
  });
  // Parked for later. Counted apart from the skipped rows because they mean
  // opposite things — one is work outstanding, the other is work deliberately
  // not done — and the person pressing Record should see both numbers.
  const toPark = usable.filter((r) => decisions[r.line]?.action === "pending");
  const toSkip = usable.filter((r) => decisions[r.line]?.action === "skip");
  const postTotal = useMemo(
    () => toPost.reduce((sum, r) =>
      sum + (r.direction === "in" ? r.amount_paise : -r.amount_paise), 0),
    [toPost]);

  const setDecision = (line: number, patch: Partial<Decision>) =>
    setDecisions((s) => ({ ...s, [line]: { ...s[line], ...patch } }));

  return (
    <RecordPage
      backTo="/finance/transactions"
      backLabel="Back to transactions"
      title="Import a bank statement"
      subtitle="Upload the statement you downloaded from your bank, then say
        who each transaction was with."
    >
      <div className="space-y-4">
        <Steps step={step} />

        {step === "upload" && (
          <UploadStep
            accountId={accountId} onAccount={setAccountId}
            file={file} onFile={setFile} fileRef={fileRef}
            busy={load.isPending}
            onNext={() => load.mutate(undefined)} />
        )}

        {step === "map" && preview && (
          <MapStep
            preview={preview} mapping={mapping} onMapping={setMapping}
            shape={shape} onShape={setShape}
            busy={load.isPending}
            onBack={() => setStep("upload")}
            onNext={() => load.mutate(mappingFor(mapping, shape))} />
        )}

        {step === "assign" && preview && (
          <>
            <AssignSummary
              preview={preview} usable={usable.length}
              toPost={toPost.length} toPark={toPark.length}
              removed={removed.size}
              net={postTotal}
              onRemap={() => setStep("map")} />

            <div className="space-y-2">
              {rows.map((r) => (r.problem ? (
                <UnreadableRow key={r.line} line={r.line} problem={r.problem}
                  description={r.description} />
              ) : (
                <StatementRowCard key={r.line}
                  facts={r}
                  decision={decisions[r.line]
                    ?? { action: "pending", key: crypto.randomUUID() }}
                  onChange={(patch) => setDecision(r.line, patch)}
                  removeLabel="Remove this transaction from the import"
                  onRemove={async () => {
                    // THE CONFIRMATION THE OWNER ASKED FOR, in the owner's own
                    // words: "we don't want to delete any of the transactions
                    // actually". Removing here only drops the row from THIS
                    // import — it is not recorded and not parked, so the only
                    // trace left is the statement file itself.
                    if (await confirmDialog({
                      title: "Remove this transaction?",
                      message: `${formatDate(r.occurred_on)} · ${
                        formatINR(r.amount_paise)} — ${
                        r.description || "no description"}.\n\nIt will not be `
                        + "recorded and will not be held as pending. If you are "
                        + "not sure, leave it as Pending instead and decide "
                        + "later.",
                      confirmLabel: "Remove it",
                      danger: true,
                    })) {
                      setRemoved((s) => new Set(s).add(r.line));
                    }
                  }} />
              )))}
            </div>

            <div className="sticky bottom-0 flex flex-wrap items-center gap-3
              border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
              <span className="text-sm text-slate-600">
                <b className="text-slate-900">{toPost.length}</b> to record
                {toPark.length > 0 && <>, {toPark.length} held as pending</>}
                {toSkip.length > 0 && <>, {toSkip.length} skipped</>}
              </span>
              <button className="btn-primary ml-auto"
                disabled={commit.isPending
                  || (toPost.length === 0 && toPark.length === 0)}
                onClick={async () => {
                  // A money write that cannot be undone in one action deserves
                  // a sentence saying what is about to happen — and the pending
                  // rows are named in the same breath, because a row parked
                  // into a queue nobody mentions is a row thrown away with
                  // extra steps.
                  if (await confirmDialog({
                    title: toPost.length
                      ? `Record ${toPost.length} transaction${
                        toPost.length === 1 ? "" : "s"}?`
                      : `Hold ${toPark.length} transaction${
                        toPark.length === 1 ? "" : "s"} as pending?`,
                    message: (toPost.length
                      ? "They post to the selected account and every balance "
                        + "updates. Each one can be edited or reversed "
                        + "afterwards from the Transactions page."
                      : "")
                      + (toPark.length
                        ? `${toPost.length ? "\n\n" : ""}${toPark.length} `
                          + "will be held as pending — nothing posts for those, "
                          + "and they wait in the Pending list on Transactions "
                          + "until somebody finishes them."
                        : ""),
                    confirmLabel: toPost.length ? "Record them" : "Hold them",
                  })) commit.mutate();
                }}>
                {commit.isPending
                  ? <Spinner className="h-4 w-4" />
                  : <><Icon.Check size={16} />{" "}
                    {toPost.length ? `Record ${toPost.length}`
                      : `Hold ${toPark.length}`}</>}
              </button>
            </div>
          </>
        )}
      </div>
    </RecordPage>
  );
}

/** Only the fields belonging to the chosen file SHAPE are sent. */
function mappingFor(m: Record<string, string>,
                    shape: "split" | "single"): Record<string, string> {
  const core = ["date_col", "description_col", "reference_col"];
  const extra = shape === "split"
    ? ["debit_col", "credit_col"] : ["amount_col", "dr_cr_col"];
  const out: Record<string, string> = {};
  for (const k of [...core, ...extra]) if (m[k]) out[k] = m[k];
  // At least one key must be present or the server treats it as "no mapping
  // sent" and guesses again — which would silently discard the person's
  // choice of shape.
  if (!Object.keys(out).length) out.date_col = m.date_col ?? "";
  return out;
}

/* -------------------------------------------------------------- the steps -- */

function Steps({ step }: { step: Step }) {
  const items: { key: Step; label: string }[] = [
    { key: "upload", label: "Choose the file" },
    { key: "map", label: "Check the columns" },
    { key: "assign", label: "Assign each transaction" },
  ];
  const at = items.findIndex((i) => i.key === step);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {items.map((i, n) => (
        <li key={i.key} className="flex items-center gap-2">
          {n > 0 && <Icon.ChevronRight size={14} className="text-slate-400" />}
          <span className={n === at ? "font-semibold text-slate-900"
            : n < at ? "text-slate-500" : "text-slate-400"}>
            {n < at && <Icon.Check size={13} className="mr-1 inline
              align-[-1px] text-money-in" />}
            {i.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function UploadStep({
  accountId, onAccount, file, onFile, fileRef, busy, onNext,
}: {
  accountId: string;
  onAccount: (v: string) => void;
  file: File | null;
  onFile: (f: File | null) => void;
  fileRef: React.RefObject<HTMLInputElement>;
  busy: boolean;
  onNext: () => void;
}) {
  return (
    <div className="card card-body space-y-5">
      {/*
        The ACCOUNT is chosen once, for the whole file.

        A bank statement does not name the account inside its rows — the account
        is what the file IS. Asking per row would be asking the same question
        two hundred times, and getting one row wrong would put money in an
        account it never reached.
      */}
      <BankAccountSelect value={accountId} onChange={onAccount}
        label="Which account is this statement for?"
        hint="Every transaction in the file posts to this account." />

      <Field label="Statement file" required
        hint="CSV or Excel, straight from your bank. Up to 2,000 rows.">
        <input ref={fileRef} type="file" className="input py-1.5"
          accept=".csv,.xlsx,.xls,text/csv"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
        {file && (
          <span className="inline-flex items-center gap-1 text-xs font-medium
            text-money-in">
            <Icon.Check size={13} /> {file.name}
          </span>
        )}
      </Field>

      <div className="rounded-control border border-line bg-slate-50 px-3 py-2.5
        text-xs text-slate-600">
        <p className="font-medium text-slate-700">
          You do not need to reformat anything.</p>
        <p className="mt-1">
          HDFC, SBI, Bank of Baroda, ICICI and Axis all name their columns
          differently. We read whatever headings your file has and show you what
          we think each one means before anything is recorded. Nothing is saved
          until the last step.
        </p>
      </div>

      <div className="flex justify-end">
        <button className="btn-primary" disabled={!file || !accountId || busy}
          onClick={onNext}>
          {busy ? <Spinner className="h-4 w-4" />
            : <>Read the file <Icon.ChevronRight size={16} /></>}
        </button>
      </div>
    </div>
  );
}

function MapStep({
  preview, mapping, onMapping, shape, onShape, busy, onBack, onNext,
}: {
  preview: StatementPreview;
  mapping: Record<string, string>;
  onMapping: (m: Record<string, string>) => void;
  shape: "split" | "single";
  onShape: (s: "split" | "single") => void;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const set = (k: string, v: string) => onMapping({ ...mapping, [k]: v });
  const fields = MAP_FIELDS.filter(
    (f) => f.group === "core" || f.group === shape);
  const ready = !!mapping.date_col && (shape === "split"
    ? !!(mapping.debit_col || mapping.credit_col)
    : !!(mapping.amount_col && mapping.dr_cr_col));

  return (
    <div className="card card-body space-y-5">
      <div>
        <p className="text-section text-slate-900">
          Does this look right?</p>
        <p className="mt-0.5 text-sm text-slate-500">
          We read {preview.total_rows} row
          {preview.total_rows === 1 ? "" : "s"} and guessed what each column
          means. Check them against the sample below — a wrong amount column
          would record the wrong money.
        </p>
      </div>

      {/* Two shapes, and a statement is one or the other. Asked explicitly
          rather than inferred, because the two produce different questions and
          a half-guessed mapping is harder to correct than a chosen one. */}
      <Field label="How does this statement show the amount?">
        <Segmented<"split" | "single">
          value={shape} onChange={onShape}
          options={[
            { value: "split", label: "Separate debit and credit columns" },
            { value: "single", label: "One amount column + Dr/Cr" },
          ]} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <select className="select" value={mapping[f.key] ?? ""}
              onChange={(e) => set(f.key, e.target.value)}>
              <option value="">— Not in this file —</option>
              {preview.columns.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
        ))}
      </div>

      {/* The file's own first rows. This is what makes the mapping CHECKABLE
          rather than merely confirmable — you can see that the column you
          picked as the date really does hold dates. */}
      {preview.sample.length > 0 && (
        <div>
          <p className="mb-2 text-caption uppercase text-slate-500">
            First {preview.sample.length} rows of your file</p>
          <div className="overflow-x-auto rounded-control border border-line">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-2 py-1.5
                      text-left font-semibold text-slate-600">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row, i) => (
                  <tr key={i} className="border-t border-line-soft">
                    {preview.columns.map((_, j) => (
                      <td key={j} className="whitespace-nowrap px-2 py-1.5
                        text-slate-600">{row[j] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex justify-between gap-2">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" disabled={!ready || busy}
          onClick={onNext}>
          {busy ? <Spinner className="h-4 w-4" />
            : <>Read the transactions <Icon.ChevronRight size={16} /></>}
        </button>
      </div>
    </div>
  );
}

function AssignSummary({
  preview, usable, toPost, toPark, removed, net, onRemap,
}: {
  preview: StatementPreview;
  usable: number;
  toPost: number;
  toPark: number;
  removed: number;
  net: number;
  onRemap: () => void;
}) {
  const unreadable = preview.rows.length - usable - removed;
  return (
    <div className="card card-body space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span><b className="text-slate-900">{preview.rows.length}</b> rows read</span>
        <span className="text-slate-500">·</span>
        <span><b className="text-slate-900">{toPost}</b> to record</span>
        {toPark > 0 && (
          <>
            <span className="text-slate-500">·</span>
            <span className="text-due"><b>{toPark}</b> pending</span>
          </>
        )}
        {removed > 0 && (
          <>
            <span className="text-slate-500">·</span>
            <span className="text-slate-500"><b>{removed}</b> removed</span>
          </>
        )}
        {preview.duplicates > 0 && (
          <>
            <span className="text-slate-500">·</span>
            <span className="text-due">
              <b>{preview.duplicates}</b> look already recorded
            </span>
          </>
        )}
        {unreadable > 0 && (
          <>
            <span className="text-slate-500">·</span>
            <span className="text-money-out"><b>{unreadable}</b> unreadable</span>
          </>
        )}
        <button className="btn-secondary btn-sm ml-auto" onClick={onRemap}>
          <Icon.Edit size={13} /> Change the columns
        </button>
      </div>

      {toPost > 0 && (
        <p className="text-sm text-slate-600">
          Net effect on this account:{" "}
          <b className={net >= 0 ? "text-money-in" : "text-money-out"}>
            {net >= 0 ? "+" : "−"}{formatINR(Math.abs(net))}
          </b>
        </p>
      )}

      {preview.truncated && (
        <p className="rounded-control border border-due/25 bg-due/10 px-3 py-2
          text-xs text-due">
          This file has more rows than can be imported in one go. The first
          2,000 are shown — import them, then upload the rest.
        </p>
      )}

      {/*
        WHAT A ROW STARTS AS, said before anybody scrolls (owner 2026-08-24).
        Pending is a real destination, not an absence — the sentence has to make
        that clear or people will assume an undecided row is lost.
      */}
      <p className="text-xs text-slate-500">
        Every row starts as <b>Pending</b>. Choose who a transaction was with to
        record it now; leave it Pending and it waits in the Pending list on
        Transactions until somebody works out what it was. Use the cross to drop
        a row from this import altogether. Nothing is saved until you press the
        button at the bottom.
      </p>
    </div>
  );
}
