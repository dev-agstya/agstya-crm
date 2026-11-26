import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  Clock,
  MoreHorizontal,
  Paperclip,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
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
import { FilterToolbar, FilterChip } from "../components/shared/FilterToolbar";
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
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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

  const chips: FilterChip[] = [];
  if (type !== "all") {
    const label = FILTERABLE_TYPES.find(([v]) => v === type)?.[1] ?? type;
    chips.push({
      key: "type",
      label: `Type: ${label}`,
      onRemove: () => { setPage(1); setType("all"); },
    });
  }
  if (account !== "all") {
    const label =
      account === "none"
        ? "No account"
        : (accounts.data ?? []).find((a) => a.id === account)?.name ?? "Account";
    chips.push({
      key: "account",
      label: `Account: ${label}`,
      onRemove: () => { setPage(1); setAccount("all"); },
    });
  }
  if (dateFrom) {
    chips.push({
      key: "from",
      label: `From: ${dateFrom}`,
      onRemove: () => { setPage(1); setDateFrom(""); },
    });
  }
  if (dateTo) {
    chips.push({
      key: "to",
      label: `To: ${dateTo}`,
      onRemove: () => { setPage(1); setDateTo(""); },
    });
  }

  const moreCount = (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);

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
        <span className="block max-w-[240px] truncate text-muted-foreground">
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
        const locked = LOCKED_TYPES.has(t.txn_type);
        return (
          <div
            className="flex items-center justify-end gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {t.attachment_doc_id && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="View attachment"
                onClick={() => openAttachment(t.attachment_doc_id!)}
              >
                <Paperclip className="h-3.5 w-3.5" />
              </Button>
            )}
            {canManage && !locked && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7">
                    <MoreHorizontal className="h-3.5 w-3.5" />
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
    <div>
      <PageHeader title="Transactions" />

      <FilterToolbar
        search={{
          value: q,
          onChange: (v) => {
            setPage(1);
            setQ(v);
          },
          placeholder: "Search reference or note...",
        }}
        moreCount={moreCount}
        chips={chips}
        onClearAll={reset}
        right={
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
                size="sm"
                className="h-8"
                onClick={() => nav("/finance/transactions/pending")}
              >
                <Clock className="mr-1 h-3.5 w-3.5 text-amber-600" />
                Pending
                <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">
                  {pendingCount.data!.open_count}
                </Badge>
              </Button>
            )}
            {canManage && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => nav("/finance/transactions/import")}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  Import
                </Button>
                <Button
                  size="sm"
                  className="h-8"
                  onClick={() => nav("/finance/transactions/new")}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Record payment
                </Button>
              </>
            )}
          </>
        }
        moreFilters={
          <>
            <div className="space-y-1">
              <Label className="text-xs">From date</Label>
              <DateInput
                value={dateFrom}
                placeholder="From"
                onChange={(v) => {
                  setPage(1);
                  setDateFrom(v);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To date</Label>
              <DateInput
                value={dateTo}
                placeholder="To"
                onChange={(v) => {
                  setPage(1);
                  setDateTo(v);
                }}
              />
            </div>
          </>
        }
      >
        <Select
          value={type}
          onValueChange={(v) => {
            setPage(1);
            setType(v);
          }}
        >
          <SelectTrigger className="h-9 w-[155px] bg-card text-xs sm:h-8">
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
            <SelectTrigger className="h-9 w-[160px] bg-card text-xs sm:h-8">
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
      </FilterToolbar>

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
            <Button variant="outline" size="sm" onClick={reset}>
              Clear filters
            </Button>
          ) : canManage ? (
            <Button size="sm" onClick={() => nav("/finance/transactions/new")}>
              <Plus className="mr-1 h-3.5 w-3.5" />
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
