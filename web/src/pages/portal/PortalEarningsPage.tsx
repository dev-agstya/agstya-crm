import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import { portalApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { TableSkeleton } from "../../components/shared/LoadingSkeleton";
import {
  DateFilter,
  periodParams,
  type PeriodValue,
} from "../../components/finance/DateFilter";
import { formatDate, formatINR } from "../../lib/format";
import { NetPosition, SectionCard } from "./shared";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function PortalEarningsPage() {
  const [period, setPeriod] = useState<PeriodValue>({
    period: "current_month",
  });
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
    <div className="space-y-4">
      <PageHeader
        title="Earnings"
        subtitle="Where you stand with Agastya, and everything behind it."
      />

      <Card className="p-4 sm:p-5">
        <NetPosition net={m?.net_balance ?? 0} />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Reward earned
            </p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
              {formatINR(m?.reward_earned_unpaid)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              not yet paid to you
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Premium you hold
            </p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
              {formatINR(m?.premium_owed)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              collected, not handed over
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Earned all time
            </p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
              {formatINR(m?.lifetime_earned)}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Paid to you
            </p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
              {formatINR(m?.lifetime_paid)}
            </p>
          </div>
        </div>
        <p className="mt-3 border-t border-border pt-2.5 text-xs text-muted-foreground">
          Payouts are made by the Agastya team. When one is recorded it appears
          in your transactions below.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <DateFilter value={period} onChange={setPeriod} />
        <span className="text-xs text-muted-foreground">{e?.period_label}</span>
      </div>

      <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-card">
        <div className="px-3.5 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            Policies
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
            {e?.policies ?? 0}
          </p>
        </div>
        <div className="px-3.5 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            Premium
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
            {formatINR(e?.premium)}
          </p>
        </div>
        <div className="px-3.5 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            You earned
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-emerald-700">
            {formatINR(e?.my_earning)}
          </p>
        </div>
      </div>

      <SectionCard title="What made it up">
        {earnings.isError ? (
          <ErrorState onRetry={() => earnings.refetch()} />
        ) : earnings.isLoading ? (
          <TableSkeleton cols={4} />
        ) : (e?.rows.length ?? 0) === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No policies were booked for you in this period.
          </p>
        ) : (
          <>
            <ul className="space-y-2 sm:hidden">
              {e!.rows.map((r) => (
                <li key={r.policy_id}>
                  <Link
                    to={`/portal/policies/${r.policy_id}`}
                    className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5 hover:bg-muted/30"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {r.policy_number || r.code}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.customer_name || "—"} · {formatDate(r.booked_at)}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-emerald-700">
                      {formatINR(r.my_earning)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableHead className="h-9 text-xs">Policy</TableHead>
                    <TableHead className="h-9 text-xs">Customer</TableHead>
                    <TableHead className="h-9 text-xs">Type</TableHead>
                    <TableHead className="h-9 text-xs">Booked</TableHead>
                    <TableHead className="h-9 text-right text-xs">
                      Premium
                    </TableHead>
                    <TableHead className="h-9 text-right text-xs">
                      You earned
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {e!.rows.map((r) => (
                    <TableRow key={r.policy_id}>
                      <TableCell className="py-2">
                        <Link
                          to={`/portal/policies/${r.policy_id}`}
                          className="text-[13px] font-medium text-foreground hover:text-primary hover:underline"
                        >
                          {r.policy_number || r.code}
                        </Link>
                      </TableCell>
                      <TableCell className="py-2 text-[13px] text-foreground">
                        {r.customer_name || "—"}
                      </TableCell>
                      <TableCell className="py-2 text-[13px] text-muted-foreground">
                        {r.category_label}
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-2 text-xs text-muted-foreground">
                        {formatDate(r.booked_at)}
                      </TableCell>
                      <TableCell className="py-2 text-right text-[13px] tabular-nums text-foreground">
                        {formatINR(r.premium_amount)}
                      </TableCell>
                      <TableCell className="py-2 text-right text-[13px] font-semibold tabular-nums text-emerald-700">
                        {formatINR(r.my_earning)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard title="Transactions">
        {txns.isError ? (
          <ErrorState onRetry={() => txns.refetch()} />
        ) : txns.isLoading ? (
          <TableSkeleton cols={3} />
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Opening</span>
              <span className="font-semibold tabular-nums text-foreground">
                {formatINR(t?.opening)}
              </span>
            </div>
            {(t?.entries.length ?? 0) === 0 ? (
              <EmptyState
                icon={<ArrowLeftRight className="h-5 w-5" />}
                title="No movement in this period"
                description="Rewards you earn and payments either way will show here."
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {t!.entries.map((entry, i) => (
                  <li
                    key={i}
                    className="flex items-start justify-between gap-3 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="block text-[13px] text-foreground">
                        {entry.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDate(entry.date)}
                        {entry.policy ? ` · ${entry.policy}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span
                        className={`block whitespace-nowrap text-[13px] font-semibold tabular-nums ${
                          entry.amount >= 0
                            ? "text-emerald-700"
                            : "text-destructive"
                        }`}
                      >
                        {entry.amount >= 0 ? "+" : "−"}
                        {formatINR(Math.abs(entry.amount))}
                      </span>
                      <span className="block whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                        {formatINR(entry.balance)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex items-center justify-between gap-3 border-t-2 border-border pt-3 text-sm">
              <span className="font-semibold text-foreground">Closing</span>
              <span
                className={`font-bold tabular-nums ${
                  (t?.closing ?? 0) >= 0
                    ? "text-emerald-700"
                    : "text-destructive"
                }`}
              >
                {formatINR(t?.closing)}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              A positive balance means Agastya owes you.
            </p>
          </>
        )}
      </SectionCard>
    </div>
  );
}
