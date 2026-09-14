import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { insurersApi, quotesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { Icon } from "../../components/Icon";
import { Field, Spinner } from "../../components/ui";
import { DateInput } from "../../components/DateInput";
import { SearchSelect } from "../../components/SearchSelect";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import {
  formatDate, formatINR, fromDateInput, rupeesToPaise,
} from "../../lib/format";
import { useAuth } from "../../store/auth";
import {
  DetailRow, QuoteStageBadge, SectionCard, Timeline,
} from "../portal/shared";

/*
  Working one quote request.

  What this screen CANNOT do, on purpose:
    * book a policy. "Book this policy" opens the normal policy form pre-filled;
      the broker and the rate card are human decisions and they belong there.
    * compute the partner's earning. The staff member types the figure they are
      quoting. A number invented here that the reward engine later disagreed
      with would be worse than no number at all.
*/

export default function QuoteDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, has } = useAuth();
  const canManage = has("manage_quotes");

  const quote = useQuery({
    queryKey: ["quote", id],
    retry: false,
    queryFn: async () => (await quotesApi.get(id)).data,
  });
  const q = quote.data;
  const missing = isAxiosError(quote.error)
    && quote.error.response?.status === 404;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["quote", id] });
    qc.invalidateQueries({ queryKey: ["quotes"] });
  };

  const act = <T,>(fn: () => Promise<T>, ok: string) => async () => {
    try { await fn(); toast.success(ok); refresh(); }
    catch (e) { toast.error(apiError(e)); }
  };

  const closed = q && ["issued", "declined", "lost", "cancelled"]
    .includes(q.stage);
  const details = Object.entries(q?.details ?? {})
    .filter(([, v]) => v !== null && v !== "" && v !== undefined);

  return (
    <RecordPage
      backTo="/quotes"
      backLabel="Back to quote requests"
      title={q ? q.customer_name : "Quote request"}
      documentTitle={q?.code ?? "Quote request"}
      subtitle={q ? `${q.partner_name ?? "Partner"} · ${
        q.category_label ?? ""}` : undefined}
      meta={q && <span className="chip">{q.code}</span>}
      badges={q && <QuoteStageBadge stage={q.stage} />}
      loading={quote.isLoading}
      error={missing ? undefined : quote.error}
      onRetry={() => quote.refetch()}
      notFound={missing}
    >
      {q && (
        <div className="space-y-4">
          {canManage && !closed && (
            <div className="card flex flex-wrap items-center gap-2 px-4 py-3">
              {q.assigned_to_id !== user?.id && (
                <button className="btn-secondary btn-sm"
                  onClick={act(() => quotesApi.pickUp(id), "Picked up.")}>
                  <Icon.Check size={14} /> I'm on it
                </button>
              )}
              <span className="text-sm text-slate-600">
                {q.assigned_to_name
                  ? `Assigned to ${q.assigned_to_name}`
                  : "Nobody has picked this up"}
              </span>
              <span className={`ml-auto text-sm ${q.answered && !q.expired
                ? "text-slate-500" : "font-medium text-due"}`}>
                {q.expired ? "Quotation expired"
                  : q.answered ? "Answered" : "Not answered yet"}
                {" · "}{q.age_hours}h old
              </span>
            </div>
          )}

          <SectionCard title="What they asked for">
            <DetailRow label="Channel partner">
              {q.partner_name || "—"}
              {q.manager_name && (
                <span className="ml-2 text-xs text-slate-500">
                  RM {q.manager_name}</span>
              )}
            </DetailRow>
            <DetailRow label="Customer">{q.customer_name}</DetailRow>
            <DetailRow label="Mobile">
              <a href={`tel:${q.customer_mobile}`} className="underline">
                {q.customer_mobile}</a>
            </DetailRow>
            {q.customer_email && (
              <DetailRow label="Email">{q.customer_email}</DetailRow>
            )}
            <DetailRow label="Type">
              {q.category_label}
              {q.subcategory_label ? ` · ${q.subcategory_label}` : ""}
              {q.is_renewal && <span className="ml-2 chip">renewal</span>}
            </DetailRow>
            {details.map(([key, value]) => (
              <DetailRow key={key} label={q.field_labels[key] ?? key}>
                {String(value)}
              </DetailRow>
            ))}
            {q.note && <DetailRow label="Their note">{q.note}</DetailRow>}
          </SectionCard>

          <SectionCard title="Documents they sent">
            {q.documents.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing attached.</p>
            ) : (
              <ul className="divide-y divide-line/70 rounded-control border
                border-line">
                {q.documents.map((d) => (
                  <li key={d.id}>
                    <button type="button"
                      className="flex w-full items-center justify-between gap-3
                        px-4 py-2.5 text-left hover:bg-slate-50"
                      onClick={async () => {
                        try {
                          const r = await quotesApi.documentUrl(id, d.id);
                          window.open(r.data.url, "_blank", "noopener");
                        } catch (e) { toast.error(apiError(e)); }
                      }}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium
                          text-slate-800">{d.label}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {d.filename}</span>
                      </span>
                      <Icon.Download size={16} className="shrink-0
                        text-slate-500" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {q.options.map((o) => (
            <SectionCard key={o.id} title="Quotation sent">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-slate-500">Insurer</p>
                  <p className="font-medium">{o.insurer_name || "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Premium</p>
                  <p className="font-semibold tabular-nums">
                    {formatINR(o.premium_amount)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Partner earns</p>
                  <p className="font-semibold tabular-nums text-money-in">
                    {formatINR(o.partner_earning)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Valid until</p>
                  <p className="font-medium">{formatDate(o.valid_until)}</p>
                </div>
              </div>
              {o.inclusions && (
                <p className="mt-3 whitespace-pre-line rounded-control
                  bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {o.inclusions}</p>
              )}
              {o.accepted_at && (
                <p className="mt-3 text-sm font-medium text-money-in">
                  Accepted by the partner on {formatDate(o.accepted_at)}.</p>
              )}
              {o.declined_at && (
                <p className="mt-3 text-sm text-slate-500">
                  Declined {formatDate(o.declined_at)}
                  {o.decline_reason ? ` — ${o.decline_reason}` : ""}.</p>
              )}
            </SectionCard>
          ))}

          {q.expired && (
            <div className="card border-l-4 border-l-due px-4 py-3">
              <p className="text-sm font-medium text-slate-800">
                The quotation you sent has expired.</p>
              <p className="mt-0.5 text-xs text-slate-500">
                The partner can no longer accept it — their screen offers them
                an "ask for a fresh quotation" button. Send a new price below
                and it replaces this one.
              </p>
            </div>
          )}

          {q.stage === "accepted" && canManage && (
            <div className="card border-l-4 border-l-money-in px-4 py-4">
              <p className="text-sm font-medium text-slate-800">
                The customer accepted. Book the policy.</p>
              <p className="mt-0.5 text-xs text-slate-500">
                The form opens pre-filled. Choose the broker there — that is
                what prices the reward — and the two records link on save.
              </p>
              <button className="btn-primary mt-3"
                onClick={() => navigate(`/policies/new?quote=${q.id}`)}>
                <Icon.Policy size={16} /> Book this policy
              </button>
            </div>
          )}
          {q.policy_id && (
            <button className="btn-secondary"
              onClick={() => navigate(`/policies/${q.policy_id}`)}>
              <Icon.Policy size={16} /> Open the policy
            </button>
          )}

          {canManage && !closed && <QuoteActions quote={q} onDone={refresh} />}

          <SectionCard title="Conversation">
            <Timeline events={q.timeline} />
          </SectionCard>

          {canManage && <InternalNotes quote={q} onDone={refresh} />}
        </div>
      )}
    </RecordPage>
  );
}

/* ------------------------------------------------------------- the actions -- */

function QuoteActions({ quote, onDone }: {
  quote: import("../../lib/types").StaffQuoteDetail;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<"quote" | "ask" | "close">("quote");
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [f, setF] = useState({
    insurer_id: "", premium: "", sum_insured: "", partner_earning: "",
    cover_from: "", cover_to: "", inclusions: "", valid_until: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const insurers = useQuery({
    queryKey: ["insurers-all"],
    queryFn: async () => (await insurersApi.list({ page_size: 200 })).data,
  });

  const run = (fn: () => Promise<unknown>, ok: string) => async () => {
    try { await fn(); toast.success(ok); onDone(); }
    catch (e) { toast.error(apiError(e)); }
  };

  const send = useMutation({
    mutationFn: () => quotesApi.sendQuote(quote.id, {
      insurer_id: f.insurer_id || null,
      premium_amount: rupeesToPaise(parseFloat(f.premium || "0")),
      sum_insured: f.sum_insured
        ? rupeesToPaise(parseFloat(f.sum_insured)) : 0,
      partner_earning: rupeesToPaise(parseFloat(f.partner_earning || "0")),
      cover_from: f.cover_from ? fromDateInput(f.cover_from) : null,
      cover_to: f.cover_to ? fromDateInput(f.cover_to) : null,
      inclusions: f.inclusions || null,
      valid_until: f.valid_until ? fromDateInput(f.valid_until) : null,
    }),
    onSuccess: () => { toast.success("Quotation sent."); onDone(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <SectionCard title="Respond">
      <div className="mb-4 flex flex-wrap gap-2">
        {([["quote", "Send a quotation"], ["ask", "Ask for something"],
          ["close", "Close it"]] as const).map(([key, label]) => (
          <button key={key}
            className={tab === key ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
            onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === "quote" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Insurer">
              <SearchSelect
                options={(insurers.data?.items ?? []).map((i) => ({
                  value: i.id, label: i.name, sub: i.code }))}
                value={f.insurer_id} placeholder="Select insurer…"
                onChange={(v) => set("insurer_id", v)} />
            </Field>
            <Field label="Premium — gross (₹)" required>
              <input type="number" step="0.01" min="0" className="input"
                value={f.premium}
                onChange={(e) => set("premium", e.target.value)} />
            </Field>
            <Field label="Sum insured (₹)">
              <input type="number" step="0.01" min="0" className="input"
                value={f.sum_insured}
                onChange={(e) => set("sum_insured", e.target.value)} />
            </Field>
            <Field label="Partner earns (₹)" required
              hint="What the partner is told they earn. Quote it off the same
                rate card the policy will be booked on.">
              <input type="number" step="0.01" min="0" className="input"
                value={f.partner_earning}
                onChange={(e) => set("partner_earning", e.target.value)} />
            </Field>
            <Field label="Cover from">
              <DateInput value={f.cover_from}
                onChange={(v) => set("cover_from", v)} />
            </Field>
            <Field label="Cover to">
              <DateInput value={f.cover_to}
                onChange={(v) => set("cover_to", v)} />
            </Field>
            <Field label="Valid until"
              hint="Blank uses the agency default from Portal settings.">
              <DateInput value={f.valid_until}
                onChange={(v) => set("valid_until", v)} />
            </Field>
          </div>
          <Field label="What's included"
            hint="Add-ons, deductibles, what is and is not covered.">
            <textarea className="input" rows={3} value={f.inclusions}
              onChange={(e) => set("inclusions", e.target.value)} />
          </Field>
          <button className="btn-primary"
            disabled={!f.premium || send.isPending}
            onClick={() => send.mutate()}>
            {send.isPending ? <Spinner className="h-4 w-4" />
              : <><Icon.Mail size={16} /> Send to the partner</>}
          </button>
          <p className="text-xs text-slate-500">
            The partner sees the premium and their own earning in rupees —
            never a rate, never the agency's side.
          </p>
        </div>
      )}

      {tab === "ask" && (
        <div className="space-y-3">
          <Field label="Message to the partner" required>
            <textarea className="input" rows={3} value={message}
              placeholder="e.g. Please send a clearer photo of the RC book."
              onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={!message.trim()}
              onClick={run(
                () => quotesApi.note(quote.id, message.trim(), true),
                "Asked. The request is now waiting on them.")}>
              Ask for this
            </button>
            <button className="btn-secondary" disabled={!message.trim()}
              onClick={run(
                () => quotesApi.note(quote.id, message.trim(), false),
                "Sent.")}>
              Just send an update
            </button>
          </div>
        </div>
      )}

      {tab === "close" && (
        <div className="space-y-3">
          <Field label="Reason" hint="The partner sees this.">
            <input className="input" value={reason}
              placeholder="e.g. No appetite for this vehicle age."
              onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button className="btn-danger-soft"
              onClick={async () => {
                if (await confirmDialog({
                  title: "Decline this request?",
                  message: "The partner is told you cannot quote it.",
                  confirmLabel: "Decline", danger: true,
                })) run(() => quotesApi.close(quote.id, "declined", reason),
                  "Declined.")();
              }}>
              We cannot quote this
            </button>
            <button className="btn-secondary"
              onClick={run(() => quotesApi.close(quote.id, "lost", reason),
                "Marked as lost.")}>
              Quoted but lost
            </button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function InternalNotes({ quote, onDone }: {
  quote: import("../../lib/types").StaffQuoteDetail;
  onDone: () => void;
}) {
  const [notes, setNotes] = useState(quote.internal_notes ?? "");
  const save = useMutation({
    mutationFn: () => quotesApi.internalNotes(quote.id, notes),
    onSuccess: () => { toast.success("Saved."); onDone(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <SectionCard title="Internal notes">
      <p className="mb-2 text-xs text-slate-500">
        Staff only. The partner never sees this — their schema has no field
        for it.
      </p>
      <textarea className="input" rows={3} value={notes}
        onChange={(e) => setNotes(e.target.value)} />
      <button className="btn-secondary mt-2"
        disabled={save.isPending || notes === (quote.internal_notes ?? "")}
        onClick={() => save.mutate()}>Save notes</button>
    </SectionCard>
  );
}
