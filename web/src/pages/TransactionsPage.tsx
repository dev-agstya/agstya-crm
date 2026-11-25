import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  Clock,
  MoreHorizontal,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  banksApi,
  documentsApi,
  financeApi,
  pendingTxnsApi,
} from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { DateInput } from "../components/DateInput";
import { DataTable, Column } from "../components/shared/DataTable";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function partyLabelOf(t: DisplayRow): string {
  if (t.txn_type !== "expense") return t.party_name || "—";
  return (
    t.paid_to_name ||
    t.party_name ||
    (t.expense_category
      ? EXPENSE_LABEL[t.expense_category] ?? t.expense_category
      : "House")
  );
}

export default function TransactionsPage() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const canManage = has("manage_transactions");
  const [type, setType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [q, setQ] = useState("");
  const [account, setAccount] = useState("all");
  const [page, setPage] = useState(1);

  const ledger = useQuery({
    queryKey: [
      "finance",
      "ledger-all",
      type,
      dateFrom,
      dateTo,
      q,
      account,
      page,
    ],
    queryFn: async () =>
      (
        await financeApi.ledger({
          txn_type: type === "all" ? undefined : type,
          exclude_types: type !== "all" ? undefined : HIDDEN_TYPES,
          date_from: dateFrom || undefined,
          date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
          bank_account_id: account === "all" ? undefined : account,
          q: q || undefined,
          page,
          page_size: 25,
        })
      ).data,
  });

  const pendingCount = useQuery({
    queryKey: ["pending-txns", "count"],
    queryFn: async () => (await pendingTxnsApi.count()).data,
    staleTime: 30_000,
  });

  const accounts = useQuery({
    queryKey: ["banks", "active"],
    enabled: has("view_bank_accounts"),
    queryFn: async () => (await banksApi.list()).data.items,
    staleTime: 60_000,
  });

  const refreshNow = () => refreshFinance(qc);
  const cancelTxn = useMutation({
    mutationFn: (id: string) => financeApi.cancelLedger(id),
    onSuccess: async () => {
      await refreshNow();
      toast.success("Transaction reversed.");
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const deleteTxn = useMutation({
    mutationFn: (id: string) => financeApi.deleteLedger(id),
    onSuccess: async () => {
      await refreshNow();
      toast.success("Transaction deleted.");
    },
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
    if (
      await confirmDialog({
        title: "Reverse transaction?",
        message:
          "Reverse this transaction? A balancing entry will be posted and all related balances will recalculate.",
        confirmLabel: "Reverse",
        danger: true,
      })
    )
      cancelTxn.mutate(t.id);
  };

  const onDelete = async (t: LedgerTxn) => {
    if (
      await confirmDialog({
        title: "Delete transaction?",
        message:
          "Permanently delete this transaction? Related balances will recalculate.",
        danger: true,
      })
    )
      deleteTxn.mutate(t.id);
  };

  const reset = () => {
    setType("all");
    setDateFrom("");
    setDateTo("");
    setQ("");
    setAccount("all");
    setPage(1);
  };

  const hasFilters = !!(
    type !== "all" ||
    dateFrom ||
    dateTo ||
    q ||
    account !== "all"
  );

  const rows: DisplayRow[] = ledger.data?.items
    ? mergeRows(ledger.data.items)
    : [];

  const columns: Column<DisplayRow>[] = [
    {
      key: "party",
      header: "Party & Date",
      cell: (t) => (
        <div>
          {t.txn_type === "expense" ? (
            <span className="font-medium text-foreground">
              {partyLabelOf(t)}
            </span>
          ) : ENTITY_OF[t.party_type] ? (
            <Link
              to={`/finance/entity/${ENTITY_OF[t.party_type]}/${t.party_id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-medium text-foreground hover:text-primary hover:underline"
            >
              {t.party_name || "—"}
            </Link>
          ) : (
            <span className="font-medium text-foreground">
              {t.party_name || "—"}
            </span>
          )}
          <p className="text-xs text-muted-foreground">
            {formatDate(t.occurred_at)} ·{" "}
            {t.txn_type === "expense"
              ? t.expense_category
                ? EXPENSE_LABEL[t.expense_category] ?? t.expense_category
                : "Expense"
              : PARTY_LABEL[t.party_type]}
          </p>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (t) => <TypeTag t={t.txn_type} party={t.party_type} />,
    },
    {
      key: "note",
      header: "Reference / Note",
      cell: (t) => (
        <span className="block max-w-[240px] truncate text-sm text-muted-foreground">
          {t.reference || t.note || "—"}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (t) => {
        const tone = amountTone(t.txn_type, t.amount_paise);
        return (
          <span className={`font-semibold tabular-nums ${tone.cls}`}>
            {tone.sign}
            {formatINR(Math.abs(t.amount_paise))}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      mobileLabel: false,
      cell: (t) => {
        const locked = LOCKED_TYPES.has(t.txn_type) || !!t.is_reversed;
        return (
          <div
            className="flex items-center justify-end gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {t.attachment_document_id && (
              <Button
                variant="ghost"
                size="icon"
                title="View attachment"
                onClick={() => openAttachment(t.attachment_document_id!)}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            )}
            {canManage && !locked && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => nav(`/finance/transactions/${t.id}`)}
                  >
                    View / Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onCancel(t)}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Reverse
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onDelete(t)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        subtitle="Every payment received, paid out, or expense recorded."
        actions={
          <>
            <ExportButton
              filename="transactions"
              onExport={(fmt) =>
                financeApi.ledgerExport({
                  txn_type: type === "all" ? undefined : type,
                  exclude_types: type !== "all" ? undefined : HIDDEN_TYPES,
                  date_from: dateFrom || undefined,
                  date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
                  bank_account_id: account === "all" ? undefined : account,
                  q: q || undefined,
                  fmt,
                })
              }
            />
            {(pendingCount.data?.open_count ?? 0) > 0 && (
              <Button
                variant="outline"
                onClick={() => nav("/finance/transactions/pending")}
              >
                <Clock className="mr-1.5 h-4 w-4 text-amber-600" />
                Pending
                <Badge variant="secondary" className="ml-1.5">
                  {pendingCount.data!.open_count}
                </Badge>
              </Button>
            )}
            {canManage && (
              <>
                <Button
                  variant="outline"
                  onClick={() => nav("/finance/transactions/import")}
                >
                  <Upload className="mr-1.5 h-4 w-4" />
                  Import statement
                </Button>
                <Button onClick={() => nav("/finance/transactions/new")}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Record payment
                </Button>
              </>
            )}
          </>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
              placeholder="Search reference or note..."
              className="pl-9"
            />
          </div>

          <Select
            value={type}
            onValueChange={(v) => {
              setPage(1);
              setType(v);
            }}
          >
            <SelectTrigger className="w-[170px]">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {FILTERABLE_TYPES.map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(accounts.data ?? []).length > 0 && (
            <Select
              value={account}
              onValueChange={(v) => {
                setPage(1);
                setAccount(v);
              }}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Account" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {(accounts.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
                <SelectItem value="none">No account recorded</SelectItem>
              </SelectContent>
            </Select>
          )}

          <div className="w-36">
            <DateInput
              value={dateFrom}
              placeholder="From"
              onChange={(v) => {
                setPage(1);
                setDateFrom(v);
              }}
            />
          </div>
          <div className="w-36">
            <DateInput
              value={dateTo}
              placeholder="To"
              onChange={(v) => {
                setPage(1);
                setDateTo(v);
              }}
            />
          </div>

          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={reset}>
              <X className="mr-1 h-4 w-4" />
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      <DataTable
        data={rows}
        columns={columns}
        keyField={(t) => t.id}
        onRowClick={(t) => nav(`/finance/transactions/${t.id}`)}
        loading={ledger.isLoading}
        error={ledger.isError ? "Could not load transactions." : null}
        onRetry={() => ledger.refetch()}
        emptyTitle="No transactions found"
        emptyDescription={
          hasFilters
            ? "No transactions match your current filters."
            : "Recorded payments and expenses will appear here."
        }
        emptyAction={
          hasFilters ? (
            <Button variant="outline" onClick={reset}>
              Clear filters
            </Button>
          ) : canManage ? (
            <Button onClick={() => nav("/finance/transactions/new")}>
              <Plus className="mr-1.5 h-4 w-4" />
              Record payment
            </Button>
          ) : undefined
        }
        page={page}
        pageSize={25}
        total={ledger.data?.total}
        onPageChange={setPage}
      />
    </div>
  );
}
