import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { auditApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { formatDateTime, titleCase } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { AuditEntry } from "../../lib/types";

type Change = { from: unknown; to: unknown };

/**
 * One audit entry, as a page (this was a dialog until 2026-08-03).
 *
 * Being able to send a colleague the link to a specific change — "this is the
 * edit I mean" — is most of the reason this stopped being a popup. It needed a
 * GET /api/audit/{id} to go with it, since a page has to load its own record
 * rather than being handed one the list already had.
 */
export default function AuditDetailPage() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const isOwner = user?.account_type === "owner";

  const entry = useQuery({
    queryKey: ["audit", id],
    retry: false,
    queryFn: async () => (await auditApi.get(id)).data,
  });
  const e = entry.data;
  const missing = isAxiosError(entry.error)
    && entry.error.response?.status === 404;

  return (
    <RecordPage
      backTo="/audit"
      backLabel="Back to audit logs"
      title={e ? e.summary : "Audit entry"}
      documentTitle="Audit entry"
      subtitle={e ? formatDateTime(e.created_at) : undefined}
      badges={e && (
        <>
          <span className="chip">{titleCase(e.action.replace(/_/g, " "))}</span>
          {e.entity_code && <span className="chip">{e.entity_code}</span>}
        </>
      )}
      loading={entry.isLoading}
      error={missing ? undefined : entry.error}
      onRetry={() => entry.refetch()}
      notFound={missing}
    >
      {e && (
        <div className="max-w-3xl">
          <AuditDetailBody entry={e} isOwner={!!isOwner} />
        </div>
      )}
    </RecordPage>
  );
}

function AuditDetailBody({ entry, isOwner }: {
  entry: AuditEntry; isOwner: boolean;
}) {
  const meta = (entry.meta ?? {}) as Record<string, unknown>;
  const changes = (meta.changes ?? {}) as Record<string, Change>;
  const otherMeta = Object.entries(meta).filter(
    ([k, v]) => k !== "changes" && v !== null && v !== undefined && v !== ""
      && !(typeof v === "object" && Object.keys(v as object).length === 0));

  return (
    <div className="space-y-4">
        <div className="rounded-control border border-line p-4">
          <DetailRow label="Time" value={formatDateTime(entry.created_at)} />
          <DetailRow label="Performed by" value={entry.actor_name || "System"} />
          {entry.actor_role && (
            <DetailRow label="Role" value={titleCase(entry.actor_role)} />
          )}
          <DetailRow label="Action" value={titleCase(entry.action)} />
          {entry.entity_type && (
            // The human-facing code (CP-264JL2, EMP-0042, AG-POL-000123), never
            // the raw Mongo ObjectId — that id is a database detail, not
            // something a channel partner or employee is ever known by.
            <DetailRow label="On" value={`${titleCase(entry.entity_type)}${
              entry.entity_code ? ` · ${entry.entity_code}` : ""}`} />
          )}
          {isOwner && <DetailRow label="IP address" value={entry.ip_address} />}
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide
            text-slate-500">What happened</p>
          <p className="rounded-control bg-slate-50 p-3 text-sm text-slate-700">{entry.summary}</p>
        </div>

        {Object.keys(changes).length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide
              text-slate-500">Changes (before → after)</p>
            <DiffTable changes={changes} />
          </div>
        )}

        {otherMeta.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide
              text-slate-500">Additional detail</p>
            <div className="rounded-control border border-line p-3">
              {otherMeta.map(([k, v]) => (
                <DetailRow key={k} label={titleCase(k)}
                  value={typeof v === "object" ? JSON.stringify(v) : String(v)} />
              ))}
            </div>
          </div>
        )}

    </div>
  );
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function DiffTable({ changes }: { changes: Record<string, Change> }) {
  const rows = Object.entries(changes);
  if (rows.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-control border border-line">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="px-5 py-3">Field</th>
            <th className="px-5 py-3">Before</th>
            <th className="px-5 py-3">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([field, c]) => (
            <tr key={field} className="border-t border-line/70">
              <td className="px-5 py-3 font-medium text-slate-600">{titleCase(field)}</td>
              <td className="px-5 py-3 text-slate-500 line-through
                decoration-money-out">{fmtVal(c.from)}</td>
              <td className="px-5 py-3 font-medium text-money-in">{fmtVal(c.to)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line/70 py-2
      last:border-0">
      <span className="shrink-0 text-sm text-slate-500">{label}</span>
      <span className="break-words text-right text-sm font-medium text-slate-800">{value || "—"}</span>
    </div>
  );
}
