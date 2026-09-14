import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { financeApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { ErrorState, EmptyState, PageLoader, StatusBadge } from "../components/ui";
import { AreaTrend, C } from "../components/finance/charts";
import { KpiTile } from "../components/finance/KpiTile";
import { formatDate, formatINR, monthShort, titleCase } from "../lib/format";
import { useAuth } from "../store/auth";
import type { LedgerTxn } from "../lib/types";

const TXN_LABEL: Record<string, string> = {
  premium_due: "Premium due", premium_collected: "Premium received",
  reward_received: "Reward received", partner_payout: "Reward paid",
  settlement: "Settlement", refund: "Refund", adjustment: "Adjustment",
  premium_to_insurer: "Premium → broker", discount: "Discount",
  reward_cancelled: "Reward cancelled", expense: "Expense",
};
const TITLE: Record<string, string> = {
  insurer: "Insurance Company", broker: "Broker",
  partner: "Channel Partner", employee: "Employee", customer: "Customer",
};

export default function EntityFinancePage() {
  const { type = "", id = "" } = useParams();
  const nav = useNavigate();
  const { has } = useAuth();
  const canManage = has("manage_transactions");

  const prof = useQuery({
    queryKey: ["finance", "entity", type, id],
    queryFn: async () => (await financeApi.entity(type, id)).data,
    retry: false,
  });
  const d = prof.data;
  const ledger = useQuery({
    queryKey: ["finance", "ledger", d?.party_type, id],
    queryFn: async () => (await financeApi.ledger({
      party_type: d!.party_type!, party_id: id, page_size: 50 })).data,
    enabled: !!d?.party_type,
  });

  const isCustomer = type === "customer";
  const bal = d?.pending.collection ?? null; // >0 they owe us, <0 we owe

  return (
    <div>
      <button className="mb-2 text-sm text-slate-500 hover:underline"
        onClick={() => nav(-1)}>← Back</button>
      <PageHeader title={d?.label || "…"}
        subtitle={`${TITLE[type] || titleCase(type)} · finance profile`}
        actions={canManage && d
          && ["partner", "customer", "broker"].includes(type) && (
          <button className="btn-primary" onClick={() => nav("/finance/transactions/new")}>
            <Icon.Plus size={18} /> Record payment
          </button>
        )} />

      {prof.isError ? <ErrorState onRetry={() => prof.refetch()} /> : prof.isLoading ? <PageLoader /> :
      !d ? <EmptyState title="Not found"
        hint="No finance data for this entity." /> : (
        <div className="space-y-6">
          {/* Balance banner (party entities) */}
          {bal != null && (
            <div className={`rounded-card p-5 text-white ${bal >= 0
              ? "bg-due" : "bg-ink"}`}>
              <p className="text-xs uppercase tracking-wide text-white/70">
                {bal >= 0 ? "They owe the agency" : "The agency owes them"}</p>
              <p className="mt-1 text-metric-lg tabular-nums">
                {formatINR(Math.abs(bal))}</p>
              {type === "partner" && d.pending.payout != null && (
                <p className="mt-2 text-sm text-white/80">
                  Reward we owe: <b>{formatINR(d.pending.payout)}</b></p>
              )}
              {type === "broker" && d.pending.reward_to_receive != null && (
                <p className="mt-2 text-sm text-white/80">
                  Rewards to receive: <b>
                    {formatINR(d.pending.reward_to_receive)}</b></p>
              )}
            </div>
          )}

          {/* KPI tiles */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile label="Policies" value={String(d.metrics.policies)} />
            <KpiTile label="Total premium" value={formatINR(d.metrics.premium)} />
            {!isCustomer && (
              <KpiTile label="Rewards earned"
                value={formatINR(d.metrics.reward_earned)} />
            )}
            {!isCustomer && (
              <KpiTile label="Profit" accent={C.green}
                value={formatINR(d.metrics.profit)} />
            )}
          </div>

          {/* Monthly + policy status */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card p-5 lg:col-span-2">
              <p className="mb-2 text-sm font-medium text-slate-600">
                Monthly {isCustomer ? "premium" : "profit"}</p>
              <AreaTrend valueLabel={isCustomer ? "Premium" : "Profit"}
                // Profit is money the agency made, so it stays green. A
                // customer's PREMIUM is not the agency's gain — it was drawn in
                // graphite for that reason and read as dull rather than as
                // neutral, so it takes the non-money series colour.
                color={isCustomer ? C.count : C.green}
                data={d.monthly.map((m) => ({
                  label: monthShort(m.month),
                  value: isCustomer ? m.premium : m.profit }))} />
            </div>
            <div className="card card-body">
              <p className="mb-3 text-sm font-medium text-slate-600">
                Policies</p>
              {Object.keys(d.policy_status).length === 0 ? (
                <p className="text-sm text-slate-500">No policies.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(d.policy_status).map(([st, n]) => (
                    <div key={st} className="flex items-center justify-between">
                      <StatusBadge value={st} />
                      <span className="text-sm font-medium text-slate-600">{n}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Ledger */}
          {d.party_type && (
            <div className="card">
              <p className="border-b border-line/70 px-5 py-3 text-sm
                font-medium text-slate-600">
                Ledger</p>
              {ledger.isError ? <ErrorState onRetry={() => ledger.refetch()} /> : ledger.isLoading ? <PageLoader /> :
              (ledger.data?.items.length ?? 0) === 0 ? (
                <EmptyState title="No transactions" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm table-sticky">
                    <thead>
                      <tr>
                        <th className="px-5 py-3">When</th>
                        <th className="px-5 py-3">Type</th>
                        <th className="px-5 py-3">Reference / note</th>
                        <th className="px-5 py-3 text-right">Debit</th>
                        <th className="px-5 py-3 text-right">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.data!.items.map((t: LedgerTxn) => (
                        <tr key={t.id} className="border-t border-line-soft">
                          <td className="px-5 py-3 text-slate-500">
                            {formatDate(t.occurred_at)}</td>
                          <td className="px-5 py-3 text-slate-700">
                            {TXN_LABEL[t.txn_type] || t.txn_type}</td>
                          <td className="px-5 py-3 text-slate-500">
                            {t.reference || t.note || "—"}</td>
                          <td className="px-5 py-3 text-right tabular-nums text-due">
                            {t.amount_paise > 0 ? formatINR(t.amount_paise) : ""}</td>
                          <td className="px-5 py-3 text-right tabular-nums text-money-in">
                            {t.amount_paise < 0 ? formatINR(-t.amount_paise) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
