import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { brokersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  EmptyState, ErrorState, Ledger, LedgerCell, LedgerFigure, LedgerRow,
  ListShell, LTh, MobileCard, SearchInput, TableSkeleton,
} from "../components/ui";
import { RateRulesPanel } from "../components/RateRulesPanel";
import { useAuth } from "../store/auth";
import type { Broker } from "../lib/types";



export default function BrokersPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const canManage = has("manage_brokers");
  const [ratesFor, setRatesFor] = useState<Broker | null>(null);
  const [q, setQ] = useState("");

  const list = useQuery({
    queryKey: ["brokers", q],
    queryFn: async () => (await brokersApi.list({ q: q || undefined })).data,
  });
  return (
    <div>
      <PageHeader
        title="Brokers"
        actions={canManage && (
          <button className="btn-primary" onClick={() => navigate("/brokers/new")}>
            <Icon.Plus size={18} /> Add Broker
          </button>
        )}
      />

      <div>
        <div className="ledger-bar">
          <SearchInput placeholder="Search broker…"
            value={q} onChange={setQ}
            className="min-w-[200px] flex-1 max-w-xs" />
        </div>

        {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
          <TableSkeleton cols={5} />
        ) : (list.data?.length ?? 0) === 0 ? (
          <EmptyState title="No brokers yet"
            hint="Add the brokerages you place policies through." />
        ) : (
          <ListShell
            bare
            cards={list.data!.map((b) => (
              <MobileCard key={b.id} to={`/brokers/${b.id}/edit`}
                title={b.name}
                meta={<>{b.code} · {b.short_code}</>}
                right={
                  <>
                    <span className="block whitespace-nowrap text-metric-sm
                      tabular-nums text-slate-900">
                      {(b.tds_percent / 100).toFixed(2)}%
                    </span>
                    <span className="text-caption uppercase text-slate-500">
                      TDS</span>
                  </>
                }
                footer={b.active ? "Active" : "Inactive"}
              />
            ))}
            table={
              <Ledger
                head={
                  <>
                    <LTh>Broker</LTh>
                    <LTh>Short code</LTh>
                    <LTh align="right">TDS</LTh>
                    <LTh>Status</LTh>
                    {canManage && <LTh />}
                  </>
                }
              >
                {list.data!.map((b) => (
                  <LedgerRow key={b.id}>
                    <LedgerCell to={`/brokers/${b.id}/edit`} title={b.name}
                      sub={b.code} />
                    <td>
                      <span className="font-semibold tracking-wider
                        text-slate-700">{b.short_code}</span>
                    </td>
                    <LedgerFigure value={`${(b.tds_percent / 100).toFixed(2)}%`} />
                    <td>
                      {/* Read-only here: Deactivate lives inside the edit popup
                          (owner 2026-07-26, matching Insurers) so a mis-click on
                          a dense list can't switch a broker off.
                          The tints were inline; `.badge-*` are the tokens. */}
                      <span className={b.active ? "badge-in" : "badge-neutral"}>
                        {b.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    {canManage && (
                      <td>
                        <div className="flex justify-end gap-2">
                          {/* Was a hand-rolled button with its own border,
                              padding and a retired hover colour. `.btn-sm` is
                              the compact variant that already exists. */}
                          <button className="btn-secondary btn-sm"
                            onClick={() => setRatesFor(
                              ratesFor?.id === b.id ? null : b)}>
                            <Icon.Money size={14} /> Rate card
                          </button>
                          <button className="icon-btn" title="Edit"
                            aria-label={`Edit ${b.name}`}
                            onClick={() => navigate(`/brokers/${b.id}/edit`)}>
                            <Icon.Edit size={15} /></button>
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

      {/* Rate card for the selected broker */}
      {ratesFor && (
        <RateRulesPanel broker={ratesFor} canManage={has("manage_rate_cards")}
          onClose={() => setRatesFor(null)} />
      )}

    </div>
  );
}
