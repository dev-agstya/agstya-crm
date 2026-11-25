import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Pencil, Trash2 } from "lucide-react";
import { leadsApi } from "../../api/endpoints";
import { api, apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { LeadRemindersPanel } from "./LeadRemindersPanel";
import { StatusBadge } from "../../components/ui";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatDateTime, titleCase } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { LEAD_TYPE_LABELS } from "../../lib/types";
import type { Lead, LeadStage } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STAGES: LeadStage[] = ["new", "contacted", "quoted", "converted", "lost"];

const STAGE_HINT =
  "Marking a lead Converted or Lost closes its open reminders. The customer or channel partner is created from their own page.";

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
  const missing =
    isAxiosError(lead.error) && lead.error.response?.status === 404;

  return (
    <RecordPage
      backTo="/leads"
      backLabel="Back to leads"
      title={d?.name ?? "Lead"}
      subtitle={
        d
          ? `Added by ${d.created_by_name || "—"} · ${formatDateTime(
              d.created_at
            )}`
          : undefined
      }
      meta={
        d && (
          <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[11px]">
            {d.code}
          </Badge>
        )
      }
      badges={
        d && (
          <>
            <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
              {LEAD_TYPE_LABELS[d.type] ?? d.type}
            </Badge>
            {!d.can_edit && <StatusBadge value={d.stage} />}
            {d.origin === "channel_partner" && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
                Added by a channel partner
              </Badge>
            )}
          </>
        )
      }
      loading={lead.isLoading}
      error={missing ? undefined : lead.error}
      onRetry={() => lead.refetch()}
      notFound={missing}
      actions={
        d?.can_edit && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              value={d.stage}
              disabled={setStage.isPending}
              onValueChange={(v) => setStage.mutate(v)}
            >
              <SelectTrigger
                className="h-8 w-[140px] text-xs"
                aria-label="Lead stage"
                title={STAGE_HINT}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAGES.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => navigate(`/leads/${id}/edit`)}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 border-destructive/30 text-xs text-destructive hover:bg-destructive/10"
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: `Delete ${d.name}?`,
                    message:
                      "The lead and its follow-ups are removed. This cannot be undone.",
                    confirmLabel: "Delete lead",
                    danger: true,
                  })
                )
                  remove.mutate();
              }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        )
      }
    >
      {d && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card className="overflow-hidden">
              <div className="border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold text-foreground">
                  Details
                </h2>
              </div>
              <div className="grid gap-x-6 gap-y-3 px-4 py-3.5 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Mobile
                  </p>
                  <p className="mt-0.5 text-[13px] text-foreground">
                    {d.mobile ? `${d.mobile_country_code} ${d.mobile}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Email
                  </p>
                  <p className="mt-0.5 text-[13px] text-foreground">
                    {d.email || "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Lead type
                  </p>
                  <p className="mt-0.5 text-[13px] text-foreground">
                    {LEAD_TYPE_LABELS[d.type] ?? d.type}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Interested in
                  </p>
                  <p className="mt-0.5 text-[13px] text-foreground">
                    {d.interested_in || d.category_key || "—"}
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Note
                  </p>
                  <p className="mt-0.5 text-[13px] text-foreground">
                    {d.note || "—"}
                  </p>
                </div>
                {d.stage === "lost" && d.lost_reason && (
                  <div className="sm:col-span-2">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Lost reason
                    </p>
                    <p className="mt-0.5 text-[13px] text-destructive">
                      {d.lost_reason}
                    </p>
                  </div>
                )}
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">
                    Comments
                  </h2>
                  {d.comments.length > 0 && (
                    <Badge
                      variant="secondary"
                      className="h-5 px-1.5 text-[11px] tabular-nums"
                    >
                      {d.comments.length}
                    </Badge>
                  )}
                </div>
                {d.origin === "channel_partner" && isInhouse && (
                  <span className="text-[11px] text-muted-foreground">
                    Your notes here are hidden from the partner
                  </span>
                )}
              </div>
              <div className="space-y-2.5 p-4">
                {d.comments.length === 0 && (
                  <p className="rounded-md border border-dashed border-border px-4 py-4 text-center text-xs text-muted-foreground">
                    No comments yet.
                  </p>
                )}
                {d.comments.map((c, i) => (
                  <div
                    key={i}
                    className="rounded-md border border-border px-3.5 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {c.author_name}
                        {c.author_role === "channel_partner" && (
                          <Badge
                            variant="secondary"
                            className="ml-1.5 h-4 px-1.5 text-[10px]"
                          >
                            Channel partner
                          </Badge>
                        )}
                      </span>
                      <span>{formatDateTime(c.created_at)}</span>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-foreground">
                      {c.body}
                    </p>
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <Input
                    className="flex-1"
                    placeholder="Add a comment…"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && comment.trim())
                        addComment.mutate();
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-9"
                    disabled={!comment.trim() || addComment.isPending}
                    onClick={() => addComment.mutate()}
                  >
                    Post
                  </Button>
                </div>
              </div>
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="overflow-hidden">
              <LeadRemindersPanel
                leadId={id}
                canEdit={d.can_edit}
                onChanged={refresh}
              />
            </Card>
          </div>
        </div>
      )}
    </RecordPage>
  );
}
