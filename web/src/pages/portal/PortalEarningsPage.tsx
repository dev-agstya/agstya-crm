import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { portalApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import { ErrorState, EmptyState, TableSkeleton } from "../../components/ui";
import {
  DateFilter, periodParams, type PeriodValue,
} from "../../components/finance/DateFilter";
import { formatDate, formatINR } from "../../lib/format";
import { NetPosition, SectionCard, StatTile } from "./shared";

/*
  Earnings — the screen a partner lives on.

  Three blocks, in the order they get asked about:
    1. WHERE THEY STAND. `net_balance`, said in words, with BOTH sides visible.
       Hiding what they owe would make what they are owed wrong by subtraction,
       which is how every payout turns into an argument.
    2. THE MONTHLY REPORT. What they wrote in the period and what it earned,
       policy by policy, so the total can be checked rather than trusted.
    3. TRANSACTIONS. Every movement between them and the agency, from the SAME
       ledger function behind the agency's own partner statement.

  There is no "request a payout" button, deliberately: payouts are made by the
  team and appear here as transactions once recorded (owner A1).
*/

export default function PortalEarningsPage() {
  const [period, setPeriod] = useState<PeriodValue>({
    period: "current_month" });
  const params = periodParams(period);

  const money = useQuery({
    queryKey: ["portal", "money"],
    queryFn: async () => (await portalApi.money()).data,
  });
  const earnings = useQuery({
    queryKey: ["portal", "earnings", period],
    queryFn: async () => (await portalApi.earnings(params)).data,
  });
  const txns = useQuery({
    queryKey: ["portal", "transactions", period],
    queryFn: async () => (await portalApi.transactions(params)).data,
  });

  const m = money.data;
  const e = earnings.data;
  const t = txns.data;

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader title="Earnings"
        subtitle="Where you stand with Agastya, and everything behind it." />

      {/* 1. Position — NOT windowed. It is where things stand right now,
             whatever the date filter below says. */}
      <section className="card px-4 py-4 sm:px-5">
        <NetPosition net={m?.net_balance ?? 0} />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-caption uppercase text-slate-500">
              Reward earned</p>
            <p className="text-sm font-semibold tabular-nums text-slate-900">
              {formatINR(m?.reward_earned_unpaid)}</p>
            <p className="text-xs text-slate-500">not yet paid to you</p>
          </div>
          <div>
            <p className="text-caption uppercase text-slate-500">
              Premium you hold</p>
            <p className="text-sm font-semibold tabular-nums text-slate-900">
              {formatINR(m?.premium_owed)}</p>
            <p className="text-xs text-slate-500">collected, not handed over</p>
          </div>
          <div>
            <p className="text-caption uppercase text-slate-500">
              Earned all time</p>
            <p className="text-sm font-semibold tabular-nums text-slate-900">
              {formatINR(m?.lifetime_earned)}</p>
          </div>
          <div>
            <p className="text-caption uppercase text-slate-500">
              Paid to you</p>
            <p className="text-sm font-semibold tabular-nums text-slate-900">
              {formatINR(m?.lifetime_paid)}</p>
          </div>
        </div>
        <p className="mt-3 border-t border-line/70 pt-3 text-xs text-slate-500">
          Payouts are made by the Agastya team. When one is recorded it appears
          in your transactions below.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <DateFilter value={period} onChange={setPeriod} />
        <span className="text-xs text-slate-500">{e?.period_label}</span>
      </div>

      {/* 2. The monthly report. */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Policies" value={String(e?.policies ?? 0)} />
        <StatTile label="Premium" value={formatINR(e?.premium)} />
        <StatTile label="You earned" value={formatINR(e?.my_earning)}
          tone="in" />
      </div>

      <SectionCard title="What made it up">
        {earnings.isError ? <ErrorState onRetry={() => earnings.refetch()} /> : earnings.isLoading ? <TableSkeleton cols={4} />
          : (e?.rows.length ?? 0) === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">
              No policies were booked for you in this period.
            </p>
          ) : (
            <>
              <ul className="space-y-2.5 sm:hidden">
                {e!.rows.map((r) => (
                  <li key={r.policy_id}>
                    <Link to={`/portal/policies/${r.policy_id}`}
                      className="flex items-start justify-between gap-3
                        rounded-control border border-line px-3 py-2.5
                        active:bg-slate-50">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium
                          text-slate-900">
                          {r.policy_number || r.code}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {r.customer_name || "—"} · {formatDate(r.booked_at)}
                        </span>
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-sm
                        font-semibold tabular-nums text-money-in">
                        {formatINR(r.my_earning)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="table-sticky">
                  <thead>
                    <tr>
                      <th>Policy</th>
                      <th>Customer</th>
                      <th>Type</th>
                      <th>Booked</th>
                      <th className="num">Premium</th>
                      <th className="num">You earned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e!.rows.map((r) => (
                      <tr key={r.policy_id}>
                        <td>
                          <Link to={`/portal/policies/${r.policy_id}`}
                            className="font-medium text-slate-900 hover:underline">
                            {r.policy_number || r.code}
                          </Link>
                        </td>
                        <td>{r.customer_name || "—"}</td>
                        <td>{r.category_label}</td>
                        <td className="whitespace-nowrap">
                          {formatDate(r.booked_at)}</td>
                        <td className="num">{formatINR(r.premium_amount)}</td>
                        <td className="num font-semibold text-money-in">
                          {formatINR(r.my_earning)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </SectionCard>

      {/* 3. Transactions — the same ledger the agency's own statement uses. */}
      <SectionCard title="Transactions">
        {txns.isError ? <ErrorState onRetry={() => txns.refetch()} /> : txns.isLoading ? <TableSkeleton cols={3} /> : (
          <>
            <div className="mb-3 flex items-center justify-between gap-3
              rounded-control bg-slate-50 px-3 py-2 text-sm">
              <span className="text-slate-600">Opening</span>
              <span className="font-semibold tabular-nums text-slate-900">
                {formatINR(t?.opening)}</span>
            </div>
            {(t?.entries.length ?? 0) === 0 ? (
              <EmptyState
              icon={<Icon.Exchange size={20} />}
              title="No movement in this period"
                hint="Rewards you earn and payments either way will show here." />
            ) : (
              <ul className="divide-y divide-line/70">
                {t!.entries.map((entry, i) => (
                  <li key={i}
                    className="flex items-start justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block text-sm text-slate-800">
                        {entry.label}</span>
                      <span className="block text-xs text-slate-500">
                        {formatDate(entry.date)}
                        {entry.policy ? ` · ${entry.policy}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className={`block whitespace-nowrap text-sm
                        font-semibold tabular-nums ${entry.amount >= 0
                          ? "text-money-in" : "text-money-out"}`}>
                        {entry.amount >= 0 ? "+" : "−"}
                        {formatINR(Math.abs(entry.amount))}
                      </span>
                      <span className="block whitespace-nowrap text-xs
                        text-slate-500 tabular-nums">
                        {formatINR(entry.balance)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex items-center justify-between gap-3
              border-t-2 border-ink/80 pt-3 text-sm">
              <span className="font-semibold text-slate-900">Closing</span>
              <span className={`font-bold tabular-nums ${
                (t?.closing ?? 0) >= 0 ? "text-money-in" : "text-money-out"}`}>
                {formatINR(t?.closing)}</span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              A positive balance means Agastya owes you.
            </p>
          </>
        )}
      </SectionCard>
    </div>
  );
}
