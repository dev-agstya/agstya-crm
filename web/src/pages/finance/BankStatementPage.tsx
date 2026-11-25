import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { banksApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { TableSkeleton } from "../../components/shared/LoadingSkeleton";
import { Pagination } from "../../components/ui";
import { formatDate, formatINR } from "../../lib/format";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
        <Card className="overflow-hidden">
          <div className="grid grid-cols-3 divide-x divide-border border-b border-border bg-muted/30">
            <div className="px-4 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Opening
              </p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                {formatINR(account.opening_balance_paise)}
              </p>
            </div>
            <div className="px-4 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Balance now
              </p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                {formatINR(account.balance_paise)}
              </p>
            </div>
            <div className="px-4 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Since
              </p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">
                {formatDate(account.opening_as_of)}
              </p>
            </div>
          </div>

          {q.isError ? (
            <ErrorState onRetry={() => q.refetch()} />
          ) : q.isLoading ? (
            <TableSkeleton cols={4} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="Nothing has moved through this account yet"
              description="Record a payment against it and it will show up here."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableHead className="h-9 text-xs">Date</TableHead>
                      <TableHead className="h-9 text-xs">Details</TableHead>
                      <TableHead className="h-9 text-right text-xs">
                        In
                      </TableHead>
                      <TableHead className="h-9 text-right text-xs">
                        Out
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((t) => {
                      const delta = t.bank_delta_paise ?? 0;
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="whitespace-nowrap py-2 text-xs text-muted-foreground">
                            {formatDate(t.occurred_at)}
                          </TableCell>
                          <TableCell className="py-2">
                            <p className="text-[13px] text-foreground">
                              {t.note || t.txn_type.replace(/_/g, " ")}
                            </p>
                            {t.reference && (
                              <p className="text-xs text-muted-foreground">
                                {t.reference}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="py-2 text-right text-[13px] tabular-nums text-emerald-700">
                            {delta > 0 ? formatINR(delta) : ""}
                          </TableCell>
                          <TableCell className="py-2 text-right text-[13px] tabular-nums text-destructive">
                            {delta < 0 ? formatINR(-delta) : ""}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="border-t border-border px-4">
                <Pagination
                  page={page}
                  pageSize={20}
                  total={q.data?.total ?? 0}
                  onChange={setPage}
                />
              </div>
            </>
          )}
        </Card>
      )}
    </RecordPage>
  );
}
