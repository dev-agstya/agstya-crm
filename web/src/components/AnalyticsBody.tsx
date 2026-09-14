import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { targetsApi } from "../api/endpoints";
import { ErrorState, EmptyState, PageLoader } from "./ui";
import { GroupedBars } from "./finance/charts";
import { formatINR } from "../lib/format";
import { canSeeProfitTargets } from "../lib/targets";
import { useAuth } from "../store/auth";
import type { TargetMetric } from "../lib/types";

const METRICS: { value: TargetMetric; label: string; money: boolean }[] = [
  { value: "house_profit", label: "House profit", money: true },
  { value: "premium", label: "Premium", money: true },
  { value: "policies", label: "Policies", money: false },
  { value: "renewals", label: "Renewals", money: false },
];

// Performance deep-dive for one employee or channel partner.
//
// Opened from the Analytics button on the People pages and the Targets report.
// For a channel partner this is how staff judge whether the relationship is
// working before picking up the phone — the partner never signs in to see it
// (their portal is permanently off).
/**
 * Target performance over six months for one person.
 *
 * Rendered inside a RecordPage (pages/people/PersonPerformancePage). It was a
 * dialog until 2026-08-03; `name` survives only because the empty states say
 * whose numbers are missing.
 */
export function AnalyticsBody({ assigneeId }: { assigneeId: string }) {
  const { user } = useAuth();
  // This is a TARGET screen, so it follows the target rule (owner or whoever
  // assigns targets — lib/targets), not the finance-screen view_agency_profit
  // flag. The server gates it the same way, so a mismatch here would only show
  // someone a column of zeroes.
  const canSeeProfit = canSeeProfitTargets(user);
  const [metric, setMetric] = useState<TargetMetric>(
    canSeeProfit ? "house_profit" : "policies");

  const q = useQuery({
    queryKey: ["targets", "analytics", assigneeId, metric],
    queryFn: async () =>
      (await targetsApi.analytics(assigneeId, { months: 6, metric })).data,
  });
  const d = q.data;
  const isMoney = METRICS.find((m) => m.value === metric)?.money ?? true;
  const fmt = (n: number) => isMoney ? formatINR(n) : String(Math.round(n));

  const isPartner = d?.assignee_type === "channel_partner";

  return (
    <>
      {q.isError ? <ErrorState onRetry={() => q.refetch()} /> : q.isLoading ? <PageLoader />
        : !d ? <EmptyState title="No data yet" />
          : (
        <div className="space-y-5">
          {/* This period at a glance */}
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-slate-700">
                {d.period_label}</p>
              {d.code && (
                <p className="text-xs text-slate-500">{d.code}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Policies" value={String(d.policies)} />
              <Stat label="Renewals" value={String(d.renewals)} />
              <Stat label="Premium" value={formatINR(d.premium)} />
              {isPartner ? (
                <Stat label="Reward earned"
                  value={formatINR(d.partner_payout)} />
              ) : canSeeProfit ? (
                <Stat label="House profit" value={formatINR(d.profit)}
                  tone="text-money-in" />
              ) : (
                <Stat label="Contribution" value="—" />
              )}
            </div>
          </div>

          {/* Targets for the current period */}
          <div className="rounded-card border border-line p-4">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-slate-700">
                Target this period</p>
              {d.has_target && (
                <span className={`text-sm font-semibold ${
                  d.attainment_pct >= 100 ? "text-money-in"
                    : d.attainment_pct >= 70 ? "text-due"
                      : "text-money-out"}`}>
                  {Math.round(d.attainment_pct)}%
                </span>
              )}
            </div>
            {d.metrics.length === 0 ? (
              <p className="text-sm text-slate-500">
                No target assigned for {d.period_label}. Set one from the
                Targets page to start tracking.
              </p>
            ) : (
              <div className="space-y-3">
                {d.metrics.map((m) => {
                  const pct = Math.min(100, m.attainment_pct);
                  const tone = m.attainment_pct >= 100 ? "bg-money-in"
                    : m.attainment_pct >= 70 ? "bg-due" : "bg-money-out";
                  const f = (n: number) =>
                    m.is_money ? formatINR(n) : String(Math.round(n));
                  return (
                    <div key={m.metric}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm text-slate-600">{m.label}</span>
                        <span className="text-xs tabular-nums text-slate-500">
                          {f(m.actual_value)}
                          <span className="text-slate-500">
                            {" "}/ {f(m.target_value)}</span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-2 w-full overflow-hidden
                        rounded-full bg-slate-100">
                        <div className={`h-full rounded-full ${tone}`}
                          style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Six-month trend against goal */}
          <div className="rounded-card border border-line p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between
              gap-2">
              <p className="text-sm font-semibold text-slate-700">
                Last 6 months vs target</p>
              <select className="select h-8 py-0 text-xs" value={metric}
                onChange={(e) => setMetric(e.target.value as TargetMetric)}>
                {METRICS.filter((m) =>
                  canSeeProfit || m.value !== "house_profit").map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <GroupedBars format={fmt}
              data={d.trend.map((t) => ({
                label: t.label.replace(/ \d{4}$/, ""),
                actual: t.actual, target: t.target }))}
              emptyHint="Nothing booked in the last six months." />
          </div>

          {/* Where the business came from */}
          <div className="rounded-card border border-line p-4">
            <p className="mb-3 text-sm font-semibold text-slate-700">
              Top categories · {d.period_label}</p>
            {d.top_categories.length === 0 ? (
              <p className="text-sm text-slate-500">
                No policies booked in this period.</p>
            ) : (
              <div className="space-y-2">
                {d.top_categories.map((c) => (
                  <div key={c.key}
                    className="flex items-center justify-between gap-3
                      border-b border-line-soft pb-2 last:border-0 last:pb-0">
                    <span className="truncate text-sm text-slate-700">
                      {c.label}</span>
                    <span className="shrink-0 text-xs text-slate-500">
                      {c.policies} {c.policies === 1 ? "policy" : "policies"}
                      {" · "}{formatINR(c.premium)}
                      {canSeeProfit && (
                        <b className="ml-1 font-medium text-money-in">
                          {formatINR(c.profit)}</b>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, tone }: {
  label: string; value: string; tone?: string;
}) {
  return (
    <div className="rounded-card border border-line p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}</p>
      <p className={`mt-1 text-metric-sm tabular-nums ${
        tone ?? "text-slate-800"}`}>{value}</p>
    </div>
  );
}
