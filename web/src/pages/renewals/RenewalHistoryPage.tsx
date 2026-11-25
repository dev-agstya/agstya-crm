import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { policiesApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { TableSkeleton } from "../../components/shared/LoadingSkeleton";
import { StatusBadge } from "../../components/ui";
import { formatDate, formatINR } from "../../lib/format";
import type { Policy } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export default function RenewalHistoryPage() {
  const { id = "" } = useParams();

  const loaded = useQuery({
    queryKey: ["policy", id],
    retry: false,
    queryFn: async () => (await policiesApi.get(id)).data,
  });
  const policy = loaded.data;
  const missing =
    isAxiosError(loaded.error) && loaded.error.response?.status === 404;

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
      {chain.isError ? (
        <ErrorState onRetry={() => chain.refetch()} />
      ) : chain.isLoading ? (
        <TableSkeleton cols={5} />
      ) : rows.length <= 1 ? (
        <EmptyState
          title="No renewals yet"
          description="This policy has not been renewed. Its future renewals will chain here."
        />
      ) : (
        <Card className="p-5">
          <ol className="relative space-y-4 border-l-2 border-border pl-5">
            {rows.map((p: Policy, i: number) => (
              <li key={p.id} className="relative">
                <span
                  className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-background ${
                    p.id === id ? "bg-primary" : "bg-muted-foreground/40"
                  }`}
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-foreground">
                      {p.code}
                    </span>
                    {i === rows.length - 1 && (
                      <Badge
                        variant="outline"
                        className="h-5 border-emerald-200 bg-emerald-50 px-1.5 text-[10px] text-emerald-700"
                      >
                        Latest
                      </Badge>
                    )}
                  </div>
                  <StatusBadge value={p.status} />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatDate(p.start_date)} {" → "} {formatDate(p.expiry_date)}
                  {" · "}
                  <span className="font-medium text-foreground">
                    {formatINR(p.premium_amount)}
                  </span>
                </p>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </RecordPage>
  );
}
