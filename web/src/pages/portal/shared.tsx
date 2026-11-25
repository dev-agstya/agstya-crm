import { ReactNode } from "react";
import { Download } from "lucide-react";
import { formatDate, formatINR } from "../../lib/format";
import type { ClaimStage, PortalEvent, QuoteStage } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export function NetPosition({
  net,
  className = "",
  dark = false,
}: {
  net: number;
  className?: string;
  dark?: boolean;
}) {
  const settled = net === 0;
  const owedToThem = net > 0;
  const tone = dark
    ? settled
      ? "text-white"
      : owedToThem
        ? "text-emerald-400"
        : "text-red-400"
    : settled
      ? "text-foreground"
      : owedToThem
        ? "text-emerald-700"
        : "text-destructive";
  return (
    <div className={className}>
      <p
        className={`text-[11px] font-medium uppercase tracking-wide ${
          dark ? "text-white/60" : "text-muted-foreground"
        }`}
      >
        {settled
          ? "You are all square"
          : owedToThem
            ? "Agastya owes you"
            : "You owe Agastya"}
      </p>
      <p
        className={`mt-1 break-words text-2xl font-bold tabular-nums sm:text-3xl ${tone}`}
      >
        {formatINR(Math.abs(net))}
      </p>
    </div>
  );
}

const QUOTE_STAGE_LABELS: Record<QuoteStage, string> = {
  submitted: "Submitted",
  in_review: "Being reviewed",
  info_needed: "We need something",
  quoted: "Quotation ready",
  accepted: "Accepted",
  issued: "Policy issued",
  declined: "Declined",
  lost: "Not taken",
  cancelled: "Cancelled",
};

const QUOTE_STAGE_TONES: Record<QuoteStage, string> = {
  submitted: "bg-muted text-foreground border-border",
  in_review: "bg-muted text-foreground border-border",
  info_needed: "bg-amber-50 text-amber-800 border-amber-200",
  quoted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  accepted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  issued: "bg-emerald-50 text-emerald-700 border-emerald-200",
  declined: "bg-red-50 text-destructive border-destructive/30",
  lost: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-muted text-muted-foreground border-border",
};

const CLAIM_STAGE_LABELS: Record<ClaimStage, string> = {
  intimated: "Reported",
  registered: "Registered",
  docs_pending: "Documents needed",
  survey: "Under survey",
  approved: "Approved",
  settled: "Settled",
  rejected: "Rejected",
  closed: "Closed",
};

const CLAIM_STAGE_TONES: Record<ClaimStage, string> = {
  intimated: "bg-muted text-foreground border-border",
  registered: "bg-muted text-foreground border-border",
  docs_pending: "bg-amber-50 text-amber-800 border-amber-200",
  survey: "bg-muted text-foreground border-border",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  settled: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-destructive border-destructive/30",
  closed: "bg-muted text-muted-foreground border-border",
};

export function QuoteStageBadge({ stage }: { stage: QuoteStage }) {
  return (
    <Badge
      variant="outline"
      className={`h-5 px-2 text-[11px] font-medium ${
        QUOTE_STAGE_TONES[stage] ?? "bg-muted text-foreground"
      }`}
    >
      {QUOTE_STAGE_LABELS[stage] ?? stage}
    </Badge>
  );
}

export function ClaimStageBadge({ stage }: { stage: ClaimStage }) {
  return (
    <Badge
      variant="outline"
      className={`h-5 px-2 text-[11px] font-medium ${
        CLAIM_STAGE_TONES[stage] ?? "bg-muted text-foreground"
      }`}
    >
      {CLAIM_STAGE_LABELS[stage] ?? stage}
    </Badge>
  );
}

export const quoteStageLabel = (s: QuoteStage) =>
  QUOTE_STAGE_LABELS[s] ?? s;
export const claimStageLabel = (s: ClaimStage) =>
  CLAIM_STAGE_LABELS[s] ?? s;

export function Timeline({ events }: { events: PortalEvent[] }) {
  if (!events.length) {
    return (
      <p className="text-xs text-muted-foreground">
        Nothing has happened yet.
      </p>
    );
  }
  return (
    <ol className="space-y-3">
      {[...events].reverse().map((e, i) => {
        const mine = e.by_side === "partner";
        return (
          <li key={i} className="flex gap-2.5">
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                mine ? "bg-muted-foreground/40" : "bg-primary"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-foreground">{e.message}</p>
              <p className="text-[11px] text-muted-foreground">
                {mine ? "You" : e.by_name || "Agastya"} · {formatDate(e.at)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function CardMoney({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "in" | "out";
}) {
  return (
    <>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`whitespace-nowrap text-sm font-semibold tabular-nums ${
          tone === "in"
            ? "text-emerald-700"
            : tone === "out"
              ? "text-destructive"
              : "text-foreground"
        }`}
      >
        {formatINR(value)}
      </p>
    </>
  );
}

export function DocumentList({
  documents,
  onOpen,
  emptyLabel,
}: {
  documents: {
    id: string;
    label: string;
    filename: string;
    created_at: string;
  }[];
  onOpen: (id: string) => void;
  emptyLabel?: string;
}) {
  if (!documents.length) {
    return (
      <p className="text-xs text-muted-foreground">
        {emptyLabel ?? "No documents yet."}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border/60 rounded-md border border-border">
      {documents.map((d) => (
        <li key={d.id}>
          <button
            type="button"
            onClick={() => onOpen(d.id)}
            className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/40"
          >
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-foreground">
                {d.label}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {d.filename} · {formatDate(d.created_at)}
              </span>
            </span>
            <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground sm:text-xs sm:normal-case sm:tracking-normal">
        {label}
      </span>
      <span className="break-words text-[13px] font-medium text-foreground sm:text-right">
        {children}
      </span>
    </div>
  );
}
