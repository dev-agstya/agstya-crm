import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { policiesApi } from "../../api/endpoints";
import { Icon } from "../Icon";
import {
  EmptyState, ErrorState, Ledger, LedgerCell, LedgerFigure, LedgerRow,
  ListShell, LTh, MobileCard, Pagination, SearchInput, StatCard, StatRow,
  TableSkeleton,
} from "../ui";
import { ExpiryChip } from "../PolicyDetailBody";
import { formatDate, formatINR, formatINRShort, titleCase } from "../../lib/format";

/*
  ONE CHANNEL PARTNER'S POLICIES, on that partner's own record.

  The owner asked for it directly: "when they go to their channel partner's
  profile, they should be able to see all the policies that this channel partner
  has, so that we can go to a channel partner and filter out the specific
  policies that they only have."

  A TAB, NOT A PAGE, and not a link into a pre-filtered /policies either. The
  standing rule is "no random pages for each and every shit thing", and the
  practical half is that everything about ONE person belongs on that person's
  record — the same call the Team tab and the HR tab already got.

  IT READS THE ORDINARY LIST ENDPOINT, filtered by partner. That means it is
  SCOPED like everything else: a relationship manager opening one of their own
  partners sees the lot, and somebody who has no business with this partner
  cannot reach this record at all. There is no second query, no second scope,
  and therefore no second answer to "may I see this".
*/

const PAGE_SIZE = 15;

export function PartnerPolicies({ partnerId, partnerName }: {
  partnerId: string;
  partnerName: string;
}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");

  const list = useQuery({
    queryKey: ["policies", "of-partner", partnerId, page, q, status],
    queryFn: async () => (await policiesApi.list({
      partner_id: partnerId, page, page_size: PAGE_SIZE,
      q: q.trim() || undefined,
      status: status || undefined,
      period: "till_date",
    })).data,
  });

  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  // Totals across the PAGE, said as such. A tile claiming a lifetime premium
  // total while showing fifteen of ninety rows would be a figure nobody could
  // reconcile with what is underneath it — and this app's worst bug is two
  // numbers on one screen disagreeing.
  const pagePremium = rows.reduce((s, p) => s + p.premium_amount, 0);
  const live = rows.filter(
    (p) => p.status === "active" || p.status === "renewal_due").length;

  return (
    <div className="space-y-4">
      <StatRow cols={3}>
        <StatCard label="Policies" value={String(total)}
          hint={`booked by ${partnerName}`} />
        <StatCard label="Live on this page" value={String(live)}
          hint={`of ${rows.length} shown`} />
        <StatCard label="Premium on this page"
          value={formatINR(pagePremium)}
          hint={total > rows.length
            ? `${rows.length} of ${total} policies` : undefined} />
      </StatRow>

      <div className="ledger-bar">
        <SearchInput value={q}
          onChange={(v) => { setPage(1); setQ(v); }}
          placeholder="Search policy number or customer…"
          className="w-64" />
        <select className="select w-40" value={status}
          onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
          <option value="">All statuses</option>
          {["active", "renewal_due", "renewed", "expired", "lapsed",
            "cancelled"].map((s) => (
            <option key={s} value={s}>{titleCase(s)}</option>
          ))}
        </select>
      </div>

      {/* Error FIRST, before loading and before empty — both of those are
          claims about data that was actually fetched. */}
      {list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : list.isLoading ? (
        <TableSkeleton cols={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon.Policy size={20} />}
          title={q || status
            ? "No policies match" : "No policies from this partner yet"}
          hint={q || status
            ? "Clear the search or the status filter."
            : "Anything booked against this partner appears here — including "
              + "policies booked before they were assigned to their current "
              + "relationship manager."} />
      ) : (
        <>
          <ListShell
            bare
            cards={rows.map((p) => (
              <MobileCard key={p.id} to={`/policies/${p.id}`}
                title={p.policy_number || p.code}
                meta={
                  <>
                    {p.customer_name || "No customer"}
                    <span className="block">
                      {p.insurer_name || p.category_key}
                    </span>
                  </>
                }
                right={
                  <span className="block whitespace-nowrap text-metric-sm
                    tabular-nums text-slate-900">
                    {formatINRShort(p.premium_amount)}
                  </span>
                }
                footer={
                  <span className="flex items-center gap-1.5">
                    {formatDate(p.start_date)} → {formatDate(p.expiry_date)}
                    <ExpiryChip expiry={p.expiry_date} status={p.status} />
                  </span>
                } />
            ))}
            table={
              <Ledger minWidth={640} head={
                <>
                  <LTh>Policy</LTh>
                  <LTh>Cover</LTh>
                  <LTh>Term</LTh>
                  <LTh align="right">Premium</LTh>
                </>
              }>
                {rows.map((p) => (
                  <LedgerRow key={p.id}>
                    {/* A real <Link>, so the row is focusable, opens on Enter
                        and middle-clicks into a new tab. */}
                    <LedgerCell to={`/policies/${p.id}`}
                      title={p.policy_number || p.code}
                      sub={p.customer_name || "No customer"} />
                    <td className="text-sm text-slate-600">
                      {titleCase(p.category_key)}
                      <span className="block text-xs text-slate-500">
                        {p.insurer_name || "—"}
                      </span>
                    </td>
                    <td className="text-sm text-slate-600">
                      {formatDate(p.start_date)}
                      <span className="block text-xs text-slate-500">
                        to {formatDate(p.expiry_date)}
                      </span>
                    </td>
                    <LedgerFigure value={formatINR(p.premium_amount)}
                      sub={titleCase(p.status)} />
                  </LedgerRow>
                ))}
              </Ledger>
            } />
          {total > PAGE_SIZE && (
            <Pagination page={page} pageSize={PAGE_SIZE} total={total}
              onChange={setPage} />
          )}
        </>
      )}
    </div>
  );
}
