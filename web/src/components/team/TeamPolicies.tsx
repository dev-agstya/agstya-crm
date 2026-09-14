import { useQuery } from "@tanstack/react-query";
import { managersApi } from "../../api/endpoints";
import { Icon } from "../Icon";
import {
  EmptyState, ErrorState, Ledger, LedgerCell, LedgerFigure, LedgerRow,
  ListShell, LTh, MobileCard, PersonCell, TableSkeleton,
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

      <ListShell
        bare
        cards={rows.map((r) => (
          <MobileCard key={r.policy_id} to={`/policies/${r.policy_id}`}
            title={r.customer_name || r.code}
            meta={<>{r.partner_name} · {r.category_label}</>}
            right={
              <span className="block whitespace-nowrap text-metric-sm
                tabular-nums text-slate-900">
                {formatINR(r.premium)}
              </span>
            }
            footer={
              <span className="flex items-center justify-between gap-2">
                <span>{formatDate(r.booked_at)}</span>
                <span className="font-semibold text-money-in">
                  {formatINR(r.their_reward)}
                </span>
              </span>
            } />
        ))}
        table={
          <Ledger
            head={
              <>
                <LTh>Policy</LTh>
                <LTh>Channel partner</LTh>
                <LTh>Type</LTh>
                <LTh align="right">Premium</LTh>
                <LTh align="right">They earn</LTh>
              </>
            }
          >
            {rows.map((r) => (
              <LedgerRow key={r.policy_id}>
                {/* Customer stacked under the policy number rather than given a
                    column of its own — related facts stack (CLAUDE.md). */}
                <LedgerCell
                  to={`/policies/${r.policy_id}`}
                  title={r.policy_number || r.code}
                  sub={r.customer_name || "—"}
                />
                <td>
                  {r.partner_name
                    ? <PersonCell name={r.partner_name} size="xs" />
                    : <span className="text-slate-500">—</span>}
                </td>
                <td className="text-[13px]">
                  <span className="text-slate-700">{r.category_label}</span>
                  <span className="block text-xs text-slate-500">
                    {r.insurer_name || "—"}
                    {r.is_renewal && (
                      <span className="ml-1.5 chip">renewal</span>
                    )}
                  </span>
                </td>
                {/* LedgerFigure renders its own <td> — wrapping it in one
                    would nest a cell inside a cell. */}
                <LedgerFigure className="num" value={formatINR(r.premium)}
                  sub={formatDate(r.booked_at)} />
                <LedgerFigure className="num" tone="in"
                  value={formatINR(r.their_reward)} />
              </LedgerRow>
            ))}
          </Ledger>
        } />
    </div>
  );
}
