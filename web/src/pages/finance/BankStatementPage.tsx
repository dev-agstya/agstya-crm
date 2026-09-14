import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { banksApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { ErrorState, EmptyState, Pagination, TableSkeleton } from "../../components/ui";
import { formatDate, formatINR } from "../../lib/format";

/** One account's statement (/finance/banks/:id/statement). */
export default function BankStatementPage() {
  const { id = "" } = useParams();
  const [page, setPage] = useState(1);

  const list = useQuery({
    queryKey: ["banks", true],
    queryFn: async () =>
      (await banksApi.list({ include_inactive: true })).data,
  });
  const account = list.data?.items.find((a) => a.id === id);
  const q = useQuery({
    queryKey: ["banks", "statement", id, page],
    enabled: !!account,
    queryFn: async () =>
      (await banksApi.statement(id, { page, page_size: 20 })).data,
  });
  const rows = q.data?.items ?? [];

  return (
    <RecordPage
      backTo="/finance/banks"
      backLabel="Back to bank & cash"
      title={account ? `${account.name} — statement` : "Statement"}
      documentTitle={account ? `${account.name} statement` : "Statement"}
      loading={list.isLoading}
      notFound={!list.isLoading && !account}
    >
      {account && (
      <div className="card space-y-4 px-5 py-5">
        <div className="flex flex-wrap gap-6 rounded-control bg-slate-50 p-3 text-sm">
          <div>
            <p className="text-xs text-slate-500">Opening</p>
            <p className="font-medium tabular-nums">
              {formatINR(account.opening_balance_paise)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Balance now</p>
            <p className="font-medium tabular-nums">
              {formatINR(account.balance_paise)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Since</p>
            <p className="font-medium">{formatDate(account.opening_as_of)}</p>
          </div>
        </div>

        {q.isError ? <ErrorState onRetry={() => q.refetch()} /> : q.isLoading ? <TableSkeleton cols={4} /> : rows.length === 0 ? (
          <EmptyState title="Nothing has moved through this account yet"
            hint="Record a payment against it and it will show up here." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm table-sticky">
                <thead>
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Details</th>
                    <th className="px-3 py-2 text-right">In</th>
                    <th className="px-3 py-2 text-right">Out</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const delta = t.bank_delta_paise ?? 0;
                    return (
                      <tr key={t.id} className="border-t border-line-soft">
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                          {formatDate(t.occurred_at)}</td>
                        <td className="px-3 py-2">
                          <p className="text-slate-700">
                            {t.note || t.txn_type.replace(/_/g, " ")}</p>
                          {t.reference && (
                            <p className="text-xs text-slate-500">
                              {t.reference}</p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums
                          text-money-in">
                          {delta > 0 ? formatINR(delta) : ""}</td>
                        <td className="px-3 py-2 text-right tabular-nums
                          text-money-out">
                          {delta < 0 ? formatINR(-delta) : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={20}
              total={q.data?.total ?? 0} onChange={setPage} />
          </>
        )}
      </div>
      )}
    </RecordPage>
  );
}
