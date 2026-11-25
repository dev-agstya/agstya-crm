import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Loader2, Plus, Send, Upload, X } from "lucide-react";
import { portalApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, type Column } from "../../components/shared/DataTable";
import { FormField } from "../../components/shared/FormSection";
import { FormPage, RecordPage } from "../../components/RecordPage";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatINR, rupeesToPaise } from "../../lib/format";
import type { PortalClaim } from "../../lib/types";
import {
  ClaimStageBadge,
  DetailRow,
  DocumentList,
  SectionCard,
  Timeline,
} from "./shared";

/* -------------------------------------------------------------------- list -- */

export function PortalClaimsPage() {
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["portal", "claims"],
    queryFn: async () => (await portalApi.claims({ page_size: 50 })).data,
  });
  const rows = list.data?.items ?? [];

  const columns = useMemo<Column<PortalClaim>[]>(
    () => [
      {
        key: "customer",
        header: "Customer",
        cell: (c) => (
          <div>
            <span className="font-medium text-slate-900">
              {c.customer_name || "—"}
            </span>
            <span className="block text-xs text-slate-500">{c.code}</span>
          </div>
        ),
      },
      {
        key: "policy",
        header: "Policy",
        cell: (c) => c.policy_number || "—",
      },
      {
        key: "incident",
        header: "Incident",
        cell: (c) => (
          <span className="whitespace-nowrap text-slate-600">
            {formatDate(c.incident_at)}
          </span>
        ),
      },
      {
        key: "claimNo",
        header: "Claim no.",
        cell: (c) => c.insurer_claim_no || "—",
      },
      {
        key: "settled",
        header: "Settled",
        align: "right",
        cell: (c) => (
          <span className="tabular-nums">
            {c.settled_amount ? formatINR(c.settled_amount) : "—"}
          </span>
        ),
      },
      {
        key: "stage",
        header: "Stage",
        cell: (c) => <ClaimStageBadge stage={c.stage} />,
      },
    ],
    []
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Claims"
        subtitle="Incidents you have reported, and where each one has got to."
        actions={
          <Button size="sm" onClick={() => navigate("/portal/claims/new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Report a claim
          </Button>
        }
      />

      <DataTable
        data={rows}
        columns={columns}
        keyField={(c) => c.id}
        loading={list.isLoading}
        error={list.error ? "Could not load claims." : null}
        onRetry={() => list.refetch()}
        onRowClick={(c) => navigate(`/portal/claims/${c.id}`)}
        emptyTitle="No claims"
        emptyDescription="If something happens on a policy of yours, report it here with photos and we will take it from there."
        renderMobileCard={(c) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="truncate font-medium text-slate-900">
                {c.customer_name || c.policy_number || c.code}
              </p>
              <p className="text-xs text-slate-500">
                {c.category_label} · {c.code}
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-slate-600">
                <span>Incident {formatDate(c.incident_at)}</span>
                {c.settled_amount > 0 && (
                  <span className="font-semibold text-emerald-700">
                    Settled {formatINR(c.settled_amount)}
                  </span>
                )}
              </div>
            </div>
            <ClaimStageBadge stage={c.stage} />
          </div>
        )}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ detail -- */

export function PortalClaimDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const claim = useQuery({
    queryKey: ["portal", "claim", id],
    retry: false,
    queryFn: async () => (await portalApi.claim(id)).data,
  });
  const c = claim.data;
  const missing = isAxiosError(claim.error) && claim.error.response?.status === 404;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["portal", "claim", id] });
    qc.invalidateQueries({ queryKey: ["portal", "claims"] });
  };

  const send = useMutation({
    mutationFn: () => portalApi.replyOnClaim(id, reply.trim()),
    onSuccess: () => {
      setReply("");
      toast.success("Sent.");
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const upload = async (file: File, label: string) => {
    setBusy(true);
    try {
      await portalApi.uploadClaimDocument(id, file, label);
      toast.success("Attached.");
      refresh();
    } catch (e) {
      toast.error(apiError(e, "Upload failed."));
    } finally {
      setBusy(false);
    }
  };

  const sent = new Set((c?.documents ?? []).map((d) => d.doc_key ?? ""));
  const outstanding = (c?.required_documents ?? []).filter(
    (d) => !sent.has(d.key)
  );

  return (
    <RecordPage
      backTo="/portal/claims"
      backLabel="Back to claims"
      title={c ? c.customer_name || c.code : "Claim"}
      documentTitle={c?.code ?? "Claim"}
      subtitle={
        c ? `${c.category_label ?? ""} · policy ${c.policy_number ?? ""}` : undefined
      }
      meta={c && <Badge variant="secondary">{c.code}</Badge>}
      badges={c && <ClaimStageBadge stage={c.stage} />}
      loading={claim.isLoading}
      error={missing ? undefined : claim.error}
      onRetry={() => claim.refetch()}
      notFound={missing}
    >
      {c && (
        <div className="space-y-4">
          {c.stage === "docs_pending" && outstanding.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-sm font-medium text-amber-800">Still needed</p>
              <ul className="mt-1 list-inside list-disc text-sm text-amber-700">
                {outstanding.map((d) => (
                  <li key={d.key}>{d.label}</li>
                ))}
              </ul>
            </div>
          )}

          {c.settled_amount > 0 && (
            <Card className="px-4 py-4 sm:px-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Settled
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-emerald-700">
                {formatINR(c.settled_amount)}
              </p>
              {c.settled_at && (
                <p className="text-xs text-slate-500">
                  on {formatDate(c.settled_at)}
                </p>
              )}
            </Card>
          )}

          {c.rejection_reason && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              Rejected: {c.rejection_reason}
            </div>
          )}

          <SectionCard title="The claim">
            <DetailRow label="Policy">
              <Link to={`/portal/policies/${c.policy_id}`} className="underline">
                {c.policy_number || "Open policy"}
              </Link>
            </DetailRow>
            <DetailRow label="Customer">{c.customer_name || "—"}</DetailRow>
            <DetailRow label="Incident on">
              {formatDate(c.incident_at)}
            </DetailRow>
            {c.incident_location && (
              <DetailRow label="Where">{c.incident_location}</DetailRow>
            )}
            <DetailRow label="What happened">{c.description}</DetailRow>
            {c.estimated_loss > 0 && (
              <DetailRow label="Estimated loss">
                {formatINR(c.estimated_loss)}
              </DetailRow>
            )}
            {c.insurer_claim_no && (
              <DetailRow label="Insurer claim no.">
                {c.insurer_claim_no}
              </DetailRow>
            )}
            {c.settlement_mode && (
              <DetailRow label="Settlement">
                {c.settlement_mode === "cashless"
                  ? "Cashless"
                  : "Reimbursement"}
              </DetailRow>
            )}
            {c.surveyor_name && (
              <DetailRow label="Surveyor">{c.surveyor_name}</DetailRow>
            )}
            {c.approved_amount > 0 && (
              <DetailRow label="Approved">
                {formatINR(c.approved_amount)}
              </DetailRow>
            )}
          </SectionCard>

          <SectionCard
            title="Documents"
            action={
              <Button
                variant="outline"
                size="sm"
                asChild
                className={busy ? "pointer-events-none opacity-50" : "cursor-pointer"}
              >
                <label>
                  {busy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Add
                  <input
                    type="file"
                    className="hidden"
                    accept=".pdf,.jpg,.jpeg,.png,image/*"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.currentTarget.value = "";
                      if (file) upload(file, file.name);
                    }}
                  />
                </label>
              </Button>
            }
          >
            <DocumentList
              documents={c.documents}
              onOpen={() =>
                toast.error(
                  "Ask your relationship manager for a copy of this document."
                )
              }
              emptyLabel="Nothing attached yet."
            />
          </SectionCard>

          <SectionCard title="Progress">
            <Timeline events={c.timeline} />
            <div className="mt-4 space-y-2 border-t border-slate-200 pt-4">
              <FormField label="Message Agastya">
                <Textarea
                  rows={3}
                  value={reply}
                  placeholder="An update, or a question…"
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
          </SectionCard>
        </div>
      )}
    </RecordPage>
  );
}

/* -------------------------------------------------------------------- form -- */

export function PortalClaimFormPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search] = useSearchParams();

  const policies = useQuery({
    queryKey: ["portal", "policies", "claimable"],
    queryFn: async () => (await portalApi.policies({ page_size: 100 })).data,
  });

  const [f, setF] = useState({
    policy_id: search.get("policy") ?? "",
    incident_at: "",
    incident_location: "",
    description: "",
    estimated_loss: "",
  });
  const [files, setFiles] = useState<File[]>([]);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const create = useMutation({
    mutationFn: async () => {
      const res = await portalApi.raiseClaim({
        policy_id: f.policy_id,
        incident_at: new Date(f.incident_at).toISOString(),
        incident_location: f.incident_location.trim() || undefined,
        description: f.description.trim(),
        estimated_loss: f.estimated_loss
          ? rupeesToPaise(parseFloat(f.estimated_loss))
          : 0,
      });
      for (const file of files) {
        try {
          await portalApi.uploadClaimDocument(res.data.id, file, file.name);
        } catch {
          toast.error(`Could not attach ${file.name}. Add it from the claim.`);
        }
      }
      return res;
    },
    onSuccess: ({ data }) => {
      toast.success("Reported. Agastya will pick it up.");
      qc.invalidateQueries({ queryKey: ["portal"] });
      navigate(`/portal/claims/${data.id}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const submit = () => {
    if (!f.policy_id) return toast.error("Which policy is this on?");
    if (!f.incident_at) return toast.error("When did it happen?");
    if (f.description.trim().length < 5)
      return toast.error("Please describe what happened.");
    create.mutate();
  };

  return (
    <FormPage
      backTo="/portal/claims"
      backLabel="Back to claims"
      title="Report a claim"
      subtitle="Tell us what happened. Photos now save a lot of time later."
      onSubmit={submit}
      submitLabel="Report it"
      submitting={create.isPending}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Which policy" required>
            <Select
              value={f.policy_id}
              onValueChange={(v) => set("policy_id", v)}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {(policies.data?.items ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.policy_number || p.code} — {p.customer_name || "—"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="When did it happen" required>
            <DateInput
              value={f.incident_at}
              required
              onChange={(v) => set("incident_at", v)}
            />
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Where" hint="Optional — the place, road or hospital.">
            <Input
              value={f.incident_location}
              onChange={(e) => set("incident_location", e.target.value)}
            />
          </FormField>
          <FormField
            label="Rough cost, if you know it (₹)"
            hint="An estimate. Nobody is held to it."
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={f.estimated_loss}
              onChange={(e) => set("estimated_loss", e.target.value)}
            />
          </FormField>
        </div>

        <FormField label="What happened" required>
          <Textarea
            rows={4}
            value={f.description}
            required
            placeholder="A few lines is enough."
            onChange={(e) => set("description", e.target.value)}
          />
        </FormField>

        <div className="rounded-lg border border-slate-200 p-3">
          <p className="mb-2 text-sm font-medium text-slate-700">
            Photos and documents
          </p>
          <Button variant="outline" size="sm" asChild className="cursor-pointer">
            <label>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Add from your phone
              <input
                type="file"
                className="hidden"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,image/*"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  e.currentTarget.value = "";
                  setFiles((s) => [...s, ...picked]);
                }}
              />
            </label>
          </Button>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((file, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-2 text-sm text-slate-700"
                >
                  <span className="truncate">{file.name}</span>
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
      </div>
    </FormPage>
  );
}
