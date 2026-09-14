import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { banksApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  EmptyState, ErrorState, Skeleton, ToggleField,
} from "../components/ui";
import { KpiTile } from "../components/finance/KpiTile";
import { ReconcileDialog } from "../components/finance/ReconcileDialog";
import { confirmDialog } from "../components/Confirm";
import { toast } from "../components/Toast";
import { useAuth } from "../store/auth";
import { liveQueryOptions } from "../lib/live";
import { formatDate, formatINR } from "../lib/format";
import {
  BANK_ACCOUNT_TYPES, type BankAccount, type BankAccountType,
} from "../lib/types";
import { C } from "../components/finance/charts";

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  BANK_ACCOUNT_TYPES.map((t) => [t.value, t.label]));

// One glyph per kind of account. A grid of cards that differ only in a line of
// grey text is a grid you have to READ to navigate; the icon is what makes
// "which one is the cash box" answerable at a glance.
const TYPE_ICON: Record<BankAccountType, keyof typeof Icon> = {
  bank: "Building",
  cash: "Money",
  upi: "Bolt",
  credit_card: "Wallet",
};

// A credit card holds money you OWE, so its balance reads the other way round
// and it is summed apart from cash. Saying so on the card stops it being read
// as "we have minus two lakhs in the bank".
function balanceLabel(a: BankAccount): string {
  if (a.is_cash_asset) return "Balance";
  return a.balance_paise <= 0 ? "Outstanding" : "In credit";
}

function balanceTone(a: BankAccount): string {
  const owed = !a.is_cash_asset;
  if (a.balance_paise === 0) return "text-slate-700";
  if (owed) return a.balance_paise < 0 ? "text-money-out" : "text-money-in";
  return a.balance_paise < 0 ? "text-money-out" : "text-slate-900";
}

// How long an account may go unchecked before the page says so. One number,
// like QUIET_AFTER_DAYS on the partner roster — "overdue" has to mean the same
// thing on every account or the flag is worth nothing.
const RECONCILE_EVERY_DAYS = 30;

function daysSince(iso: string): number {
  return Math.floor(
    (Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * "Checked against your bank 12 days ago", or a nudge when it never has been.
 *
 * Deliberately NOT red. An unreconciled account is not wrong, it is
 * UNVERIFIED — colouring it like a loss would be a claim this page cannot
 * make. Amber past the threshold, grey inside it.
 */
function ReconciledNote({ account }: { account: BankAccount }) {
  const at = account.last_reconciled_at;
  if (!at) {
    return (
      <p className="mt-1 text-xs text-slate-500">
        Never checked against your bank.
      </p>
    );
  }
  const days = daysSince(at);
  const stale = days >= RECONCILE_EVERY_DAYS;
  const agreed = account.last_reconciled_diff_paise === 0;
  return (
    <p className={`mt-1 text-xs ${stale ? "font-medium text-due"
      : "text-slate-500"}`}>
      {stale && <Icon.Clock size={11} className="mr-1 inline align-[-1px]" />}
      Checked {days === 0 ? "today" : days === 1 ? "yesterday"
        : `${days} days ago`}
      {agreed && !stale ? " — it agreed" : ""}
    </p>
  );
}

/** Bank · ****6728 — the identifying line, with the empty pieces dropped so it
 *  never reads "Cash in hand ·  · ". */
function accountLine(a: BankAccount): string {
  return [TYPE_LABEL[a.account_type] ?? a.account_type, a.bank_name,
    a.account_last4 ? `****${a.account_last4}` : null]
    .filter(Boolean).join(" · ");
}

// Presentation order only — the API returns whatever Mongo hands back, which
// puts the account somebody actually uses wherever it happens to land. Default
// first, live accounts before switched-off ones, then alphabetical.
function forDisplay(items: BankAccount[]): BankAccount[] {
  return [...items].sort((a, b) =>
    Number(b.active) - Number(a.active)
    || Number(b.is_default) - Number(a.is_default)
    || a.name.localeCompare(b.name));
}

export default function BanksPage() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canManage = has("manage_bank_accounts");

  const [showInactive, setShowInactive] = useState(false);
  // Which account the reconcile dialog is open for, if any.
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
      message: "Only an account no money has ever moved through can be "
        + "deleted. Otherwise deactivate it — its history keeps working.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) remove.mutate(a.id);
  };

  return (
    <div>
      <PageHeader
        title="Bank & Cash Accounts"
        subtitle="Where the agency's money actually sits, and what is in it right now."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ToggleField checked={showInactive} label="Show inactive"
              onChange={setShowInactive} />
            {canManage && (
              <>
                <button className="btn-secondary"
                  onClick={() => navigate("/finance/banks/transfer")}
                  disabled={items.filter((a) => a.active).length < 2}>
                  <Icon.Exchange size={16} /> Transfer
                </button>
                <button className="btn-primary" onClick={() => navigate("/finance/banks/new")}>
                  <Icon.Plus size={16} /> Add account
                </button>
              </>
            )}
          </div>
        }
      />

      {/*
        AN ERROR IS NOT A ZERO (2026-08-07).

        These three tiles used to read `data?.totals.cash_in_hand ?? 0`, so a
        failed request — and this app runs on ONE Render instance, where a cold
        start after idle is routine — rendered "Cash + bank in hand ₹0" in the
        largest type on the page, with total confidence.

        A finance product telling the owner they have no money because a fetch
        timed out is worse than showing nothing. The whole page now yields to
        `ErrorState`, which says what happened and offers Retry.

        The rule this came with: never write `data?.<money> ?? 0`. A zero rupee
        figure has to come from the server.
      */}
      {accounts.isError ? (
        <ErrorState onRetry={() => accounts.refetch()} />
      ) : (
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <KpiTile label="Cash + bank in hand"
            value={data ? formatINR(data.totals.cash_in_hand) : "—"}
            sub="across every active bank, cash and UPI account"
            accent={C.green} />
          <KpiTile label="Owed on credit cards"
            value={data ? formatINR(data.totals.credit_outstanding) : "—"}
            sub="reported separately — this is money you owe" />
          <KpiTile label="Accounts"
            value={data ? String(data.totals.accounts) : "—"}
            sub={canManage ? "add one for every account you actually use"
              : undefined} />
        </div>

        {accounts.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card space-y-4 p-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-control" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                </div>
                <Skeleton className="h-8 w-1/2" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Icon.Building size={24} />}
              title="No accounts yet"
              hint={canManage
                ? "Add your bank, cash-in-hand and UPI accounts with their "
                  + "current balances. Every payment you record from then on "
                  + "gets linked to one, so these balances stay live."
                : "Ask an owner to set up the agency's accounts."}
              action={canManage && (
                <button className="btn-primary"
                  onClick={() => navigate("/finance/banks/new")}>
                  <Icon.Plus size={16} /> Add account
                </button>
              )} />
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((a) => (
              <AccountCard key={a.id} account={a} canManage={canManage}
                onEdit={() => navigate(`/finance/banks/${a.id}/edit`)}
                onStatement={() =>
                  navigate(`/finance/banks/${a.id}/statement`)}
                onDelete={() => onDelete(a)}
                onReconcile={() => setReconciling(a)} />
            ))}
          </div>
        )}
      </div>
      )}

      {/* One dialog for the page, not one per card — sixty accounts must not
          mean sixty mounted modals. */}
      {reconciling && (
        <ReconcileDialog account={reconciling} open
          onClose={() => setReconciling(null)} />
      )}
    </div>
  );
}

/**
 * One account.
 *
 * There is exactly ONE figure on it (owner 2026-08-04). It used to also carry
 * lifetime In and Out totals, which answered a question nobody asks on this
 * page — how much has ever passed through — while competing with the balance,
 * which is the only thing the page exists to tell you. Those two fields are
 * still kept server-side: they are what `recompute_balance()` heals the running
 * balance from, so they are load-bearing even though nothing displays them.
 */
function AccountCard({ account: a, canManage, onEdit, onStatement, onDelete,
  onReconcile }: {
  account: BankAccount;
  canManage: boolean;
  onEdit: () => void;
  onStatement: () => void;
  onDelete: () => void;
  onReconcile: () => void;
}) {
  const TypeIcon = Icon[TYPE_ICON[a.account_type] ?? "Money"];

  return (
    <div className={`card group flex flex-col p-4 transition-shadow
      hover:shadow-pop ${a.active ? "" : "bg-slate-50/60"}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center
          rounded-control bg-slate-100 text-slate-600">
          <TypeIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate font-semibold text-slate-900">{a.name}</p>
            {a.is_default && <span className="chip">Default</span>}
            {/* An inactive account used to be signalled by opacity alone, which
                reads as "still loading" more than "switched off". */}
            {!a.active && <span className="chip">Inactive</span>}
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {accountLine(a)}</p>
        </div>
        {canManage && (
          // Two grey squares on every card is a lot of furniture for actions
          // taken once a year. They stay put on touch screens, where there is
          // no hover to reveal them with.
          <div className="flex shrink-0 gap-1 transition-opacity
            focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
            <button className="icon-btn" title="Edit account"
              aria-label={`Edit ${a.name}`} onClick={onEdit}>
              <Icon.Edit size={15} />
            </button>
            <button className="icon-btn icon-btn-danger" title="Delete account"
              aria-label={`Delete ${a.name}`} onClick={onDelete}>
              <Icon.Trash size={15} />
            </button>
          </div>
        )}
      </div>

      <div className="mt-4">
        <p className="text-caption font-semibold uppercase text-slate-500">
          {balanceLabel(a)}</p>
        <p className={`mt-1 text-metric tabular-nums
          ${balanceTone(a)}`}>
          {formatINR(Math.abs(a.balance_paise))}</p>
        {/*
          Directly under the figure it is disputing (owner 2026-08-07).

          This lived at the foot of the account SETTINGS form, behind an Edit
          pencil that is `sm:opacity-0 sm:group-hover:opacity-100` — invisible
          until you hover the card. So the route to it was an invisible button,
          then a page, then a scroll, for the one action you want at the moment
          you are holding your phone open on your bank's app comparing figures.
          It belongs next to the number.
        */}
        {canManage && (
          <button type="button"
            onClick={onReconcile}
            className="mt-1 text-xs font-medium text-slate-500
              underline-offset-2 transition-colors hover:text-slate-900
              hover:underline">
            Doesn't match your bank?
          </button>
        )}
        {/*
          WHEN it was last checked (2026-08-19).

          Reconciliation shipped on 2026-08-07 and worked. What it never had was
          a prompt: nothing on this page ever said an account was overdue a
          check, so the only way to discover our figure had drifted from the
          bank's was to go and compare them by hand — which is the job the
          feature exists to prompt. A control nobody is reminded to use does not
          get used.

          Amber past the threshold rather than red: an unreconciled account is
          not WRONG, it is UNVERIFIED, and colouring it like a loss would be a
          claim this page cannot make.
        */}
        <ReconciledNote account={a} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t
        border-line/70 pt-3">
        <span className="truncate text-xs text-slate-500">
          {a.last_txn_at
            ? `Last movement ${formatDate(a.last_txn_at)}`
            : `Opened ${formatDate(a.opening_as_of)}`}
        </span>
        <button className="btn-ghost btn-sm shrink-0" onClick={onStatement}>
          Statement <Icon.ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
