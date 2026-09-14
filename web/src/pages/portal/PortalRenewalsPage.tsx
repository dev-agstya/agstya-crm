import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { portalApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import { ErrorState, EmptyState, TableSkeleton } from "../../components/ui";
import { formatDate, formatINR } from "../../lib/format";
import { ListShell, MobileCard } from "./shared";

/*
  A partner's own book, expiring soonest first.

  The highest-value screen in the portal: it is the agency's renewal book being
  chased for free by the person who sold it. Every row carries the customer's
  phone number as a tap-to-call link, because the action this page exists to
  cause is a phone call.
*/

function urgency(days: number) {
  if (days <= 7) return { tone: "text-money-out", label: "this week" };
  if (days <= 30) return { tone: "text-due", label: "this month" };
  return { tone: "text-slate-600", label: "" };
}

export default function PortalRenewalsPage() {
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["portal", "renewals"],
    queryFn: async () => (await portalApi.renewals()).data,
  });
  const rows = list.data ?? [];

  return (
    <div>
      <PageHeader title="Renewals"
        subtitle="Your policies coming up for renewal in the next 60 days." />

      {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
        <div className="card card-body"><TableSkeleton cols={5} /></div>
      ) : (
        <ListShell
          empty={rows.length === 0 ? (
            <EmptyState
              icon={<Icon.Refresh size={20} />}
              title="Nothing due"
              hint="No policy of yours expires in the next 60 days." />
          ) : undefined}
          cards={rows.map((r) => {
            const u = urgency(r.days_left);
            return (
              <MobileCard key={r.policy_id}
                to={`/portal/policies/${r.policy_id}`}
                title={r.customer_name || r.policy_number || r.code}
                meta={<>{r.category_label} · {r.policy_number || r.code}</>}
                right={
                  <>
                    <span className={`block whitespace-nowrap text-sm
                      font-semibold ${u.tone}`}>{r.days_left}d left</span>
                    <span className="block text-xs text-slate-500">
                      {formatDate(r.expiry_date)}</span>
                  </>
                }
                footer={
                  <span className="flex items-center justify-between gap-2">
                    <span>Premium {formatINR(r.premium_amount)}</span>
                    {r.quote_requested
                      ? <span className="chip">quote asked</span>
                      : <span className="font-medium text-slate-700">
                          Ask for a quote</span>}
                  </span>
                } />
            );
          })}
          table={
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Policy</th>
                  <th>Type</th>
                  <th className="num">Premium</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const u = urgency(r.days_left);
                  return (
                    <tr key={r.policy_id} className="row-link"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") navigate(`/portal/policies/${r.policy_id}`);
                      }}
                      onClick={() =>
                        navigate(`/portal/policies/${r.policy_id}`)}>
                      <td>
                        <span className="font-medium text-slate-900">
                          {r.customer_name || "—"}</span>
                        {r.customer_mobile && (
                          <a href={`tel:${r.customer_mobile}`}
                            onClick={(e) => e.stopPropagation()}
                            className="ml-2 text-xs text-slate-500 underline">
                            {r.customer_mobile}</a>
                        )}
                      </td>
                      <td>{r.policy_number || r.code}</td>
                      <td>{r.category_label}</td>
                      <td className="num">{formatINR(r.premium_amount)}</td>
                      <td className="whitespace-nowrap">
                        {formatDate(r.expiry_date)}
                        <span className={`ml-2 text-xs font-medium ${u.tone}`}>
                          {r.days_left}d
                        </span>
                      </td>
                      <td className="num">
                        {r.quote_requested ? (
                          <span className="chip">quote asked</span>
                        ) : (
                          <button className="btn-secondary btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(
                                `/portal/quotes/new?renewal=${r.policy_id}`);
                            }}>
                            <Icon.Refresh size={14} /> Ask for a quote
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          } />
      )}
    </div>
  );
}
