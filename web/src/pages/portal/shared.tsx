import { ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { formatDate, formatINR } from "../../lib/format";
import type {
  ClaimStage, PortalEvent, QuoteStage,
} from "../../lib/types";

/*
  Shared building blocks for the Channel Partner portal.

  MOBILE FIRST, and that is the whole reason this file exists. The staff app is
  desktop-first and that is fine — staff sit at desks. A partner is standing
  next to a customer holding a phone, so every screen here is built at 360px and
  allowed to grow, not the other way round:

    * a list is CARDS on a phone and a table from `sm:` up (`ListShell`)
    * money is never truncated — it wraps to its own line rather than shrinking
    * tap targets are 44px, which is why the rows below are `py-3` not `py-1.5`

  Everything still uses the app's design tokens (`.card`, `.badge`, `money-in` /
  `money-out`, day-first dates) so the portal looks like the same product, not a
  bolt-on.
*/

/* ------------------------------------------------------------- stat tiles -- */

/**
 * The portal's stat tile is the APP's stat card.
 *
 * It used to be a near-copy sitting in this file, which is how the two halves
 * of the product drift: someone improves one and the other keeps the old label
 * casing and number size forever. Re-exported under the portal's own name so
 * the portal pages read naturally, but there is only one implementation.
 */
export { StatCard as StatTile, StatRow } from "../../components/ui";

/* ------------------------------------------------------------ money words -- */

/**
 * A net position said in WORDS, not just a sign.
 *
 * "Rs 18,300" with a minus in front is read wrong by half the people who see
 * it. Which direction the money goes is the thing a partner actually wants, so
 * it is the sentence and the number is the supporting detail.
 */
export function NetPosition({ net, className = "", dark = false }: {
  net: number;
  className?: string;
  /** On the ink hero card, where the money colours need to lift off black. */
  dark?: boolean;
}) {
  const settled = net === 0;
  const owedToThem = net > 0;
  const tone = dark
    ? (settled ? "text-white" : owedToThem ? "text-money-in" : "text-money-out")
    : (settled ? "text-slate-900"
      : owedToThem ? "text-money-in" : "text-money-out");
  return (
    <div className={className}>
      <p className={`text-caption uppercase ${dark
        ? "text-white/45" : "text-slate-500"}`}>
        {settled ? "You are all square"
          : owedToThem ? "Agastya owes you" : "You owe Agastya"}
      </p>
      {/* On the figure ladder, not beside it. This was `text-[2rem]` /
          `sm:text-[2.5rem]` with its own `tracking-[-0.025em]` — a fourth and
          fifth figure size on the single most important number a partner ever
          sees, when the scale has exactly three steps and says so. */}
      <p className={`mt-1.5 break-words text-metric tabular-nums
        sm:text-metric-lg ${tone}`}>
        {formatINR(Math.abs(net))}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- stages -- */

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
  submitted: "bg-slate-100 text-slate-700",
  in_review: "bg-slate-100 text-slate-700",
  info_needed: "bg-due/15 text-due",
  quoted: "bg-money-in/10 text-money-in",
  accepted: "bg-money-in/10 text-money-in",
  issued: "bg-money-in/10 text-money-in",
  declined: "bg-money-out/15 text-money-out",
  lost: "bg-slate-100 text-slate-600",
  cancelled: "bg-slate-100 text-slate-600",
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
  intimated: "bg-slate-100 text-slate-700",
  registered: "bg-slate-100 text-slate-700",
  docs_pending: "bg-due/15 text-due",
  survey: "bg-slate-100 text-slate-700",
  approved: "bg-money-in/10 text-money-in",
  settled: "bg-money-in/10 text-money-in",
  rejected: "bg-money-out/15 text-money-out",
  closed: "bg-slate-100 text-slate-600",
};

export function QuoteStageBadge({ stage }: { stage: QuoteStage }) {
  return (
    <span className={`badge ${QUOTE_STAGE_TONES[stage]
      ?? "bg-slate-100 text-slate-700"}`}>
      {QUOTE_STAGE_LABELS[stage] ?? stage}
    </span>
  );
}

export function ClaimStageBadge({ stage }: { stage: ClaimStage }) {
  return (
    <span className={`badge ${CLAIM_STAGE_TONES[stage]
      ?? "bg-slate-100 text-slate-700"}`}>
      {CLAIM_STAGE_LABELS[stage] ?? stage}
    </span>
  );
}

export const quoteStageLabel = (s: QuoteStage) => QUOTE_STAGE_LABELS[s] ?? s;
export const claimStageLabel = (s: ClaimStage) => CLAIM_STAGE_LABELS[s] ?? s;

/* -------------------------------------------------------------- timelines -- */

/**
 * What has happened, in order, with a clear side to each entry.
 *
 * A partner must never have to work out whether "Rahul" is one of us — the
 * alignment and the colour say it, and the name is the detail.
 */
export function Timeline({ events }: { events: PortalEvent[] }) {
  if (!events.length) {
    return <p className="text-sm text-slate-500">Nothing has happened yet.</p>;
  }
  return (
    <ol className="space-y-3">
      {[...events].reverse().map((e, i) => {
        const mine = e.by_side === "partner";
        return (
          <li key={i} className="flex gap-3">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${mine
              ? "bg-slate-300" : "bg-ink"}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-800">{e.message}</p>
              <p className="text-xs text-slate-500">
                {mine ? "You" : (e.by_name || "Agastya")}
                {" · "}{formatDate(e.at)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ lists -- */

/*
  `ListShell` and `MobileCard` MOVED to components/ui.tsx (2026-08-07).

  They were the best thing in this file and the staff app could not reach them,
  which is why 30 staff tables had no phone rendering at all. Re-exported here
  so the portal pages keep reading naturally — same arrangement as `StatTile`
  above, and for the same reason: one implementation, two names.
*/
export { ListShell, MobileCard } from "../../components/ui";

/** The money figure on a card — always its own line, never truncated. */
export function CardMoney({ label, value, tone }: {
  label: string; value: number; tone?: "in" | "out";
}) {
  return (
    <>
      <p className="text-caption uppercase text-slate-500">{label}</p>
      <p className={`whitespace-nowrap text-sm font-semibold tabular-nums ${
        tone === "in" ? "text-money-in"
          : tone === "out" ? "text-money-out" : "text-slate-900"}`}>
        {formatINR(value)}
      </p>
    </>
  );
}

/* -------------------------------------------------------------- documents -- */

export function DocumentList({ documents, onOpen, emptyLabel }: {
  documents: { id: string; label: string; filename: string;
    created_at: string }[];
  onOpen: (id: string) => void;
  emptyLabel?: string;
}) {
  if (!documents.length) {
    return (
      <p className="text-sm text-slate-500">
        {emptyLabel ?? "No documents yet."}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line/70 rounded-control border border-line">
      {documents.map((d) => (
        <li key={d.id}>
          <button type="button" onClick={() => onOpen(d.id)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3
              text-left transition-colors active:bg-slate-50
              hover:bg-slate-50">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium
                text-slate-800">{d.label}</span>
              <span className="block truncate text-xs text-slate-500">
                {d.filename} · {formatDate(d.created_at)}
              </span>
            </span>
            <span className="shrink-0 text-slate-500">
              <Icon.Download size={18} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ misc -- */

export function SectionCard({ title, action, children }: {
  title: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2
        border-b border-line px-4 py-3 sm:px-5">
        <h2 className="text-card-title text-slate-900">{title}</h2>
        {action}
      </div>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

/** A row of label + value that stacks on a phone. */
export function DetailRow({ label, children }: {
  label: string; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line/70 py-2.5
      last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span className="text-xs uppercase tracking-wide text-slate-500
        sm:text-sm sm:normal-case sm:tracking-normal">{label}</span>
      <span className="break-words text-sm font-medium text-slate-800
        sm:text-right">{children}</span>
    </div>
  );
}
