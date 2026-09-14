import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  banksApi, documentsApi, financeApi, pendingTxnsApi,
} from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { DateInput } from "../components/DateInput";
import {
  EmptyState, ErrorState, Ledger, LedgerFigure, LedgerRow, ListShell, LTh,
  MobileCard, Pagination, SearchInput, TableSkeleton,
} from "../components/ui";
import { ExportButton } from "../components/ExportButton";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { apiError } from "../api/client";
import { formatDate, formatINR } from "../lib/format";
import { refreshFinance } from "../lib/live";
import { useAuth } from "../store/auth";
import type { LedgerTxn } from "../lib/types";
import {
  ENTITY_OF,
  EXPENSE_LABEL,
  FILTERABLE_TYPES,
  HIDDEN_TYPES,
  LOCKED_TYPES,
  PARTY_LABEL,
  TypeTag,
  amountTone,
  mergeRows,
} from "./finance/txnDisplay";
import type { DisplayRow } from "./finance/txnDisplay";
import { FilterPill } from "../components/FilterPill";

/*
  Who the row is about, in one string.

  An expense has no party — it is paid TO someone, or it is just the house —
  so the label had two different shapes written inline in two places (the
  desktop cell and, once the phone rendering arrived, a third). One function.
*/
function partyLabelOf(t: DisplayRow): string {
  if (t.txn_type !== "expense") return t.party_name || "—";
  return t.paid_to_name || t.party_name
    || (t.expense_category
      ? EXPENSE_LABEL[t.expense_category] ?? t.expense_category
      : "House");
}

// Read-only detail popup for ANY transaction (manual or auto). Auto rows show
// which policy the money moved for, with a jump to that policy.
// Edit a manual ledger row — magnitude, reference, note and date. The sign
// (receivable vs payable) is preserved server-side from the original row.
// Merged log + history: manually record any money movement, then browse the
// full ledger with type / date / search filters. Managers can edit, cancel
// (reverse) or delete rows — balances recompute automatically.
export default function TransactionsPage() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const canManage = has("manage_transactions");
  const [type, setType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [q, setQ] = useState("");
  // Which of OUR accounts. "" = all, "none" = rows carrying no account at all.
  //
  // That second value is the one that earns this filter. A row with no account
  // is a row no balance can explain — a legacy entry, or one recorded before
  // the agency added accounts — and there was no way to list them. They stayed
  // invisible until an account disagreed with the bank, at which point nobody
  // could say which rows were unaccounted for.
  const [account, setAccount] = useState("");
  const [page, setPage] = useState(1);

  const ledger = useQuery({
    queryKey: ["finance", "ledger-all", type, dateFrom, dateTo, q, account,
      page],
    queryFn: async () => (await financeApi.ledger({
      txn_type: type || undefined,
      exclude_types: type ? undefined : HIDDEN_TYPES,
      date_from: dateFrom || undefined,
      date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
      bank_account_id: account || undefined,
      q: q || undefined, page, page_size: 25,
    })).data,
  });

  // How many statement lines are waiting for somebody to place them. Its own
  // tiny endpoint rather than a field on the ledger response: the badge is read
  // from a page that already loads 25 rows and must not drag a second list
  // behind it, and the count has to be the OPEN one regardless of any filter in
  // force on the queue itself.
  const pendingCount = useQuery({
    queryKey: ["pending-txns", "count"],
    queryFn: async () => (await pendingTxnsApi.count()).data,
    staleTime: 30_000,
  });

  // The account list for the filter. Behind view_bank_accounts, like the picker
  // on the payment form — somebody who may not read balances is not shown a
  // list of the agency's accounts just because they can read the ledger.
  const accounts = useQuery({
    queryKey: ["banks", "active"],
    enabled: has("view_bank_accounts"),
    queryFn: async () => (await banksApi.list()).data.items,
    staleTime: 60_000,
  });

  // After any mutation the list must update INSTANTLY (owner 1.6 note):
  // refreshFinance refetches every finance/dashboard/wallet query (including
  // pages that aren't mounted, via refetchType "all"), so the on-page ledger
  // list and every other surface update together.
  const refreshNow = () => refreshFinance(qc);
  const cancelTxn = useMutation({
    mutationFn: (id: string) => financeApi.cancelLedger(id),
    onSuccess: async () => { await refreshNow();
      toast.success("Transaction reversed."); },
    onError: (e) => toast.error(apiError(e)),
  });
  const deleteTxn = useMutation({
    mutationFn: (id: string) => financeApi.deleteLedger(id),
    onSuccess: async () => { await refreshNow();
      toast.success("Transaction deleted."); },
    onError: (e) => toast.error(apiError(e)),
  });

  const openAttachment = async (docId: string) => {
    try {
      const { data } = await documentsApi.download(docId);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      /* toast handled globally */
    }
  };

  const onCancel = async (t: LedgerTxn) => {
    if (await confirmDialog({
      title: "Reverse transaction?",
      message: "Reverse this transaction? A balancing entry will be posted and "
        + "all related balances will recalculate.",
      confirmLabel: "Reverse", danger: true })) cancelTxn.mutate(t.id);
  };
  const onDelete = async (t: LedgerTxn) => {
    if (await confirmDialog({
      title: "Delete transaction?",
      message: "Permanently delete this transaction? Related balances will "
        + "recalculate.",
      danger: true })) deleteTxn.mutate(t.id);
  };

  const reset = () => {
    setType(""); setDateFrom(""); setDateTo(""); setQ(""); setAccount("");
    setPage(1);
  };
  const hasFilters = type || dateFrom || dateTo || q || account;

  return (
    <div>
      <PageHeader title="Transactions"
        subtitle="Every money movement. Editing a row recalculates all balances."
        actions={
          <div className="flex items-center gap-2">
            <ExportButton filename="transactions"
              onExport={(fmt) => financeApi.ledgerExport({
                txn_type: type || undefined,
                exclude_types: type ? undefined : HIDDEN_TYPES,
                date_from: dateFrom || undefined,
                date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
                bank_account_id: account || undefined,
                q: q || undefined, fmt })} />
            {/*
              THE PENDING BUTTON (owner 2026-08-24), and the count on it.

              "Make sure there is a proper view somewhere on the transactions
              page where the owner can see the pending actions to take on these
              imported transactions, so like a pending button."

              Drawn ONLY when something is waiting. A permanent button reading
              "Pending 0" is a button people stop seeing, which would defeat the
              whole point of parking a row rather than skipping it.
            */}
            {(pendingCount.data?.open_count ?? 0) > 0 && (
              <button className="btn-secondary"
                title="Statement lines nobody has placed yet"
                onClick={() => nav("/finance/transactions/pending")}>
                <Icon.Clock size={16} /> Pending
                <span className="badge-due ml-1">
                  {pendingCount.data!.open_count}
                </span>
              </button>
            )}
            {canManage && (
              <button className="btn-secondary"
                title="Bulk-record transactions from a bank statement"
                onClick={() => nav("/finance/transactions/import")}>
                <Icon.Upload size={16} /> Import statement
              </button>
            )}
            {canManage && (
              <button className="btn-primary" onClick={() => nav("/finance/transactions/new")}>
                <Icon.Plus size={18} /> Add Transaction
              </button>
            )}
          </div>
        } />

      <div>
        {/* Was a hand-rolled `flex gap-2 border-b border-line/70 p-3` — one of
            the eight bespoke filter rows the system exists to prevent. */}
        <div className="ledger-bar">
          <FilterPill label="Type" value={type}
            onChange={(v) => { setPage(1); setType(v); }}
            options={FILTERABLE_TYPES.map(([v, l]) => ({
              value: v, label: l }))} />
          <DateInput className="input w-40"
            value={dateFrom} title="From" placeholder="From dd/mm/yyyy"
            onChange={(v) => { setPage(1); setDateFrom(v); }} />
          <DateInput className="input w-40"
            value={dateTo} title="To" placeholder="To dd/mm/yyyy"
            onChange={(v) => { setPage(1); setDateTo(v); }} />
          {(accounts.data ?? []).length > 0 && (
            <FilterPill label="Account" value={account}
              onChange={(v) => { setPage(1); setAccount(v); }}
              options={[
                ...(accounts.data ?? []).map((a) => ({
                  value: a.id, label: a.name })),
                { value: "none", label: "No account recorded" },
              ]} />
          )}
          <SearchInput value={q} onChange={(v) => { setPage(1); setQ(v); }}
            placeholder="Search reference / note…" className="w-56" />
          {hasFilters && (
            <button className="text-xs text-slate-500 hover:underline"
              onClick={reset}>Clear</button>
          )}
        </div>

        {ledger.isError ? (
          <ErrorState onRetry={() => ledger.refetch()} />
        ) : ledger.isLoading ? (
          <TableSkeleton cols={6} />
        ) : (ledger.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No transactions"
            hint={hasFilters ? "No transactions match these filters."
              : "Recorded payments appear here."} />
        ) : (
          <>
            <ListShell
              bare
              cards={mergeRows(ledger.data!.items).map((t: DisplayRow) => (
                <MobileCard key={t.id} to={`/finance/transactions/${t.id}`}
                  title={partyLabelOf(t)}
                  meta={
                    <>
                      {formatDate(t.occurred_at)}
                      {(t.reference || t.note) && ` · ${t.reference || t.note}`}
                    </>
                  }
                  right={
                    <span className={`block whitespace-nowrap text-metric-sm
                      tabular-nums ${amountTone(t.txn_type,
                        t.amount_paise).cls}`}>
                      {amountTone(t.txn_type, t.amount_paise).sign}
                      {formatINR(Math.abs(t.amount_paise))}
                    </span>
                  }
                  footer={<TypeTag t={t.txn_type} party={t.party_type} />}
                />
              ))}
              table={
                <Ledger
                  head={
                    <>
                      <LTh>Party</LTh>
                      <LTh>Type</LTh>
                      <LTh>Reference / note</LTh>
                      <LTh align="right">Amount</LTh>
                      <LTh align="right">Actions</LTh>
                    </>
                  }
                >
                  {mergeRows(ledger.data!.items).map((t: DisplayRow) => (
                    <LedgerRow key={t.id}>
                      {/*
                        Party over date: "When" was its own leading column of
                        grey text, which put the least distinguishing fact on a
                        statement first. You look for WHO, then check the date.
                      */}
                      <td>
                        {t.txn_type === "expense" ? (
                          <span className="ledger-primary">
                            {partyLabelOf(t)}
                          </span>
                        ) : ENTITY_OF[t.party_type] ? (
                          <Link
                            to={`/finance/entity/${ENTITY_OF[t.party_type]}/${t.party_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="ledger-primary ledger-focus
                              hover:underline decoration-slate-300
                              underline-offset-2">
                            {t.party_name || "—"}
                          </Link>
                        ) : (
                          <span className="ledger-primary">
                            {t.party_name || "—"}
                          </span>
                        )}
                        <span className="ledger-sub">
                          {formatDate(t.occurred_at)}
                          {" · "}
                          {t.txn_type === "expense"
                            ? (t.expense_category
                              ? EXPENSE_LABEL[t.expense_category]
                                ?? t.expense_category
                              : "Expense")
                            : PARTY_LABEL[t.party_type]}
                        </span>
                      </td>
                      <td>
                        <TypeTag t={t.txn_type} party={t.party_type} />
                      </td>
                      <td className="text-[13px] text-slate-500">
                        <span>{t.reference || t.note || "—"}</span>
                        {t.attachment_doc_id && (
                          <button title="View attachment"
                            aria-label="View attachment"
                            className="ml-2 align-middle text-slate-500
                              hover:text-slate-900"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAttachment(t.attachment_doc_id!);
                            }}>
                            <Icon.Folder size={14} /></button>
                        )}
                      </td>
                      <LedgerFigure
                        className={amountTone(t.txn_type, t.amount_paise).cls}
                        value={
                          <>
                            {amountTone(t.txn_type, t.amount_paise).sign}
                            {formatINR(Math.abs(t.amount_paise))}
                          </>
                        }
                      />
                      <td>
                        <div className="flex items-center justify-end gap-1">
                          {canManage && LOCKED_TYPES.has(t.txn_type) && (
                            <span title="Auto-managed from the policy — edit the policy instead."
                              className="mr-1 text-xs text-slate-500">auto</span>
                          )}
                          {/* `.icon-btn` is the token control. These were
                              `rounded p-1.5` by hand — no size, no press
                              state, and a hover colour the palette retired. */}
                          {canManage && !LOCKED_TYPES.has(t.txn_type) && (
                            <>
                              <button title="Edit" aria-label="Edit"
                                className="icon-btn border-transparent"
                                onClick={() =>
                                  nav(`/finance/transactions/${t.id}/edit`)}>
                                <Icon.Edit size={15} /></button>
                              <button title="Cancel (reverse)"
                                aria-label="Cancel transaction"
                                className="icon-btn border-transparent
                                  hover:text-due"
                                onClick={() => onCancel(t)}>
                                <Icon.Refresh size={15} /></button>
                              <button title="Delete" aria-label="Delete"
                                className="icon-btn icon-btn-danger
                                  border-transparent"
                                onClick={() => onDelete(t)}>
                                <Icon.Trash size={15} /></button>
                            </>
                          )}
                          <button title="View details"
                            aria-label="View details"
                            className="icon-btn border-transparent"
                            onClick={() =>
                              nav(`/finance/transactions/${t.id}`)}>
                            <Icon.Eye size={15} /></button>
                        </div>
                      </td>
                    </LedgerRow>
                  ))}
                </Ledger>
              }
            />
            {ledger.data && (
              <Pagination page={page} pageSize={25} total={ledger.data.total}
                onChange={setPage} />
            )}
          </>
        )}
      </div>

    </div>
  );
}
