import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, TrendingUp } from "lucide-react";
import { managersApi } from "../api/endpoints";
import { EmptyState } from "./shared/EmptyState";
import { ErrorState } from "./shared/ErrorState";
import { TableSkeleton } from "./shared/LoadingSkeleton";
import { Meter, SplitBar } from "./ui";
import {
  DateFilter,
  periodParams,
  type PeriodValue,
} from "./finance/DateFilter";
import { formatINR, initials } from "../lib/format";
import type { ManagerRow } from "../lib/types";
import { moneyTone } from "../lib/tone";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function ManagerLeague({
  period,
  onPeriodChange,
}: {
  period: PeriodValue;
  onPeriodChange: (v: PeriodValue) => void;
}) {
  const navigate = useNavigate();

  const rollup = useQuery({
    queryKey: ["managers", "rollup", period],
    queryFn: async () => (await managersApi.rollup(periodParams(period))).data,
  });

  const rows = rollup.data?.rows ?? [];
  const unassigned = rollup.data?.unassigned;
  const canProfit = rollup.data?.can_view_profit ?? false;
  const canAll = rollup.data?.can_view_all ?? false;

  const totals = [...rows, ...(unassigned ? [unassigned] : [])].reduce(
    (a, r) => ({
      partners: a.partners + r.partners,
      policies: a.policies + r.policies,
      premium: a.premium + r.premium,
      profit: a.profit + r.profit,
      renewals: a.renewals + r.renewals,
    }),
    { partners: 0, policies: 0, premium: 0, profit: 0, renewals: 0 }
  );

  const peak = Math.max(...rows.map((r) => r.premium), 1);

  const row = (r: ManagerRow, rank: number | null) => {
    const muted = rank === null;
    return (
      <TableRow
        key={r.manager_id || "unassigned"}
        className={muted ? "" : "cursor-pointer"}
        tabIndex={muted ? undefined : 0}
        onKeyDown={
          muted
            ? undefined
            : (e) => {
                if (e.key === "Enter")
                  navigate(`/people/employees/${r.manager_id}?tab=team`);
              }
        }
        onClick={
          muted
            ? undefined
            : () => navigate(`/people/employees/${r.manager_id}?tab=team`)
        }
      >
        <TableCell className="py-2">
          {muted ? (
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" />
              </span>
              <div>
                <p className="text-[13px] font-medium text-foreground">
                  {r.manager_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  No relationship manager could be resolved when these were
                  booked.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2.5">
              <span className="w-4 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                {rank}
              </span>
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                  {initials(r.manager_name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {r.manager_name}
                  </span>
                  {!r.active_account && (
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                      inactive
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {r.manager_code ?? ""}
                  {r.manager_code ? " · " : ""}
                  {r.active_partners}/{r.partners} partners writing
                </p>
              </div>
            </div>
          )}
        </TableCell>

        <TableCell className="py-2 text-right">
          <div className="ml-auto w-32">
            <p className="text-[13px] font-semibold tabular-nums text-foreground">
              {formatINR(r.premium)}
            </p>
            {!muted && (
              <Meter
                value={r.premium}
                total={peak}
                className="mt-1"
                title="Premium relative to the top performer in this list"
              />
            )}
          </div>
        </TableCell>

        <TableCell className="py-2 text-right text-[13px] font-medium tabular-nums text-foreground">
          {r.policies}
        </TableCell>

        {canProfit && (
          <TableCell className="py-2 text-right">
            <span
              className={`text-[13px] font-semibold tabular-nums ${moneyTone(
                r.profit
              )}`}
            >
              {formatINR(r.profit)}
            </span>
          </TableCell>
        )}

        <TableCell className="py-2 text-right">
          {r.renewals > 0 ? (
            <Badge
              variant="outline"
              className="h-5 border-amber-200 bg-amber-50 px-1.5 text-[11px] text-amber-800"
            >
              {r.renewals} due
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>

        <TableCell className="py-2">
          {muted ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <SplitBar
              a={r.partner_premium}
              b={r.own_premium}
              aLabel="Partners"
              bLabel="Own"
            />
          )}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <DateFilter value={period} onChange={onPeriodChange} />
        <span className="text-xs text-muted-foreground">
          {rollup.data?.period_label}
        </span>
      </div>

      {canAll && (
        <div
          className={`grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-card sm:divide-x sm:divide-y-0 ${
            canProfit ? "sm:grid-cols-4" : "sm:grid-cols-3"
          }`}
        >
          <div className="px-3.5 py-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Channel partners
            </p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
              {totals.partners}
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                across {rows.length} managers
              </span>
            </p>
          </div>
          <div className="px-3.5 py-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Policies
            </p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
              {totals.policies}
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                {formatINR(totals.premium)}
              </span>
            </p>
          </div>
          {canProfit && (
            <div className="px-3.5 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                House profit
              </p>
              <p
                className={`mt-0.5 text-lg font-semibold tabular-nums ${moneyTone(
                  totals.profit
                )}`}
              >
                {formatINR(totals.profit)}
              </p>
            </div>
          )}
          <div className="px-3.5 py-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Renewals due
            </p>
            <p
              className={`mt-0.5 text-lg font-semibold tabular-nums ${
                totals.renewals ? "text-amber-700" : "text-foreground"
              }`}
            >
              {totals.renewals}
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                next 30 days
              </span>
            </p>
          </div>
        </div>
      )}

      {!canAll && (
        <p className="rounded-md border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
          You are seeing your own book. Comparing across managers needs the View
          team permission.
        </p>
      )}

      <Card className="overflow-hidden">
        {rollup.isError ? (
          <ErrorState onRetry={() => rollup.refetch()} />
        ) : rollup.isLoading ? (
          <TableSkeleton cols={6} />
        ) : !rows.length && !unassigned ? (
          <EmptyState
            icon={<TrendingUp className="h-5 w-5" />}
            title="Nothing in this period"
            description="No policies were booked in the selected window."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="h-9 text-xs">Manager</TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    Premium
                  </TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    Policies
                  </TableHead>
                  {canProfit && (
                    <TableHead className="h-9 text-right text-xs">
                      House profit
                    </TableHead>
                  )}
                  <TableHead className="h-9 text-right text-xs">
                    Renewals
                  </TableHead>
                  <TableHead className="h-9 text-xs">
                    Partners vs own
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => row(r, i + 1))}
                {unassigned && row(unassigned, null)}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <p className="text-xs leading-relaxed text-muted-foreground">
        A manager&apos;s numbers are frozen onto each policy when it is booked,
        so moving a partner to someone else changes who they report to from now
        on — never who is credited with what they have already brought in.
      </p>
    </div>
  );
}
