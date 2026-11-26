import { useMemo, useState } from "react";
import { Check, CheckSquare, Clock, Loader2, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pendingTxnsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import {
  StatementRowCard, type RowDecision,
} from "../../components/finance/StatementRow";
import { toast } from "../../components/Toast";
import { confirmDialog, promptDialog } from "../../components/Confirm";
import { formatDate, formatINR } from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import { useAuth } from "../../store/auth";
import type { PendingResolveRow, PendingTxn } from "../../lib/types";

/*
  THE PENDING LIST (/finance/transactions/pending).

  Statement lines somebody could not decide when they imported them. The owner
  asked for it in the same breath as replacing "skip" with "pending":

    "make sure there is a proper view somewhere on the transactions page where
     the owner can see the pending actions to take on these imported
     transactions, so like a pending button. So when he clicks on it, he can
     again go back to the same kind of UI and make those changes in those
     pending transactions that are there."

  "THE SAME KIND OF UI" IS LITERAL. Every row here is the same
  `StatementRowCard` the import screen draws, because it is the same question
  about the same kind of line, and the server books both through the same
  function. A second rendering is how the two screens end up offering different
  options for the same row.

  GROUPED BY THE FILE THEY CAME FROM. A person works a statement — "Tuesday's
  HDFC file, six left" is a task with an end; ninety rows from four files is
  not.

  NOTHING HERE IS DELETED. The cross marks a row DISMISSED, with who and why,
  and it can be put back. That is the owner's own condition: "we don't want to
  delete any of the transactions actually."
*/

type View = "open" | "closed";

export default function PendingTransactionsPage() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const canManage = has("manage_transactions");
  const [view, setView] = useState<View>("open");
  // Which import is on screen. "" is all of them — which is right when there
  // are six rows and wrong when there are ninety, so the batch strip below is
  // how you narrow it.
  const [batch, setBatch] = useState(() => params.get("batch") ?? "");
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});

  const list = useQuery({
    queryKey: ["pending-txns", view, batch],
    queryFn: async () => (await pendingTxnsApi.list({
      status: view === "open" ? "pending" : "all",
      import_batch_id: batch || undefined,
    })).data,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pending-txns"] });
    refreshFinance(qc);
  };

  const rows = useMemo(
    () => (list.data?.items ?? []).filter(
      (r) => view === "open" ? r.status === "pending" : r.status !== "pending"),
    [list.data, view]);

  const decisionFor = (r: PendingTxn): RowDecision =>
    decisions[r.id] ?? { action: "party", key: r.id };

  const setDecision = (id: string, patch: Partial<RowDecision>) =>
    setDecisions((s) => ({
      ...s,
      [id]: { ...(s[id] ?? { action: "party", key: id }), ...patch },
    }));

  const ready = rows.filter((r) => {
    const d = decisions[r.id];
    return d && ((d.action === "party" && d.party)
      || (d.action === "expense" && d.category));
  });

  const record = useMutation({
    mutationFn: async () => {
      const payload: PendingResolveRow[] = ready.map((r) => {
        const d = decisions[r.id]!;
        return d.action === "party"
          ? { id: r.id, action: "party" as const,
            party_type: d.party!.kind, party_id: d.party!.id,
            idempotency_key: d.key }
          : { id: r.id, action: "expense" as const,
            expense_category: d.category, idempotency_key: d.key };
      });
      return (await pendingTxnsApi.resolve(payload)).data;
    },
    onSuccess: (res) => {
      refresh();
      setDecisions({});
      if (res.failed.length) {
        // Partial success is the design here as it is on the importer: the rows
        // that posted are real money movements, and the ones that did not are
        // still in the queue, which is the correct state.
        toast.error(`${res.detail} ${res.failed.length} stayed in the list.`);
      } else {
        toast.success(res.detail);
      }
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const discard = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      pendingTxnsApi.discard(v.id, v.reason),
    onSuccess: () => { refresh(); toast.success("Removed from the list."); },
    onError: (e) => toast.error(apiError(e)),
  });

  const restore = useMutation({
    mutationFn: (id: string) => pendingTxnsApi.restore(id),
    onSuccess: () => { refresh(); toast.success("Back in the list."); },
    onError: (e) => toast.error(apiError(e)),
  });

  const totals = list.data;

  return (
    <RecordPage
      backTo="/finance/transactions"
      backLabel="Back to transactions"
      title="Pending transactions"
      subtitle="Lines from a bank statement that nobody could place yet. Nothing
        here has been recorded and no balance has moved — say who each one was
        with and it posts exactly as it would have on import."
    >
      <div className="space-y-4">
        <Tabs
          value={view}
          onValueChange={(v) => {
            setView(v as View);
            setDecisions({});
          }}
        >
          <TabsList>
            <TabsTrigger value="open" className="gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Waiting
              {totals?.open_count ? (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                  {totals.open_count}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="closed" className="gap-1.5">
              <CheckSquare className="h-3.5 w-3.5" />
              Dealt with
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {view === "open" && (totals?.open_count ?? 0) > 0 && (
          <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm">
            <span>
              <b className="text-slate-900">{totals!.open_count}</b> waiting
            </span>
            {totals!.in_paise > 0 && (
              <span className="text-emerald-700">
                +{formatINR(totals!.in_paise)} received
              </span>
            )}
            {totals!.out_paise > 0 && (
              <span className="text-red-600">
                −{formatINR(totals!.out_paise)} paid
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => navigate("/finance/transactions/import")}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import another statement
            </Button>
          </Card>
        )}

        {view === "open" && (totals?.batches.length ?? 0) > 1 && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={batch === "" ? "default" : "outline"}
              size="sm"
              className="h-7 rounded-full text-xs"
              onClick={() => {
                setBatch("");
                syncBatch(params, setParams, "");
              }}
            >
              All imports
            </Button>
            {totals!.batches.map((b) => (
              <Button
                key={b.import_batch_id}
                variant={batch === b.import_batch_id ? "default" : "outline"}
                size="sm"
                className="h-7 rounded-full text-xs"
                onClick={() => {
                  setBatch(b.import_batch_id);
                  syncBatch(params, setParams, b.import_batch_id);
                }}
              >
                {b.source_file || b.bank_account_name || "Import"}
                <span className="ml-1.5 opacity-70">{b.open_count}</span>
              </Button>
            ))}
          </div>
        )}

        {list.isError ? (
          <ErrorState onRetry={() => list.refetch()} />
        ) : list.isLoading ? (
          <Card className="flex items-center justify-center p-8">
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
          </Card>
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              view === "open"
                ? "Nothing waiting"
                : "Nothing has been dealt with yet"
            }
            description={
              view === "open"
                ? "Rows you mark as Pending while importing a bank statement land here."
                : "Rows you record or remove from the list show up here, so a dismissed transaction can always be found again."
            }
            action={
              view === "open" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate("/finance/transactions/import")}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Import a statement
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <StatementRowCard
                key={r.id}
                facts={r}
                showPending={false}
                decision={decisionFor(r)}
                onChange={(patch) => setDecision(r.id, patch)}
                removeLabel="Remove from the pending list"
                onRemove={view === "open" && canManage ? async () => {
                  // The owner's confirmation, and the REASON behind it. A row
                  // that vanished with no explanation is exactly what the
                  // dialog was protecting against, so the dialog collects the
                  // explanation rather than merely asking twice.
                  const reason = await promptDialog({
                    title: "Remove this from the pending list?",
                    message: `${formatDate(r.occurred_on)} · ${
                      formatINR(r.amount_paise)} — ${
                      r.description || "no description"}.`
                      + " It stays on record as dismissed and can be put back, "
                      + "but it will not be recorded as a transaction.",
                    label: "Why is this not ours?",
                    placeholder: "Internal transfer already recorded",
                    confirmLabel: "Remove it",
                    minLength: 3,
                  });
                  if (reason) discard.mutate({ id: r.id, reason });
                } : undefined}
                extra={<RowFooter row={r} canManage={canManage}
                  onRestore={() => restore.mutate(r.id)} />} />
            ))}
          </div>
        )}

        {view === "open" && rows.length > 0 && canManage && (
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white/95 px-1 py-3 backdrop-blur">
            <span className="text-sm text-slate-600">
              <b className="text-slate-900">{ready.length}</b> of {rows.length}{" "}
              ready to record
            </span>
            <Button
              className="ml-auto"
              size="sm"
              disabled={record.isPending || ready.length === 0}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: `Record ${ready.length} transaction${
                      ready.length === 1 ? "" : "s"
                    }?`,
                    message:
                      "They post to the account each one came from and every balance updates. Each can be edited or reversed afterwards from the Transactions page.",
                    confirmLabel: "Record them",
                  })
                ) {
                  record.mutate();
                }
              }}
            >
              {record.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5" /> Record {ready.length}
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </RecordPage>
  );
}

/** Keep the chosen import in the URL, so a link to one batch is shareable. */
function syncBatch(params: URLSearchParams,
                   setParams: (p: URLSearchParams,
                               o?: { replace?: boolean }) => void,
                   value: string) {
  const next = new URLSearchParams(params);
  if (value) next.set("batch", value); else next.delete("batch");
  setParams(next, { replace: true });
}

/**
 * Where a row came from, and what happened to it.
 *
 * Under the controls rather than beside the amount, because it is provenance
 * and not a decision — but it is on the row rather than a click away, because
 * "which statement was this?" is the first question anybody asks about a line
 * they are seeing three weeks after it was parked.
 */
function RowFooter({ row, canManage, onRestore }: {
  row: PendingTxn; canManage: boolean; onRestore: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t
      border-line-soft pt-2 text-xs text-slate-500">
      <span>{row.bank_account_name || "Account not named"}</span>
      {row.source_file && <span>· {row.source_file}</span>}
      {row.created_by_name && <span>· held by {row.created_by_name}</span>}
      {row.note && (
        <span className="text-slate-600">· “{row.note}”</span>
      )}
      {row.status === "recorded" && (
        <Badge variant="secondary" className="gap-1 bg-emerald-50 text-emerald-700">
          <Check className="h-3 w-3" /> Recorded
          {row.resolved_by_name ? ` by ${row.resolved_by_name}` : ""}
        </Badge>
      )}
      {row.status === "discarded" && (
        <>
          <Badge variant="secondary">
            Removed{row.discarded_by_name
              ? ` by ${row.discarded_by_name}` : ""}
            {row.discard_reason ? ` — ${row.discard_reason}` : ""}
          </Badge>
          {canManage && (
            <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={onRestore}>
              <RefreshCw className="mr-1 h-3 w-3" /> Put it back
            </Button>
          )}
        </>
      )}
    </div>
  );
}
