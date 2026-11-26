import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { financeApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/shared/StatCard";
import { DataTable, Column } from "../components/shared/DataTable";
import { ErrorState } from "../components/shared/ErrorState";
import { CardGridSkeleton } from "../components/shared/LoadingSkeleton";
import {
  DateFilter,
  PeriodValue,
  periodParams,
} from "../components/finance/DateFilter";
import { formatINR } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function TdsPage() {
  const [period, setPeriod] = useState<PeriodValue>({ period: "this_year" });

  const q = useQuery({
    queryKey: ["finance", "tds", period],
    queryFn: async () => (await financeApi.tds(periodParams(period))).data,
  });
  const d = q.data;

  const brokerCols: Column<any>[] = [
    {
      key: "broker",
      header: "Broker",
      cell: (b) => <span className="font-medium text-foreground">{b.broker_name}</span>,
    },
    {
      key: "rate",
      header: "TDS %",
      cell: (b) => (
        <Badge variant="secondary" className="tabular-nums">
          {((b.tds_percent ?? 0) / 100).toFixed(2)}%
        </Badge>
      ),
    },
    {
      key: "events",
      header: "Transactions",
      cell: (b) => <span className="tabular-nums">{b.entries ?? 0}</span>,
    },
    {
      key: "gross",
      header: "Gross reward",
      align: "right",
      cell: (b) => <span className="tabular-nums">{formatINR(b.gross_reward)}</span>,
    },
    {
      key: "tds",
      header: "TDS deducted",
      align: "right",
      cell: (b) => (
        <span className="font-semibold tabular-nums text-amber-600">
          {formatINR(b.tds_deducted)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="TDS Summary"
        subtitle="Tax deducted at source by brokers when settling agency commissions."
        actions={<DateFilter value={period} onChange={setPeriod} />}
      />

      {q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <CardGridSkeleton count={3} />
      ) : !d ? null : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="TDS deducted"
              value={formatINR(d.total_tds)}
              hint={d.fy_label ?? undefined}
              tone="warning"
              icon={<Receipt className="h-4 w-4" />}
            />
            <StatCard
              label="Gross reward (before TDS)"
              value={formatINR(d.total_gross_reward)}
            />
            <StatCard
              label="Net reward received"
              value={formatINR(d.total_gross_reward - d.total_tds)}
              tone="success"
            />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">By Broker</CardTitle>
            </CardHeader>
            <CardContent className="p-0 sm:p-4 sm:pt-0">
              <DataTable
                data={d.by_broker}
                columns={brokerCols}
                keyField={(b) => b.broker_id || b.broker_name || "unknown"}
                emptyTitle="No TDS in this window"
                emptyDescription="TDS appears here when a broker payout is recorded with a TDS %."
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
