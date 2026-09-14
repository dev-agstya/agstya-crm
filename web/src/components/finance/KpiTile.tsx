import { Sparkline, C } from "./charts";

// A modern KPI tile: label, big value, optional delta pill and sparkline.
export function KpiTile({ label, value, delta, spark, sparkColor, accent, sub,
  tone }: {
  label: string;
  value: string;
  delta?: number | null; // percent change vs previous
  spark?: number[];
  sparkColor?: string;
  accent?: string; // left accent bar color
  sub?: React.ReactNode;
  tone?: string; // value colour class (e.g. sign rule)
}) {
  const up = (delta ?? 0) >= 0;
  return (
    <div className="card relative overflow-hidden p-4">
      {accent && (
        <span className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} />
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* Caption / big figure / sub-caption — the KPI tile from the design
              system. Secondary text is slate-500, not slate-400: the muted grey
              was unreadable on a white card (owner Q4.4). */}
          <p className="truncate text-caption font-semibold uppercase
            text-slate-500">{label}</p>
          <p className={`mt-1.5 text-metric tabular-nums
            tracking-tight ${tone ?? "text-slate-900"}`}>{value}</p>
          {sub && (
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{sub}</p>
          )}
        </div>
        {delta != null && (
          <span className={`badge shrink-0 ring-1 ring-inset ${
            up ? "bg-money-in/10 text-money-in ring-money-in/20"
              : "bg-money-out/10 text-money-out ring-money-out/20"}`}>
            {up ? "+" : "−"}{Math.abs(delta)}%
          </span>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className="mt-2 -mb-1">
          <Sparkline data={spark} color={sparkColor ?? C.green} width={220}
            height={34} />
        </div>
      )}
    </div>
  );
}
