import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import {
  Check,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Upload,
  X,
} from "lucide-react";
import { portalApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, type Column } from "../../components/shared/DataTable";
import { FormField } from "../../components/shared/FormSection";
import { FormPage, RecordPage } from "../../components/RecordPage";
import { confirmDialog } from "../../components/Confirm";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatINR } from "../../lib/format";
import type { PortalQuoteRequest, PortalQuoteOption } from "../../lib/types";
import {
  DetailRow,
  DocumentList,
  QuoteStageBadge,
  quoteStageLabel,
  SectionCard,
  Timeline,
} from "./shared";

/* -------------------------------------------------------------------- list -- */

export function PortalQuotesPage() {
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["portal", "quotes"],
    queryFn: async () => (await portalApi.quotes({ page_size: 50 })).data,
  });
  const rows = list.data?.items ?? [];

  const columns = useMemo<Column<PortalQuoteRequest>[]>(
    () => [
      {
        key: "customer",
        header: "Customer",
        cell: (q) => (
          <div>
            <span className="font-medium text-slate-900">{q.customer_name}</span>
            <span className="block text-xs text-slate-500">{q.code}</span>
          </div>
        ),
      },
      {
        key: "type",
        header: "Type",
        cell: (q) => (
          <div className="flex items-center gap-2">
            <span>{q.category_label}</span>
            {q.is_renewal && (
              <Badge variant="secondary" className="text-[11px] font-medium">
                renewal
              </Badge>
            )}
          </div>
        ),
      },
      {
        key: "asked",
        header: "Asked",
        cell: (q) => (
          <span className="whitespace-nowrap text-slate-600">
            {formatDate(q.created_at)}
          </span>
        ),
      },
      {
        key: "premium",
        header: "Premium",
        align: "right",
        cell: (q) => (
          <span className="tabular-nums">
            {q.options[0] ? formatINR(q.options[0].premium_amount) : "—"}
          </span>
        ),
      },
      {
        key: "earning",
        header: "You earn",
        align: "right",
        cell: (q) => (
          <span className="font-semibold tabular-nums text-emerald-700">
            {q.options[0] ? formatINR(q.options[0].my_earning) : "—"}
          </span>
        ),
      },
      {
        key: "stage",
        header: "Stage",
        cell: (q) => <QuoteStageBadge stage={q.stage} />,
      },
    ],
    []
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Quote requests"
        subtitle="Ask for a price, then tell us whether the customer took it."
        actions={
          <Button size="sm" onClick={() => navigate("/portal/quotes/new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Ask for a quote
          </Button>
        }
      />

      <DataTable
        data={rows}
        columns={columns}
        keyField={(q) => q.id}
        loading={list.isLoading}
        error={list.error ? "Could not load quote requests." : null}
        onRetry={() => list.refetch()}
        onRowClick={(q) => navigate(`/portal/quotes/${q.id}`)}
        emptyTitle="No quote requests"
        emptyDescription="Send us the customer's details and we will come back with the premium and what you earn."
        renderMobileCard={(q) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="truncate font-medium text-slate-900">{q.customer_name}</p>
              <p className="text-xs text-slate-500">
                {q.category_label} · {q.code}
                {q.is_renewal ? " · renewal" : ""}
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-slate-600">
                <span>
                  {q.options[0]
                    ? `Premium ${formatINR(q.options[0].premium_amount)}`
                    : formatDate(q.created_at)}
                </span>
                {q.options[0] && (
                  <span className="font-semibold text-emerald-700">
                    You earn {formatINR(q.options[0].my_earning)}
                  </span>
                )}
              </div>
            </div>
            <QuoteStageBadge stage={q.stage} />
          </div>
        )}
      />
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
  const missing = isAxiosError(quote.error) && quote.error.response?.status === 404;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["portal", "quote", id] });
    qc.invalidateQueries({ queryKey: ["portal", "quotes"] });
    qc.invalidateQueries({ queryKey: ["portal", "summary"] });
  };

  const send = useMutation({
    mutationFn: () => portalApi.replyOnQuote(id, reply.trim()),
    onSuccess: () => {
      setReply("");
      toast.success("Sent.");
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const decide = useMutation({
    mutationFn: (body: { option_id: string; accept: boolean; reason?: string }) =>
      portalApi.decideOnQuote(id, body),
    onSuccess: (_r, v) => {
      toast.success(
        v.accept
          ? "Accepted. Agastya will issue the policy."
          : "Marked as not taken."
      );
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const cancel = useMutation({
    mutationFn: () => portalApi.cancelQuote(id),
    onSuccess: () => {
      toast.success("Request cancelled.");
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const refreshQuote = useMutation({
    mutationFn: () => portalApi.refreshQuote(id),
    onSuccess: () => {
      toast.success("Asked. Agastya will send a fresh quotation.");
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const openDoc = async (docId: string) => {
    try {
      const { data } = await portalApi.quoteDocumentUrl(id, docId);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  const details = Object.entries(q?.details ?? {}).filter(
    ([, v]) => v !== null && v !== "" && v !== undefined
  );
  const canTalk = q && !["issued", "cancelled", "lost", "declined"].includes(q.stage);

  return (
    <RecordPage
      backTo="/portal/quotes"
      backLabel="Back to quote requests"
      title={q ? q.customer_name : "Quote request"}
      documentTitle={q?.code ?? "Quote request"}
      subtitle={
        q
          ? `${q.category_label ?? ""}${
              q.subcategory_label ? ` · ${q.subcategory_label}` : ""
            }`
          : undefined
      }
      meta={q && <Badge variant="secondary">{q.code}</Badge>}
      badges={q && <QuoteStageBadge stage={q.stage} />}
      loading={quote.isLoading}
      error={missing ? undefined : quote.error}
      onRetry={() => quote.refetch()}
      notFound={missing}
    >
      {q && (
        <div className="space-y-4">
          {q.stage === "info_needed" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Agastya needs something from you — see the latest message below, and
              reply or attach what they asked for.
            </div>
          )}

          {q.options.map((o) => (
            <QuoteOptionCard
              key={o.id}
              option={o}
              stage={q.stage}
              busy={decide.isPending}
              onAccept={() => decide.mutate({ option_id: o.id, accept: true })}
              onDecline={async () => {
                if (
                  await confirmDialog({
                    title: "Not taking this quote?",
                    message:
                      "This closes the request. You can always raise a new one.",
                    confirmLabel: "Mark as not taken",
                  })
                ) {
                  decide.mutate({ option_id: o.id, accept: false });
                }
              }}
            />
          ))}

          {q.stage === "quoted" && q.options.some((o) => o.expired) && (
            <Card className="border-l-4 border-l-amber-500 p-4">
              <p className="text-sm font-medium text-slate-900">
                This quotation has expired.
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Premiums move, so a quotation is only good for a few days. Ask and
                the team will re-price the same case — your customer&apos;s details
                and everything you attached stay on this request.
              </p>
              <Button
                className="mt-3 w-full sm:w-auto"
                disabled={refreshQuote.isPending}
                onClick={() => refreshQuote.mutate()}
              >
                {refreshQuote.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                )}
                Ask for a fresh quotation
              </Button>
            </Card>
          )}

          {q.stage === "accepted" && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              Accepted. Agastya is issuing the policy — it will appear under My
              Policies, and you will get a notification.
            </div>
          )}

          {q.policy_id && (
            <Button asChild className="w-full">
              <Link to={`/portal/policies/${q.policy_id}`}>
                <FileText className="mr-1.5 h-4 w-4" />
                Open the policy
              </Link>
            </Button>
          )}

          {q.closed_reason && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {quoteStageLabel(q.stage)}: {q.closed_reason}
            </div>
          )}

          <SectionCard title="What you asked for">
            <DetailRow label="Customer">{q.customer_name}</DetailRow>
            <DetailRow label="Mobile">
              <a href={`tel:${q.customer_mobile}`} className="underline">
                {q.customer_mobile}
              </a>
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
            <DocumentList
              documents={q.documents}
              onOpen={openDoc}
              emptyLabel="You did not attach anything."
            />
          </SectionCard>

          <SectionCard title="Progress">
            <Timeline events={q.timeline} />
            {canTalk && (
              <div className="mt-4 space-y-2 border-t border-slate-200 pt-4">
                <FormField label="Reply to Agastya">
                  <Textarea
                    rows={3}
                    value={reply}
                    placeholder="Anything they should know…"
                    onChange={(e) => setReply(e.target.value)}
                  />
                </FormField>
                <Button
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={!reply.trim() || send.isPending}
                  onClick={() => send.mutate()}
                >
                  {send.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Send
                </Button>
              </div>
            )}
          </SectionCard>

          {q.can_cancel && (
            <Button
              variant="outline"
              className="w-full border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
              disabled={cancel.isPending}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: "Cancel this request?",
                    message:
                      "The customer went elsewhere, or you no longer need a quote. Agastya will stop working on it.",
                    confirmLabel: "Cancel request",
                    danger: true,
                  })
                ) {
                  cancel.mutate();
                }
              }}
            >
              Cancel this request
            </Button>
          )}
        </div>
      )}
    </RecordPage>
  );
}

function QuoteOptionCard({
  option,
  stage,
  busy,
  onAccept,
  onDecline,
}: {
  option: PortalQuoteOption;
  stage: string;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const decided = !!option.accepted_at || !!option.declined_at;
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-slate-50/70 px-4 py-2.5 sm:px-5">
        <CardTitle className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Quotation{option.insurer_name ? ` · ${option.insurer_name}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 py-4 sm:px-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-500">Premium</p>
            <p className="text-lg font-semibold tabular-nums text-slate-900">
              {formatINR(option.premium_amount)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">You earn</p>
            <p className="text-lg font-semibold tabular-nums text-emerald-700">
              {formatINR(option.my_earning)}
            </p>
          </div>
        </div>
        {option.sum_insured > 0 && (
          <DetailRow label="Sum insured">
            {formatINR(option.sum_insured)}
          </DetailRow>
        )}
        {(option.cover_from || option.cover_to) && (
          <DetailRow label="Cover">
            {formatDate(option.cover_from)} — {formatDate(option.cover_to)}
          </DetailRow>
        )}
        {option.inclusions && (
          <div className="mt-3 whitespace-pre-line rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {option.inclusions}
          </div>
        )}
        {option.valid_until && (
          <p
            className={`mt-3 text-xs ${
              option.expired ? "font-medium text-red-600" : "text-slate-500"
            }`}
          >
            {option.expired
              ? "This quotation has expired — ask for a fresh one, premiums move."
              : `Valid until ${formatDate(option.valid_until)}.`}
          </p>
        )}

        {stage === "quoted" && !decided && !option.expired && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Button className="flex-1" disabled={busy} onClick={onAccept}>
              <Check className="mr-1.5 h-4 w-4" />
              Customer accepts
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy}
              onClick={onDecline}
            >
              Not taken
            </Button>
          </div>
        )}
        {option.accepted_at && (
          <p className="mt-3 text-sm font-medium text-emerald-700">
            Accepted on {formatDate(option.accepted_at)}.
          </p>
        )}
        {option.declined_at && (
          <p className="mt-3 text-sm text-slate-500">
            Declined on {formatDate(option.declined_at)}.
          </p>
        )}
      </CardContent>
    </Card>
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
    customer_name: "",
    customer_mobile: "",
    customer_email: "",
    category_key: "",
    note: "",
  });
  const [path, setPath] = useState<string[]>([]);
  const [details, setDetails] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<{ file: File; label: string }[]>([]);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const cat = cats.find((c) => c.key === f.category_key);
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
      for (const { file, label } of files) {
        try {
          await portalApi.uploadQuoteDocument(res.data.id, file, label);
        } catch {
          toast.error(
            `Could not attach ${file.name}. You can add it from the request page.`
          );
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

  const valid =
    f.customer_name.trim().length >= 2 &&
    f.customer_mobile.trim().length === 10 &&
    !!f.category_key;

  const submit = () => {
    if (!valid) {
      return toast.error(
        "Please give the customer's name, a 10-digit mobile and a policy type."
      );
    }
    create.mutate();
  };

  return (
    <FormPage
      backTo="/portal/quotes"
      backLabel="Back to quote requests"
      title={renewalOf ? "Ask for a renewal quote" : "Ask for a quotation"}
      subtitle="Tell us what the customer needs. We will price it and come back with the premium and what you earn."
      onSubmit={submit}
      submitLabel="Send to Agastya"
      submitting={create.isPending}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Customer name" required>
            <Input
              value={f.customer_name}
              required
              autoComplete="name"
              onChange={(e) => set("customer_name", e.target.value)}
            />
          </FormField>
          <FormField label="Customer mobile" required>
            <div className="flex">
              <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 border-input bg-slate-50 px-3 text-sm text-slate-500">
                +91
              </span>
              <Input
                className="rounded-l-none"
                value={f.customer_mobile}
                required
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit number"
                onChange={(e) =>
                  set("customer_mobile", e.target.value.replace(/\D/g, ""))
                }
              />
            </div>
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Customer email" hint="Optional.">
            <Input
              type="email"
              value={f.customer_email}
              inputMode="email"
              onChange={(e) => set("customer_email", e.target.value)}
            />
          </FormField>
          <FormField label="Policy type" required>
            <Select
              value={f.category_key}
              onValueChange={(v) => {
                set("category_key", v);
                setPath([]);
                setDetails({});
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {cats.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>

        {subOptions.length > 0 && (
          <FormField label="Sub-type">
            <Select
              value={path[0] || "__none__"}
              onValueChange={(v) => setPath(v === "__none__" ? [] : [v])}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="— Select —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Select —</SelectItem>
                {subOptions.map((n) => (
                  <SelectItem key={n.key} value={n.key}>
                    {n.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}

        {(cat?.fields.length ?? 0) > 0 && (
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-3 text-sm font-medium text-slate-700">
              {cat!.label} details
              <span className="ml-1 font-normal text-slate-500">
                — fill in what you know
              </span>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {cat!.fields.map((spec) => (
                <FormField
                  key={spec.key}
                  label={spec.label}
                  hint={spec.hint || undefined}
                >
                  {spec.type === "select" ? (
                    <Select
                      value={((details[spec.key] as string) ?? "") || "__none__"}
                      onValueChange={(v) =>
                        setDetails((d) => ({
                          ...d,
                          [spec.key]: v === "__none__" ? undefined : v,
                        }))
                      }
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">—</SelectItem>
                        {spec.options.map((o) => (
                          <SelectItem key={o} value={o}>
                            {o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : spec.type === "date" ? (
                    <DateInput
                      value={(details[spec.key] as string) ?? ""}
                      onChange={(v) =>
                        setDetails((d) => ({ ...d, [spec.key]: v || undefined }))
                      }
                    />
                  ) : (
                    <Input
                      inputMode={
                        spec.type === "number" || spec.type === "amount"
                          ? "decimal"
                          : undefined
                      }
                      value={(details[spec.key] as string) ?? ""}
                      onChange={(e) =>
                        setDetails((d) => ({
                          ...d,
                          [spec.key]: e.target.value || undefined,
                        }))
                      }
                    />
                  )}
                </FormField>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-slate-200 p-3">
          <p className="mb-1 text-sm font-medium text-slate-700">Documents</p>
          {(cat?.documents.length ?? 0) > 0 && (
            <p className="mb-2 text-xs text-slate-500">
              Helpful for this type:{" "}
              {cat!.documents.map((d) => d.label).join(", ")}.
            </p>
          )}
          <Button variant="outline" size="sm" asChild className="cursor-pointer">
            <label>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Add a photo or PDF
              <input
                type="file"
                className="hidden"
                accept=".pdf,.jpg,.jpeg,.png,image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = "";
                  if (file) setFiles((s) => [...s, { file, label: file.name }]);
                }}
              />
            </label>
          </Button>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((x, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-2 text-sm text-slate-700"
                >
                  <span className="truncate">{x.file.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-slate-400 hover:text-slate-700"
                    aria-label="Remove"
                    title="Remove this file"
                    onClick={() =>
                      setFiles((s) => s.filter((_, j) => j !== i))
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <FormField label="Anything else we should know?">
          <Textarea
            rows={3}
            value={f.note}
            onChange={(e) => set("note", e.target.value)}
          />
        </FormField>

        <p className="text-xs text-slate-500">
          We will come back with the premium and exactly what you earn. Nothing
          is booked until the customer accepts and Agastya issues the policy.
        </p>
      </div>
    </FormPage>
  );
}
