import { Icon } from "./Icon";
import { formatINR } from "../lib/format";

/*
  Target attainment, drawn the same way everywhere it appears.

  FIVE surfaces read a target: the employee's dashboard, the owner's team
  roll-up, the manager's own number on the Team tab, each partner's row on that
  tab, and the partner's own portal home. They were on the way to being five
  slightly different bar charts — the dashboard already had one hand-rolled
  inline, the Targets body another with a different colour ramp and a different
  rounding rule, so the same 99.6% read as "100%" on one screen and "99%" on the
  next.

  So the drawing lives here, once, and every caller hands it rows. It makes no
  visibility decision of its own: the server has already stripped any metric the
  viewer may not see (house profit is owner-side — services/targets), so
  whatever arrives is renderable.

  MONOCHROME, with one exception. The design system's rule is that hierarchy
  comes from type and space, not colour — but a target is the one thing on these
  pages that is genuinely binary (you hit it or you did not), and the money
  colours already mean exactly that. Green at 100, amber in the run-up, plain
  slate below: three states, matching the rest of the app.
*/

/** The shape every caller shares — the server's TargetMetricRow. */
export interface MetricRow {
  metric: string;
  label: string;
  is_money: boolean;
  target_value: number;
  actual_value: number;
  attainment_pct: number;
}

/** One rounding rule, so two screens can never disagree about the same figure. */
export const pctLabel = (pct: number) => `${Math.max(0, Math.round(pct))}%`;

export const fmtMetric = (isMoney: boolean, v: number) =>
  isMoney ? formatINR(v) : String(Math.round(v));

type Tone = "done" | "close" | "behind";

export function toneFor(pct: number): Tone {
  if (pct >= 100) return "done";
  if (pct >= 70) return "close";
  return "behind";
}

const BAR: Record<Tone, string> = {
  done: "bg-money-in",
  close: "bg-due",
  behind: "bg-slate-400",
};

const TEXT: Record<Tone, string> = {
  done: "text-money-in",
  close: "text-due",
  behind: "text-slate-700",
};

/**
 * The headline percentage. Big, tabular, and coloured by state.
 *
 * `size` is the only thing that varies between callers — a dashboard card wants
 * it loud, a table row wants it to sit next to a name.
 */
export function AttainmentPct({ pct, size = "md" }: {
  pct: number; size?: "sm" | "md" | "lg";
}) {
  const tone = toneFor(pct);
  const cls = size === "lg" ? "text-metric"
    : size === "sm" ? "text-sm font-semibold" : "text-metric-sm";
  return (
    <span className={`tabular-nums ${cls} ${TEXT[tone]}`}
      title="Attainment — percentage of this period's target reached so far">
      {pctLabel(pct)}
    </span>
  );
}

const RING: Record<Tone, string> = {
  done: "stroke-money-in",
  close: "stroke-due",
  behind: "stroke-slate-400",
};

/**
 * Attainment as a ring.
 *
 * A percentage set in type is a number you have to READ; a ring is a shape you
 * recognise across a grid of thirty people without reading any of them. That is
 * the whole job on the Targets roster, so the ring is the headline there and
 * the bars are the detail underneath.
 *
 * Same three tones and the same `pctLabel` rounding as every other surface —
 * this is a second RENDERING of the one rule, never a second rule.
 */
export function TargetRing({ pct, size = 64, stroke = 6, label }: {
  pct: number;
  size?: number;
  stroke?: number;
  /** A short word under the figure ("of goal"), when there is room for it. */
  label?: string;
}) {
  const tone = toneFor(pct);
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  // The ARC caps at 100 while the LABEL does not: beating a goal by half is
  // worth reading, and a ring that wraps past its own start reads as 40%.
  const filled = Math.min(100, Math.max(0, pct)) / 100;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          strokeWidth={stroke} className="stroke-slate-100" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          strokeWidth={stroke} strokeLinecap="round"
          className={`${RING[tone]} transition-[stroke-dashoffset] duration-700`}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - filled)} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center
        justify-center">
        <span className={`tabular-nums font-semibold leading-none ${TEXT[tone]}`}
          style={{ fontSize: Math.max(11, size * 0.26) }}
          title="Attainment — percentage of this period's target reached so far">
          {pctLabel(pct)}
        </span>
        {label && size >= 60 && (
          <span className="mt-0.5 text-[9px] uppercase tracking-wide
            text-slate-400">{label}</span>
        )}
      </div>
    </div>
  );
}

/**
 * One goal: what it is, how far along, and the two numbers behind the bar.
 *
 * The bar is capped at 100% of its track while the LABEL is not — beating a
 * target by half is worth reading, and a bar that overflows its container is
 * just a broken bar.
 */
export function MetricBar({ row, compact = false }: {
  row: MetricRow; compact?: boolean;
}) {
  const tone = toneFor(row.attainment_pct);
  const width = Math.min(100, Math.max(0, row.attainment_pct));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`font-medium text-slate-600 ${
          compact ? "text-xs" : "text-sm"}`}>{row.label}</span>
        <span className="text-xs tabular-nums text-slate-500">
          {fmtMetric(row.is_money, row.actual_value)}
          <span className="text-slate-500">
            {" of "}{fmtMetric(row.is_money, row.target_value)}
          </span>
        </span>
      </div>
      <div className={`mt-1.5 w-full overflow-hidden rounded-full bg-slate-100
        ${compact ? "h-1.5" : "h-2.5"}`}>
        <div className={`h-full rounded-full ${BAR[tone]}
          transition-[width] duration-700`}
          // A 2% floor so "started, barely" is visibly different from "nothing
          // yet" — a zero-width bar and an empty track look identical.
          style={{ width: `${row.attainment_pct > 0
            ? Math.max(2, width) : 0}%` }} />
      </div>
    </div>
  );
}

export function MetricBars({ rows, compact = false }: {
  rows: MetricRow[]; compact?: boolean;
}) {
  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {rows.map((r) => (
        <MetricBar key={r.metric} row={r} compact={compact} />
      ))}
    </div>
  );
}

/**
 * The whole card: a heading, the headline percentage, and the bars.
 *
 * `right` is where a caller hangs a month switcher. `empty` is what shows when
 * nobody has been given a number — deliberately a sentence rather than a hidden
 * card (owner D4): an employee who has not been set a target should know that,
 * not wonder where the card went.
 */
export function TargetCard({
  title, subtitle, rows, attainmentPct, hasTarget, right, empty, footer,
  className = "",
}: {
  title: string;
  subtitle?: React.ReactNode;
  rows: MetricRow[];
  attainmentPct: number;
  hasTarget: boolean;
  right?: React.ReactNode;
  empty?: string;
  footer?: React.ReactNode;
  className?: string;
}) {
  const done = hasTarget && attainmentPct >= 100;
  return (
    <section className={`card p-5 ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption uppercase text-slate-500">
            {done ? "Target achieved" : title}
          </p>
          {subtitle && (
            <p className="mt-0.5 truncate text-sm font-semibold text-slate-800">
              {subtitle}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {hasTarget && <AttainmentPct pct={attainmentPct} size="lg" />}
          {right}
        </div>
      </div>

      {!hasTarget || rows.length === 0 ? (
        <p className="flex items-center gap-2 py-2 text-sm text-slate-500">
          <Icon.Target size={16} className="shrink-0 text-slate-400" />
          {empty ?? "No target has been set for this period."}
        </p>
      ) : (
        <MetricBars rows={rows} />
      )}

      {footer}
    </section>
  );
}
