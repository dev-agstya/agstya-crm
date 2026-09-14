import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { managersApi } from "../api/endpoints";
import { Icon } from "./Icon";
import {
  ErrorState, EmptyState, Meter, PersonCell, SplitBar, StatCard, StatRow, TableSkeleton,
} from "./ui";
import {
  DateFilter, periodParams, type PeriodValue,
} from "./finance/DateFilter";
import { formatINR } from "../lib/format";
import type { ManagerRow } from "../lib/types";
import { moneyTone } from "../lib/tone";

/*
  How each employee's book is performing — the relationship-manager roll-up.

  This USED TO BE ITS OWN PAGE (/people/managers) and the owner's verdict was
  blunt: "it doesn't need to be a separate page, it could have been somewhere on
  the employee's profile". So it is a view of the Employees screen now, and one
  employee's own detail is a tab on their record. Two fewer nav entries, and the
  numbers sit next to the people they describe.

  Every figure comes off the FROZEN manager stamp on each policy, so reassigning
  a partner tomorrow does not move last quarter's business onto somebody who did
  not do the work.

  Not a visibility boundary: everyone in-house can still open every record. What
  IS gated is whose numbers you may read — the owner sees the table, an employee
  sees their own row — and house profit, which follows view_agency_profit like
  every other surface that carries it.

  The columns are the three the owner said they actually judge on (Q4): house
  profit, policies, and renewals coming up. Premium is kept as the ranking bar
  because it is what makes the rows comparable, not because it is judged.
*/

export function ManagerLeague({ period, onPeriodChange }: {
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
    }), { partners: 0, policies: 0, premium: 0, profit: 0, renewals: 0 });

  // Rows arrive sorted by the server. The bar is drawn against the strongest
  // book on screen so a row's length means "compared to the best", not
  // "compared to an arbitrary maximum".
  const peak = Math.max(...rows.map((r) => r.premium), 1);

  const row = (r: ManagerRow, rank: number | null) => {
    const muted = rank === null;          // the unassigned bucket
    return (
      <tr key={r.manager_id || "unassigned"}
        className={muted ? "" : "row-link"}
        tabIndex={muted ? undefined : 0}
        onKeyDown={muted ? undefined : (e) => {
          if (e.key === "Enter") navigate(`/people/employees/${r.manager_id}?tab=team`);
        }}
        onClick={muted ? undefined
          : () => navigate(`/people/employees/${r.manager_id}?tab=team`)}>
        <td>
          {muted ? (
            <div className="flex items-center gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center
                rounded-full bg-slate-50 text-slate-500 ring-1 ring-inset
                ring-slate-200">
                <Icon.Alert size={14} />
              </span>
              <div>
                <p className="font-medium text-slate-600">{r.manager_name}</p>
                <p className="text-xs text-slate-500">
                  No relationship manager could be resolved when these were
                  booked.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="w-4 shrink-0 text-right text-xs font-semibold
                tabular-nums text-slate-500">{rank}</span>
              <PersonCell
                name={r.manager_name}
                sub={`${r.manager_code ?? ""}${r.manager_code ? " · " : ""}${
                  r.active_partners}/${r.partners} partners writing`}
                badges={!r.active_account
                  ? <span className="badge bg-slate-100 text-slate-600">
                      inactive</span>
                  : undefined}
              />
            </div>
          )}
        </td>

        {/* The ranking column. Premium is the comparable quantity, so it gets
            the bar; it is deliberately NOT one of the judged figures. */}
        <td className="num">
          <div className="ml-auto w-32">
            <p className="font-semibold text-slate-900">
              {formatINR(r.premium)}</p>
            {!muted && <Meter value={r.premium} total={peak} className="mt-1.5"
              title="Premium relative to the top performer in this list" />}
          </div>
        </td>

        <td className="num font-medium text-slate-900">{r.policies}</td>

        {canProfit && (
          <td className="num">
            <span className={`font-semibold ${moneyTone(r.profit)}`}>
              {formatINR(r.profit)}
            </span>
          </td>
        )}

        <td className="num">
          {r.renewals > 0
            ? <span className="badge bg-due/10 text-due">{r.renewals} due</span>
            : <span className="text-slate-500">—</span>}
        </td>

        {/* One bar instead of the four columns this used to be: partner
            policies, partner premium, own policies, own premium — each of them
            a count and a money figure crammed into a cell with a "·". */}
        <td>
          {muted ? <span className="text-slate-500">—</span> : (
            <SplitBar a={r.partner_premium} b={r.own_premium}
              aLabel="Partners" bLabel="Own" />
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateFilter value={period} onChange={onPeriodChange} />
        <span className="text-xs text-slate-500">
          {rollup.data?.period_label}
        </span>
      </div>

      {canAll && (
        <StatRow>
          <StatCard label="Channel partners" value={String(totals.partners)}
            icon="Users" hint={`across ${rows.length} managers`} />
          <StatCard label="Policies" value={String(totals.policies)}
            icon="Policy" hint={formatINR(totals.premium) + " premium"} />
          {canProfit && (
            <StatCard label="House profit" value={formatINR(totals.profit)}
              icon="Trend"
              tone={totals.profit > 0 ? "in"
                : totals.profit < 0 ? "out" : undefined} />
          )}
          <StatCard label="Renewals due" value={String(totals.renewals)}
            icon="Refresh" tone={totals.renewals ? "due" : undefined}
            hint="next 30 days" />
        </StatRow>
      )}

      {!canAll && (
        <p className="rounded-control border border-line bg-white px-4 py-3
          text-sm text-slate-600">
          You are seeing your own book. Comparing across managers needs the
          View team permission.
        </p>
      )}

      <div className="card overflow-hidden">
        {rollup.isError ? <ErrorState onRetry={() => rollup.refetch()} /> : rollup.isLoading ? (
          <TableSkeleton cols={6} />
        ) : !rows.length && !unassigned ? (
          <EmptyState
            icon={<Icon.Trend size={20} />}
            title="Nothing in this period"
            hint="No policies were booked in the selected window."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-sticky">
              <thead>
                <tr>
                  <th>Manager</th>
                  <th className="num">Premium</th>
                  <th className="num">Policies</th>
                  {canProfit && <th className="num">House profit</th>}
                  <th className="num">Renewals</th>
                  <th>Partners vs own</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => row(r, i + 1))}
                {unassigned && row(unassigned, null)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs leading-relaxed text-slate-500">
        A manager's numbers are frozen onto each policy when it is booked, so
        moving a partner to someone else changes who they report to from now
        on — never who is credited with what they have already brought in.
      </p>
    </div>
  );
}
