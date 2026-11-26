import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Banknote,
  Building2,
  ChevronRight,
  Clock,
  CreditCard,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { banksApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { ErrorState } from "../components/shared/ErrorState";
import { KpiTile } from "../components/finance/KpiTile";
import { ReconcileDialog } from "../components/finance/ReconcileDialog";
import { confirmDialog } from "../components/Confirm";
import { toast } from "../components/Toast";
import { useAuth } from "../store/auth";
import { liveQueryOptions } from "../lib/live";
import { formatDate, formatINR } from "../lib/format";
import {
  BANK_ACCOUNT_TYPES,
  type BankAccount,
  type BankAccountType,
} from "../lib/types";
import { C } from "../components/finance/charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  BANK_ACCOUNT_TYPES.map((t) => [t.value, t.label])
);

const TYPE_ICON: Record<BankAccountType, typeof Building2> = {
  bank: Building2,
  cash: Banknote,
  upi: Zap,
  credit_card: CreditCard,
};

function balanceLabel(a: BankAccount): string {
  if (a.is_cash_asset) return "Balance";
  return a.balance_paise <= 0 ? "Outstanding" : "In credit";
}

function balanceTone(a: BankAccount): string {
  const owed = !a.is_cash_asset;
  if (a.balance_paise === 0) return "text-foreground";
  if (owed)
    return a.balance_paise < 0 ? "text-destructive" : "text-emerald-700";
  return a.balance_paise < 0 ? "text-destructive" : "text-foreground";
}

const RECONCILE_EVERY_DAYS = 30;

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function ReconciledNote({ account }: { account: BankAccount }) {
  const at = account.last_reconciled_at;
  if (!at) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground">
        Never checked against your bank.
      </p>
    );
  }
  const days = daysSince(at);
  const stale = days >= RECONCILE_EVERY_DAYS;
  const agreed = account.last_reconciled_diff_paise === 0;
  return (
    <p
      className={`mt-1 flex items-center gap-1 text-[11px] ${
        stale ? "font-medium text-amber-700" : "text-muted-foreground"
      }`}
    >
      {stale && <Clock className="h-3 w-3 shrink-0" />}
      <span>
        Checked{" "}
        {days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`}
        {agreed && !stale ? " — it agreed" : ""}
      </span>
    </p>
  );
}

function accountLine(a: BankAccount): string {
  return [
    TYPE_LABEL[a.account_type] ?? a.account_type,
    a.bank_name,
    a.account_last4 ? `****${a.account_last4}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function forDisplay(items: BankAccount[]): BankAccount[] {
  return [...items].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.is_default) - Number(a.is_default) ||
      a.name.localeCompare(b.name)
  );
}

export default function BanksPage() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canManage = has("manage_bank_accounts");

  const [showInactive, setShowInactive] = useState(false);
  const [reconciling, setReconciling] = useState<BankAccount | null>(null);

  const accounts = useQuery({
    queryKey: ["banks", showInactive],
    queryFn: async () =>
      (await banksApi.list({ include_inactive: showInactive })).data,
    ...liveQueryOptions,
  });
  const data = accounts.data;
  const items = forDisplay(data?.items ?? []);

  const remove = useMutation({
    mutationFn: (id: string) => banksApi.remove(id),
    onSuccess: () => {
      toast.success("Account deleted.");
      qc.invalidateQueries({ queryKey: ["banks"] });
    },
  });

  const onDelete = async (a: BankAccount) => {
    const ok = await confirmDialog({
      title: `Delete ${a.name}?`,
      message:
        "Only an account no money has ever moved through can be deleted. Otherwise deactivate it — its history keeps working.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) remove.mutate(a.id);
  };

  return (
    <div className="space-y-3">
      <PageHeader
        title="Bank & Cash Accounts"
        subtitle="Where the agency's money sits right now."
        actions={
          <div className="flex flex-wrap items-center gap-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={showInactive}
                onCheckedChange={setShowInactive}
              />
              Show inactive
            </label>
            {canManage && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => navigate("/finance/banks/transfer")}
                  disabled={items.filter((a) => a.active).length < 2}
                >
                  <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" /> Transfer
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => navigate("/finance/banks/new")}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add account
                </Button>
              </>
            )}
          </div>
        }
      />

      {accounts.isError ? (
        <ErrorState onRetry={() => accounts.refetch()} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <KpiTile
              label="Cash + bank in hand"
              tooltip="Total balance across all active bank, cash, and UPI accounts."
              value={data ? formatINR(data.totals.cash_in_hand) : "—"}
              sub="across every active bank, cash and UPI account"
              accent={C.green}
            />
            <KpiTile
              label="Owed on credit cards"
              tooltip="Credit card balances are liability accounts tracked separately from cash in hand."
              value={data ? formatINR(data.totals.credit_outstanding) : "—"}
              sub="reported separately — this is money you owe"
            />
            <KpiTile
              label="Accounts"
              value={data ? String(data.totals.accounts) : "—"}
              sub={
                canManage
                  ? "add one for every account you actually use"
                  : undefined
              }
            />
          </div>

          {accounts.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Card key={i} className="space-y-3 p-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-9 w-9 rounded-md" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-2/5" />
                      <Skeleton className="h-3 w-3/5" />
                    </div>
                  </div>
                  <Skeleton className="h-7 w-1/2" />
                  <Skeleton className="h-3 w-full" />
                </Card>
              ))}
            </div>
          ) : items.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Building2 className="h-5 w-5" />}
                title="No accounts yet"
                description={
                  canManage
                    ? "Add your bank, cash-in-hand and UPI accounts with their current balances."
                    : "Ask an owner to set up the agency's accounts."
                }
                action={
                  canManage ? (
                    <Button
                      size="sm"
                      onClick={() => navigate("/finance/banks/new")}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" /> Add account
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {items.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  canManage={canManage}
                  onEdit={() => navigate(`/finance/banks/${a.id}/edit`)}
                  onStatement={() =>
                    navigate(`/finance/banks/${a.id}/statement`)
                  }
                  onDelete={() => onDelete(a)}
                  onReconcile={() => setReconciling(a)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {reconciling && (
        <ReconcileDialog
          account={reconciling}
          open
          onClose={() => setReconciling(null)}
        />
      )}
    </div>
  );
}

function AccountCard({
  account: a,
  canManage,
  onEdit,
  onStatement,
  onDelete,
  onReconcile,
}: {
  account: BankAccount;
  canManage: boolean;
  onEdit: () => void;
  onStatement: () => void;
  onDelete: () => void;
  onReconcile: () => void;
}) {
  const TypeIcon = TYPE_ICON[a.account_type] ?? Banknote;

  return (
    <Card
      className={`group flex flex-col p-4 transition-colors hover:border-primary/40 ${
        a.active ? "" : "bg-muted/40"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <TypeIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-foreground">
              {a.name}
            </p>
            {a.is_default && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                Default
              </Badge>
            )}
            {!a.active && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                Inactive
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {accountLine(a)}
          </p>
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-0.5 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="Edit account"
              aria-label={`Edit ${a.name}`}
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              title="Delete account"
              aria-label={`Delete ${a.name}`}
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {balanceLabel(a)}
        </p>
        <p
          className={`mt-0.5 text-xl font-bold tabular-nums ${balanceTone(a)}`}
        >
          {formatINR(Math.abs(a.balance_paise))}
        </p>
        {canManage && (
          <button
            type="button"
            onClick={onReconcile}
            className="mt-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Doesn&apos;t match your bank?
          </button>
        )}
        <ReconciledNote account={a} />
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <span className="truncate text-[11px] text-muted-foreground">
          {a.last_txn_at
            ? `Last movement ${formatDate(a.last_txn_at)}`
            : `Opened ${formatDate(a.opening_as_of)}`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={onStatement}
        >
          Statement <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </Card>
  );
}
