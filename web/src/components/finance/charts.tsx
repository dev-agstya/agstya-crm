import { useEffect, useRef, useState } from "react";
import { formatINR } from "../../lib/format";

/*
  THE CHART PALETTE — every value is a design token.

  2026-08-06 — charts were the last place a second palette survived. Because
  these are hex strings in JavaScript rather than Tailwind classes, no lint, no
  token sweep and no CSS check could see them, and they quietly carried colours
  the product had officially retired: a SECOND red (#ef4444), a THIRD amber,
  `info` blue used decoratively, and an eight-hue categorical ramp maintained to
  colour ONE bar chart. That pass replaced the lot with a six-step grey ramp.

  2026-08-19 — the owner's verdict on the result: the graphs and the circular
  diagrams read "very black and dull". They are right, and the two facts are not
  in conflict. What was wrong in August was that the hues were UNGOVERNED, not
  that they existed: six categories in six greys cannot be told apart, which is
  a legibility failure dressed up as restraint.

  So colour is back and the governance stayed:

    * The hues are TOKENS (tailwind.config.js -> colors.chart.1..8). There is
      one list, in one file, and designSystem.test.ts allows exactly it.
    * They are CATEGORICAL ONLY — which insurer, which policy type, which
      payer. A mark whose value means MONEY still uses the money colours, and
      that rule is unchanged and load-bearing (`money`/`due`/`info` below).
    * No hue in the ramp is close to one of the four semantic colours, so a
      category slice can never be misread as "received", "paid", "due" or
      "zero" — which is why a categorical palette that would normally open with
      red/green/amber opens with indigo/teal/magenta instead.
    * Every chart using the ramp carries a legend or direct labels. Colour is
      never the only cue, so the ramp does not have to survive greyscale on its
      own — though it is ordered dark-to-light so it largely does.
*/
export const C = {
  ink: "#3f3f46", inkSoft: "#9d9da5",
  // The money tokens, exactly as tailwind.config.js defines them.
  green: "#16a34a", greenSoft: "rgba(22,163,74,.18)",
  amber: "#d97706", amberSoft: "rgba(217,119,6,.18)",
  red: "#dc2626", redSoft: "rgba(220,38,38,.18)",
  grid: "currentColor",
  // A COUNT is not money. Trend lines and bars whose value is a number of
  // policies / customers / leads used `ink` and were the other half of what
  // read as dull — a graphite line on a white card. They take the first
  // categorical hue, which leaves green free to keep meaning profit on the
  // chart directly beside it.
  count: "#4f46e5",
  countSoft: "rgba(79,70,229,.18)",
};

// Categorical series, in FIXED order (never cycled past its length, except by
// catColor below). Mirrors colors.chart.1..8 in tailwind.config.js — the two
// must be edited together, and designSystem.test.ts fails if a hex appears here
// that the config does not define.
//
// The last entry is deliberately graphite: it is where "Others" lands, and a
// bucket that means "everything too small to name" should not be the brightest
// thing on the chart.
export const CAT = [
  "#4f46e5",  // indigo
  "#0d9488",  // teal
  "#db2777",  // magenta
  "#7c3aed",  // violet
  "#0891b2",  // cyan
  "#ea580c",  // orange
  "#65a30d",  // lime
  "#52525b",  // graphite — the neutral tail
];
export const catColor = (i: number) => CAT[i % CAT.length];

// Measure a container's pixel width so charts render crisp marks and easy hover.
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export type TrendPoint = { label: string; value: number; target?: number | null };

// Area + line trend for a single money series over time, with an optional dashed
// target line, gradient fill, hover crosshair + tooltip, and a zero baseline.
export function AreaTrend({ data, height = 220, color = C.green,
  valueLabel = "Earnings", format = formatINR }: {
  data: TrendPoint[]; height?: number; color?: string; valueLabel?: string;
  format?: (n: number) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const uid = useRef(`g${Math.random().toString(36).slice(2, 8)}`).current;

  if (data.length === 0)
    return <div className="py-12 text-center text-sm text-slate-500">
      No data yet.</div>;

  const pad = { t: 14, r: 14, b: 24, l: 14 };
  const iw = Math.max(1, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const vals = data.map((d) => d.value);
  const tgts = data.map((d) => d.target ?? 0);
  const max = Math.max(1, ...vals, ...tgts);
  const min = Math.min(0, ...vals);
  const range = max - min || 1;
  const x = (i: number) => pad.l + (data.length === 1 ? iw / 2
    : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ((max - v) / range) * ih;
  const zeroY = y(0);

  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.value)}`).join(" ");
  const area = `${line} L${x(data.length - 1)},${zeroY} L${x(0)},${zeroY} Z`;
  const targetLine = tgts.some((t) => t > 0)
    ? data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.target ?? 0)}`).join(" ")
    : null;

  const onMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0, bd = Infinity;
    data.forEach((_, i) => { const d = Math.abs(x(i) - px); if (d < bd) { bd = d; best = i; } });
    setHi(best);
  };

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}
      onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      {w > 0 && (
        <svg width={w} height={height} className="overflow-visible">
          <defs>
            <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {/* zero baseline */}
          <line x1={pad.l} y1={zeroY} x2={w - pad.r} y2={zeroY}
            className="text-slate-200" stroke="currentColor"
            strokeWidth="1" />
          <path d={area} fill={`url(#${uid})`} />
          <path d={line} fill="none" stroke={color} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
          {targetLine && (
            <path d={targetLine} fill="none" stroke={C.amber} strokeWidth="1.5"
              strokeDasharray="4 3" opacity="0.8" />
          )}
          {hi != null && (
            <line x1={x(hi)} y1={pad.t} x2={x(hi)} y2={height - pad.b}
              className="text-slate-300" stroke="currentColor"
              strokeWidth="1" />
          )}
          {data.map((d, i) => (
            <circle key={i} cx={x(i)} cy={y(d.value)} r={hi === i ? 4 : 0}
              fill={color} stroke="white" strokeWidth="1.5" />
          ))}
        </svg>
      )}
      {/* x labels */}
      <div className="absolute inset-x-0 bottom-0 flex text-[10px] text-slate-500"
        style={{ paddingLeft: pad.l, paddingRight: pad.r }}>
        {data.map((d, i) => (
          <div key={i} className="flex-1 text-center">
            {data.length > 8 && i % 2 ? "" : d.label}</div>
        ))}
      </div>
      {/* tooltip */}
      {hi != null && w > 0 && (
        <div className="pointer-events-none absolute z-raised -translate-x-1/2
          rounded-control bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-pop"
          style={{ left: Math.min(Math.max(x(hi), 40), w - 40), top: 0 }}>
          <div className="font-medium">{data[hi].label}</div>
          <div>{valueLabel}: {format(data[hi].value)}</div>
          {data[hi].target != null && data[hi].target! > 0 && (
            <div className="text-due/70">Target: {format(data[hi].target!)}</div>
          )}
        </div>
      )}
    </div>
  );
}

// Tiny inline trend line for KPI tiles. Stretches to its container width.
export function Sparkline({ data, color = C.green, width = 120, height = 30 }: {
  data: number[]; color?: string; width?: number; height?: number;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * width;
  const y = (v: number) => height - ((v - min) / range) * (height - 4) - 2;
  const line = data.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none" className="block">
      <path d={`${line} L${width},${height} L0,${height} Z`}
        fill={color} opacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round"
        vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Horizontal ranked bars (magnitude), one hue, value labels at the end.
export function RankedBars({ data, color = C.ink, max: maxOverride }: {
  data: { label: string; value: number; onClick?: () => void }[];
  color?: string; max?: number;
}) {
  const max = maxOverride ?? Math.max(1, ...data.map((d) => Math.abs(d.value)));
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-3 text-sm">
          <button className="w-40 shrink-0 truncate text-left text-slate-600
            hover:text-brand-700 hover:underline disabled:no-underline"
            onClick={d.onClick} disabled={!d.onClick} title={d.label}>
            {d.label}</button>
          <div className="relative h-5 flex-1 rounded bg-slate-100">
            <div className="absolute inset-y-0 left-0 rounded"
              style={{ width: `${Math.max(2, (Math.abs(d.value) / max) * 100)}%`,
                background: color }} />
          </div>
          <span className="w-24 shrink-0 text-right font-medium tabular-nums
            text-slate-700">
            {formatINR(d.value)}</span>
        </div>
      ))}
    </div>
  );
}

// Vertical grouped bars: two series (actual vs target) side by side per label.
// Drives Performance vs Target on the Finance Overview.
//
// Rebuilt 2026-07-26 after the owner's screenshot showed three of four buckets
// rendering as literally nothing — no axis, no baseline, no explanation — which
// reads as a broken chart rather than "no activity". It now draws gridlines and
// a value axis, marks a genuine zero with a hairline stub, and says so plainly
// when there is no data or no target at all.
export type GroupedPoint = { label: string; actual: number; target: number };

// "Nice" axis maximum, so ticks land on round numbers instead of 1,347.
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(value));
  const norm = value / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function GroupedBars({ data, height = 220,
  actualColor = C.green, targetColor = C.amber,
  format = formatINR, emptyHint }: {
  data: GroupedPoint[]; height?: number;
  actualColor?: string; targetColor?: string;
  format?: (n: number) => string;
  emptyHint?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  if (data.length === 0)
    return <div className="py-12 text-center text-sm text-slate-500">
      No data yet.</div>;

  const hasAny = data.some((d) => d.actual !== 0 || d.target !== 0);

  const pad = { t: 12, r: 8, b: 24, l: 52 };
  const ih = height - pad.t - pad.b;
  const max = niceMax(Math.max(...data.flatMap((d) => [d.actual, d.target]), 0));
  const iw = Math.max(1, w - pad.l - pad.r);
  const slot = iw / data.length;
  const barW = Math.min(18, slot / 3);
  const gap = 3;
  const y = (v: number) => pad.t + ih - (Math.max(0, v) / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}
      onMouseLeave={() => setHi(null)}>
      {w > 0 && (
        <svg width={w} height={height} className="overflow-visible">
          {/* Gridlines + value axis — without these a short bar has no scale. */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={pad.l} y1={y(t)} x2={w - pad.r} y2={y(t)}
                className="text-slate-100" stroke="currentColor"
                strokeWidth="1" />
              <text x={pad.l - 8} y={y(t) + 3} textAnchor="end"
                className="fill-slate-400" style={{ fontSize: 10 }}>
                {format(t)}
              </text>
            </g>
          ))}
          <line x1={pad.l} y1={pad.t + ih} x2={w - pad.r} y2={pad.t + ih}
            className="text-slate-300" stroke="currentColor" strokeWidth="1" />
          {data.map((d, i) => {
            const cx = pad.l + slot * i + slot / 2;
            const bars: [number, string][] = [
              [d.actual, actualColor], [d.target, targetColor]];
            return (
              <g key={i} onMouseEnter={() => setHi(i)}>
                <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih}
                  fill={hi === i ? "currentColor" : "transparent"}
                  className="text-slate-100" />
                {bars.map(([v, color], b) => {
                  const bx = cx + (b === 0 ? -(barW + gap / 2) : gap / 2);
                  const barH = Math.max(0, pad.t + ih - y(v));
                  // A real zero gets a 2px stub on the baseline: the reader can
                  // see the series exists and is empty, instead of guessing
                  // whether the chart failed to load.
                  return barH < 1 ? (
                    <rect key={b} x={bx} y={pad.t + ih - 2} width={barW}
                      height={2} rx={1} fill={color} opacity={0.28} />
                  ) : (
                    <rect key={b} x={bx} y={y(v)} width={barW} height={barH}
                      rx={2} fill={color}
                      opacity={hi == null || hi === i ? 1 : 0.5} />
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      <div className="absolute bottom-0 right-0 flex text-[10px] text-slate-500"
        style={{ left: pad.l, paddingRight: pad.r }}>
        {data.map((d, i) => (
          <div key={i} className="flex-1 truncate text-center">{d.label}</div>
        ))}
      </div>
      {!hasAny && (
        <div className="pointer-events-none absolute inset-0 flex items-center
          justify-center">
          <p className="rounded-control bg-white/85 px-3 py-1.5 text-xs
            text-slate-500">
            {emptyHint ?? "Nothing booked in this period."}
          </p>
        </div>
      )}
      {hi != null && w > 0 && (
        <div className="pointer-events-none absolute z-raised -translate-x-1/2
          rounded-control bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-pop"
          style={{ left: Math.min(Math.max(pad.l + slot * hi + slot / 2, 60),
            w - 60), top: 0 }}>
          <div className="font-medium">{data[hi].label}</div>
          <div className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm"
              style={{ background: actualColor }} />
            Actual: {format(data[hi].actual)}</div>
          <div className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm"
              style={{ background: targetColor }} />
            Target: {data[hi].target > 0 ? format(data[hi].target) : "not set"}
          </div>
        </div>
      )}
    </div>
  );
}

// Horizontal actual-vs-target bars, one row per person. Used by the employee
// performance block and the Targets page, where names read better down the side
// than squeezed under a vertical axis.
export type PerfBarRow = {
  label: string; actual: number; target: number; attainment: number;
};

export function PerformanceBars({ rows, format = formatINR }: {
  rows: PerfBarRow[]; format?: (n: number) => string;
}) {
  if (rows.length === 0)
    return <div className="py-8 text-center text-sm text-slate-500">
      Nobody to show yet.</div>;
  const max = Math.max(1, ...rows.flatMap((r) => [r.actual, r.target]));
  return (
    <div className="space-y-3">
      {rows.map((r, i) => {
        // >=100% green, 70-99% amber, below that red — the owner's rule.
        const tone = !r.target ? "bg-slate-300"
          : r.attainment >= 100 ? "bg-money-in"
            : r.attainment >= 70 ? "bg-due" : "bg-money-out";
        return (
          <div key={i}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-medium text-slate-700">
                {r.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-slate-500">
                {format(r.actual)}
                {r.target > 0 && (
                  <span className="text-slate-500"> / {format(r.target)}</span>
                )}
              </span>
            </div>
            <div className="relative mt-1.5 h-2 w-full overflow-hidden
              rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${tone}`}
                style={{ width: `${Math.min(100, (r.actual / max) * 100)}%` }} />
              {r.target > 0 && (
                // Target marker on the same scale, so "how far to go" is
                // readable without doing arithmetic.
                <span className="absolute top-0 h-full w-0.5 bg-slate-500"
                  style={{ left: `${Math.min(100, (r.target / max) * 100)}%` }} />
              )}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              {r.target > 0
                ? `${Math.round(r.attainment)}% of target`
                : "No target set"}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// Donut for part-to-whole identity (category / type / payer mix). Fixed-order
// categorical hues, a 2px surface gap between arcs, centre total, and a legend
// carrying the value + share so identity is never colour-alone.
export type Slice = { label: string; value: number; color?: string };

export function Donut({ data, size = 170, centerLabel = "Total",
  format = formatINR }: {
  data: Slice[]; size?: number; centerLabel?: string;
  format?: (n: number) => string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0)
    return <div className="py-10 text-center text-sm text-slate-500">
      No data yet.</div>;
  const r = size / 2, stroke = size * 0.16, rr = r - stroke / 2;
  const circ = 2 * Math.PI * rr;
  let offset = 0;
  const arcs = data.map((d, i) => {
    const frac = d.value / total;
    const seg = { d, i, frac, dash: frac * circ, offset };
    offset += frac * circ;
    return seg;
  });
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        className="shrink-0">
        <g transform={`rotate(-90 ${r} ${r})`}>
          {arcs.map(({ d, i, dash, offset }) => (
            <circle key={i} cx={r} cy={r} r={rr} fill="none"
              stroke={d.color ?? catColor(i)}
              strokeWidth={hi === i ? stroke + 3 : stroke}
              strokeDasharray={`${Math.max(0, dash - 2)} ${circ - Math.max(0, dash - 2)}`}
              strokeDashoffset={-offset}
              opacity={hi == null || hi === i ? 1 : 0.45}
              onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)} />
          ))}
        </g>
        <text x={r} y={r - 4} textAnchor="middle"
          className="fill-slate-800"
          style={{ fontSize: 18, fontWeight: 700 }}>
          {hi == null ? format(total) : format(data[hi].value)}</text>
        <text x={r} y={r + 14} textAnchor="middle"
          className="fill-slate-400" style={{ fontSize: 10 }}>
          {hi == null ? centerLabel : data[hi].label}</text>
      </svg>
      <div className="min-w-0 flex-1 space-y-1.5">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-sm"
            onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}>
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: d.color ?? catColor(i) }} />
            <span className="min-w-0 flex-1 truncate text-slate-600" title={d.label}>{d.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-slate-700">{format(d.value)}</span>
            <span className="w-10 shrink-0 text-right text-xs text-slate-500">
              {Math.round((d.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Vertical stacked bars: several identity series summed per label (e.g. new
// business vs renewals per month). 2px surface gap between segments; legend.
export type StackDatum = { label: string; parts: number[] };

export function StackedBars({ data, series, height = 200,
  format = formatINR }: {
  data: StackDatum[]; series: { label: string; color: string }[];
  height?: number; format?: (n: number) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  if (data.length === 0)
    return <div className="py-12 text-center text-sm text-slate-500">
      No data yet.</div>;
  const pad = { t: 10, r: 8, b: 22, l: 8 };
  const ih = height - pad.t - pad.b;
  const max = Math.max(1, ...data.map((d) => d.parts.reduce((s, v) => s + v, 0)));
  const iw = Math.max(1, w - pad.l - pad.r);
  const slot = iw / data.length;
  const barW = Math.min(26, slot * 0.6);

  return (
    <div>
      <div ref={ref} className="relative w-full select-none" style={{ height }}
        onMouseLeave={() => setHi(null)}>
        {w > 0 && (
          <svg width={w} height={height} className="overflow-visible">
            <line x1={pad.l} y1={pad.t + ih} x2={w - pad.r} y2={pad.t + ih}
              className="text-slate-200" stroke="currentColor"
              strokeWidth="1" />
            {data.map((d, i) => {
              const cx = pad.l + slot * i + slot / 2;
              let acc = 0;
              return (
                <g key={i} onMouseEnter={() => setHi(i)}>
                  <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih}
                    fill={hi === i ? "currentColor" : "transparent"}
                    className="text-slate-100" />
                  {d.parts.map((v, s) => {
                    const h = (v / max) * ih;
                    const y = pad.t + ih - acc - h;
                    acc += h + (v > 0 ? 2 : 0); // 2px surface gap
                    return h <= 0 ? null : (
                      <rect key={s} x={cx - barW / 2} y={y} width={barW}
                        height={Math.max(0, h - 2)} rx={2} fill={series[s].color}
                        opacity={hi == null || hi === i ? 1 : 0.5} />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        )}
        <div className="absolute inset-x-0 bottom-0 flex text-[10px] text-slate-500"
          style={{ paddingLeft: pad.l, paddingRight: pad.r }}>
          {data.map((d, i) => (
            <div key={i} className="flex-1 text-center">
              {data.length > 8 && i % 2 ? "" : d.label}</div>
          ))}
        </div>
        {hi != null && w > 0 && (
          <div className="pointer-events-none absolute z-raised -translate-x-1/2
            rounded-control bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-pop"
            style={{ left: Math.min(Math.max(pad.l + slot * hi + slot / 2, 54),
              w - 54), top: 0 }}>
            <div className="font-medium">{data[hi].label}</div>
            {series.map((s, si) => (
              <div key={si} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: s.color }} />
                {s.label}: {format(data[hi].parts[si] ?? 0)}</div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {series.map((s, i) => (
          <span key={i} className="flex items-center gap-1.5 text-slate-500">
            <span className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
    </div>
  );
}

// A single stacked horizontal bar for ordered buckets (e.g. aging), with legend.
export function SegmentBar({ segments }: {
  segments: { label: string; value: number; color: string }[];
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {segments.map((s, i) => (
          <div key={i} title={`${s.label}: ${formatINR(s.value)}`}
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
            className={i ? "border-l-2 border-white" : ""} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {segments.map((s, i) => (
          <span key={i} className="flex items-center gap-1.5 text-slate-500">
            <span className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: s.color }} />
            {s.label}
            <b className="text-slate-700">
              {formatINR(s.value)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
