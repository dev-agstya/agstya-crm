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
import { formatDate, formatINR, rupeesToPaise } from "../../lib/format";
import {
  ClaimStageBadge, DetailRow, DocumentList, ListShell, MobileCard,
  SectionCard, Timeline,
} from "./shared";

/*
  Claims — report an incident, then watch it.

  Raising one with photos attached, at the scene, is most of the value, so the
  form asks for as little as possible and lets the documents follow.

  A claim never touches money in this app: the settled amount is shown because
  the partner and the customer will ask, not because the agency's books care.
  The money moves between the insurer and the customer.
*/

/* -------------------------------------------------------------------- list -- */

export function PortalClaimsPage() {
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["portal", "claims"],
    queryFn: async () => (await portalApi.claims({ page_size: 50 })).data,
  });
  const rows = list.data?.items ?? [];

  return (
    <div>
      <PageHeader title="Claims"
        subtitle="Incidents you have reported, and where each one has got to."
        actions={
          <button className="btn-primary"
            onClick={() => navigate("/portal/claims/new")}>
            <Icon.Plus size={16} /> Report a claim
          </button>
        } />

      {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
        <div className="card card-body"><TableSkeleton cols={4} /></div>
      ) : (
        <ListShell
          empty={rows.length === 0 ? (
            <EmptyState
              icon={<Icon.Shield size={20} />}
              title="No claims"
              hint="If something happens on a policy of yours, report it here
                with photos and we will take it from there." />
          ) : undefined}
          cards={rows.map((c) => (
            <MobileCard key={c.id} to={`/portal/claims/${c.id}`}
              title={c.customer_name || c.policy_number || c.code}
              meta={<>{c.category_label} · {c.code}</>}
              right={<ClaimStageBadge stage={c.stage} />}
              footer={
                <span className="flex items-center justify-between gap-2">
                  <span>Incident {formatDate(c.incident_at)}</span>
                  {c.settled_amount > 0 && (
                    <span className="font-semibold text-money-in">
                      Settled {formatINR(c.settled_amount)}</span>
                  )}
                </span>
              } />
          ))}
          table={
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Policy</th>
                  <th>Incident</th>
                  <th>Claim no.</th>
                  <th className="num">Settled</th>
                  <th>Stage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="row-link"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") navigate(`/portal/claims/${c.id}`);
                    }}
                    onClick={() => navigate(`/portal/claims/${c.id}`)}>
                    <td>
                      <span className="font-medium text-slate-900">
                        {c.customer_name || "—"}</span>
                      <span className="block text-xs text-slate-500">
                        {c.code}</span>
                    </td>
                    <td>{c.policy_number || "—"}</td>
                    <td className="whitespace-nowrap">
                      {formatDate(c.incident_at)}</td>
                    <td>{c.insurer_claim_no || "—"}</td>
                    <td className="num">
                      {c.settled_amount
                        ? formatINR(c.settled_amount) : "—"}</td>
                    <td><ClaimStageBadge stage={c.stage} /></td>
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
  const missing = isAxiosError(claim.error)
    && claim.error.response?.status === 404;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["portal", "claim", id] });
    qc.invalidateQueries({ queryKey: ["portal", "claims"] });
  };

  const send = useMutation({
    mutationFn: () => portalApi.replyOnClaim(id, reply.trim()),
    onSuccess: () => { setReply(""); toast.success("Sent."); refresh(); },
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
  const outstanding = (c?.required_documents ?? [])
    .filter((d) => !sent.has(d.key));

  return (
    <RecordPage
      backTo="/portal/claims"
      backLabel="Back to claims"
      title={c ? (c.customer_name || c.code) : "Claim"}
      documentTitle={c?.code ?? "Claim"}
      subtitle={c ? `${c.category_label ?? ""} · policy ${
        c.policy_number ?? ""}` : undefined}
      meta={c && <span className="chip">{c.code}</span>}
      badges={c && <ClaimStageBadge stage={c.stage} />}
      loading={claim.isLoading}
      error={missing ? undefined : claim.error}
      onRetry={() => claim.refetch()}
      notFound={missing}
    >
      {c && (
        <div className="space-y-4">
          {c.stage === "docs_pending" && outstanding.length > 0 && (
            <div className="rounded-control border border-due/25 bg-due/10
              px-4 py-3">
              <p className="text-sm font-medium text-due">
                Still needed</p>
              <ul className="mt-1 list-inside list-disc text-sm text-due">
                {outstanding.map((d) => <li key={d.key}>{d.label}</li>)}
              </ul>
            </div>
          )}

          {c.settled_amount > 0 && (
            <div className="card px-4 py-4 sm:px-5">
              <p className="text-caption font-semibold uppercase text-slate-500">
                Settled</p>
              <p className="mt-1 text-metric-sm tabular-nums text-money-in">
                {formatINR(c.settled_amount)}</p>
              {c.settled_at && (
                <p className="text-xs text-slate-500">
                  on {formatDate(c.settled_at)}</p>
              )}
            </div>
          )}
          {c.rejection_reason && (
            <div className="rounded-control border border-money-out/25 bg-money-out/10 px-4
              py-3 text-sm text-money-out">
              Rejected: {c.rejection_reason}
            </div>
          )}

          <SectionCard title="The claim">
            <DetailRow label="Policy">
              <Link to={`/portal/policies/${c.policy_id}`}
                className="underline">{c.policy_number || "Open policy"}</Link>
            </DetailRow>
            <DetailRow label="Customer">{c.customer_name || "—"}</DetailRow>
            <DetailRow label="Incident on">
              {formatDate(c.incident_at)}</DetailRow>
            {c.incident_location && (
              <DetailRow label="Where">{c.incident_location}</DetailRow>
            )}
            <DetailRow label="What happened">{c.description}</DetailRow>
            {c.estimated_loss > 0 && (
              <DetailRow label="Estimated loss">
                {formatINR(c.estimated_loss)}</DetailRow>
            )}
            {c.insurer_claim_no && (
              <DetailRow label="Insurer claim no.">
                {c.insurer_claim_no}</DetailRow>
            )}
            {c.settlement_mode && (
              <DetailRow label="Settlement">
                {c.settlement_mode === "cashless"
                  ? "Cashless" : "Reimbursement"}</DetailRow>
            )}
            {c.surveyor_name && (
              <DetailRow label="Surveyor">{c.surveyor_name}</DetailRow>
            )}
            {c.approved_amount > 0 && (
              <DetailRow label="Approved">
                {formatINR(c.approved_amount)}</DetailRow>
            )}
          </SectionCard>

          <SectionCard title="Documents"
            action={
              <label className={`btn-secondary btn-sm cursor-pointer${
                busy ? " pointer-events-none opacity-50" : ""}`}>
                {busy ? <Spinner className="h-4 w-4" />
                  : <><Icon.Upload size={14} /> Add</>}
                <input type="file" className="hidden"
                  accept=".pdf,.jpg,.jpeg,.png,image/*" disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.currentTarget.value = "";
                    if (file) upload(file, file.name);
                  }} />
              </label>
            }>
            <DocumentList documents={c.documents}
              onOpen={() => toast.error(
                "Ask your relationship manager for a copy of this document.")}
              emptyLabel="Nothing attached yet." />
          </SectionCard>

          <SectionCard title="Progress">
            <Timeline events={c.timeline} />
            <div className="mt-4 border-t border-line/70 pt-4">
              <Field label="Message Agastya">
                <textarea className="input" rows={3} value={reply}
                  placeholder="An update, or a question…"
                  onChange={(e) => setReply(e.target.value)} />
              </Field>
              <button className="btn-primary mt-2 w-full sm:w-auto"
                disabled={!reply.trim() || send.isPending}
                onClick={() => send.mutate()}>
                {send.isPending ? <Spinner className="h-4 w-4" /> : "Send"}
              </button>
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
    incident_at: "", incident_location: "", description: "",
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
          ? rupeesToPaise(parseFloat(f.estimated_loss)) : 0,
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
        <Field label="Which policy" required>
          <select className="select" value={f.policy_id} required
            onChange={(e) => set("policy_id", e.target.value)}>
            <option value="">Select…</option>
            {(policies.data?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.policy_number || p.code} — {p.customer_name || "—"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="When did it happen" required>
          <DateInput value={f.incident_at} required
            onChange={(v) => set("incident_at", v)} />
        </Field>
        <Field label="Where" hint="Optional — the place, road or hospital.">
          <input className="input" value={f.incident_location}
            onChange={(e) => set("incident_location", e.target.value)} />
        </Field>
        <Field label="What happened" required>
          <textarea className="input" rows={4} value={f.description} required
            placeholder="A few lines is enough."
            onChange={(e) => set("description", e.target.value)} />
        </Field>
        <Field label="Rough cost, if you know it (₹)"
          hint="An estimate. Nobody is held to it.">
          <input type="number" inputMode="decimal" step="0.01" min="0"
            className="input" value={f.estimated_loss}
            onChange={(e) => set("estimated_loss", e.target.value)} />
        </Field>

        <div className="rounded-control border border-line p-3">
          <p className="mb-2 text-sm font-medium text-slate-600">
            Photos and documents</p>
          <label className="btn-secondary w-full cursor-pointer sm:w-auto">
            <Icon.Upload size={16} /> Add from your phone
            <input type="file" className="hidden" multiple
              accept=".pdf,.jpg,.jpeg,.png,image/*"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.currentTarget.value = "";
                setFiles((s) => [...s, ...picked]);
              }} />
          </label>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((file, i) => (
                <li key={i} className="flex items-center justify-between gap-2
                  text-sm text-slate-700">
                  <span className="truncate">{file.name}</span>
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
      </div>
    </FormPage>
  );
}
