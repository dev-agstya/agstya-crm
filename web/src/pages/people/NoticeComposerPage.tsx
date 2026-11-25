import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Mail, Search } from "lucide-react";
import { announcementsApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { ErrorState } from "../../components/shared/ErrorState";
import { FormField, FormSection } from "../../components/shared/FormSection";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { formatDate, fromDateInput } from "../../lib/format";
import type { AssignableManager } from "../../lib/types";
import { AUDIENCES, CATEGORIES } from "./NoticesPage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export default function NoticeComposerPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [f, setF] = useState({
    title: "",
    body: "",
    category: "notice",
    valid_until: "",
    audience: "all",
    manager_id: "",
    joined_within_days: "30",
    send_email: true,
    send_whatsapp: false,
  });
  const set = (k: keyof typeof f, v: string | boolean) =>
    setF((s) => ({ ...s, [k]: v }));

  const [selected, setSelected] = useState<string[]>([]);
  const [partnerQuery, setPartnerQuery] = useState("");

  const managers = (useQuery({
    queryKey: ["assignable-managers"],
    queryFn: async () => (await usersApi.assignableManagers()).data,
  }).data ?? []) as AssignableManager[];

  const partners = useQuery({
    queryKey: ["attributable-partners"],
    queryFn: async () => (await usersApi.attributablePartners()).data,
  });

  const payload = () => ({
    title: f.title.trim(),
    body: f.body.trim(),
    category: f.category,
    valid_until: f.valid_until ? fromDateInput(f.valid_until) : null,
    audience: f.audience,
    manager_id: f.audience === "manager" ? f.manager_id : null,
    selected_partner_ids: f.audience === "selected" ? selected : [],
    joined_within_days:
      f.audience === "new_partners"
        ? Number(f.joined_within_days) || 30
        : null,
    send_email: f.send_email,
    send_whatsapp: f.send_whatsapp,
  });

  const preview = useQuery({
    queryKey: [
      "announcement-preview",
      f.audience,
      f.manager_id,
      f.joined_within_days,
      selected,
    ],
    queryFn: async () => (await announcementsApi.preview(payload())).data,
    enabled: f.audience !== "manager" || !!f.manager_id,
    retry: false,
  });

  const send = useMutation({
    mutationFn: () => announcementsApi.send(payload()),
    onSuccess: (r) => {
      toast.success(`Sent to ${r.data.recipients} channel partner(s).`);
      qc.invalidateQueries({ queryKey: ["announcements"] });
      navigate("/people/notices");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const valid =
    f.title.trim().length >= 3 &&
    f.body.trim().length > 0 &&
    (f.audience !== "manager" || !!f.manager_id) &&
    (f.audience !== "selected" || selected.length > 0);

  const visiblePartners = (partners.data ?? []).filter((p) =>
    p.full_name.toLowerCase().includes(partnerQuery.trim().toLowerCase())
  );

  const categoryLabel =
    CATEGORIES.find((c) => c.value === f.category)?.label ?? "";

  return (
    <RecordPage
      backTo="/people/notices"
      backLabel="Back to notices"
      title="New notice"
      subtitle="This reaches your channel partners in their portal, and by email if switched on."
      actions={
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigate("/people/notices")}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!valid || send.isPending || !preview.data?.count}
            onClick={() => send.mutate()}
          >
            {send.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <Mail className="mr-1.5 h-3.5 w-3.5" /> Send to{" "}
                {preview.data?.count ?? 0}
              </>
            )}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <FormSection title="Message">
            <div className="space-y-3">
              <FormField label="Title" required>
                <Input
                  value={f.title}
                  autoFocus
                  placeholder="e.g. Motor reward raised for August"
                  onChange={(e) => set("title", e.target.value)}
                />
              </FormField>
              <FormField
                label="Message"
                required
                hint="Plain text. Line breaks are kept; formatting is not."
              >
                <Textarea
                  className="min-h-[150px]"
                  value={f.body}
                  onChange={(e) => set("body", e.target.value)}
                />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Kind">
                  <Select
                    value={f.category}
                    onValueChange={(v) => set("category", v)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField
                  label="Valid until"
                  hint="Optional — shown on the notice."
                >
                  <DateInput
                    value={f.valid_until}
                    onChange={(v) => set("valid_until", v)}
                  />
                </FormField>
              </div>
            </div>
          </FormSection>

          <FormSection title="Who gets it">
            <div className="space-y-3">
              <FormField label="Audience" required>
                <Select
                  value={f.audience}
                  onValueChange={(v) => set("audience", v)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIENCES.map((a) => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              {f.audience === "manager" && (
                <FormField label="Relationship manager" required>
                  <Select
                    value={f.manager_id}
                    onValueChange={(v) => set("manager_id", v)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="— Select —" />
                    </SelectTrigger>
                    <SelectContent>
                      {managers.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.full_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              )}

              {f.audience === "new_partners" && (
                <FormField label="Joined within (days)">
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    value={f.joined_within_days}
                    onChange={(e) =>
                      set("joined_within_days", e.target.value)
                    }
                  />
                </FormField>
              )}

              {f.audience === "selected" && (
                <FormField
                  label="Partners"
                  required
                  hint={`${selected.length} selected`}
                >
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={partnerQuery}
                      onChange={(e) => setPartnerQuery(e.target.value)}
                      placeholder="Find a partner…"
                      className="pl-8"
                    />
                  </div>
                  <div className="max-h-60 overflow-y-auto rounded-md border border-border">
                    {visiblePartners.length === 0 ? (
                      <p className="px-3 py-4 text-xs text-muted-foreground">
                        Nobody matches that.
                      </p>
                    ) : (
                      visiblePartners.map((p) => {
                        const checked = selected.includes(p.id);
                        return (
                          <label
                            key={p.id}
                            className="flex cursor-pointer items-center gap-2.5 border-b border-border/60 px-3 py-2 text-xs text-foreground last:border-0 hover:bg-muted/40"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(c) =>
                                setSelected((s) =>
                                  c
                                    ? [...s, p.id]
                                    : s.filter((x) => x !== p.id)
                                )
                              }
                            />
                            <span>{p.full_name}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </FormField>
              )}

              <div className="flex flex-wrap gap-6 border-t border-border pt-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                  <Switch
                    checked={f.send_email}
                    onCheckedChange={(v) => set("send_email", v)}
                  />
                  Also email it
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                  <Switch
                    checked={f.send_whatsapp}
                    onCheckedChange={(v) => set("send_whatsapp", v)}
                  />
                  Also WhatsApp
                </label>
              </div>
            </div>
          </FormSection>
        </div>

        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <Card className="overflow-hidden">
            <div className="border-b border-border bg-muted/40 px-4 py-3">
              {preview.isError ? (
                <ErrorState onRetry={() => preview.refetch()} />
              ) : preview.isLoading ? (
                <p className="text-xs text-muted-foreground">
                  Working out who this reaches…
                </p>
              ) : preview.data ? (
                <>
                  <p className="text-2xl font-bold tabular-nums text-foreground">
                    {preview.data.count}
                  </p>
                  <p className="text-xs font-medium text-foreground">
                    channel partner{preview.data.count === 1 ? "" : "s"} will
                    get this
                  </p>
                  {preview.data.names.length > 0 && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      {preview.data.names.join(", ")}
                      {preview.data.truncated ? ", …" : ""}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Choose an audience to see who this reaches.
                </p>
              )}
            </div>

            <div className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Preview
              </p>
              <div className="mt-2 rounded-md border border-border bg-background p-3.5">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {categoryLabel}
                  </Badge>
                  {f.valid_until && (
                    <span className="text-[11px] text-muted-foreground">
                      until {formatDate(fromDateInput(f.valid_until))}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-sm font-semibold text-foreground">
                  {f.title.trim() || "Your title appears here"}
                </p>
                <div className="mt-1 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                  {f.body.trim() ? (
                    f.body
                      .trim()
                      .split(/\n{2,}/)
                      .map((para, i) => (
                        <p key={i} className="whitespace-pre-line">
                          {para}
                        </p>
                      ))
                  ) : (
                    <p>
                      Your message appears here, exactly as the partner reads
                      it.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </Card>

          <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5" /> This cannot be unsent
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-900/80">
              Withdrawing it later removes it from the portal, but emails and
              WhatsApp messages that have already gone out cannot be recalled.
            </p>
          </div>
        </div>
      </div>
    </RecordPage>
  );
}
