import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { portalApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { FormPage, RecordPage } from "../../components/RecordPage";
import { Icon } from "../../components/Icon";
import { ErrorState, EmptyState, Field, Spinner, TableSkeleton } from "../../components/ui";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatDate, formatINR } from "../../lib/format";
import {
  DetailRow, DocumentList, ListShell, MobileCard, QuoteStageBadge,
  SectionCard, Timeline, quoteStageLabel,
} from "./shared";
import type { PortalQuoteOption } from "../../lib/types";

/*
  Quote requests — a partner's ONLY way to bring business in.

  They ask; the agency prices it; they accept or decline; STAFF book the policy.
  Nothing here creates a policy, sets a premium or decides a reward — the form
  has no field for any of it, which is the safeguard rather than a rule someone
  has to remember.
*/

/* -------------------------------------------------------------------- list -- */

export function PortalQuotesPage() {
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["portal", "quotes"],
    queryFn: async () => (await portalApi.quotes({ page_size: 50 })).data,
  });
  const rows = list.data?.items ?? [];

  return (
    <div>
      <PageHeader title="Quote Requests"
        subtitle="Ask Agastya to price a case, and follow it through."
        actions={
          <button className="btn-primary"
            onClick={() => navigate("/portal/quotes/new")}>
            <Icon.Plus size={16} /> New request
          </button>
        } />

      {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
        <div className="card card-body"><TableSkeleton cols={4} /></div>
      ) : (
        <ListShell
          empty={rows.length === 0 ? (
            <EmptyState
              icon={<Icon.Lead size={20} />}
              title="No requests yet"
              hint="Send us a case — the policy type, the customer's name and
                number, and whatever documents you have. We will come back with
                a quotation."
              action={
                <button className="btn-primary"
                  onClick={() => navigate("/portal/quotes/new")}>
                  <Icon.Plus size={16} /> Ask for a quotation
                </button>
              } />
          ) : undefined}
          cards={rows.map((q) => (
            <MobileCard key={q.id} to={`/portal/quotes/${q.id}`}
              title={q.customer_name}
              meta={<>{q.category_label} · {q.code}</>}
              right={<QuoteStageBadge stage={q.stage} />}
              footer={
                <span className="flex items-center justify-between gap-2">
                  <span>{formatDate(q.created_at)}</span>
                  {q.options[0] && (
                    <span className="font-semibold text-money-in">
                      You earn {formatINR(q.options[0].my_earning)}
                    </span>
                  )}
                </span>
              } />
          ))}
          table={
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Type</th>
                  <th>Raised</th>
                  <th className="num">Premium quoted</th>
                  <th className="num">You earn</th>
                  <th>Stage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={q.id} className="row-link"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") navigate(`/portal/quotes/${q.id}`);
                    }}
                    onClick={() => navigate(`/portal/quotes/${q.id}`)}>
                    <td>
                      <span className="font-medium text-slate-900">
                        {q.customer_name}</span>
                      <span className="block text-xs text-slate-500">
                        {q.code}</span>
                    </td>
                    <td>
                      {q.category_label}
                      {q.is_renewal && <span className="ml-2 chip">renewal</span>}
                    </td>
                    <td className="whitespace-nowrap">
                      {formatDate(q.created_at)}</td>
                    <td className="num">
                      {q.options[0]
                        ? formatINR(q.options[0].premium_amount) : "—"}</td>
                    <td className="num font-semibold text-money-in">
                      {q.options[0]
                        ? formatINR(q.options[0].my_earning) : "—"}</td>
                    <td><QuoteStageBadge stage={q.stage} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          } />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ detail -- */

export function PortalQuoteDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [reply, setReply] = useState("");

  const quote = useQuery({
    queryKey: ["portal", "quote", id],
    retry: false,
    queryFn: async () => (await portalApi.quote(id)).data,
  });
  const q = quote.data;
  const missing = isAxiosError(quote.error)
    && quote.error.response?.status === 404;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["portal", "quote", id] });
    qc.invalidateQueries({ queryKey: ["portal", "quotes"] });
    qc.invalidateQueries({ queryKey: ["portal", "summary"] });
  };

  const send = useMutation({
    mutationFn: () => portalApi.replyOnQuote(id, reply.trim()),
    onSuccess: () => { setReply(""); toast.success("Sent."); refresh(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const decide = useMutation({
    mutationFn: (body: { option_id: string; accept: boolean; reason?: string }) =>
      portalApi.decideOnQuote(id, body),
    onSuccess: (_r, v) => {
      toast.success(v.accept
        ? "Accepted. Agastya will issue the policy."
        : "Marked as not taken.");
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const cancel = useMutation({
    mutationFn: () => portalApi.cancelQuote(id),
    onSuccess: () => { toast.success("Request cancelled."); refresh(); },
    onError: (e) => toast.error(apiError(e)),
  });

  // The screen said "ask for a fresh one" and gave them nothing to ask with, so
  // an expired request sat in QUOTED for ever — not closed, not workable, and
  // indistinguishable from a live one on the staff queue.
  const refreshQuote = useMutation({
    mutationFn: () => portalApi.refreshQuote(id),
    onSuccess: () => {
      toast.success("Asked. Agastya will send a fresh quotation.");
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Their own upload, downloadable. This was an error toast — "Ask your
  // relationship manager for a copy of this document" — on a file the partner
  // had attached themselves, off their own phone, minutes earlier. There was no
  // endpoint behind it until 2026-08-19.
  const openDoc = async (docId: string) => {
    try {
      const { data } = await portalApi.quoteDocumentUrl(id, docId);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  const details = Object.entries(q?.details ?? {})
    .filter(([, v]) => v !== null && v !== "" && v !== undefined);
  const canTalk = q && !["issued", "cancelled", "lost", "declined"]
    .includes(q.stage);

  return (
    <RecordPage
      backTo="/portal/quotes"
      backLabel="Back to quote requests"
      title={q ? q.customer_name : "Quote request"}
      documentTitle={q?.code ?? "Quote request"}
      subtitle={q ? `${q.category_label ?? ""}${q.subcategory_label
        ? ` · ${q.subcategory_label}` : ""}` : undefined}
      meta={q && <span className="chip">{q.code}</span>}
      badges={q && <QuoteStageBadge stage={q.stage} />}
      loading={quote.isLoading}
      error={missing ? undefined : quote.error}
      onRetry={() => quote.refetch()}
      notFound={missing}
    >
      {q && (
        <div className="space-y-4">
          {q.stage === "info_needed" && (
            <div className="rounded-control border border-due/25 bg-due/10
              px-4 py-3 text-sm text-due">
              Agastya needs something from you — see the latest message below,
              and reply or attach what they asked for.
            </div>
          )}

          {/* The quotation, when there is one. This is the whole point of the
              screen, so it goes first and it says what THEY earn. */}
          {q.options.map((o) => (
            <QuoteOptionCard key={o.id} option={o} stage={q.stage}
              busy={decide.isPending}
              onAccept={() => decide.mutate({ option_id: o.id, accept: true })}
              onDecline={async () => {
                if (await confirmDialog({
                  title: "Not taking this quote?",
                  message: "This closes the request. You can always raise a "
                    + "new one.",
                  confirmLabel: "Mark as not taken",
                })) decide.mutate({ option_id: o.id, accept: false });
              }} />
          ))}

          {q.stage === "quoted" && q.options.some((o) => o.expired) && (
            <div className="card border-l-4 border-l-due px-4 py-4">
              <p className="text-sm font-medium text-slate-800">
                This quotation has expired.</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Premiums move, so a quotation is only good for a few days. Ask
                and the team will re-price the same case — your customer's
                details and everything you attached stay on this request.
              </p>
              <button className="btn-primary btn-lg mt-3 w-full sm:w-auto"
                disabled={refreshQuote.isPending}
                onClick={() => refreshQuote.mutate()}>
                {refreshQuote.isPending
                  ? <Spinner className="h-4 w-4" />
                  : <><Icon.Refresh size={16} /> Ask for a fresh quotation</>}
              </button>
            </div>
          )}

          {q.stage === "accepted" && (
            <div className="rounded-control border border-money-in/30
              bg-money-in/5 px-4 py-3 text-sm text-slate-700">
              Accepted. Agastya is issuing the policy — it will appear under My
              Policies, and you will get a notification.
            </div>
          )}
          {q.policy_id && (
            <Link to={`/portal/policies/${q.policy_id}`}
              className="btn-primary btn-lg w-full">
              <Icon.Policy size={16} /> Open the policy
            </Link>
          )}
          {q.closed_reason && (
            <div className="rounded-control border border-line bg-slate-50 px-4
              py-3 text-sm text-slate-600">
              {quoteStageLabel(q.stage)}: {q.closed_reason}
            </div>
          )}

          <SectionCard title="What you asked for">
            <DetailRow label="Customer">{q.customer_name}</DetailRow>
            <DetailRow label="Mobile">
              <a href={`tel:${q.customer_mobile}`} className="underline">
                {q.customer_mobile}</a>
            </DetailRow>
            <DetailRow label="Policy type">
              {q.category_label}
              {q.subcategory_label ? ` · ${q.subcategory_label}` : ""}
            </DetailRow>
            {q.is_renewal && <DetailRow label="Renewal">Yes</DetailRow>}
            {details.map(([key, value]) => (
              <DetailRow key={key} label={q.field_labels[key] ?? key}>
                {String(value)}
              </DetailRow>
            ))}
            {q.note && <DetailRow label="Your note">{q.note}</DetailRow>}
          </SectionCard>

          <SectionCard title="Documents you sent">
            <DocumentList documents={q.documents} onOpen={openDoc}
              emptyLabel="You did not attach anything." />
          </SectionCard>

          <SectionCard title="Progress">
            <Timeline events={q.timeline} />
            {canTalk && (
              <div className="mt-4 border-t border-line/70 pt-4">
                <Field label="Reply to Agastya">
                  <textarea className="input" rows={3} value={reply}
                    placeholder="Anything they should know…"
                    onChange={(e) => setReply(e.target.value)} />
                </Field>
                <button className="btn-primary mt-2 w-full sm:w-auto"
                  disabled={!reply.trim() || send.isPending}
                  onClick={() => send.mutate()}>
                  {send.isPending ? <Spinner className="h-4 w-4" /> : "Send"}
                </button>
              </div>
            )}
          </SectionCard>

          {q.can_cancel && (
            <button className="btn-danger-soft w-full"
              disabled={cancel.isPending}
              onClick={async () => {
                if (await confirmDialog({
                  title: "Cancel this request?",
                  message: "The customer went elsewhere, or you no longer need "
                    + "a quote. Agastya will stop working on it.",
                  confirmLabel: "Cancel request", danger: true,
                })) cancel.mutate();
              }}>
              Cancel this request
            </button>
          )}
        </div>
      )}
    </RecordPage>
  );
}

function QuoteOptionCard({ option, stage, busy, onAccept, onDecline }: {
  option: PortalQuoteOption;
  stage: string;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const decided = !!option.accepted_at || !!option.declined_at;
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line bg-slate-50/70 px-4 py-3 sm:px-5">
        <p className="text-caption font-semibold uppercase text-slate-500">
          Quotation{option.insurer_name ? ` · ${option.insurer_name}` : ""}</p>
      </div>
      <div className="px-4 py-4 sm:px-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-500">Premium</p>
            <p className="text-metric-sm tabular-nums text-slate-900">
              {formatINR(option.premium_amount)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">You earn</p>
            <p className="text-metric-sm tabular-nums text-money-in">
              {formatINR(option.my_earning)}</p>
          </div>
        </div>
        {option.sum_insured > 0 && (
          <DetailRow label="Sum insured">
            {formatINR(option.sum_insured)}</DetailRow>
        )}
        {(option.cover_from || option.cover_to) && (
          <DetailRow label="Cover">
            {formatDate(option.cover_from)} — {formatDate(option.cover_to)}
          </DetailRow>
        )}
        {option.inclusions && (
          <div className="mt-3 whitespace-pre-line rounded-control bg-slate-50
            px-3 py-2 text-sm text-slate-700">{option.inclusions}</div>
        )}
        {option.valid_until && (
          <p className={`mt-3 text-xs ${option.expired
            ? "font-medium text-money-out" : "text-slate-500"}`}>
            {option.expired
              ? "This quotation has expired — ask for a fresh one, premiums move."
              : `Valid until ${formatDate(option.valid_until)}.`}
          </p>
        )}

        {stage === "quoted" && !decided && !option.expired && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button className="btn-primary flex-1" disabled={busy}
              onClick={onAccept}>
              <Icon.Check size={16} /> Customer accepts
            </button>
            <button className="btn-secondary flex-1" disabled={busy}
              onClick={onDecline}>Not taken</button>
          </div>
        )}
        {option.accepted_at && (
          <p className="mt-3 text-sm font-medium text-money-in">
            Accepted on {formatDate(option.accepted_at)}.</p>
        )}
        {option.declined_at && (
          <p className="mt-3 text-sm text-slate-500">
            Declined on {formatDate(option.declined_at)}.</p>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- form -- */

export function PortalQuoteFormPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search] = useSearchParams();
  const renewalOf = search.get("renewal") || undefined;

  const options = useQuery({
    queryKey: ["portal", "quote-options"],
    queryFn: async () => (await portalApi.quoteOptions()).data,
  });
  const cats = options.data ?? [];

  const [f, setF] = useState({
    customer_name: "", customer_mobile: "", customer_email: "",
    category_key: "", note: "",
  });
  const [path, setPath] = useState<string[]>([]);
  const [details, setDetails] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<{ file: File; label: string }[]>([]);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const cat = cats.find((c) => c.key === f.category_key);
  // One level of sub-type on the phone form. The full tree lives on the staff
  // booking form; a partner picking four nested dropdowns on a phone is how a
  // request never gets sent.
  const subOptions = cat?.children ?? [];

  const create = useMutation({
    mutationFn: async () => {
      const res = await portalApi.raiseQuote({
        customer_name: f.customer_name.trim(),
        customer_mobile: f.customer_mobile.trim(),
        customer_email: f.customer_email.trim() || undefined,
        category_key: f.category_key,
        subcategory_path: path,
        details,
        note: f.note.trim() || undefined,
        renewal_of_policy_id: renewalOf,
      });
      // Attachments follow the request, one at a time and best-effort: a failed
      // photo upload must not lose the request itself.
      for (const { file, label } of files) {
        try {
          await portalApi.uploadQuoteDocument(res.data.id, file, label);
        } catch {
          toast.error(`Could not attach ${file.name}. You can add it from the `
            + "request page.");
        }
      }
      return res;
    },
    onSuccess: ({ data }) => {
      toast.success("Sent to Agastya. We will come back with a quotation.");
      qc.invalidateQueries({ queryKey: ["portal"] });
      navigate(`/portal/quotes/${data.id}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const valid = f.customer_name.trim().length >= 2
    && f.customer_mobile.trim().length === 10 && !!f.category_key;

  const submit = () => {
    if (!valid) {
      return toast.error(
        "Please give the customer's name, a 10-digit mobile and a policy type.");
    }
    create.mutate();
  };

  return (
    <FormPage
      backTo="/portal/quotes"
      backLabel="Back to quote requests"
      title={renewalOf ? "Ask for a renewal quote" : "Ask for a quotation"}
      subtitle="Tell us what the customer needs. We will price it and come back
        with the premium and what you earn."
      onSubmit={submit}
      submitLabel="Send to Agastya"
      submitting={create.isPending}
    >
      <div className="space-y-4">
        <Field label="Customer name" required>
          <input className="input" value={f.customer_name} required
            autoComplete="name"
            onChange={(e) => set("customer_name", e.target.value)} />
        </Field>
        <Field label="Customer mobile" required>
          <div className="flex">
            <span className="inline-flex items-center rounded-l-control border
              border-r-0 border-line bg-slate-50 px-3 text-sm text-slate-500">
              +91</span>
            <input className="input rounded-l-none" value={f.customer_mobile}
              required inputMode="numeric" maxLength={10}
              placeholder="10-digit number"
              onChange={(e) => set("customer_mobile",
                e.target.value.replace(/\D/g, ""))} />
          </div>
        </Field>
        <Field label="Customer email" hint="Optional.">
          <input type="email" className="input" value={f.customer_email}
            inputMode="email"
            onChange={(e) => set("customer_email", e.target.value)} />
        </Field>

        <Field label="Policy type" required>
          <select className="select" value={f.category_key} required
            onChange={(e) => {
              set("category_key", e.target.value);
              setPath([]); setDetails({});
            }}>
            <option value="">Select…</option>
            {cats.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </Field>
        {subOptions.length > 0 && (
          <Field label="Sub-type">
            <select className="select" value={path[0] ?? ""}
              onChange={(e) => setPath(e.target.value ? [e.target.value] : [])}>
              <option value="">— Select —</option>
              {subOptions.map((n) => (
                <option key={n.key} value={n.key}>{n.label}</option>
              ))}
            </select>
          </Field>
        )}

        {/* The type's own fields. NONE is required — this is an enquiry, and
            refusing it over a missing field is how a partner stops sending
            them. */}
        {(cat?.fields.length ?? 0) > 0 && (
          <div className="rounded-control border border-line p-3">
            <p className="mb-3 text-sm font-medium text-slate-600">
              {cat!.label} details
              <span className="ml-1 font-normal text-slate-500">
                — fill in what you know</span>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {cat!.fields.map((spec) => (
                <Field key={spec.key} label={spec.label}
                  hint={spec.hint || undefined}>
                  {spec.type === "select" ? (
                    <select className="select"
                      value={(details[spec.key] as string) ?? ""}
                      onChange={(e) => setDetails((d) => ({
                        ...d, [spec.key]: e.target.value || undefined }))}>
                      <option value="">—</option>
                      {spec.options.map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  ) : spec.type === "date" ? (
                    <DateInput value={(details[spec.key] as string) ?? ""}
                      onChange={(v) => setDetails((d) => ({
                        ...d, [spec.key]: v || undefined }))} />
                  ) : (
                    <input className="input"
                      inputMode={spec.type === "number" || spec.type === "amount"
                        ? "decimal" : undefined}
                      value={(details[spec.key] as string) ?? ""}
                      onChange={(e) => setDetails((d) => ({
                        ...d, [spec.key]: e.target.value || undefined }))} />
                  )}
                </Field>
              ))}
            </div>
          </div>
        )}

        {/* The type's document checklist, so a partner is TOLD what to bring
            rather than being asked for it a day later. */}
        <div className="rounded-control border border-line p-3">
          <p className="mb-1 text-sm font-medium text-slate-600">Documents</p>
          {(cat?.documents.length ?? 0) > 0 && (
            <p className="mb-2 text-xs text-slate-500">
              Helpful for this type: {cat!.documents.map((d) => d.label)
                .join(", ")}.
            </p>
          )}
          <label className="btn-secondary w-full cursor-pointer sm:w-auto">
            <Icon.Upload size={16} /> Add a photo or PDF
            <input type="file" className="hidden"
              accept=".pdf,.jpg,.jpeg,.png,image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.currentTarget.value = "";
                if (file) setFiles((s) => [...s, { file, label: file.name }]);
              }} />
          </label>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((x, i) => (
                <li key={i} className="flex items-center justify-between gap-2
                  text-sm text-slate-700">
                  <span className="truncate">{x.file.name}</span>
                  <button type="button" className="icon-btn h-8 w-8"
                    aria-label="Remove" title="Remove this file"
                    onClick={() => setFiles((s) =>
                      s.filter((_, j) => j !== i))}>
                    <Icon.X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Field label="Anything else we should know?">
          <textarea className="input" rows={3} value={f.note}
            onChange={(e) => set("note", e.target.value)} />
        </Field>

        <p className="text-xs text-slate-500">
          We will come back with the premium and exactly what you earn. Nothing
          is booked until the customer accepts and Agastya issues the policy.
        </p>
      </div>
    </FormPage>
  );
}
