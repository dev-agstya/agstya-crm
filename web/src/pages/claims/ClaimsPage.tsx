import { useState } from "react";
import { AlertCircle, Clock, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormField } from "../../components/shared/FormSection";
import { DataTable, type Column } from "../../components/shared/DataTable";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { claimsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { RecordPage } from "../../components/RecordPage";
import { PersonCell, SearchInput, Segmented } from "../../components/ui";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import {
  formatDate, formatINR, fromDateInput, rupeesToPaise, toDateInput,
} from "../../lib/format";
import { useAuth } from "../../store/auth";
import {
  ClaimStageBadge, DetailRow, SectionCard, Timeline, claimStageLabel,
} from "../portal/shared";
import type { ClaimStage } from "../../lib/types";

/*
  Claims, staff side.

  A claim never touches the ledger (owner C4). The settled amount is recorded
  because the partner and the customer will ask, not because the agency's books
  care — the money moves between the insurer and the customer. Nothing on this
  page books a finance row, and that is deliberate rather than unfinished.
*/

const STAGES: ClaimStage[] = [
  "intimated", "registered", "docs_pending", "survey",
  "approved", "settled", "rejected", "closed",
];

/*
  Claims is the TWIN of the quote queue: both are work a channel partner
  raised, each has its own permission pair since 2026-08-07, and both are
  useless without a clock. They are built the same way on purpose — a queue
  that looks different depending on which one you opened is a queue people
  learn twice.

  The thresholds are not arbitrary. IRDAI expects a surveyor appointed within
  72h of a material loss and a settlement offer within 30 days of the survey
  report, so a claim still open at a week wants looking at and one open past a
  month is the agency's problem whoever is at fault.
*/
const CLAIM_WARN_DAYS = 7;
const CLAIM_LATE_DAYS = 30;

type ClaimScope = "open" | "all";

/** A settled or closed claim has stopped the clock; nothing else has. */
function claimUrgency(days: number, stage: string): "calm" | "warn" | "late" {
  if (["settled", "closed", "rejected"].includes(stage)) return "calm";
  if (days >= CLAIM_LATE_DAYS) return "late";
  if (days >= CLAIM_WARN_DAYS) return "warn";
  return "calm";
}

export function ClaimsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<ClaimScope>("open");

  const list = useQuery({
    queryKey: ["claims", page, q, scope],
    queryFn: async () => (await claimsApi.list({
      page, page_size: 20, q: q || undefined, open_only: scope === "open",
    })).data,
  });
  const rows = list.data?.items ?? [];
  const late = rows.filter(
    (c) => claimUrgency(c.age_days, c.stage) === "late").length;

  return (
    <div>
      <PageHeader
        title="Claims"
        actions={late > 0 ? (
          <Badge variant="destructive" className="gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {late} open past {CLAIM_LATE_DAYS} days
          </Badge>
        ) : undefined} />

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<ClaimScope>
            value={scope}
            onChange={(v) => { setScope(v); setPage(1); }}
            options={[
              { value: "open", label: "Open" },
              { value: "all", label: "All" },
            ]} />
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }}
            placeholder="Claim, policy, customer…"
            className="max-w-xs flex-1" />
        </div>
        <DataTable
          data={rows}
          columns={[
            {
              key: "claim",
              header: "Claim",
              cell: (c) => {
                const tone = claimUrgency(c.age_days, c.stage);
                return (
                  <div
                    className={
                      tone === "late"
                        ? "border-l-2 border-red-500 pl-2"
                        : tone === "warn"
                        ? "border-l-2 border-amber-500 pl-2"
                        : ""
                    }
                  >
                    <p className="font-medium text-slate-900">
                      {c.customer_name || "—"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {c.code} · {c.policy_number || "no policy"}
                    </p>
                  </div>
                );
              },
            },
            {
              key: "reportedBy",
              header: "Reported by",
              cell: (c) =>
                c.raised_by_name ? (
                  <PersonCell
                    name={c.raised_by_name}
                    size="xs"
                    badges={
                      c.raised_by_side === "partner" ? (
                        <Badge variant="secondary" className="text-[11px]">
                          partner
                        </Badge>
                      ) : undefined
                    }
                  />
                ) : (
                  <span className="text-slate-500">—</span>
                ),
            },
            {
              key: "openFor",
              header: "Open for",
              cell: (c) => {
                const tone = claimUrgency(c.age_days, c.stage);
                return (
                  <div className="whitespace-nowrap">
                    <Badge
                      variant={
                        tone === "late"
                          ? "destructive"
                          : tone === "warn"
                          ? "outline"
                          : "secondary"
                      }
                      className={
                        tone === "warn"
                          ? "border-amber-300 bg-amber-50 text-amber-800"
                          : ""
                      }
                    >
                      {tone !== "calm" && <Clock className="mr-1 h-3 w-3" />}
                      {c.age_days}d
                    </Badge>
                    <p className="mt-0.5 text-xs text-slate-500">
                      since {formatDate(c.incident_at)}
                    </p>
                  </div>
                );
              },
            },
            {
              key: "settled",
              header: "Settled",
              align: "right",
              cell: (c) =>
                c.settled_amount ? (
                  <span className="font-semibold tabular-nums text-emerald-700">
                    {formatINR(c.settled_amount)}
                  </span>
                ) : (
                  <span className="text-slate-400">—</span>
                ),
            },
            {
              key: "stage",
              header: "Stage",
              cell: (c) => <ClaimStageBadge stage={c.stage} />,
            },
          ] as Column<(typeof rows)[number]>[]}
          keyField={(c) => c.id}
          loading={list.isLoading}
          error={list.error ? "Could not load claims." : null}
          onRetry={() => list.refetch()}
          onRowClick={(c) => navigate(`/claims/${c.id}`)}
          emptyTitle="No claims"
          emptyDescription="Claims reported by channel partners, or recorded here by the team, appear in this queue."
          page={page}
          pageSize={20}
          total={list.data?.total ?? 0}
          onPageChange={setPage}
          renderMobileCard={(c) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="truncate font-medium text-slate-900">
                  {c.customer_name || c.code}
                </p>
                <p className="text-xs text-slate-500">
                  {c.code} · {c.policy_number || "no policy"}
                </p>
                <p className="text-xs text-slate-500">
                  Open {c.age_days}d · since {formatDate(c.incident_at)}
                </p>
              </div>
              {c.settled_amount ? (
                <span className="whitespace-nowrap font-semibold tabular-nums text-emerald-700">
                  {formatINR(c.settled_amount)}
                </span>
              ) : (
                <ClaimStageBadge stage={c.stage} />
              )}
            </div>
          )}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ detail -- */

export function ClaimDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { has } = useAuth();
  const canManage = has("manage_claims");
  const [message, setMessage] = useState("");

  const claim = useQuery({
    queryKey: ["claim", id],
    retry: false,
    queryFn: async () => (await claimsApi.get(id)).data,
  });
  const c = claim.data;
  const missing = isAxiosError(claim.error)
    && claim.error.response?.status === 404;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["claim", id] });
    qc.invalidateQueries({ queryKey: ["claims"] });
  };

  const move = useMutation({
    mutationFn: (stage: ClaimStage) =>
      claimsApi.setStage(id, stage, message.trim() || undefined),
    onSuccess: () => { setMessage(""); toast.success("Updated."); refresh(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <RecordPage
      backTo="/claims"
      backLabel="Back to claims"
      title={c ? (c.customer_name || c.code) : "Claim"}
      documentTitle={c?.code ?? "Claim"}
      subtitle={c ? `Policy ${c.policy_number ?? "—"} · ${
        c.category_label ?? ""}` : undefined}
      meta={c && <span className="chip">{c.code}</span>}
      badges={c && <ClaimStageBadge stage={c.stage} />}
      loading={claim.isLoading}
      error={missing ? undefined : claim.error}
      onRetry={() => claim.refetch()}
      notFound={missing}
    >
      {c && (
        <div className="space-y-4">
          <SectionCard title="The incident">
            <DetailRow label="Reported by">
              {c.raised_by_name || "—"}
              {c.raised_by_side === "partner" && (
                <span className="ml-2 chip">channel partner</span>
              )}
            </DetailRow>
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
            <DetailRow label="Open for">{c.age_days} days</DetailRow>
          </SectionCard>

          {canManage && <ClaimInsurerPanel claim={c} onDone={refresh} />}

          {canManage && (
            <SectionCard title="Move it on">
              <FormField label="Message to the partner"
                hint="Optional — they see this on their timeline.">
                <Input value={message}
                  onChange={(e) => setMessage(e.target.value)} />
              </FormField>
              <div className="mt-3 flex flex-wrap gap-2">
                {STAGES.filter((s) => s !== c.stage).map((s) => (
                  <Button key={s} variant="outline" size="sm"
                    disabled={move.isPending}
                    onClick={() => move.mutate(s)}>
                    {claimStageLabel(s)}
                  </Button>
                ))}
              </div>
            </SectionCard>
          )}

          <SectionCard title="Documents">
            {c.documents.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing attached.</p>
            ) : (
              <ul className="divide-y divide-line/70 rounded-control border
                border-line">
                {c.documents.map((d) => (
                  <li key={d.id}>
                    <button type="button"
                      className="flex w-full items-center justify-between gap-3
                        px-4 py-2.5 text-left hover:bg-slate-50"
                      onClick={async () => {
                        try {
                          const r = await claimsApi.documentUrl(id, d.id);
                          window.open(r.data.url, "_blank", "noopener");
                        } catch (e) { toast.error(apiError(e)); }
                      }}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium
                          text-slate-800">{d.label}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {d.filename}</span>
                      </span>
                      <Download className="h-4 w-4 shrink-0 text-slate-500" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {c.required_documents.length > 0 && (
              <p className="mt-3 text-xs text-slate-500">
                This type asks for: {c.required_documents
                  .map((d) => d.label).join(", ")}.
              </p>
            )}
          </SectionCard>

          <SectionCard title="Timeline">
            <Timeline events={c.timeline} />
          </SectionCard>
        </div>
      )}
    </RecordPage>
  );
}

/** The insurer's side. None of it moves money (owner C4). */
function ClaimInsurerPanel({ claim, onDone }: {
  claim: import("../../lib/types").StaffClaimDetail;
  onDone: () => void;
}) {
  const [f, setF] = useState({
    insurer_claim_no: claim.insurer_claim_no ?? "",
    settlement_mode: claim.settlement_mode ?? "",
    surveyor_name: claim.surveyor_name ?? "",
    surveyor_contact: claim.surveyor_contact ?? "",
    surveyor_appointed_at: toDateInput(claim.surveyor_appointed_at),
    approved_amount: claim.approved_amount
      ? String(claim.approved_amount / 100) : "",
    settled_amount: claim.settled_amount
      ? String(claim.settled_amount / 100) : "",
    rejection_reason: claim.rejection_reason ?? "",
    internal_notes: claim.internal_notes ?? "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: () => claimsApi.update(claim.id, {
      insurer_claim_no: f.insurer_claim_no || null,
      settlement_mode: f.settlement_mode || null,
      surveyor_name: f.surveyor_name || null,
      surveyor_contact: f.surveyor_contact || null,
      surveyor_appointed_at: f.surveyor_appointed_at
        ? fromDateInput(f.surveyor_appointed_at) : null,
      approved_amount: f.approved_amount
        ? rupeesToPaise(parseFloat(f.approved_amount)) : 0,
      settled_amount: f.settled_amount
        ? rupeesToPaise(parseFloat(f.settled_amount)) : 0,
      rejection_reason: f.rejection_reason || null,
      internal_notes: f.internal_notes || null,
    }),
    onSuccess: () => { toast.success("Saved."); onDone(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <SectionCard title="Insurer & assessment">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Insurer claim number">
          <Input value={f.insurer_claim_no}
            onChange={(e) => set("insurer_claim_no", e.target.value)} />
        </FormField>
        <FormField label="Settlement">
          <Select
            value={f.settlement_mode || "__none__"}
            onValueChange={(v) => set("settlement_mode", v === "__none__" ? "" : v)}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">—</SelectItem>
              <SelectItem value="cashless">Cashless</SelectItem>
              <SelectItem value="reimbursement">Reimbursement</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField label="Surveyor"
          hint="IRDAI: appoint within 72 hours on a material loss.">
          <Input value={f.surveyor_name}
            onChange={(e) => set("surveyor_name", e.target.value)} />
        </FormField>
        <FormField label="Surveyor contact">
          <Input value={f.surveyor_contact}
            onChange={(e) => set("surveyor_contact", e.target.value)} />
        </FormField>
        <FormField label="Surveyor appointed">
          <DateInput value={f.surveyor_appointed_at}
            onChange={(v) => set("surveyor_appointed_at", v)} />
        </FormField>
        <FormField label="Approved amount (₹)">
          <Input type="number" step="0.01" min="0"
            value={f.approved_amount}
            onChange={(e) => set("approved_amount", e.target.value)} />
        </FormField>
        <FormField label="Settled amount (₹)"
          hint="Recorded for the record only — it does not touch the ledger.">
          <Input type="number" step="0.01" min="0"
            value={f.settled_amount}
            onChange={(e) => set("settled_amount", e.target.value)} />
        </FormField>
        <FormField label="Rejection reason">
          <Input value={f.rejection_reason}
            onChange={(e) => set("rejection_reason", e.target.value)} />
        </FormField>
      </div>
      <div className="mt-3">
        <FormField label="Internal notes"
          hint="Staff only — the partner's claim schema has no field for this.">
          <Textarea rows={2} value={f.internal_notes}
            onChange={(e) => set("internal_notes", e.target.value)} />
        </FormField>
      </div>
      <Button className="mt-3" size="sm" disabled={save.isPending}
        onClick={() => save.mutate()}>Save</Button>
    </SectionCard>
  );
}
