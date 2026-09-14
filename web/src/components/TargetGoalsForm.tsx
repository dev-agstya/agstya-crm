import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { targetsApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { Avatar } from "./ui";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { formatINR, formatMonthYear, rupeesToPaise } from "../lib/format";
import { refreshFinance } from "../lib/live";
import { canSeeProfitTargets, isProfitMetric } from "../lib/targets";
import { useAuth } from "../store/auth";
import { MetricBar } from "./TargetProgress";
import type { Target, TargetMetric, TargetMetricRow } from "../lib/types";

/*
  ONE form for setting somebody's goals.

  It is rendered in three places — the Targets page roster, the per-person
  Targets page (pages/people/PersonTargetsPage) and the inline dialog on an
  employee's Team tab, where a relationship manager hands numbers to their own
  partners (owner F1, 2026-08-06). Both must produce the SAME payload against
  the same endpoint: a second form writing targets is a second place for the
  paise/rupee conversion, the "blank means no goal" rule and the profit gate to
  be got subtly wrong.

  Three rules it owns:

  * BLANK IS NOT ZERO. A metric left empty is "no goal for this", which is
    different from a goal of nought — the server drops non-positive values for
    the same reason (schemas/target._clean_metrics). Clearing every box and
    saving is how you remove a target.
  * A PROFIT GOAL IS CARRIED, NEVER DROPPED. Somebody who cannot see house
    profit does not get the input, and any existing profit goal is passed
    through untouched, so their save cannot silently delete a number they were
    never shown.
  * MONTHS ONLY. The period is picked as a month, not a free start date — that
    is what stopped a "July" target from silently covering only 26-31 July.

  THE SHAPE (2026-08-07 rebuild). It was four number inputs in a grid, which
  asks the hardest question in the flow — "what number?" — with nothing to
  answer it from. Now a metric is a CARD you switch on, and switching one on
  reveals what this person actually did last month plus a row of suggestions
  built from it. Typing a goal is still possible and still the point; it is
  just no longer the only thing on offer.
*/

interface MetricDef {
  value: TargetMetric;
  label: string;
  money: boolean;
  icon: keyof typeof Icon;
  /** What the number means, in the fewest words that are still true. */
  unit: string;
}

const ALL_METRICS: MetricDef[] = [
  { value: "policies", label: "Policies", money: false, icon: "Policy",
    unit: "policies booked" },
  { value: "premium", label: "Premium", money: true, icon: "Money",
    unit: "gross premium" },
  { value: "renewals", label: "Renewals", money: false, icon: "Refresh",
    unit: "renewals booked" },
  { value: "house_profit", label: "House profit", money: true, icon: "Trend",
    unit: "agency margin" },
];

function monthInput(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Is this month already OVER? (owner C4, 2026-08-21)
 *
 * A relationship manager without `manage_targets` may LOOK at any month — you
 * cannot decide this month's number for a partner without reading last
 * month's — but may not change a goal somebody has already been measured
 * against. That is the difference between setting a target and editing history.
 *
 * The server is the enforcement (`routers/targets._assert_period_open`); this
 * exists so the form does not offer a Save that is going to 403. Both have to
 * agree, or the page shows a control that fails.
 */
export function monthIsPast(key: string): boolean {
  const [y, m] = key.split("-").map(Number);
  const now = new Date();
  return y < now.getFullYear()
    || (y === now.getFullYear() && m < now.getMonth() + 1);
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return formatMonthYear(new Date(y, m - 1, 1));
}

/**
 * Suggested goals, derived from what they actually did.
 *
 * A goal is a judgement about a person, and the only honest input to it is
 * their own recent output — so the chips are "same again", "a bit more" and
 * "a lot more" rather than round numbers picked out of the air. Rounded to
 * something a human would say out loud, and de-duplicated so 0 and 1 do not
 * produce five chips that all read 1.
 */
export function suggestionsFor(lastMonth: number, money: boolean): number[] {
  if (lastMonth <= 0) {
    return money ? [] : [5, 10, 15, 20];
  }
  const round = (n: number) => {
    if (!money) return Math.max(1, Math.round(n));
    // Money is typed in RUPEES here, so round to a figure somebody would say:
    // nearest 1,000 above 50k, nearest 500 above 5k, nearest 100 below that.
    const step = n >= 50000 ? 1000 : n >= 5000 ? 500 : 100;
    return Math.max(step, Math.round(n / step) * step);
  };
  const raw = [lastMonth, lastMonth * 1.1, lastMonth * 1.25, lastMonth * 1.5];
  return [...new Set(raw.map(round))];
}

export function TargetGoalsForm({
  assigneeId, assigneeType, assigneeName, assigneeCode, target,
  existingMetrics, onDone, onCancel, onDelete,
}: {
  assigneeId: string;
  assigneeType: string;
  assigneeName: string;
  assigneeCode?: string | null;
  /** The target being edited, when there is a whole one to edit. */
  target?: Target | null;
  /**
   * Pre-filled goals when the caller has metric ROWS but not a Target object —
   * the roster hands these over, because its rows carry attainment rather than
   * the record.
   */
  existingMetrics?: TargetMetricRow[];
  onDone: () => void;
  onCancel: () => void;
  /** Shown only when the caller can actually delete the record it came from. */
  onDelete?: () => void;
}) {
  const qc = useQueryClient();
  const { user: me, has } = useAuth();
  const canSeeProfit = canSeeProfitTargets(me);
  const METRICS = canSeeProfit
    ? ALL_METRICS : ALL_METRICS.filter((m) => !isProfitMetric(m.value));

  const seed = target?.metrics ?? existingMetrics ?? [];
  // Defaults to the target being edited, else the current month. The picker is
  // ALWAYS visible: targets are monthly and the roster's date filter is not, so
  // there is no window the form could safely inherit without occasionally
  // setting a target for a month nobody chose.
  const [month, setMonth] = useState(() => monthInput(target?.period_start));
  const [values, setValues] = useState<Partial<Record<TargetMetric, string>>>(
    () => {
      const initial: Partial<Record<TargetMetric, string>> = {};
      seed.forEach((m) => {
        initial[m.metric] = String(
          m.is_money ? m.target_value / 100 : m.target_value);
      });
      return initial;
    });

  // What this person actually did in the month BEFORE the one being set. It is
  // the only defensible basis for a suggestion, and it is also the sentence
  // that makes the number feel decided rather than guessed.
  const prevKey = shiftMonth(month, -1);
  const history = useQuery({
    queryKey: ["targets", "performance", prevKey, assigneeType],
    queryFn: async () => (await targetsApi.performance({
      month: prevKey, kind: assigneeType })).data,
    // A relationship manager may set their own partners' targets without
    // manage_targets, but /performance needs the team-wide read. A 403 here is
    // expected for them, so it must not retry or surface as an error — the form
    // simply loses its suggestions.
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const lastMonth = useMemo(() => {
    const row = history.data?.rows.find((r) => r.assignee_id === assigneeId);
    if (!row) return null;
    return {
      policies: row.policies,
      renewals: row.renewals,
      premium: row.premium,
      house_profit: row.profit,
    } as Record<TargetMetric, number>;
  }, [history.data, assigneeId]);

  const setValue = (metric: TargetMetric, v: string) =>
    setValues((cur) => ({ ...cur, [metric]: v }));

  const isOn = (metric: TargetMetric) => (values[metric] ?? "").trim() !== "";

  const toggle = (m: MetricDef) => {
    if (isOn(m.value)) {
      setValue(m.value, "");
      return;
    }
    // Switching a metric on pre-fills the FIRST suggestion rather than an empty
    // box: an empty required field is a question, and the whole point of the
    // suggestions is that we can already answer it.
    const prev = lastMonth?.[m.value] ?? 0;
    const inUnits = m.money ? prev / 100 : prev;
    const picks = suggestionsFor(inUnits, m.money);
    setValue(m.value, picks.length ? String(picks[0]) : "");
  };

  const metricsPayload = () => {
    const out: Record<string, number> = {};
    // Goals this viewer cannot see are carried straight through.
    seed.filter((m) => !METRICS.some((x) => x.value === m.metric))
      .forEach((m) => { out[m.metric] = m.target_value; });
    METRICS.forEach(({ value, money }) => {
      const raw = (values[value] ?? "").trim();
      if (!raw) return;
      const n = parseFloat(raw);
      if (!Number.isFinite(n) || n <= 0) return;
      out[value] = money ? rupeesToPaise(n) : Math.round(n);
    });
    return out;
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        // Targets are monthly only (owner 2026-07-26, reconfirmed J2).
        period: "month" as const,
        // Any day in the chosen month; the server snaps it to the IST 1st, so
        // a target can never cover a partial month.
        period_start: `${month}-01T00:00:00Z`,
        metrics: metricsPayload(),
      };
      // POST is an UPSERT on (assignee, period) server-side, so the roster —
      // which knows the person and the month but not always the target id —
      // can always create and let the server find the existing row.
      return target
        ? targetsApi.update(target.id, body)
        : targetsApi.create({ assignee_type: assigneeType,
                              assignee_id: assigneeId, ...body });
    },
    onSuccess: () => {
      toast.success(seed.length ? "Target updated." : "Target set.");
      qc.invalidateQueries({ queryKey: ["targets"] });
      qc.invalidateQueries({ queryKey: ["managers"] });
      qc.invalidateQueries({ queryKey: ["target-progress"] });
      refreshFinance(qc); // targets drive the dashboard/overview graphs
      onDone();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const chosen = metricsPayload();
  // A month that has finished is read-only for anyone without manage_targets.
  // `has` answers true for every flag on an owner, so this never blocks them.
  const locked = monthIsPast(month) && !has("manage_targets");
  const canSave = Object.keys(chosen).length > 0 && !locked;
  const onCount = METRICS.filter((m) => isOn(m.value)).length;

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (canSave) save.mutate(); }}
      className="space-y-5">

      {/* Who this is for. The reference dialog opens with the person and it is
          right to: a target is about a human, and the roster it was opened from
          has thirty of them. */}
      <div className="flex items-center gap-3 rounded-card border border-line
        bg-slate-50 px-4 py-3">
        <Avatar name={assigneeName} size="md" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-800">
            {assigneeName}
          </p>
          <p className="text-xs text-slate-500">
            {assigneeType === "channel_partner" ? "Channel partner" : "Employee"}
            {assigneeCode ? ` · ${assigneeCode}` : ""}
          </p>
        </div>
      </div>

      {/* The month, as a stepper. A bare <input type="month"> renders as a
          different control in every browser and reads as a form field; a target
          is set FOR a month, so the month is a heading with arrows. */}
      <div>
        <p className="mb-1.5 text-caption uppercase text-slate-500">
          Target month
        </p>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Previous month"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            <Icon.ChevronLeft size={16} />
          </button>
          <span className="min-w-[140px] text-center text-sm font-semibold
            text-slate-800">{monthLabel(month)}</span>
          <button type="button" className="icon-btn" title="Next month"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            <Icon.ChevronRight size={16} />
          </button>
          <span className="ml-1 text-xs text-slate-500">
            Targets run for one calendar month.
          </span>
        </div>
        {locked && (
          // Never a disabled button with no explanation: the reason is the
          // month, so it belongs against the month.
          <p className="mt-2 text-xs text-money-out">
            {monthLabel(month)} has finished, so its target can no longer be
            changed. Pick this month or a later one.
          </p>
        )}
      </div>

      {/* Which goals. Cards, not a grid of inputs: the first decision is WHAT
          to measure, and asking it as four empty number boxes makes the answer
          "all four" by default. */}
      <div>
        <p className="mb-1.5 text-caption uppercase text-slate-500">
          What to measure
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {METRICS.map((m) => {
            const on = isOn(m.value);
            const IconCmp = Icon[m.icon];
            return (
              <button key={m.value} type="button" onClick={() => toggle(m)}
                aria-pressed={on}
                className={`flex flex-col items-start gap-1.5 rounded-card
                  border p-3 text-left transition-colors ${on
                    ? "border-ink bg-ink text-white"
                    : "border-line text-slate-600 hover:bg-slate-50"}`}>
                <IconCmp size={16} className={on ? "" : "text-slate-400"} />
                <span className="text-sm font-medium">{m.label}</span>
                <span className={`text-[11px] leading-tight ${
                  on ? "text-white/70" : "text-slate-500"}`}>{m.unit}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* The numbers, one block per switched-on metric. */}
      {onCount === 0 ? (
        <p className="rounded-card border border-dashed border-line px-4 py-6
          text-center text-sm text-slate-500">
          Pick at least one thing to measure.
        </p>
      ) : (
        <div className="space-y-3">
          {METRICS.filter((m) => isOn(m.value)).map((m) => (
            <GoalBlock key={m.value} def={m}
              value={values[m.value] ?? ""}
              lastMonth={lastMonth?.[m.value] ?? null}
              prevLabel={monthLabel(prevKey)}
              onChange={(v) => setValue(m.value, v)} />
          ))}
        </div>
      )}

      {/* What was actually chosen, in the same bars the person will be judged
          by. Reading the goal back in the shape it will be reported in is the
          cheapest way to catch a paise/rupee slip before it is saved. */}
      {canSave && (
        <div className="rounded-card border border-line p-3.5">
          <p className="mb-2.5 text-caption uppercase text-slate-500">
            {monthLabel(month)} target
          </p>
          <div className="space-y-2">
            {METRICS.filter((m) => chosen[m.value] !== undefined).map((m) => (
              <MetricBar key={m.value} compact row={{
                metric: m.value,
                label: m.label,
                is_money: m.money,
                target_value: chosen[m.value],
                actual_value: 0,
                attainment_pct: 0,
              }} />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {onDelete && (
          <button type="button" className="btn-secondary mr-auto text-money-out"
            onClick={onDelete}>
            <Icon.Trash size={16} /> Remove target
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel</button>
        <button type="submit" className="btn-primary"
          disabled={!canSave || save.isPending}>
          {save.isPending ? "Saving…"
            : seed.length ? "Save changes" : "Set target"}
        </button>
      </div>
    </form>
  );
}

/** One goal: the context, the input, and the suggestions built from it. */
function GoalBlock({ def, value, lastMonth, prevLabel, onChange }: {
  def: MetricDef;
  value: string;
  /** Last month's actual, in STORE units (paise for money). Null if unknown. */
  lastMonth: number | null;
  prevLabel: string;
  onChange: (v: string) => void;
}) {
  const inUnits = lastMonth === null ? null
    : def.money ? lastMonth / 100 : lastMonth;
  const picks = inUnits === null ? [] : suggestionsFor(inUnits, def.money);
  const current = parseFloat(value);

  return (
    <div className="rounded-card border border-line p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm font-medium text-slate-700">
          {def.label}
          {def.money && <span className="font-normal text-slate-500"> (₹)</span>}
        </label>
        {/* The context line. Not decoration: "what number?" is the hard part of
            this form, and this is the only fact that answers it. */}
        {inUnits !== null && (
          <span className="text-xs text-slate-500">
            {inUnits > 0 ? (
              <>Booked{" "}
                <b className="font-semibold text-slate-700">
                  {def.money ? formatINR(lastMonth!) : Math.round(inUnits)}
                </b>{" "}in {prevLabel}</>
            ) : (
              <>Nothing booked in {prevLabel}</>
            )}
          </span>
        )}
      </div>

      <input type="number" min="0" step={def.money ? "0.01" : "1"}
        className="input mt-2 tabular-nums" placeholder="No goal"
        aria-label={`${def.label} goal`}
        value={value} onChange={(e) => onChange(e.target.value)} />

      {picks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {picks.map((p, i) => {
            const active = Number.isFinite(current) && current === p;
            return (
              <button key={p} type="button" onClick={() => onChange(String(p))}
                className={`rounded-control border px-2.5 py-1 text-xs
                  tabular-nums transition-colors ${active
                    ? "border-ink bg-ink text-white"
                    : "border-line text-slate-600 hover:bg-slate-50"}`}>
                {def.money ? `₹${p.toLocaleString("en-IN")}` : p}
                {/* Only the FIRST chip is "same as last month"; the rest are
                    increases, and saying so is what makes them a choice rather
                    than a row of arbitrary numbers. */}
                {i === 0 && inUnits ? (
                  <span className={active ? "ml-1 text-white/60"
                    : "ml-1 text-slate-400"}>same</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
