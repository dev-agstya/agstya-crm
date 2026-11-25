import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { auditApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { formatDateTime, titleCase } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { AuditEntry } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Change = { from: unknown; to: unknown };

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
  const missing =
    isAxiosError(entry.error) && entry.error.response?.status === 404;

  return (
    <RecordPage
      backTo="/audit"
      backLabel="Back to audit logs"
      title={e ? e.summary : "Audit entry"}
      documentTitle="Audit entry"
      subtitle={e ? formatDateTime(e.created_at) : undefined}
      badges={
        e && (
          <>
            <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
              {titleCase(e.action.replace(/_/g, " "))}
            </Badge>
            {e.entity_code && (
              <Badge
                variant="secondary"
                className="h-5 px-1.5 font-mono text-[11px]"
              >
                {e.entity_code}
              </Badge>
            )}
          </>
        )
      }
      loading={entry.isLoading}
      error={missing ? undefined : entry.error}
      onRetry={() => entry.refetch()}
      notFound={missing}
    >
      {e && <AuditDetailBody entry={e} isOwner={!!isOwner} />}
    </RecordPage>
  );
}

function AuditDetailBody({
  entry,
  isOwner,
}: {
  entry: AuditEntry;
  isOwner: boolean;
}) {
  const meta = (entry.meta ?? {}) as Record<string, unknown>;
  const changes = (meta.changes ?? {}) as Record<string, Change>;
  const otherMeta = Object.entries(meta).filter(
    ([k, v]) =>
      k !== "changes" &&
      v !== null &&
      v !== undefined &&
      v !== "" &&
      !(typeof v === "object" && Object.keys(v as object).length === 0)
  );

  return (
    <div className="space-y-4">
      <Card className="divide-y divide-border/60 px-4 py-1">
        <DetailRow label="Time" value={formatDateTime(entry.created_at)} />
        <DetailRow
          label="Performed by"
          value={entry.actor_name || "System"}
        />
        {entry.actor_role && (
          <DetailRow label="Role" value={titleCase(entry.actor_role)} />
        )}
        <DetailRow label="Action" value={titleCase(entry.action)} />
        {entry.entity_type && (
          <DetailRow
            label="On"
            value={`${titleCase(entry.entity_type)}${
              entry.entity_code ? ` · ${entry.entity_code}` : ""
            }`}
          />
        )}
        {isOwner && <DetailRow label="IP address" value={entry.ip_address} />}
      </Card>

      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          What happened
        </p>
        <Card className="bg-muted/30 px-4 py-3 text-xs text-foreground">
          {entry.summary}
        </Card>
      </div>

      {Object.keys(changes).length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Changes (before → after)
          </p>
          <DiffTable changes={changes} />
        </div>
      )}

      {otherMeta.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Additional detail
          </p>
          <Card className="divide-y divide-border/60 px-4 py-1">
            {otherMeta.map(([k, v]) => (
              <DetailRow
                key={k}
                label={titleCase(k)}
                value={typeof v === "object" ? JSON.stringify(v) : String(v)}
              />
            ))}
          </Card>
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
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead className="h-9 text-xs">Field</TableHead>
            <TableHead className="h-9 text-xs">Before</TableHead>
            <TableHead className="h-9 text-xs">After</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([field, c]) => (
            <TableRow key={field}>
              <TableCell className="py-2 text-xs font-medium text-foreground">
                {titleCase(field)}
              </TableCell>
              <TableCell className="py-2 text-xs text-muted-foreground line-through decoration-destructive">
                {fmtVal(c.from)}
              </TableCell>
              <TableCell className="py-2 text-xs font-medium text-emerald-700">
                {fmtVal(c.to)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4 py-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="break-words text-right text-xs font-medium text-foreground">
        {value || "—"}
      </span>
    </div>
  );
}
