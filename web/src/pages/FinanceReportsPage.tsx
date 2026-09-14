import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  businessReportApi, categoriesApi, financeApi, insurersApi, usersApi,
} from "../api/endpoints";
import { blobError, downloadBlob, filenameFromResponse } from "../lib/download";
import { toast } from "../components/Toast";
import { useAuth } from "../store/auth";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { ErrorState, EmptyState, PageLoader } from "../components/ui";
import {
  AreaTrend, Donut, RankedBars, SegmentBar, StackedBars,
  C, catColor,
} from "../components/finance/charts";
import { KpiTile } from "../components/finance/KpiTile";
import { SearchSelect } from "../components/SearchSelect";
import {
  DateFilter, periodLabel, periodParams, type PeriodValue,
} from "../components/finance/DateFilter";
import {
  formatDateTime, formatINR, monthShort, paiseToRupeeStr, pctText,
} from "../lib/format";
import { liveQueryOptions } from "../lib/live";
import type { InsightSlice, ReportRow } from "../lib/types";
import { moneyTone } from "../lib/tone";

// A titled dashboard card.
function Card({ title, sub, right, children, className = "" }: {
  title: string; sub?: string; right?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`card p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-700">
            {title}</p>
          {sub && <p className="text-xs text-slate-500">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// Horizontal bars for COUNT data (no money formatting).
function CountBars({ data, color = C.count }: {
  data: { label: string; value: number; sub?: string }[]; color?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0)
    return <p className="py-6 text-center text-sm text-slate-500">No data.</p>;
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-3 text-sm">
          <span className="w-32 shrink-0 truncate text-slate-600"
            title={d.label}>{d.label}</span>
          <div className="relative h-5 flex-1 rounded bg-slate-100">
            <div className="absolute inset-y-0 left-0 rounded"
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%`,
                background: color }} />
          </div>
          <span className="w-16 shrink-0 text-right font-medium tabular-nums
            text-slate-700">{d.value}
            {d.sub && <span className="ml-1 text-xs font-normal text-slate-500">
              {d.sub}</span>}</span>
        </div>
      ))}
    </div>
  );
}

function MiniStat({ label, value, tone }: {
  label: string; value: string; tone?: string;
}) {
  return (
    <div className="rounded-card border border-line p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}</p>
      <p className={`mt-1 text-metric-sm tabular-nums ${
        tone ?? "text-slate-800"}`}>{value}</p>
    </div>
  );
}

const DIMENSIONS: { value: string; label: string; entity?: string }[] = [
  { value: "insurer", label: "Insurance Company", entity: "insurer" },
  { value: "broker", label: "Broker", entity: "broker" },
  { value: "partner", label: "Channel Partner", entity: "partner" },
  { value: "employee", label: "Employee", entity: "employee" },
  { value: "customer", label: "Customer", entity: "customer" },
  { value: "month", label: "Month" },
];
const rupees = paiseToRupeeStr;

export default function FinanceReportsPage() {
  const nav = useNavigate();
  const [period, setPeriod] = useState<PeriodValue>({ period: "this_year" });
  const [insurerId, setInsurerId] = useState("");
  const [categoryKey, setCategoryKey] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [employeeId, setEmployeeId] = useState("");

  // Filter option sources.
  const insurers = useQuery({ queryKey: ["insurers-all"],
    queryFn: async () => (await insurersApi.list({ page_size: 200 })).data });
  const cats = useQuery({ queryKey: ["categories"],
    queryFn: async () => (await categoriesApi.list()).data });
  const partners = useQuery({ queryKey: ["attributable-partners"],
    queryFn: async () => (await usersApi.attributablePartners()).data });
  const staff = useQuery({ queryKey: ["staff-users"],
    queryFn: async () => (await usersApi.list({ page_size: 200 })).data });
  const employees = (staff.data?.items ?? []).filter(
    (u) => u.account_type === "employee" || u.account_type === "owner");

  const insight = useQuery({
    queryKey: ["finance", "insights", period, insurerId, categoryKey,
      partnerId, employeeId],
    queryFn: async () => (await financeApi.insights({
      ...periodParams(period),
      insurer_id: insurerId || undefined,
      category_key: categoryKey || undefined,
      partner_id: partnerId || undefined,
      employee_id: employeeId || undefined,
    })).data,
    ...liveQueryOptions,
  });
  const d = insight.data;

  return (
    <div>
      {/* No download button up here (owner 2026-08-04). Downloading the report
          is the last thing you do on this page, not the first, and it lives in
          its own section at the foot of it with its own period. */}
      <PageHeader title="Finance Reports" />

      {/* One unified filter toolbar — the date filter and every entity filter
          share the same 40px field styling so nothing looks heavier than its
          neighbours (owner 2026-07-25: "why is one black and the other grey?").
          Long lists get a type-to-search dropdown; the category list is short so
          it stays a plain select, restyled to match. */}
      <div className="card mb-5 flex flex-wrap items-center gap-2 p-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium
          uppercase tracking-wide text-slate-500">
          <Icon.Filter size={14} /> Filters</span>
        <div className="w-44">
          <DateFilter value={period} onChange={setPeriod} variant="field" />
        </div>
        <div className="w-48">
          <SearchSelect value={insurerId} onChange={setInsurerId}
            triggerClassName="h-10"
            placeholder="All insurers" allowClear clearLabel="All insurers"
            options={(insurers.data?.items ?? []).map((i) => ({
              value: i.id, label: i.name }))} />
        </div>
        <select className="select h-10 w-44"
          value={categoryKey}
          onChange={(e) => setCategoryKey(e.target.value)}>
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>))}
        </select>
        <div className="w-52">
          <SearchSelect value={partnerId} onChange={setPartnerId}
            triggerClassName="h-10"
            placeholder="All channel partners" allowClear
            clearLabel="All channel partners"
            options={(partners.data ?? []).map((p) => ({
              value: p.id, label: p.full_name }))} />
        </div>
        <div className="w-48">
          <SearchSelect value={employeeId} onChange={setEmployeeId}
            triggerClassName="h-10"
            placeholder="All employees" allowClear clearLabel="All employees"
            options={employees.map((u) => ({
              value: u.id, label: u.full_name }))} />
        </div>
        {(insurerId || categoryKey || partnerId || employeeId) && (
          <button className="ml-auto text-xs font-medium text-slate-900
            hover:underline"
            onClick={() => { setInsurerId(""); setCategoryKey("");
              setPartnerId(""); setEmployeeId(""); }}>Clear all</button>
        )}
      </div>

      {insight.isLoading || !d ? <PageLoader /> : (
        <div className="space-y-5">
          {/* KPI row (owner 2026-07-16): Net Profit (cash, follows the date
              filter, sign-coloured) · Pending Collect & Pay (point in time,
              ignores every filter) · Total Policies · Renewal Rate. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile label="Net profit"
              value={formatINR(d.kpis.net_profit)}
              tone={moneyTone(d.kpis.net_profit)}
              sub="cash in − cash out · selected period" />
            <div className="relative overflow-hidden rounded-card border
              border-line bg-white p-4 shadow-card">
              <p className="truncate text-xs font-medium uppercase
                tracking-wide text-slate-500">Pending to Collect &amp; Pay</p>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-5">
                <div>
                  <p className="text-metric tabular-nums
                    text-money-in">
                    {formatINR(d.kpis.pending_to_collect)}</p>
                  <p className="text-xs text-slate-500">to collect</p>
                </div>
                <div>
                  <p className="text-metric tabular-nums
                    text-money-out">
                    −{formatINR(d.kpis.pending_to_pay)}</p>
                  <p className="text-xs text-slate-500">to pay</p>
                </div>
              </div>
            </div>
            <KpiTile label="Total policies" accent={C.count}
              value={String(d.kpis.policies)}
              sub={`${d.kpis.active_policies} active in this period · avg ${
                formatINR(d.kpis.avg_premium)}`} />
            <KpiTile label="Renewal rate" accent={C.green}
              value={pctText(d.kpis.renewal_rate)}
              sub={`repeat customers ${pctText(d.kpis.repeat_rate)}`} />
          </div>

          {/* Trends — fixed 12-month context, NOT driven by the date filter */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Total policies — last 12 months"
              sub="Policies booked each month">
              <AreaTrend valueLabel="Policies" color={C.count}
                format={(n) => String(n)}
                data={d.trend.map((t) => ({
                  label: monthShort(t.month), value: t.policies }))} />
            </Card>
            <Card title="Net profit — last 12 months"
              sub="Cash in minus cash out, month by month">
              <AreaTrend valueLabel="Net profit" color={C.green}
                data={d.trend.map((t) => ({
                  label: monthShort(t.month), value: t.net_profit }))} />
            </Card>
          </div>

          {/* Category + insurer */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Premium by category" sub="Share of business by policy type">
              <Donut data={d.by_category.slice(0, 8).map((c) => ({
                label: c.label, value: c.premium }))} centerLabel="Premium" />
            </Card>
            <Card title="Insurance companies" sub="Premium placed, top 8">
              <RankedBars color={catColor(1)}
                data={d.by_insurer.slice(0, 8).map((r) => ({
                  label: r.label, value: r.premium,
                  onClick: () => nav(`/finance/entity/insurer/${r.key}`) }))} />
            </Card>
          </div>

          {/* Mix + reward health */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Who paid the premium" sub="Cash-flow mix">
              <Donut centerLabel="Policies" format={(n) => String(n)}
                data={d.payer_mix.map((s) => ({ label: s.label, value: s.count }))} />
            </Card>
            <Card title="Direct vs via partner" sub="Sourcing mix">
              <Donut centerLabel="Policies" format={(n) => String(n)}
                data={d.buyer_mix.map((s) => ({ label: s.label, value: s.count }))} />
            </Card>
            <Card title="Reward health"
              sub={`Realization ${pctText(d.reward_health.realization_pct)} of rewards earned`}>
              <SegmentBar segments={[
                { label: "Received", value: d.reward_health.received, color: C.green },
                { label: "Pending", value: d.reward_health.pending, color: C.amber },
                { label: "Rejected", value: d.reward_health.rejected, color: C.red },
                { label: "Not eligible", value: d.reward_health.not_eligible,
                  color: C.inkSoft },
                { label: "Refunded", value: d.reward_health.refunded, color: C.red },
              ].filter((s) => s.value > 0)} />
            </Card>
          </div>

          {/* Renewals */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="New business vs renewals" sub="Policies booked each month"
              className="lg:col-span-2">
              <StackedBars format={(n) => String(n)}
                series={[{ label: "New business", color: catColor(0) },
                  { label: "Renewals", color: catColor(1) }]}
                data={d.renewal_trend.map((t) => ({
                  label: monthShort(t.month),
                  parts: [t.new_business, t.renewals] }))} />
            </Card>
            <Card title="Renewals due" sub="Live policies expiring soon">
              <div className="grid grid-cols-3 gap-2">
                <MiniStat label="30 days" value={String(d.renewals_due.d30)}
                  tone="text-due" />
                <MiniStat label="60 days" value={String(d.renewals_due.d60)} />
                <MiniStat label="90 days" value={String(d.renewals_due.d90)} />
              </div>
              <div className="mt-3">
                <MiniStat label="Renewal rate"
                  value={pctText(d.kpis.renewal_rate)} tone="text-money-in" />
              </div>
            </Card>
          </div>

          {/* Retention & customers */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Repeat customers"
              sub="Customers with more than one policy">
              <div className="space-y-2">
                <MiniStat label="Repeat rate"
                  value={pctText(d.retention.repeat_rate)} tone="text-slate-900" />
                <div className="grid grid-cols-2 gap-2">
                  <MiniStat label="Customers"
                    value={String(d.retention.total_customers)} />
                  <MiniStat label="Avg policies"
                    value={String(d.retention.avg_policies)} />
                </div>
              </div>
            </Card>
            <Card title="New vs returning customers"
              sub="By month, last 12 months" className="lg:col-span-2">
              <StackedBars format={(n) => String(n)}
                series={[{ label: "New", color: catColor(0) },
                  { label: "Returning", color: catColor(4) }]}
                data={d.customer_trend.map((t) => ({
                  label: monthShort(t.month), parts: [t.new, t.returning] }))} />
            </Card>
          </div>

          {/* Leaderboards */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Top channel partners" sub="By profit contribution">
              <RankedBars color={catColor(2)}
                data={d.top_partners.map((r) => ({
                  label: r.label, value: r.profit,
                  onClick: () => nav(`/finance/entity/partner/${r.key}`) }))} />
            </Card>
            <Card title="Top employees" sub="By profit contribution">
              <RankedBars color={catColor(3)}
                data={d.top_employees.map((r) => ({
                  label: r.label, value: r.profit,
                  onClick: () => nav(`/finance/entity/employee/${r.key}`) }))} />
            </Card>
          </div>

          {/* The "Employees — actual vs target" chart lived here until
              2026-07-26. Removed at the owner's request: target attainment is
              the Targets page's job, and repeating it here gave two screens
              that had to agree about the same number. */}

          {/* Leads + status */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Lead funnel"
              sub={`Conversion ${pctText(d.lead_conversion_pct)}`}
              className="lg:col-span-2">
              <CountBars color={C.count}
                data={d.lead_funnel.map((s: InsightSlice) => ({
                  label: s.label, value: s.count }))} />
            </Card>
            <Card title="Policy status" sub="Current distribution">
              <Donut centerLabel="Policies" format={(n) => String(n)}
                data={d.status_dist.map((s) => ({
                  label: s.label, value: s.count }))} />
            </Card>
          </div>

          {/* Explore & export (per-dimension detail table) */}
          <DetailTable dateFrom={d.date_from ?? ""} dateTo={d.date_to ?? ""}
            periodName={periodLabel(period)} />

          {/* The whole business in one file — the last thing on the page. */}
          <ReportDownload />
        </div>
      )}
    </div>
  );
}

// The per-dimension detail table + CSV/PDF export, kept for drill-down and
// downloadable numbers. Follows the page's top Duration filter (owner
// 2026-07-16: one date filter drives the whole page).
function DetailTable({ dateFrom, dateTo, periodName }: {
  dateFrom: string; dateTo: string; periodName: string;
}) {
  const nav = useNavigate();
  const [dimension, setDimension] = useState("insurer");
  const dim = DIMENSIONS.find((x) => x.value === dimension)!;

  const report = useQuery({
    queryKey: ["finance", "reports", dimension, dateFrom, dateTo],
    queryFn: async () => (await financeApi.reports({
      dimension, date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
    })).data,
    ...liveQueryOptions,
  });
  const rows = report.data?.rows ?? [];
  const label = (r: ReportRow) => dimension === "month"
    ? monthShort(r.key, true) : r.label;
  const columns: { key: string; label: string; get: (r: ReportRow) => string }[] = [
    { key: "label", label: dim.label, get: label },
    { key: "policies", label: "Policies", get: (r) => String(r.policies) },
    { key: "premium", label: "Premium", get: (r) => rupees(r.premium) },
    { key: "reward_earned", label: "Rewards", get: (r) => rupees(r.reward_earned) },
    { key: "reward", label: "Reward", get: (r) => rupees(r.reward) },
    { key: "profit", label: "Profit", get: (r) => rupees(r.profit) },
    { key: "growth", label: "Growth %", get: (r) => r.growth_pct == null ? "" : `${r.growth_pct}%` },
  ];
  const period = periodName;

  const exportCsv = () => {
    const head = columns.map((c) => c.label).join(",");
    const body = rows.map((r) => columns.map((c) =>
      `"${c.get(r).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([`${head}\n${body}`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `finance-report-${dimension}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const exportPdf = () => {
    const win = window.open("", "_blank");
    if (!win) return;
    const th = columns.map((c) => `<th>${c.label}</th>`).join("");
    const trs = rows.map((r) => `<tr>${columns.map((c, i) =>
      `<td class="${i === 0 ? "l" : "r"}">${c.get(r) || "—"}</td>`).join("")}</tr>`)
      .join("");
    win.document.write(`<!doctype html><html><head><title>Finance report</title>
      <style>body{font-family:Inter,system-ui,Arial,sans-serif;color:#18181b;
          padding:28px;-webkit-font-smoothing:antialiased;}
        .top{display:flex;justify-content:space-between;align-items:flex-start;
          border-bottom:1px solid #18181b;padding-bottom:12px;margin-bottom:20px;}
        h1{font-size:18px;margin:0;letter-spacing:-.018em;}
        .muted{color:#71717a;font-size:12px;}
        img{height:44px;} table{width:100%;border-collapse:collapse;font-size:12px;}
        th,td{padding:8px;border-bottom:1px solid #f0f0f2;text-align:right;}
        th:first-child,td.l{text-align:left;}
        thead th{border-bottom:1px solid #e8e8ea;color:#71717a;
          text-transform:uppercase;font-size:10px;letter-spacing:.04em;}
      </style></head><body>
      <div class="top"><div><h1>Finance Report — ${dim.label}</h1>
        <div class="muted">Period: ${period} · Generated ${formatDateTime(new Date().toISOString())}</div></div>
        <img src="/agastya_hindi_full_logo.png" alt="Agastya" /></div>
      <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  };

  return (
    <div className="card">
      <div className="filter-bar">
        <p className="mr-2 text-sm font-semibold text-slate-700">
          Explore &amp; export</p>
        <select className="select h-9 max-w-[190px] text-sm" value={dimension}
          onChange={(e) => setDimension(e.target.value)}>
          {DIMENSIONS.map((x) => (
            <option key={x.value} value={x.value}>By {x.label}</option>))}
        </select>
        <span className="text-xs text-slate-500">{periodName}</span>
        <div className="ml-auto flex gap-2">
          <button className="btn-secondary" onClick={exportCsv}
            disabled={rows.length === 0}><Icon.Download size={16} /> CSV</button>
          <button className="btn-secondary" onClick={exportPdf}
            disabled={rows.length === 0}><Icon.Download size={16} /> PDF</button>
        </div>
      </div>
      {report.isError ? <ErrorState onRetry={() => report.refetch()} /> : report.isLoading ? <PageLoader /> : rows.length === 0 ? (
        <EmptyState title="No data"
          hint="No policies match this dimension / period yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm table-sticky">
            <thead>
              <tr>{columns.map((c, i) => (
                <th key={c.key} className={`px-4 py-3 font-medium ${
                  i === 0 ? "" : "text-right"}`}>{c.label}</th>))}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line-soft
                  hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    {dim.entity ? (
                      <button className="font-medium text-slate-700
                        hover:text-brand-600 hover:underline"
                        onClick={() => nav(`/finance/entity/${dim.entity}/${r.key}`)}>
                        {label(r)}</button>
                    ) : <span className="font-medium text-slate-700">{label(r)}</span>}
                  </td>
                  <td className="px-5 py-3 text-right text-slate-600">{r.policies}</td>
                  <td className="px-5 py-3 text-right text-slate-600">{formatINR(r.premium)}</td>
                  <td className="px-5 py-3 text-right text-slate-600">{formatINR(r.reward_earned)}</td>
                  <td className="px-5 py-3 text-right text-slate-600">{formatINR(r.reward)}</td>
                  <td className="px-5 py-3 text-right font-medium text-money-in">{formatINR(r.profit)}</td>
                  <td className="px-5 py-3 text-right">
                    {r.growth_pct == null ? <span className="text-slate-300">—</span>
                      : <span className={`inline-flex items-center gap-1 ${
                          r.growth_pct >= 0 ? "text-money-in" : "text-money-out"}`}>
                          <Icon.Trend size={14}
                            className={r.growth_pct >= 0 ? "" : "-scale-y-100"} />
                          {Math.abs(r.growth_pct)}%</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


/* -------------------------------------------------------- report download -- */

/**
 * "Everything for the period, in one file" — the section this page ends on.
 *
 * A card at the foot of the page rather than a button in the header (owner
 * 2026-08-04): downloading the report is the last thing you do here, not the
 * first, and it needs room for a period picker and an honest description of
 * what is in the file.
 *
 * Its date filter is deliberately its OWN, not the one driving the charts
 * above. Silently inheriting a period somebody set twenty seconds ago to look
 * at a graph is how you end up emailing your CA the wrong month.
 */
function ReportDownload() {
  const { has, user } = useAuth();
  const canExport = user?.account_type === "owner" || has("export_data");
  // Default to the last COMPLETED month — the one you actually want to close
  // off — rather than the half-finished current one.
  const [period, setPeriod] = useState<PeriodValue>({ period: "last_month" });
  const [busy, setBusy] = useState<"excel" | "pdf" | null>(null);

  const download = async (fmt: "excel" | "pdf") => {
    setBusy(fmt);
    try {
      const res = await businessReportApi.download({
        ...periodParams(period), fmt });
      // The server names the file (it knows whether the range is a whole
      // month), so the browser is only asked to save what it was sent.
      downloadBlob(res.data as Blob,
        filenameFromResponse(res) ?? `Agastya-Report.${
          fmt === "pdf" ? "pdf" : "xlsx"}`);
      toast.success("Downloaded.");
    } catch (e) {
      toast.error(await blobError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card card-body">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-card-title text-slate-900">
            Download the full report</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">
            The whole business for a period in one file — every policy with its
            reward rate and what that rate was applied to, every transaction and
            expense, the channel-partner accounts, and where the money sits.
          </p>
        </div>
        <DateFilter value={period} onChange={setPeriod} />
      </div>

      <ul className="mt-4 grid gap-x-6 gap-y-1.5 text-sm text-slate-600
        sm:grid-cols-2 lg:grid-cols-3">
        {[
          "Every policy, in full detail",
          "Revenue month by month",
          "Every transaction and expense",
          "Channel partner ledgers",
          "Rewards, TDS and payouts",
          "Outstanding, bank and cash",
        ].map((line) => (
          <li key={line} className="flex items-center gap-2">
            <Icon.Check size={14} className="shrink-0 text-money-in" />
            {line}
          </li>
        ))}
      </ul>

      {!canExport ? (
        <p className="mt-4 rounded-control bg-slate-50 p-3 text-sm
          text-slate-500">
          You need the export permission to download the report.
        </p>
      ) : (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t
          border-line pt-4">
          <button className="btn-primary" disabled={!!busy}
            onClick={() => download("excel")}>
            <Icon.Download size={16} />
            {busy === "excel" ? "Building…" : "Download Excel"}
          </button>
          <button className="btn-secondary" disabled={!!busy}
            onClick={() => download("pdf")}>
            <Icon.Download size={16} />
            {busy === "pdf" ? "Building…" : "Download PDF"}
          </button>
          <p className="text-xs text-slate-500">
            Excel has every row and every sheet. The PDF is the one you print
            and hand over.
          </p>
        </div>
      )}
    </div>
  );
}
