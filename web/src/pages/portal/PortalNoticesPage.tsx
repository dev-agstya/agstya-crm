import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { portalApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { CardGridSkeleton } from "../../components/shared/LoadingSkeleton";
import { formatDate } from "../../lib/format";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

const CATEGORY_LABELS: Record<string, string> = {
  offer: "Offer",
  rate_change: "Rate change",
  notice: "Notice",
  training: "Training",
};

const CATEGORY_TONES: Record<string, string> = {
  offer: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rate_change: "bg-amber-50 text-amber-800 border-amber-200",
  notice: "bg-muted text-foreground border-border",
  training: "bg-muted text-foreground border-border",
};

export default function PortalNoticesPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["portal", "notices"],
    queryFn: async () => (await portalApi.notices()).data,
  });
  const rows = list.data ?? [];

  const markRead = useMutation({
    mutationFn: (id: string) => portalApi.markNoticeRead(id),
  });

  useEffect(() => {
    for (const n of rows) {
      if (!n.read_at) markRead.mutate(n.id);
    }
    if (rows.some((n) => !n.read_at)) {
      qc.invalidateQueries({ queryKey: ["portal", "summary"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

  if (list.isError) return <ErrorState onRetry={() => list.refetch()} />;
  if (list.isLoading) return <CardGridSkeleton count={3} />;

  return (
    <div className="space-y-3">
      <PageHeader title="Notices" subtitle="Messages from Agastya." />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bell className="h-5 w-5" />}
            title="Nothing yet"
            description="Offers, rate changes and announcements from Agastya will appear here."
          />
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((n) => (
            <li key={n.id}>
              <Card className="px-4 py-3.5 sm:px-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`h-5 px-2 text-[11px] ${
                      CATEGORY_TONES[n.category] ?? "bg-muted text-foreground"
                    }`}
                  >
                    {CATEGORY_LABELS[n.category] ?? n.category}
                  </Badge>
                  {!n.read_at && (
                    <Badge
                      variant="outline"
                      className="h-5 border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800"
                    >
                      new
                    </Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDate(n.created_at)}
                  </span>
                </div>
                <h2 className="mt-2 text-sm font-semibold text-foreground">
                  {n.title}
                </h2>
                <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">
                  {n.body}
                </p>
                {n.valid_until && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Valid until {formatDate(n.valid_until)}.
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
