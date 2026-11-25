import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { financeApi } from "../api/endpoints";
import { RecordPage } from "../components/RecordPage";
import { EmptyState } from "../components/shared/EmptyState";
import { ErrorState } from "../components/shared/ErrorState";
import { TableSkeleton } from "../components/shared/LoadingSkeleton";
import { StatusBadge } from "../components/ui";
import { AreaTrend, C } from "../components/finance/charts";
import { KpiTile } from "../components/finance/KpiTile";
import { formatDate, formatINR, monthShort, titleCase } from "../lib/format";
import { useAuth } from "../store/auth";
import type { LedgerTxn } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const TXN_LABEL: Record<string, string> = {
  premium_due: "Premium due",
  premium_collected: "Premium received",
  reward_received: "Reward received",
  partner_payout: "Reward paid",
  settlement: "Settlement",
  refund: "Refund",
  adjustment: "Adjustment",
  premium_to_insurer: "Premium → broker",
  discount: "Discount",
  reward_cancelled: "Reward cancelled",
  expense: "Expense",
};

const TITLE: Record<string, string> = {
  insurer: "Insurance Company",
  broker: "Broker",
  partner: "Channel Partner",
  employee: "Employee",
  customer: "Customer",
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
    queryFn: async () =>
      (
        await financeApi.ledger({
          party_type: d!.party_type!,
          party_id: id,
          page_size: 50,
        })
      ).data,
    enabled: !!d?.party_type,
  });

  const isCustomer = type === "customer";
  const bal = d?.pending.collection ?? null;

  return (
    <RecordPage
      backTo="/finance/balance-sheet"
      backLabel="Back"
      title={d?.label || "…"}
      subtitle={`${TITLE[type] || titleCase(type)} · finance profile`}
      loading={prof.isLoading}
      error={prof.error}
      onRetry={() => prof.refetch()}
      actions={
        canManage &&
        d &&
        ["partner", "customer", "broker"].includes(type) && (
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            onClick={() => nav("/finance/transactions/new")}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Record payment
          </Button>
        )
      }
    >
      {!d ? (
        <EmptyState
          title="Not found"
          description="No finance data for this entity."
        />
      ) : (
        <div className="space-y-4">
          {bal != null && (
            <Card
              className={`p-4 ${
                bal >= 0
                  ? "border-amber-200 bg-amber-50/70"
                  : "border-primary/20 bg-primary/5"
              }`}
            >
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {bal >= 0 ? "They owe the agency" : "The agency owes them"}
              </p>
              <p className="mt-0.5 text-2xl font-bold tabular-nums text-foreground">
                {formatINR(Math.abs(bal))}
              </p>
              {type === "partner" && d.pending.payout != null && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Reward we owe:{" "}
                  <strong className="text-foreground">
                    {formatINR(d.pending.payout)}
                  </strong>
                </p>
              )}
              {type === "broker" && d.pending.reward_to_receive != null && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Rewards to receive:{" "}
                  <strong className="text-foreground">
                    {formatINR(d.pending.reward_to_receive)}
                  </strong>
                </p>
              )}
            </Card>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile label="Policies" value={String(d.metrics.policies)} />
            <KpiTile
              label="Total premium"
              value={formatINR(d.metrics.premium)}
            />
            {!isCustomer && (
              <KpiTile
                label="Rewards earned"
                value={formatINR(d.metrics.reward_earned)}
              />
            )}
            {!isCustomer && (
              <KpiTile
                label="Profit"
                accent={C.green}
                value={formatINR(d.metrics.profit)}
              />
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-4 lg:col-span-2">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Monthly {isCustomer ? "premium" : "profit"}
              </p>
              <AreaTrend
                valueLabel={isCustomer ? "Premium" : "Profit"}
                color={isCustomer ? C.count : C.green}
                data={d.monthly.map((m) => ({
                  label: monthShort(m.month),
                  value: isCustomer ? m.premium : m.profit,
                }))}
              />
            </Card>
            <Card className="p-4">
              <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Policies
              </p>
              {Object.keys(d.policy_status).length === 0 ? (
                <p className="text-xs text-muted-foreground">No policies.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(d.policy_status).map(([st, n]) => (
                    <div
                      key={st}
                      className="flex items-center justify-between"
                    >
                      <StatusBadge value={st} />
                      <span className="text-xs font-medium tabular-nums text-foreground">
                        {n}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {d.party_type && (
            <Card className="overflow-hidden">
              <div className="border-b border-border px-4 py-2.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Ledger
                </p>
              </div>
              {ledger.isError ? (
                <ErrorState onRetry={() => ledger.refetch()} />
              ) : ledger.isLoading ? (
                <TableSkeleton cols={5} />
              ) : (ledger.data?.items.length ?? 0) === 0 ? (
                <EmptyState title="No transactions" />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableHead className="h-9 text-xs">When</TableHead>
                        <TableHead className="h-9 text-xs">Type</TableHead>
                        <TableHead className="h-9 text-xs">
                          Reference / note
                        </TableHead>
                        <TableHead className="h-9 text-right text-xs">
                          Debit
                        </TableHead>
                        <TableHead className="h-9 text-right text-xs">
                          Credit
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ledger.data!.items.map((t: LedgerTxn) => (
                        <TableRow key={t.id}>
                          <TableCell className="py-2 text-xs text-muted-foreground">
                            {formatDate(t.occurred_at)}
                          </TableCell>
                          <TableCell className="py-2 text-[13px] text-foreground">
                            {TXN_LABEL[t.txn_type] || t.txn_type}
                          </TableCell>
                          <TableCell className="py-2 text-xs text-muted-foreground">
                            {t.reference || t.note || "—"}
                          </TableCell>
                          <TableCell className="py-2 text-right text-[13px] tabular-nums text-amber-700">
                            {t.amount_paise > 0
                              ? formatINR(t.amount_paise)
                              : ""}
                          </TableCell>
                          <TableCell className="py-2 text-right text-[13px] tabular-nums text-emerald-700">
                            {t.amount_paise < 0
                              ? formatINR(-t.amount_paise)
                              : ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </RecordPage>
  );
}
