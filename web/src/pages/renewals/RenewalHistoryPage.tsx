import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { policiesApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import {
  ErrorState, EmptyState, StatusBadge, TableSkeleton,
} from "../../components/ui";
import { formatDate, formatINR } from "../../lib/format";
import type { Policy } from "../../lib/types";

/** The renewal chain for one policy (/renewals/:id/history). */
export default function RenewalHistoryPage() {
  const { id = "" } = useParams();

  const loaded = useQuery({
    queryKey: ["policy", id],
    retry: false,
    queryFn: async () => (await policiesApi.get(id)).data,
  });
  const policy = loaded.data;
  const missing = isAxiosError(loaded.error)
    && loaded.error.response?.status === 404;

  const chain = useQuery({
    queryKey: ["renewal-chain", id],
    enabled: !!policy,
    queryFn: async () => (await policiesApi.renewalChain(id)).data,
  });
  const rows = useMemo(() => chain.data ?? [], [chain.data]);

  return (
    <RecordPage
      backTo="/renewals"
      backLabel="Back to renewals"
      title={policy ? `Renewal history — ${policy.code}` : "Renewal history"}
      documentTitle="Renewal history"
      loading={loaded.isLoading}
      error={missing ? undefined : loaded.error}
      onRetry={() => loaded.refetch()}
      notFound={missing}
    >
      {chain.isError ? <ErrorState onRetry={() => chain.refetch()} /> : chain.isLoading ? (
        <TableSkeleton cols={5} />
      ) : rows.length <= 1 ? (
        <EmptyState title="No renewals yet"
          hint="This policy has not been renewed. Its future renewals will chain here." />
      ) : (
        <ol className="relative space-y-4 border-l-2 border-line/70 pl-5">
          {rows.map((p: Policy, i: number) => (
            <li key={p.id} className="relative">
              <span className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full ${
                p.id === id ? "bg-ink" : "bg-slate-300"}`} />
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-700">
                  {p.code}
                  {i === rows.length - 1 && (
                    <span className="ml-2 badge bg-money-in/15 text-money-in">Latest</span>
                  )}
                </span>
                <StatusBadge value={p.status} />
              </div>
              <p className="text-xs text-slate-500">
                {formatDate(p.start_date)}
                {" → "}
                {formatDate(p.expiry_date)}
                {" · "}{formatINR(p.premium_amount)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </RecordPage>
  );
}
