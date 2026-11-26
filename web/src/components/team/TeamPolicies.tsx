import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "../shared/DataTable";
import { managersApi } from "../../api/endpoints";
import { Icon } from "../Icon";
import {
  EmptyState, ErrorState, PersonCell, TableSkeleton,
} from "../ui";
import { formatDate, formatINR } from "../../lib/format";
import { periodParams, type PeriodValue } from "../finance/DateFilter";

/*
  THE BUSINESS BEHIND THE TEAM'S NUMBERS.

  The Team view could say what a partner was GIVEN and what they TOTALLED, and
  show not one line of the actual policies. So the obvious next question — "why
  is that number what it is?" — meant leaving the page for /policies and
  filtering it by partner, one at a time, for a roster of ten. The owner asked
  for "easy to see policies on that team", and this is it.

  It is a LEDGER, not a card list: it is a list of transactions being scanned
  down a column, which is exactly what `.ledger*` exists for (CLAUDE.md, "A list
  is a LEDGER"). Six columns, related facts stacked rather than columned —
  customer under the policy number, insurer under the type.

  NO AGENCY REWARD AND NO HOUSE PROFIT. `their_reward` is what the PARTNER
  earns, which is operational and already on the roster above. The agency's own
  margin has its own permission and its own screens; a team view is not a
  finance report and must not quietly become one.
*/

export function TeamPolicies({ managerId, period }: {
  /** Omitted means "me". */
  managerId?: string;
  period: PeriodValue;
}) {
  const q = useQuery({
    queryKey: ["managers", "team-policies", managerId ?? "me", period],
    queryFn: async () => (managerId
      ? await managersApi.teamPolicies(managerId, periodParams(period))
      : await managersApi.myTeamPolicies(periodParams(period))).data,
  });
  const d = q.data;
  const rows = d?.rows ?? [];

  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  if (q.isLoading) return <TableSkeleton cols={5} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Icon.Policy size={20} />}
        title="No policies in this period"
        hint="Nothing your channel partners wrote falls inside the date filter.
          Widen it, or check the roster for partners who have gone quiet." />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4
        gap-y-1">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">
            {rows.length}</span>{" "}
          {rows.length === 1 ? "policy" : "policies"}
          {" · "}
          <span className="font-semibold text-slate-900">
            {formatINR(d!.premium)}</span> premium
          {" · "}
          <span className="font-semibold text-money-in">
            {formatINR(d!.their_reward_total)}</span> earned by partners
        </p>
        <p className="text-xs text-slate-500">{d!.period_label}</p>
      </div>

      {/* Honest about the cap. A footer summing 500 rows under a count of 900
          is a spreadsheet that lies quietly — the totals above are of what is
          LISTED, and this says so and points at the page that paginates. */}
      {d!.truncated && (
        <p className="rounded-control border border-due/25 bg-due/10 px-3 py-2
          text-xs text-due">
          Showing the most recent {rows.length} of {d!.total} policies in this
          period, and the totals above cover only those. Narrow the date filter,
          or open Policies for the full list.
        </p>
      )}

      <DataTable
        data={rows}
        columns={[
          {
            key: "policy",
            header: "Policy",
            cell: (r) => (
              <div>
                <p className="font-medium text-slate-900">
                  {r.policy_number || r.code}
                </p>
                <p className="text-xs text-slate-500">
                  {r.customer_name || "—"}
                </p>
              </div>
            ),
          },
          {
            key: "partner",
            header: "Channel partner",
            cell: (r) =>
              r.partner_name ? (
                <PersonCell name={r.partner_name} size="xs" />
              ) : (
                <span className="text-slate-500">—</span>
              ),
          },
          {
            key: "type",
            header: "Type",
            cell: (r) => (
              <div className="text-[13px]">
                <span className="text-slate-700">{r.category_label}</span>
                <span className="block text-xs text-slate-500">
                  {r.insurer_name || "—"}
                  {r.is_renewal && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      renewal
                    </Badge>
                  )}
                </span>
              </div>
            ),
          },
          {
            key: "premium",
            header: "Premium",
            align: "right",
            cell: (r) => (
              <div className="text-right tabular-nums">
                <p className="font-medium text-slate-900">
                  {formatINR(r.premium)}
                </p>
                <p className="text-xs text-slate-500">
                  {formatDate(r.booked_at)}
                </p>
              </div>
            ),
          },
          {
            key: "earning",
            header: "They earn",
            align: "right",
            cell: (r) => (
              <span className="font-semibold tabular-nums text-emerald-700">
                {formatINR(r.their_reward)}
              </span>
            ),
          },
        ] as Column<(typeof rows)[number]>[]}
        keyField={(r) => r.policy_id}
        onRowClick={(r) => window.location.assign(`/policies/${r.policy_id}`)}
        renderMobileCard={(r) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="truncate font-medium text-slate-900">
                {r.customer_name || r.code}
              </p>
              <p className="text-xs text-slate-500">
                {r.partner_name} · {r.category_label}
              </p>
              <p className="text-xs text-slate-500">
                {formatDate(r.booked_at)}
              </p>
            </div>
            <div className="text-right tabular-nums">
              <p className="font-semibold text-slate-900">
                {formatINR(r.premium)}
              </p>
              <p className="text-xs font-semibold text-emerald-700">
                {formatINR(r.their_reward)}
              </p>
            </div>
          </div>
        )}
      />
    </div>
  );
}
