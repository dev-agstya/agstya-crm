import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { customersApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import { ExportButton } from "../../components/ExportButton";
import {
  EmptyState,
  ErrorState,
  Ledger,
  LedgerCell,
  LedgerFigure,
  LedgerRow,
  ListShell,
  LTh,
  MobileCard,
  Pagination,
  SearchInput,
  TableSkeleton,
} from "../../components/ui";
import { useAuth } from "../../store/auth";
import { FilterPill } from "../../components/FilterPill";

// Sort + filter options for the customer list (owner 2026-07-17).
const CUST_SORTS: { value: string; label: string }[] = [
  { value: "profit", label: "Top profit contributors" },
  { value: "policies", label: "Most policies" },
  { value: "active_policies", label: "Most active policies" },
  { value: "renewals", label: "Renewals due (soonest)" },
  { value: "recent", label: "Recently added" },
  { value: "name_asc", label: "Name A–Z" },
];

const PAGE_SIZE = 15;

export default function CustomersListPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const [sp] = useSearchParams();

  const [page, setPage] = useState(1);
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [sort, setSort] = useState("recent");
  const [renewalDue, setRenewalDue] = useState("");
  const [hasActive, setHasActive] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const list = useQuery({
    queryKey: ["customers", page, q, sort, renewalDue, hasActive, showArchived],
    queryFn: async () =>
      (await customersApi.list({
        page, page_size: PAGE_SIZE, q, sort,
        include_archived: showArchived ? 1 : undefined,
        has_active_policy: hasActive ? 1 : undefined,
        renewal_due_days: renewalDue || undefined,
      })).data,
  });

  const addButton = has("manage_customers") ? (
    <button className="btn-primary" onClick={() => navigate("/customers/new")}>
      <Icon.Plus size={16} /> Add customer
    </button>
  ) : undefined;

  return (
    <div>
      <PageHeader
        title="Customers"
        actions={
          <>
            <ExportButton filename="customers"
              onExport={(fmt) => customersApi.export({ q: q || undefined, fmt })} />
            {has("manage_customers") && (
              <>
                <button className="btn-secondary"
                  onClick={() => navigate("/customers/import")}>
                  <Icon.Upload size={16} /> Import
                </button>
                {addButton}
              </>
            )}
          </>
        }
      />

      <div>
        <div className="ledger-bar">
          <SearchInput placeholder="Search name, mobile, ID…"
            value={q} onChange={(v) => { setPage(1); setQ(v); }}
            className="min-w-[220px] max-w-sm flex-1" />
          <FilterPill label="Sort" value={sort}
            defaultValue={CUST_SORTS[0].value}
            onChange={(v) => { setPage(1); setSort(v); }}
            options={CUST_SORTS.map((s) => ({
              value: s.value, label: s.label }))} />
          <FilterPill label="Renewal" value={renewalDue}
            allLabel="Any renewal date"
            onChange={(v) => { setPage(1); setRenewalDue(v); }}
            options={[
              { value: "30", label: "Due within 30 days" },
              { value: "60", label: "Due within 60 days" },
              { value: "90", label: "Due within 90 days" },
            ]} />
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" className="h-4 w-4" checked={hasActive}
              onChange={(e) => { setPage(1); setHasActive(e.target.checked); }} />
            Has active policy
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" className="h-4 w-4" checked={showArchived}
              onChange={(e) => {
                setPage(1); setShowArchived(e.target.checked); }} />
            Show archived
          </label>
        </div>

        {list.isError ? (
          <ErrorState onRetry={() => list.refetch()} />
        ) : list.isLoading ? (
          <TableSkeleton cols={3} />
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No customers yet"
            icon={<Icon.Customers size={24} />}
            hint="Add your first customer, or import a list from a spreadsheet."
            action={addButton} />
        ) : (
          <ListShell
            bare
            cards={list.data!.items.map((c) => (
              <MobileCard key={c.id} to={`/customers/${c.id}`}
                title={c.name}
                meta={c.mobile || c.email || "No contact details"}
                right={
                  <>
                    <span className="block text-metric-sm tabular-nums
                      text-slate-900">{c.active_policies ?? 0}</span>
                    <span className="text-caption uppercase text-slate-500">
                      active</span>
                  </>
                }
              />
            ))}
            table={
              <Ledger
                head={
                  <>
                    <LTh>Customer</LTh>
                    <LTh>Mobile</LTh>
                    <LTh align="right">Policies</LTh>
                  </>
                }
              >
                {list.data!.items.map((c) => (
                  <LedgerRow key={c.id}
                    onClick={() => navigate(`/customers/${c.id}`)}>
                    {/* The Customer ID column was dropped (owner 2026-07-26).
                        The archived badge lives here with the name — "Show
                        archived" is only useful if you can tell which rows
                        are. Email is the sub-line rather than a column: it
                        identifies the person, it is not a separate fact. */}
                    <LedgerCell
                      to={`/customers/${c.id}`}
                      title={
                        <>
                          {c.name}
                          {c.is_archived && (
                            <span className="badge-due ml-2">Archived</span>
                          )}
                        </>
                      }
                      sub={c.email || "—"}
                    />
                    <td className="tabular-nums text-[13px] text-slate-700">
                      {c.mobile || "—"}
                    </td>
                    {/* One hero figure: how many live policies they hold.
                        "3 / 7" was a proportion written as text. */}
                    <LedgerFigure
                      value={c.active_policies ?? 0}
                      sub={`of ${c.total_policies ?? 0}`}
                    />
                  </LedgerRow>
                ))}
              </Ledger>
            }
          />
        )}
        {list.data && (
          <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total}
            onChange={setPage} />
        )}
      </div>
    </div>
  );
}
