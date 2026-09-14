import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { insurersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  EmptyState, ErrorState, Ledger, LedgerCell, LedgerRow, ListShell, LTh,
  MobileCard, SearchInput, TableSkeleton,
} from "../components/ui";
import { useAuth } from "../store/auth";
import { FilterPill } from "../components/FilterPill";

export default function InsurersPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const [q, setQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);

  const list = useQuery({
    queryKey: ["insurers", q, activeOnly],
    queryFn: async () =>
      (await insurersApi.list({
        page_size: 200, q: q || undefined, active_only: activeOnly ? 1 : 0,
      })).data,
  });


  return (
    <div>
      <PageHeader
        title="Insurers"
        actions={
          has("manage_insurers") && (
            <button className="btn-primary" onClick={() => navigate("/insurers/new")}>
              <Icon.Plus size={18} /> Add Insurer
            </button>
          )
        }
      />

      <div>
        <div className="ledger-bar">
          <SearchInput placeholder="Search insurer name…"
            value={q} onChange={setQ}
            className="min-w-[200px] flex-1 max-w-xs" />
          <FilterPill label="Showing" value={activeOnly ? "active" : "all"}
            defaultValue="active"
            onChange={(v) => setActiveOnly(v === "active")}
            options={[
              { value: "active", label: "Active only" },
              { value: "all", label: "All insurers" },
            ]} />
        </div>

        {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
          <TableSkeleton cols={5} />
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No insurers found"
            hint="Add insurers so you can attach policies to them." />
        ) : (
          <ListShell
            bare
            cards={list.data!.items.map((i) => (
              <MobileCard key={i.id} to={`/insurers/${i.id}/edit`}
                title={i.name}
                meta={<>{i.code}{i.phone ? ` · ${i.phone}` : ""}</>}
                right={
                  <span className={i.active ? "badge-in" : "badge-neutral"}>
                    {i.active ? "Active" : "Inactive"}
                  </span>
                }
              />
            ))}
            table={
              <Ledger
                head={
                  <>
                    <LTh>Insurer</LTh>
                    <LTh>Contact</LTh>
                    <LTh>Status</LTh>
                    {has("manage_insurers") && <LTh />}
                  </>
                }
              >
                {list.data!.items.map((i) => (
                  <LedgerRow key={i.id}>
                    <LedgerCell to={`/insurers/${i.id}/edit`} title={i.name}
                      sub={i.code} />
                    <td className="text-[13px] text-slate-700">
                      {i.contact_person || "—"}
                      {i.phone && (
                        <span className="block text-xs text-slate-500">
                          {i.phone}</span>
                      )}
                    </td>
                    <td>
                      <span className={i.active ? "badge-in" : "badge-neutral"}>
                        {i.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    {has("manage_insurers") && (
                      <td>
                        {/* One action per row: Deactivate and Delete live
                            inside the edit popup (owner 2026-07-26), so a
                            mis-click on a dense list can't disable an insurer. */}
                        <div className="flex justify-end">
                          <button className="btn-secondary btn-sm"
                            onClick={() => navigate(`/insurers/${i.id}/edit`)}>
                            <Icon.Edit size={14} /> Edit
                          </button>
                        </div>
                      </td>
                    )}
                  </LedgerRow>
                ))}
              </Ledger>
            }
          />
        )}
      </div>

    </div>
  );
}
