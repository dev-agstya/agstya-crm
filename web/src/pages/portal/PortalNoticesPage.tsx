import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { portalApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import { EmptyState, ErrorState, PageLoader } from "../../components/ui";
import { formatDate } from "../../lib/format";

/*
  Notices from Agastya — offers, rate changes, announcements.

  Opening the page marks everything on it as read. A per-notice "mark as read"
  button would be a chore nobody performs, and then the read receipts on the
  owner's side stop meaning anything — which is the whole reason they exist.
*/

const CATEGORY_LABELS: Record<string, string> = {
  offer: "Offer",
  rate_change: "Rate change",
  notice: "Notice",
  training: "Training",
};

const CATEGORY_TONES: Record<string, string> = {
  offer: "bg-money-in/10 text-money-in",
  rate_change: "bg-due/10 text-due",
  notice: "bg-slate-100 text-slate-700",
  training: "bg-slate-100 text-slate-700",
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

  // Mark the unread ones read once, on arrival. Fire-and-forget: a failed
  // receipt must not put an error toast in front of somebody who is just
  // reading their messages.
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
  if (list.isLoading) return <PageLoader />;

  return (
    <div>
      <PageHeader title="Notices"
        subtitle="Messages from Agastya." />

      {rows.length === 0 ? (
        <div className="card">
          <EmptyState
              icon={<Icon.Bell size={20} />}
              title="Nothing yet"
            hint="Offers, rate changes and announcements from Agastya will
              appear here." />
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((n) => (
            <li key={n.id} className="card px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${CATEGORY_TONES[n.category]
                  ?? "bg-slate-100 text-slate-700"}`}>
                  {CATEGORY_LABELS[n.category] ?? n.category}
                </span>
                {!n.read_at && (
                  <span className="badge bg-due/10 text-due">new</span>
                )}
                <span className="ml-auto text-xs text-slate-500">
                  {formatDate(n.created_at)}
                </span>
              </div>
              <h2 className="mt-2 text-section text-slate-900">
                {n.title}</h2>
              {/* Plain text with line breaks — never rendered as markup. */}
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed
                text-slate-700">{n.body}</p>
              {n.valid_until && (
                <p className="mt-2 text-xs text-slate-500">
                  Valid until {formatDate(n.valid_until)}.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
