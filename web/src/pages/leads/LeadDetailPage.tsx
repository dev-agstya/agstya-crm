import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { leadsApi } from "../../api/endpoints";
import { api, apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { LeadRemindersPanel } from "./LeadRemindersPanel";
import { Icon } from "../../components/Icon";
import { DetailItem, StatusBadge } from "../../components/ui";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatDateTime, titleCase } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { LEAD_TYPE_LABELS } from "../../lib/types";
import type { Lead, LeadStage } from "../../lib/types";

const STAGES: LeadStage[] = ["new", "contacted", "quoted", "converted", "lost"];

// What changing the stage actually does. It used to be a paragraph under the
// Stage card; the picker now lives in the header action row, where there is no
// room for prose, so it is the control's tooltip instead.
const STAGE_HINT =
  "Marking a lead Converted or Lost closes its open reminders. "
  + "The customer or channel partner is created from their own page.";

/**
 * One lead, as a page (owner 2026-08-03 — this replaced a dialog).
 *
 * Everything about the lead is done from here: stage, comments, reminders, edit
 * and delete. The URL is the record, so it can be linked to, refreshed and
 * opened in a second tab — none of which a dialog could do.
 */
export default function LeadDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isInhouse = user?.account_type !== "channel_partner";

  const [comment, setComment] = useState("");

  const lead = useQuery({
    queryKey: ["lead", id],
    queryFn: async () => (await api.get<Lead>(`/api/leads/${id}`)).data,
    retry: false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["lead", id] });
    qc.invalidateQueries({ queryKey: ["leads"] });
  };

  const setStage = useMutation({
    mutationFn: (s: string) => leadsApi.setStage(id, s),
    onSuccess: (res) => {
      toast.success("Stage updated.");
      qc.setQueryData(["lead", id], res.data);
      qc.invalidateQueries({ queryKey: ["leads"] });
      // Converted and Lost close the lead's open reminders server-side.
      qc.invalidateQueries({ queryKey: ["reminders"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const addComment = useMutation({
    mutationFn: () => leadsApi.addComment(id, comment),
    onSuccess: (res) => {
      setComment("");
      qc.setQueryData(["lead", id], res.data);
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: () => leadsApi.remove(id),
    onSuccess: () => {
      toast.success("Lead deleted.");
      qc.invalidateQueries({ queryKey: ["leads"] });
      navigate("/leads");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const d = lead.data;
  const missing = isAxiosError(lead.error) && lead.error.response?.status === 404;

  return (
    <RecordPage
      backTo="/leads"
      backLabel="Back to leads"
      title={d?.name ?? "Lead"}
      subtitle={d ? `Added by ${d.created_by_name || "—"} · ${
        formatDateTime(d.created_at)}` : undefined}
      meta={d && <span className="chip">{d.code}</span>}
      badges={d && (
        <>
          <span className="chip">{LEAD_TYPE_LABELS[d.type] ?? d.type}</span>
          {/* The stage is a control in the header for anyone who can change it
              (below), so the read-only pill would be the same fact twice.
              Someone who cannot edit still needs to SEE it. */}
          {!d.can_edit && <StatusBadge value={d.stage} />}
          {d.origin === "channel_partner" && (
            <span className="chip">Added by a channel partner</span>
          )}
        </>
      )}
      loading={lead.isLoading}
      error={missing ? undefined : lead.error}
      onRetry={() => lead.refetch()}
      notFound={missing}
      actions={d?.can_edit && (
        <>
          {/* Stage is the thing you change most often on a lead, so it sits in
              the header beside Edit rather than in a card of its own down the
              right-hand side (owner 2026-08-04). h-9 to match the buttons —
              `.select` is the 40px form height. */}
          <select className="select h-9 w-[150px]" value={d.stage}
            aria-label="Lead stage" title={STAGE_HINT}
            disabled={setStage.isPending}
            onChange={(e) => setStage.mutate(e.target.value)}>
            {STAGES.map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
          <button className="btn-secondary"
            onClick={() => navigate(`/leads/${id}/edit`)}>
            <Icon.Edit size={15} /> Edit
          </button>
          <button className="btn-danger-soft"
            onClick={async () => {
              if (await confirmDialog({
                title: `Delete ${d.name}?`,
                message: "The lead and its follow-ups are removed. This cannot "
                  + "be undone.",
                confirmLabel: "Delete lead",
                danger: true,
              })) remove.mutate();
            }}>
            <Icon.Trash size={15} /> Delete
          </button>
        </>
      )}
    >
      {d && (
        <div className="grid gap-5 lg:grid-cols-3">
          {/* Left: the record itself */}
          <div className="space-y-5 lg:col-span-2">
            <section className="card">
              <div className="card-head"><h2 className="card-title">Details</h2></div>
              <div className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">
                <DetailItem label="Mobile" value={d.mobile
                  ? `${d.mobile_country_code} ${d.mobile}` : "—"} />
                <DetailItem label="Email" value={d.email || "—"} />
                <DetailItem label="Lead type"
                  value={LEAD_TYPE_LABELS[d.type] ?? d.type} />
                <DetailItem label="Interested in"
                  value={d.interested_in || d.category_key || "—"} />
                <DetailItem className="sm:col-span-2" label="Note"
                  value={d.note || "—"} />
                {d.stage === "lost" && d.lost_reason && (
                  <DetailItem className="sm:col-span-2" label="Lost reason"
                    value={d.lost_reason} />
                )}
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h2 className="card-title">
                  Comments
                  {d.comments.length > 0 && (
                    <span className="chip ml-2 tabular-nums">
                      {d.comments.length}</span>
                  )}
                </h2>
                {d.origin === "channel_partner" && isInhouse && (
                  <span className="text-xs text-slate-500">
                    Your notes here are hidden from the partner
                  </span>
                )}
              </div>
              <div className="space-y-2 px-5 py-4">
                {d.comments.length === 0 && (
                  <p className="rounded-control border border-dashed border-line
                    px-4 py-5 text-center text-sm text-slate-500">
                    No comments yet.
                  </p>
                )}
                {d.comments.map((c, i) => (
                  <div key={i}
                    className="rounded-control border border-line px-3.5 py-3">
                    <div className="flex items-center justify-between gap-2
                      text-xs text-slate-500">
                      <span className="font-medium text-slate-700">
                        {c.author_name}
                        {c.author_role === "channel_partner" && (
                          <span className="chip ml-1.5">Channel partner</span>
                        )}
                      </span>
                      <span>{formatDateTime(c.created_at)}</span>
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                      {c.body}</p>
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <input className="input flex-1" placeholder="Add a comment…"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && comment.trim())
                        addComment.mutate();
                    }} />
                  <button className="btn-primary"
                    disabled={!comment.trim() || addComment.isPending}
                    onClick={() => addComment.mutate()}>
                    Post
                  </button>
                </div>
              </div>
            </section>
          </div>

          {/* Right: reminders, and only reminders (owner 2026-08-04). Stage
              moved into the header, which leaves this column doing one job
              instead of being a stack of unrelated small cards. */}
          <div className="space-y-5">
            <section className="card">
              <LeadRemindersPanel leadId={id} canEdit={d.can_edit}
                onChanged={refresh} />
            </section>
          </div>
        </div>
      )}
    </RecordPage>
  );
}
