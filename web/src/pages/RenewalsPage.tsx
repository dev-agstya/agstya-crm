import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { policiesApi, reportsApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  EmptyState, ErrorState, Ledger, LedgerCell, LedgerFigure, LedgerRow,
  ListShell, LTh, MobileCard, StatCard, StatRow, TableSkeleton,
} from "../components/ui";
import { formatDate, formatINR } from "../lib/format";
import { useAuth } from "../store/auth";
import { FilterPill } from "../components/FilterPill";

const daysLeft = (iso?: string | null) => {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
};

/*
  The renewal clock, said once.

  This used to be a coloured suffix in the Expiry cell ("14d" in amber, "3d" in
  red) AND nothing else — so urgency was a piece of text inside a column, which
  is the thing a queue cannot afford. It is now the row's left edge as well: red
  inside a week, amber beyond it. The eye finds the edge before it reads
  anything, which is the whole point of a queue.
*/
const urgencyRail = (dl: number | null): "out" | "due" | undefined =>
  dl == null ? undefined : dl <= 7 ? "out" : "due";

function DaysLeft({ dl }: { dl: number | null }) {
  if (dl == null) return null;
  return (
    <span className={`text-xs font-medium ${
      dl <= 7 ? "text-money-out" : "text-due"}`}>
      {dl <= 0 ? "due" : `${dl}d`}
    </span>
  );
}

export default function RenewalsPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const canManage = has("manage_renewals");
  const canReports = has("view_reports");
  const [windowDays, setWindowDays] = useState(30);

  const due = useQuery({
    queryKey: ["renewals-due", windowDays],
    queryFn: async () => (await policiesApi.list({
      expiring_in_days: windowDays, page_size: 100 })).data,
  });
  const summary = useQuery({
    queryKey: ["renewal-summary"],
    queryFn: async () => (await reportsApi.renewalSummary(90)).data,
    enabled: canReports,
  });

  return (
    <div>
      <PageHeader title="Renewals"
        subtitle="Policies coming up for renewal — renew in one click, re-pricing under the Broker Code."
        figure={canReports && summary.data ? {
          label: "Due premium · 30 days",
          value: formatINR(summary.data.due_30d_premium),
          tone: "due",
        } : undefined}
      />

      {/* The tiles were four hand-rolled `card p-4` blocks with their own label
          casing and their own number size. `StatCard` is the one definition. */}
      {canReports && summary.data && (
        <StatRow cols={3}>
          <StatCard label="Due in 30 days"
            value={String(summary.data.due_30d)} tone="due" />
          <StatCard label={`Renewed (${summary.data.window_days}d)`}
            value={String(summary.data.renewed_window)} />
          <StatCard label="Renewal rate"
            value={summary.data.renewal_rate == null ? "—"
              : `${Math.round(summary.data.renewal_rate * 100)}%`} />
        </StatRow>
      )}

      <div className="mt-5">
        <div className="ledger-bar">
          <span className="text-sm text-slate-500">Expiring within</span>
          <FilterPill label="Window" value={String(windowDays)}
            defaultValue="30"
            onChange={(v) => setWindowDays(Number(v))}
            options={[
              { value: "30", label: "Next 30 days" },
              { value: "60", label: "Next 60 days" },
              { value: "90", label: "Next 90 days" },
            ]} />
          {due.data && (
            <span className="ledger-bar-end text-secondary text-slate-500">
              {due.data.items.length} due
            </span>
          )}
        </div>

        {due.isError ? (
          <ErrorState onRetry={() => due.refetch()} />
        ) : due.isLoading ? (
          <TableSkeleton cols={5} />
        ) : (due.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="Nothing due"
            hint="No policies are expiring in this window." />
        ) : (
          <ListShell
            bare
            cards={due.data!.items.map((p) => {
              const dl = daysLeft(p.expiry_date);
              return (
                <MobileCard key={p.id} to={`/renewals/${p.id}`}
                  rail={urgencyRail(dl)}
                  title={p.customer_name || p.code}
                  meta={<>{p.code} · {p.category_key}</>}
                  right={
                    <>
                      <span className="block whitespace-nowrap text-metric-sm
                        tabular-nums text-slate-900">
                        {formatINR(p.premium_amount)}
                      </span>
                      <DaysLeft dl={dl} />
                    </>
                  }
                  footer={`Expires ${formatDate(p.expiry_date)}`}
                />
              );
            })}
            table={
              <Ledger
                head={
                  <>
                    <LTh>Policy</LTh>
                    <LTh>Cover</LTh>
                    <LTh>Expiry</LTh>
                    <LTh align="right">Premium</LTh>
                    <LTh />
                  </>
                }
              >
                {due.data!.items.map((p) => {
                  const dl = daysLeft(p.expiry_date);
                  const rail = urgencyRail(dl);
                  return (
                    <LedgerRow key={p.id}>
                      <LedgerCell
                        rail={rail}
                        to={`/policies/${p.id}`}
                        title={p.customer_name || "—"}
                        sub={p.code}
                      />
                      <LedgerCell title={p.category_key}
                        sub={p.insurer_name || "—"} />
                      <td className="whitespace-nowrap">
                        <span className="block text-[13px] text-slate-700">
                          {formatDate(p.expiry_date)}
                        </span>
                        <span className="mt-0.5 block">
                          <DaysLeft dl={dl} />
                        </span>
                      </td>
                      <LedgerFigure value={formatINR(p.premium_amount)} />
                      <td>
                        {/* Buttons were `btn-secondary px-2.5 py-1 text-xs` —
                            a per-call height override of the one thing `.btn`
                            owns. `.btn-sm` is the variant that exists. */}
                        <div className="flex justify-end gap-1.5">
                          <button className="btn-secondary btn-sm"
                            onClick={() =>
                              navigate(`/renewals/${p.id}/history`)}>
                            <Icon.Clock size={14} /> History
                          </button>
                          {canManage && (
                            <button className="btn-primary btn-sm"
                              onClick={() => navigate(`/renewals/${p.id}`)}>
                              <Icon.Refresh size={14} /> Renew
                            </button>
                          )}
                        </div>
                      </td>
                    </LedgerRow>
                  );
                })}
              </Ledger>
            }
          />
        )}
      </div>

    </div>
  );
}
