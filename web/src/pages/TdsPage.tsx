import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { financeApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState, TableSkeleton } from "../components/ui";
import {
  DateFilter, PeriodValue, periodParams,
} from "../components/finance/DateFilter";
import { KpiTile } from "../components/finance/KpiTile";
import { formatDate, formatINR } from "../lib/format";
import { C } from "../components/finance/charts";

// TDS the brokers withheld on our reward, for the selected window (default: this
// financial year). TDS is tracked separately from house profit — it is an advance
// tax we later reclaim — so this page is where the agency sees it clearly.
export default function TdsPage() {
  const [period, setPeriod] = useState<PeriodValue>({ period: "this_year" });

  const q = useQuery({
    queryKey: ["finance", "tds", period],
    queryFn: async () => (await financeApi.tds(periodParams(period))).data,
  });
  const d = q.data;

  return (
    <div>
      <PageHeader
        title="TDS"
        subtitle="Tax deducted at source by brokers when they settle our reward."
        actions={<DateFilter value={period} onChange={setPeriod} />}
        figure={d ? {
          label: "TDS deducted",
          value: formatINR(d.total_tds),
          tone: "due",
        } : undefined}
      />

      {/*
        A FAILED REQUEST IS NOT AN EMPTY YEAR (2026-08-07).

        `!d ? EmptyState "No TDS recorded yet."` treated every non-answer the
        same way, so a dropped connection told the owner — as a statement of
        fact about their books — that no broker had ever withheld tax. The
        error branch has to come first and has to say what actually happened.
      */}
      {q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : q.isLoading ? <TableSkeleton cols={5} /> : !d ? (
        <EmptyState title="No TDS recorded yet"
          hint="It appears here once a reward is received with a TDS %." />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiTile label="TDS deducted"
              value={formatINR(d.total_tds)}
              sub={d.fy_label ?? undefined} accent={C.amber} />
            <KpiTile label="Gross reward (with TDS)"
              value={formatINR(d.total_gross_reward)} />
            <KpiTile label="Net reward received"
              value={formatINR(d.total_gross_reward - d.total_tds)} />
          </div>

          {/* Per-broker breakdown */}
          <div className="card">
            <div className="border-b border-line/70 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-700">By broker</h3>
            </div>
            {d.by_broker.length === 0 ? (
              <EmptyState title="No TDS in this window"
                hint="Record a reward received from a broker with a TDS %." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm table-sticky">
                  <thead>
                    <tr>
                      <th className="px-5 py-3">Broker</th>
                      <th className="px-5 py-3">TDS %</th>
                      <th className="px-5 py-3">Events</th>
                      <th className="px-5 py-3 text-right">Gross reward</th>
                      <th className="px-5 py-3 text-right">TDS deducted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.by_broker.map((b) => (
                      <tr key={b.broker_id}
                        className="border-t border-line-soft hover:bg-slate-50/60">
                        <td className="px-5 py-3">
                          <p className="font-medium text-slate-800">
                            {b.broker_name}</p>
                          {b.broker_code && (
                            <p className="text-xs text-slate-500">{b.broker_code}</p>
                          )}
                        </td>
                        <td className="px-5 py-3 text-slate-600">
                          {(b.tds_percent / 100).toFixed(2)}%</td>
                        <td className="px-5 py-3 text-slate-600">{b.entries}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                          {formatINR(b.gross_reward)}</td>
                        <td className="px-5 py-3 text-right tabular-nums font-medium
                          text-slate-800">
                          {formatINR(b.tds_deducted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Individual entries */}
          {d.entries.length > 0 && (
            <div className="card">
              <div className="border-b border-line/70 px-5 py-3">
                <h3 className="text-sm font-semibold text-slate-700">Entries</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm table-sticky">
                  <thead>
                    <tr>
                      <th className="px-5 py-3">Date</th>
                      <th className="px-5 py-3">Broker</th>
                      <th className="px-5 py-3">Policy</th>
                      <th className="px-5 py-3 text-right">Gross</th>
                      <th className="px-5 py-3">%</th>
                      <th className="px-5 py-3 text-right">TDS</th>
                      <th className="px-5 py-3">Reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.entries.map((e) => (
                      <tr key={e.id} className="border-t border-line-soft">
                        <td className="px-5 py-3 text-slate-600">
                          {formatDate(e.date)}</td>
                        <td className="px-5 py-3 text-slate-700">{e.broker_name}</td>
                        <td className="px-5 py-3 text-slate-500">
                          {e.policy_code || "—"}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                          {formatINR(e.gross_reward)}</td>
                        <td className="px-5 py-3 text-slate-500">
                          {(e.tds_percent / 100).toFixed(2)}%</td>
                        <td className="px-5 py-3 text-right tabular-nums font-medium
                          text-slate-800">{formatINR(e.tds_deducted)}</td>
                        <td className="px-5 py-3 text-slate-500">
                          {e.reference || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
