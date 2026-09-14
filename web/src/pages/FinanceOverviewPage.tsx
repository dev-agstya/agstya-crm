import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { financeApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";

// The three party kinds a pending row can point at. Matches the :type segment
// of /finance/entity/:type/:id.
type ContactPartyType = "customer" | "partner" | "broker";
import { ErrorState, Modal, PageLoader } from "../components/ui";
import { Icon } from "../components/Icon";
import {
  AreaTrend, GroupedBars, PerformanceBars, C,
} from "../components/finance/charts";
import {
  DateFilter, periodParams, type PeriodValue,
} from "../components/finance/DateFilter";
import { formatINR } from "../lib/format";
import { liveQueryOptions } from "../lib/live";
import type {
  EmployeeTarget, PendingItem, TargetMetric, TopPerformer,
} from "../lib/types";
import { moneyTone } from "../lib/tone";

type TopKind = "employee" | "partner" | "broker" | "category";

const pct = (num: number, den: number) =>
  den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "—";

// The metrics shown for a performer, tuned to what matters for each kind.
// Profit here is ACCRUAL — booked on policies, not necessarily received yet.
function metricsFor(kind: TopKind, p: TopPerformer): { label: string; value: string }[] {
  if (kind === "employee") return [
    { label: "Policies", value: String(p.policies) },
    { label: "Accrual profit", value: formatINR(p.profit) },
    { label: "Rewards earned", value: formatINR(p.agency_reward) },
    { label: "Avg reward %", value: pct(p.agency_reward, p.premium) },
  ];
  if (kind === "partner") return [
    { label: "Policies", value: String(p.policies) },
    { label: "Reward earned", value: formatINR(p.reward) },
    { label: "Reward %", value: pct(p.reward, p.premium) },
    { label: "Accrual profit", value: formatINR(p.profit) },
    { label: "Renewal %", value: pct(p.renewals, p.policies) },
  ];
  if (kind === "broker") return [
    { label: "Policies", value: String(p.policies) },
    { label: "Rewards earned", value: formatINR(p.agency_reward) },
    { label: "Avg reward %", value: pct(p.agency_reward, p.premium) },
    { label: "Accrual profit", value: formatINR(p.profit) },
  ];
  return [ // category
    { label: "Policies", value: String(p.policies) },
    { label: "Avg reward %", value: pct(p.agency_reward, p.premium) },
    { label: "Accrual profit", value: formatINR(p.profit) },
  ];
}

const KIND_META: Record<TopKind, {
  title: string; icon: keyof typeof Icon; tone: string;
}> = {
  employee: { title: "Top Employee", icon: "Users",
    tone: "bg-slate-100 text-slate-900" },
  partner: { title: "Top Channel Partner", icon: "Wallet",
    tone: "bg-slate-100 text-slate-700" },
  broker: { title: "Top Broker", icon: "Insurer",
    tone: "bg-due/10 text-due" },
  category: { title: "Top Category", icon: "Tag",
    tone: "bg-money-in/10 text-money-in" },
};

function TopCard({ kind, list, onExpand }: {
  kind: TopKind; list: TopPerformer[]; onExpand: () => void;
}) {
  const meta = KIND_META[kind];
  const Ico = Icon[meta.icon];
  const top = list[0];
  return (
    <div className="card group relative p-4">
      <div className="flex items-center gap-2">
        <span className={`rounded-control p-1.5 ${meta.tone}`}><Ico size={16} /></span>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {meta.title}</p>
        {list.length > 0 && (
          <button onClick={onExpand} title="View top 5"
            className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100
              hover:text-slate-600">
            <Icon.More size={16} />
          </button>
        )}
      </div>
      {top ? (
        <>
          <p className="mt-2 truncate text-section text-slate-900" title={top.label}>{top.label}</p>
          <p className="mt-0.5 text-sm font-medium tabular-nums text-money-in">
            {formatINR(top.profit)} <span className="text-xs font-normal
              text-slate-500">accrual profit</span></p>
          <p className="mt-1 text-xs text-slate-500">
            {top.policies} {top.policies === 1 ? "policy" : "policies"}</p>

          {/* Rich hover detail */}
          <div className="pointer-events-none absolute inset-x-2 top-full z-raised
            -mt-1 rounded-card border border-line bg-white p-3 opacity-0
            shadow-pop transition group-hover:pointer-events-auto
            group-hover:opacity-100">
            <p className="mb-2 truncate text-sm font-semibold text-slate-700">{top.label}</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {metricsFor(kind, top).map((m) => (
                <div key={m.label} className="flex items-baseline justify-between
                  gap-2">
                  <span className="text-xs text-slate-500">{m.label}</span>
                  <span className="text-xs font-medium tabular-nums text-slate-700">{m.value}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No data for this period.</p>
      )}
    </div>
  );
}

function TopListModal({ kind, list, onClose }: {
  kind: TopKind; list: TopPerformer[]; onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={`Top 5 — ${KIND_META[kind].title
      .replace("Top ", "")}`} wide>
      <div className="space-y-2">
        {list.map((p, i) => (
          <div key={p.key} className="rounded-card border border-line p-3">
            <div className="flex items-center gap-3">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center
                rounded-full text-sm font-bold ${i === 0
                  ? "bg-due/15 text-due"
                  : "bg-slate-100 text-slate-500"}`}>
                {i + 1}</span>
              <span className="min-w-0 flex-1 truncate font-semibold text-slate-800" title={p.label}>{p.label}</span>
              <span className="shrink-0 text-sm font-semibold tabular-nums
                text-money-in">{formatINR(p.profit)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 pl-10 text-xs">
              {metricsFor(kind, p).map((m) => (
                <span key={m.label} className="text-slate-500">{m.label}:{" "}
                  <b className="font-medium text-slate-600">
                    {m.value}</b></span>
              ))}
            </div>
          </div>
        ))}
        {list.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-500">
            No data for this period.</p>
        )}
      </div>
    </Modal>
  );
}

// Everyone's actuals against the goal they were given, ranked by the combined
// profit + attainment score. Replaces the single thin bar that only ever
// worked for the logged-in user and only for house-profit targets.
function EmployeePerformance({ rows, metricLabel, format, periodLabel }: {
  rows: EmployeeTarget[]; metricLabel: string;
  format: (n: number) => string; periodLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, 5);
  const withTarget = rows.filter((r) => r.has_target).length;
  const onTrack = rows.filter(
    (r) => r.has_target && r.attainment_pct >= 100).length;

  return (
    <div className="card card-body">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-700">
            Employee performance</p>
          <p className="text-xs text-slate-500">
            {metricLabel} booked vs target · {periodLabel}
          </p>
        </div>
        <p className="text-xs text-slate-500">
          {withTarget > 0
            ? `${onTrack} of ${withTarget} on or above target`
            : "No targets assigned for this period"}
        </p>
      </div>
      <PerformanceBars format={format}
        rows={shown.map((r) => ({
          label: `${r.rank ? `${r.rank}. ` : ""}${r.label}`,
          actual: r.actual, target: r.target,
          attainment: r.attainment_pct }))} />
      {rows.length > 5 && (
        <button onClick={() => setExpanded((v) => !v)}
          className="mt-4 text-xs font-medium text-slate-500 hover:text-slate-800">
          {expanded ? "Show less" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

const PARTY_LABEL: Record<PendingItem["party_type"], string> = {
  customer: "Customer", partner: "Channel Partner", broker: "Broker",
};

// The "we owe them" side is labelled per party (reward for partners, discount
// refund for customers, premium for brokers) so the net figure reads clearly.
const OWED_TO_THEM_LABEL: Record<PendingItem["party_type"], string> = {
  customer: "refund", partner: "reward", broker: "premium",
};

// Sub-line spelling out the gross premium/reward behind a netted figure.
function breakdown(r: PendingItem): string | null {
  const us = r.owed_to_us ?? 0;
  const them = r.owed_to_them ?? 0;
  if (us <= 0 || them <= 0) return null; // nothing to net — net == gross
  const owed = r.party_type === "broker" ? "reward" : "premium";
  return `${owed} ${formatINR(us)} − ${OWED_TO_THEM_LABEL[r.party_type]} `
    + `${formatINR(them)}`;
}

// Balances below ₹100 are pulled out of the main party groups into a collapsible
// "Others" bucket, so tiny netting residuals don't clutter the view. Anything
// below ₹10 is pure rounding dust — not listed anywhere, but still counted in the
// total so the figure keeps matching the dashboard card.
const SMALL_MAX_PAISE = 100 * 100; // amount < ₹100 -> "Others"
const DUST_MAX_PAISE = 10 * 100; // amount < ₹10 -> hidden entirely

// One line in a pending list: name, an open-contact arrow, and the amount.
// `showBreakdown` adds the gross premium/reward sub-line — shown in the main
// party groups, hidden in the compact "Others" list (owner: "only the amounts").
function PendingRow({ r, tone, showBreakdown, onOpenParty }: {
  r: PendingItem; tone: string; showBreakdown: boolean;
  onOpenParty: (t: ContactPartyType, id: string) => void;
}) {
  const sub = showBreakdown ? breakdown(r) : null;
  return (
    <div className="flex items-center justify-between gap-3 border-b
      border-line-soft px-4 py-3 transition last:border-0 hover:bg-slate-50/70">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-700" title={r.label}>{r.label}</p>
          {sub && (
            <p className="text-xs tabular-nums text-slate-500">{sub}</p>
          )}
        </div>
        <button title="Open this party’s finance page"
          className="shrink-0 rounded-md p-1 text-slate-300 transition
            hover:bg-slate-100 hover:text-brand-600"
          onClick={() => onOpenParty(
            r.party_type as ContactPartyType, r.party_id)}>
          {/* redirect-arrow */}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M7 17L17 7" /><path d="M8 7h9v9" />
          </svg>
        </button>
      </div>
      <span className={`shrink-0 text-sm font-semibold tabular-nums ${tone}`}>
        {formatINR(r.amount)}</span>
    </div>
  );
}

function PendingModal({ title, items, tone, chipTone, onClose, onOpenParty }: {
  title: string; items: PendingItem[]; tone: string; chipTone: string;
  onClose: () => void;
  onOpenParty: (t: ContactPartyType, id: string) => void;
}) {
  const [showOthers, setShowOthers] = useState(false);
  // Main list: only balances of ₹100+. Small (₹10–₹100) go to "Others"; dust
  // (< ₹10) is dropped from the list but stays in the total below.
  const bigItems = items.filter((i) => i.amount >= SMALL_MAX_PAISE);
  const otherItems = items
    .filter((i) => i.amount >= DUST_MAX_PAISE && i.amount < SMALL_MAX_PAISE)
    .sort((a, b) => b.amount - a.amount);
  const groups = ["customer", "partner", "broker"]
    .map((t) => ({ type: t as PendingItem["party_type"],
      rows: bigItems.filter((i) => i.party_type === t) }))
    .filter((g) => g.rows.length > 0);
  const total = items.reduce((s, i) => s + i.amount, 0);
  const othersTotal = otherItems.reduce((s, i) => s + i.amount, 0);
  const nothingListed = groups.length === 0 && otherItems.length === 0;
  return (
    <Modal open onClose={onClose} title={title} wide>
      <div className="space-y-5">
        {groups.map((g) => (
          <div key={g.type}>
            <div className="mb-2 flex items-center justify-between">
              <span className={`rounded-full px-2.5 py-0.5 text-[11px]
                font-semibold uppercase tracking-wide ${chipTone}`}>
                {PARTY_LABEL[g.type]}s · {g.rows.length}</span>
              <p className="text-xs font-medium tabular-nums text-slate-500">
                {formatINR(g.rows.reduce((s, r) => s + r.amount, 0))}</p>
            </div>
            <div className="overflow-hidden rounded-card border border-line
              shadow-sm">
              {g.rows.map((r, i) => (
                <PendingRow key={r.party_id + i} r={r} tone={tone}
                  showBreakdown onOpenParty={onOpenParty} />
              ))}
            </div>
          </div>
        ))}

        {/* Collapsible bucket for sub-₹100 balances — amounts only. */}
        {otherItems.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowOthers((v) => !v)}
              className="flex w-full items-center justify-between gap-3 rounded-card
                border border-line px-4 py-3 text-left transition
                hover:bg-slate-50/70">
              <span className="flex items-center gap-2">
                <Icon.ChevronRight size={16}
                  className={`text-slate-500 transition-transform
                    ${showOthers ? "rotate-90" : ""}`} />
                <span className="text-sm font-medium text-slate-600">Others</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5
                  text-[11px] font-semibold text-slate-500">{otherItems.length}</span>
                <span className="text-xs text-slate-500">under ₹100</span>
              </span>
              <span className={`text-sm font-semibold tabular-nums ${tone}`}>
                {formatINR(othersTotal)}</span>
            </button>
            {showOthers && (
              <div className="mt-2 overflow-hidden rounded-card border
                border-line shadow-sm">
                {otherItems.map((r, i) => (
                  <PendingRow key={r.party_id + i} r={r} tone={tone}
                    showBreakdown={false} onOpenParty={onOpenParty} />
                ))}
              </div>
            )}
          </div>
        )}

        {nothingListed && (
          <p className="py-6 text-center text-sm text-slate-500">
            {items.length === 0
              ? "Nothing pending."
              : "Only minor balances under ₹10 remain."}</p>
        )}
        <div className="flex items-center justify-between rounded-card bg-slate-50
          px-4 py-3">
          <span className="text-sm font-medium text-slate-600">
            Total</span>
          <span className={`text-metric-sm tabular-nums ${tone}`}>
            {formatINR(total)}</span>
        </div>
      </div>
    </Modal>
  );
}

// The four owner-requested graphs. Bucket size follows the date filter (day /
// week / month) — the server decides and sends the ready-made series.
type GraphType = "policies" | "net_profit" | "target" | "renewal_rate";
const GRAPHS: { value: GraphType; label: string }[] = [
  { value: "policies", label: "Total Number of Policies" },
  { value: "net_profit", label: "Net Profit" },
  { value: "target", label: "Performance vs Target (company)" },
  { value: "renewal_rate", label: "Renewal Rate (%)" },
];

// Which goal the target graph plots. The server returns actual AND target in
// the chosen metric's units — previously the graph put cash net profit next to
// whatever house-profit goal it could find, so the two bars were never
// comparable and a policies target was invisible entirely.
const TARGET_METRICS: { value: TargetMetric; label: string }[] = [
  { value: "house_profit", label: "House profit" },
  { value: "premium", label: "Premium" },
  { value: "policies", label: "Policies" },
  { value: "renewals", label: "Renewals" },
];

// The sign/colour rule lives in lib/tone — see the note there about the five
// copies this replaced.
const profitCls = moneyTone;

export default function FinanceOverviewPage() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<PeriodValue>({ period: "current_month" });
  const [graph, setGraph] = useState<GraphType>("net_profit");
  const [targetMetric, setTargetMetric] =
    useState<TargetMetric>("house_profit");
  // "" = the company total; otherwise one employee's own actual vs own goal.
  const [targetWho, setTargetWho] = useState("");
  const [topModal, setTopModal] = useState<TopKind | null>(null);
  const [pendingModal, setPendingModal] = useState<"collect" | "pay" | null>(null);

  const dash = useQuery({
    queryKey: ["finance", "dashboard", period, targetMetric, targetWho],
    queryFn: async () => (await financeApi.dashboard({
      ...periodParams(period), target_metric: targetMetric,
      target_employee_id: targetWho || undefined })).data,
    ...liveQueryOptions,
  });
  const d = dash.data;

  const listFor = (k: TopKind): TopPerformer[] => {
    if (!d) return [];
    return { employee: d.top_employees, partner: d.top_partners,
      broker: d.top_brokers, category: d.top_categories }[k];
  };

  const series = d?.series ?? [];
  const policiesTrend = series.map((s) => ({
    label: s.label, value: s.policies }));
  const profitTrend = series.map((s) => ({
    label: s.label, value: s.net_profit }));
  // Both bars are the SAME metric now — s.actual is the booked figure for the
  // selected target metric, not the cash net_profit plotted above it.
  const targetBars = series.map((s) => ({
    label: s.label, actual: s.actual, target: s.target }));
  // Counts must not be formatted as rupees.
  const fmtTarget = (n: number) =>
    d?.target_is_money === false ? String(Math.round(n)) : formatINR(n);
  const renewalTrend = series.map((s) => ({
    label: s.label, value: s.renewal_rate_pct ?? 0 }));

  // The party's own finance page already exists for all three kinds and is
  // more useful than the contact card this used to open — it names them, shows
  // their position, and can be linked to.
  const openParty = (type: ContactPartyType, id: string) =>
    navigate(`/finance/entity/${type}/${id}`);

  return (
    <div>
      <PageHeader title="Finance Overview"
        actions={<DateFilter value={period} onChange={setPeriod} />} />

      {dash.isError ? <ErrorState onRetry={() => dash.refetch()} />
        : dash.isLoading || !d ? <PageLoader /> : (
        <div className="space-y-5">
          {/* Net Profit hero + performance chart */}
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="flex flex-col justify-between rounded-card
              bg-ink p-5 text-white lg:col-span-2">
              <div title="Agency reward minus partner reward, booked in the last 30 days">
                <p className="text-xs uppercase tracking-wide text-white/60">
                  Net Profit · last 30 days</p>
                <p className={`mt-1 text-metric-lg tabular-nums
                  ${profitCls(d.net_profit_30d)}`}>
                  {formatINR(d.net_profit_30d)}</p>
              </div>
              <div className="mt-6 flex items-center justify-between border-t
                border-white/10 pt-4">
                <span className="flex items-center gap-2 text-sm text-white/70">
                  {/* This legend swatch sits on the DARK hero, so `C.ink`
                      (#18181b) painted a near-black square on a near-black card
                      — invisible, not subtle. It carries the same colour as the
                      policies trend it labels. */}
                  <span className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: C.count }} />
                  Total Policies Done
                  <span className="text-xs text-white/40">
                    · {d.period_label}</span>
                </span>
                <b className="text-metric tabular-nums">
                  {d.earnings.total_policies}</b>
              </div>
            </div>

            <div className="card p-5 lg:col-span-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <select value={graph}
                  onChange={(e) => setGraph(e.target.value as GraphType)}
                  className="select h-8 max-w-[70%] py-0 text-sm font-medium">
                  {GRAPHS.map((g) => (
                    <option key={g.value} value={g.value}>{g.label}</option>
                  ))}
                </select>
                {graph === "target" ? (
                  <div className="flex items-center gap-3">
                    <select value={targetWho} title="Whose target to plot"
                      onChange={(e) => setTargetWho(e.target.value)}
                      className="select h-8 max-w-[130px] py-0 text-xs">
                      <option value="">Company</option>
                      {(d.employee_targets ?? []).map((e) => (
                        <option key={e.key} value={e.key}>{e.label}</option>
                      ))}
                    </select>
                    <select value={targetMetric} title="Which goal to plot"
                      onChange={(e) =>
                        setTargetMetric(e.target.value as TargetMetric)}
                      className="select h-8 py-0 text-xs">
                      {TARGET_METRICS.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                    <p className="flex items-center gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2 w-3 rounded-sm"
                          style={{ background: C.green }} /> Actual</span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2 w-3 rounded-sm"
                          style={{ background: C.amber }} /> Target</span>
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    {d.granularity === "day" ? "Day-wise"
                      : d.granularity === "week" ? "Week-wise"
                        : "Month-wise"}
                    <span className="ml-1 text-slate-300">· {d.period_label}</span>
                  </p>
                )}
              </div>
              {graph === "policies" && (
                <AreaTrend data={policiesTrend} valueLabel="Policies"
                  color={C.count} format={(n) => String(n)} />)}
              {graph === "net_profit" && (
                <AreaTrend data={profitTrend} valueLabel="Net profit" />)}
              {graph === "target" && (
                <GroupedBars data={targetBars} format={fmtTarget}
                  emptyHint={d.has_targets
                    ? "Nothing booked against this goal yet."
                    : `No ${d.target_metric_label.toLowerCase()} target set for `
                      + "this period — assign one from the Targets page."} />
              )}
              {graph === "renewal_rate" && (
                <AreaTrend data={renewalTrend} valueLabel="Renewal rate"
                  color={C.amber} format={(n) => `${n}%`} />)}
            </div>
          </div>

          {/* Top performers (accrual profit — booked, not yet received) */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(["employee", "partner", "broker", "category"] as TopKind[])
              .map((k) => (
                <TopCard key={k} kind={k} list={listFor(k)}
                  onExpand={() => setTopModal(k)} />
              ))}
          </div>

          {/* Employee performance — actuals vs the goals they were given. */}
          <EmployeePerformance rows={d.employee_targets}
            metricLabel={d.target_metric_label} format={fmtTarget}
            periodLabel={d.period_label} />

          {/* Outstanding — always current, not affected by the filter */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card flex items-center justify-between p-5">
              <div>
                <p className="text-sm font-medium text-slate-600">Pending to Collect</p>
                <p className="mt-1 text-metric tabular-nums
                  text-money-in">{formatINR(d.pending.to_collect)}</p>
              </div>
              <button onClick={() => setPendingModal("collect")}
                title="View breakdown"
                className="rounded-card bg-money-in/10 p-3 text-money-in
                  hover:bg-money-in/15">
                <Icon.More size={22} /></button>
            </div>
            <div className="card flex items-center justify-between p-5">
              <div>
                <p className="text-sm font-medium text-slate-600">Pending to Pay</p>
                <p className="mt-1 text-metric tabular-nums
                  text-money-out">
                  {d.pending.to_pay > 0 ? "−" : ""}{formatINR(d.pending.to_pay)}</p>
              </div>
              <button onClick={() => setPendingModal("pay")}
                title="View breakdown"
                className="rounded-card bg-money-out/10 p-3 text-money-out
                  hover:bg-money-out/15">
                <Icon.More size={22} /></button>
            </div>
          </div>
        </div>
      )}

      {topModal && d && (
        <TopListModal kind={topModal} list={listFor(topModal)}
          onClose={() => setTopModal(null)} />
      )}
      {pendingModal === "collect" && d && (
        <PendingModal title="Pending to Collect"
          items={d.pending.collect_items} tone="text-money-in"
          chipTone="bg-money-in/10 text-money-in"
          onClose={() => setPendingModal(null)} onOpenParty={openParty} />
      )}
      {pendingModal === "pay" && d && (
        <PendingModal title="Pending to Pay"
          items={d.pending.pay_items} tone="text-money-out"
          chipTone="bg-money-out/10 text-money-out"
          onClose={() => setPendingModal(null)} onOpenParty={openParty} />
      )}
    </div>
  );
}
