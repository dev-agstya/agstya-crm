import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { announcementsApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import { ErrorState, Field, SearchInput, Spinner, ToggleField } from "../../components/ui";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { formatDate, fromDateInput } from "../../lib/format";
import type { AssignableManager } from "../../lib/types";
import { AUDIENCES, CATEGORIES } from "./NoticesPage";

/*
  Composing a broadcast to channel partners.

  A FULL PAGE, not a modal (owner 2026-08-05). A notice cannot be unsent, and
  the modal version put the one irreversible fact — how many people this
  reaches — at the bottom of a scrolling dialog, under the fold, above the Send
  button. Here the audience and a live preview of what the partner actually
  receives sit beside the form the whole time.

  The preview is not decoration. Staff write these in a hurry, and the single
  most common broadcast mistake is sending something whose meaning depends on
  formatting that plain text does not have.
*/

export default function NoticeComposerPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [f, setF] = useState({
    title: "", body: "", category: "notice", valid_until: "",
    audience: "all", manager_id: "", joined_within_days: "30",
    send_email: true, send_whatsapp: false,
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
    joined_within_days: f.audience === "new_partners"
      ? Number(f.joined_within_days) || 30 : null,
    send_email: f.send_email,
    send_whatsapp: f.send_whatsapp,
  });

  // The audience count, live. A broadcast cannot be unsent, so the number is on
  // screen BEFORE the button is pressed — and stays there while you type.
  const preview = useQuery({
    queryKey: ["announcement-preview", f.audience, f.manager_id,
      f.joined_within_days, selected],
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

  const valid = f.title.trim().length >= 3 && f.body.trim().length > 0
    && (f.audience !== "manager" || !!f.manager_id)
    && (f.audience !== "selected" || selected.length > 0);

  const visiblePartners = (partners.data ?? []).filter((p) =>
    p.full_name.toLowerCase().includes(partnerQuery.trim().toLowerCase()));

  const categoryLabel = CATEGORIES.find(
    (c) => c.value === f.category)?.label ?? "";

  return (
    <div>
      <PageHeader
        backTo="/people/notices"
        backLabel="Back to notices"
        title="New notice"
        subtitle="This reaches your channel partners in their portal, and by
          email if you leave that switched on."
        actions={
          <>
            <button className="btn-secondary"
              onClick={() => navigate("/people/notices")}>Cancel</button>
            <button className="btn-primary"
              disabled={!valid || send.isPending || !preview.data?.count}
              onClick={() => send.mutate()}>
              {send.isPending ? <Spinner className="h-4 w-4" />
                : <><Icon.Mail size={16} /> Send to {preview.data?.count ?? 0}</>}
            </button>
          </>
        } />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ------------------------------------------------------- the form */}
        <div className="space-y-4">
          <section className="card">
            <div className="card-head"><h2 className="card-title">Message</h2></div>
            <div className="card-body space-y-4">
              <Field label="Title" required>
                <input className="input" value={f.title} autoFocus
                  placeholder="e.g. Motor reward raised for August"
                  onChange={(e) => set("title", e.target.value)} />
              </Field>
              <Field label="Message" required
                hint="Plain text. Line breaks are kept; formatting is not.">
                <textarea className="input min-h-[160px]" value={f.body}
                  onChange={(e) => set("body", e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Kind">
                  <select className="select" value={f.category}
                    onChange={(e) => set("category", e.target.value)}>
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Valid until" hint="Optional — shown on the notice.">
                  <DateInput value={f.valid_until}
                    onChange={(v) => set("valid_until", v)} />
                </Field>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Who gets it</h2>
            </div>
            <div className="card-body space-y-4">
              <Field label="Audience" required>
                <select className="select" value={f.audience}
                  onChange={(e) => set("audience", e.target.value)}>
                  {AUDIENCES.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
              </Field>

              {f.audience === "manager" && (
                <Field label="Relationship manager" required>
                  <select className="select" value={f.manager_id}
                    onChange={(e) => set("manager_id", e.target.value)}>
                    <option value="">— Select —</option>
                    {managers.map((m) => (
                      <option key={m.id} value={m.id}>{m.full_name}</option>
                    ))}
                  </select>
                </Field>
              )}

              {f.audience === "new_partners" && (
                <Field label="Joined within (days)">
                  <input type="number" min={1} max={3650} className="input"
                    value={f.joined_within_days}
                    onChange={(e) =>
                      set("joined_within_days", e.target.value)} />
                </Field>
              )}

              {f.audience === "selected" && (
                <Field label="Partners" required
                  hint={`${selected.length} selected`}>
                  <SearchInput value={partnerQuery} onChange={setPartnerQuery}
                    placeholder="Find a partner…" className="mb-2" />
                  <div className="max-h-64 overflow-y-auto scrollbar-light
                    rounded-control border border-line">
                    {visiblePartners.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-slate-500">
                        Nobody matches that.</p>
                    ) : visiblePartners.map((p) => (
                      <label key={p.id}
                        className="flex cursor-pointer items-center gap-2.5
                          border-b border-line-soft px-3 py-2.5 text-sm
                          text-slate-700 last:border-0 hover:bg-slate-50">
                        <input type="checkbox" checked={selected.includes(p.id)}
                          onChange={(e) => setSelected((s) => e.target.checked
                            ? [...s, p.id] : s.filter((x) => x !== p.id))} />
                        {p.full_name}
                      </label>
                    ))}
                  </div>
                </Field>
              )}

              <div className="flex flex-wrap gap-5 border-t border-line-soft
                pt-4">
                <ToggleField checked={f.send_email} label="Also email it"
                  onChange={(v) => set("send_email", v)} />
                <ToggleField checked={f.send_whatsapp} label="Also WhatsApp"
                  onChange={(v) => set("send_whatsapp", v)} />
              </div>
            </div>
          </section>
        </div>

        {/* ------------------------------------------- audience + preview */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <section className="card overflow-hidden">
            <div className="border-b border-line bg-slate-50/70 px-5 py-4">
              {preview.isError ? <ErrorState onRetry={() => preview.refetch()} /> : preview.isLoading ? (
                <p className="text-sm text-slate-500">
                  Working out who this reaches…</p>
              ) : preview.data ? (
                <>
                  <p className="text-metric-sm tabular-nums text-slate-900">
                    {preview.data.count}
                  </p>
                  <p className="text-sm font-medium text-slate-700">
                    channel partner{preview.data.count === 1 ? "" : "s"} will
                    get this
                  </p>
                  {preview.data.names.length > 0 && (
                    <p className="mt-2 text-xs leading-relaxed text-slate-500">
                      {preview.data.names.join(", ")}
                      {preview.data.truncated ? ", …" : ""}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  Choose an audience to see who this reaches.</p>
              )}
            </div>

            {/* What they will actually see. */}
            <div className="card-body">
              <p className="text-caption uppercase text-slate-500">Preview</p>
              <div className="mt-2.5 rounded-control border border-line
                bg-white p-4">
                <div className="flex items-center gap-2">
                  <span className="chip">{categoryLabel}</span>
                  {f.valid_until && (
                    <span className="text-xs text-slate-500">
                      until {formatDate(fromDateInput(f.valid_until))}
                    </span>
                  )}
                </div>
                <p className="mt-2 font-semibold text-slate-900">
                  {f.title.trim() || "Your title appears here"}
                </p>
                <div className="mt-1.5 space-y-2 text-sm leading-relaxed
                  text-slate-600">
                  {f.body.trim()
                    ? f.body.trim().split(/\n{2,}/).map((para, i) => (
                        <p key={i} className="whitespace-pre-line">{para}</p>
                      ))
                    : <p className="text-slate-500">
                        Your message appears here, exactly as the partner reads
                        it.</p>}
                </div>
              </div>
            </div>
          </section>

          <div className="rounded-card border border-due/25 bg-due/[0.05]
            px-4 py-3.5">
            <p className="flex items-center gap-1.5 text-sm font-semibold
              text-due">
              <Icon.Alert size={14} /> This cannot be unsent
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Withdrawing it later removes it from the portal, but emails and
              WhatsApp messages that have already gone out cannot be recalled.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
