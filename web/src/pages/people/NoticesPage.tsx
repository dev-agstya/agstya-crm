import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { announcementsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import {
  ErrorState, EmptyState, Meter, PersonCell, TableSkeleton,
} from "../../components/ui";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatDate } from "../../lib/format";
import { useAuth } from "../../store/auth";

/*
  Broadcasting to channel partners.

  A notice CANNOT BE UNSENT. That single fact shapes the whole feature: the
  composer is a full PAGE with a live preview of what the partner will actually
  receive (pages/people/NoticeComposerPage), not a scrollable modal with the
  audience count buried under the fold — and "withdraw" is honest about only
  hiding it from the portal.

  The audience is resolved and FROZEN at send time (server side). A notice sent
  to "everyone under Rahul" in August still shows the same people in November
  after two of them moved — otherwise the read receipts stop meaning anything.

  The read rate used to be the text "12 / 30". That is a progress bar spelled
  out in characters, so it is a progress bar now.
*/

export const CATEGORIES = [
  { value: "offer", label: "Offer" },
  { value: "rate_change", label: "Rate change" },
  { value: "notice", label: "Notice" },
  { value: "training", label: "Training" },
];

export const AUDIENCES = [
  { value: "all", label: "Every channel partner" },
  { value: "manager", label: "Everyone under one relationship manager" },
  { value: "new_partners", label: "Partners who joined recently" },
  { value: "selected", label: "Specific partners" },
];

export default function NoticesPage() {
  const { has } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canSend = has("manage_announcements");

  const list = useQuery({
    queryKey: ["announcements"],
    queryFn: async () => (await announcementsApi.list({ page_size: 50 })).data,
  });
  const rows = list.data?.items ?? [];

  const withdraw = useMutation({
    mutationFn: (id: string) => announcementsApi.withdraw(id),
    onSuccess: (r) => {
      toast.success(r.data.detail);
      qc.invalidateQueries({ queryKey: ["announcements"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const compose = (
    <button className="btn-primary"
      onClick={() => navigate("/people/notices/new")}>
      <Icon.Plus size={16} /> New notice
    </button>
  );

  return (
    <div>
      <PageHeader
        eyebrow="Workplace"
        title="Notices to Channel Partners"
        subtitle="Offers, rate changes and announcements. Once sent, a notice
          cannot be recalled."
        actions={canSend ? compose : undefined} />

      <div className="card overflow-hidden">
        {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
          <TableSkeleton cols={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Icon.Bell size={20} />}
            title="Nothing sent yet"
            hint="Tell your channel partners about a new offer, a rate change
              or anything else they should know."
            action={canSend ? compose : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-sticky">
              <thead>
                <tr>
                  <th>Notice</th>
                  <th>Audience</th>
                  <th>Sent</th>
                  <th className="w-40">Read</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const category = CATEGORIES.find(
                    (c) => c.value === a.category)?.label ?? a.category;
                  return (
                    <tr key={a.id} className={a.withdrawn_at ? "opacity-55" : ""}>
                      <td>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-900">
                            {a.title}</span>
                          {a.withdrawn_at && (
                            <span className="badge bg-slate-100 text-slate-600">
                              withdrawn</span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className="chip">{category}</span>
                          <span className="text-xs text-slate-500">
                            Portal{a.send_email ? " · email" : ""}
                            {a.send_whatsapp ? " · WhatsApp" : ""}
                          </span>
                        </div>
                      </td>

                      <td>
                        <p className="text-slate-700">
                          {AUDIENCES.find((x) => x.value === a.audience)?.label
                            ?? a.audience}</p>
                        {a.manager_name && (
                          <p className="text-xs text-slate-500">
                            {a.manager_name}</p>
                        )}
                      </td>

                      <td className="whitespace-nowrap">
                        <p className="text-slate-700">
                          {formatDate(a.created_at)}</p>
                        {a.created_by_name && (
                          <PersonCell name={a.created_by_name} size="xs" />
                        )}
                      </td>

                      {/* Drawn, not written. "12 / 30" is a bar in text form. */}
                      <td>
                        <div className="flex items-baseline justify-between
                          gap-2">
                          <span className="text-sm font-semibold tabular-nums
                            text-slate-900">{a.read_count}</span>
                          <span className="text-xs tabular-nums text-slate-500">
                            of {a.recipients}</span>
                        </div>
                        <Meter value={a.read_count} total={a.recipients}
                          className="mt-1.5" />
                      </td>

                      <td className="num">
                        {canSend && !a.withdrawn_at && (
                          <button className="btn-ghost btn-sm"
                            onClick={async () => {
                              if (await confirmDialog({
                                title: "Withdraw this notice?",
                                message: "It disappears from the partner "
                                  + "portal. Emails and WhatsApp messages "
                                  + "already sent CANNOT be recalled.",
                                confirmLabel: "Withdraw",
                              })) withdraw.mutate(a.id);
                            }}>Withdraw</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
