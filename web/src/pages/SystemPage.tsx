import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { systemApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { ErrorState, EmptyState, PageLoader, Pagination, TableSkeleton , StatCard } from "../components/ui";
import { toast } from "../components/Toast";
import { KpiTile } from "../components/finance/KpiTile";
import { C } from "../components/finance/charts";
import { downloadBlob } from "../lib/download";
import { formatDateTime, formatINR } from "../lib/format";

function bytesH(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function UsageTab() {
  const [exporting, setExporting] = useState(false);
  const summary = useQuery({
    queryKey: ["system", "usage-summary"],
    queryFn: async () => (await systemApi.usageSummary()).data,
  });
  const s = summary.data;

  const doExport = async () => {
    setExporting(true);
    try {
      const res = await systemApi.usageExport({ fmt: "excel" });
      downloadBlob(res.data as Blob, "api-usage.xlsx");
    } catch (e) { toast.error(apiError(e)); }
    finally { setExporting(false); }
  };

  if (summary.isLoading || !s) return <PageLoader />;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="API calls (30d)" value={String(s.total_calls)}
          accent={C.ink} />
        <KpiTile label="Failed calls" value={String(s.total_errors)}
          accent={s.total_errors ? C.red : C.green} />
        <KpiTile label="Estimated cost" value={formatINR(s.total_cost_paise)}
          sub="paid APIs only; free tiers show ₹0" />
        <KpiTile label="Services used" value={String(s.by_service.length)} />
      </div>

      <div className="card">
        <div className="flex items-center justify-between border-b border-line/70
          p-4">
          <p className="text-sm font-semibold text-slate-700">
            Usage by service (last 30 days)</p>
          <button className="btn-secondary" disabled={exporting}
            onClick={doExport}><Icon.Download size={16} /> Export</button>
        </div>
        {s.by_service.length === 0 ? (
          <EmptyState title="No API activity yet"
            hint="Third-party calls (email, storage, and future paid APIs) will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="px-5 py-3">Service</th>
                  <th className="px-5 py-3 text-right">Calls</th>
                  <th className="px-5 py-3 text-right">Errors</th>
                  <th className="px-5 py-3 text-right">Units</th>
                  <th className="px-5 py-3 text-right">Data</th>
                  <th className="px-5 py-3 text-right">Avg ms</th>
                  <th className="px-5 py-3 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {s.by_service.map((r) => (
                  <tr key={r.service} className="border-t border-line-soft">
                    <td className="px-5 py-3 font-medium text-slate-700">{r.service}</td>
                    <td className="px-5 py-3 text-right text-slate-600">{r.calls}</td>
                    <td className={`px-5 py-2.5 text-right ${
                      r.errors ? "text-money-out" : "text-slate-500"}`}>{r.errors}</td>
                    <td className="px-5 py-3 text-right text-slate-600">{r.units}</td>
                    <td className="px-5 py-3 text-right text-slate-600">
                      {bytesH(r.bytes_transferred)}</td>
                    <td className="px-5 py-3 text-right text-slate-600">
                      {r.avg_duration_ms}</td>
                    <td className="px-5 py-3 text-right font-medium text-slate-700">{formatINR(r.cost_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorsTab() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["system", "errors", page, q],
    queryFn: async () =>
      (await systemApi.errors({ page, page_size: 25, q: q || undefined })).data,
  });
  return (
    <div className="card">
      <div className="border-b border-line/70 p-3">
        <div className="relative max-w-sm">
          <span className="pointer-events-none absolute left-2.5 top-1/2
            -translate-y-1/2 text-slate-400"><Icon.Search size={15} /></span>
          <input className="input w-full pl-8 text-sm" value={q}
            placeholder="Search ref (ERR-…), path, message…"
            onChange={(e) => { setPage(1); setQ(e.target.value); }} />
        </div>
      </div>
      {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? <TableSkeleton cols={4} /> :
      (list.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No errors logged"
          hint="Unexpected server errors would show here with their reference code." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="px-5 py-3">Time</th>
                <th className="px-5 py-3">Reference</th>
                <th className="px-5 py-3">Where</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Message</th>
              </tr>
            </thead>
            <tbody>
              {list.data!.items.map((e) => (
                <tr key={e.id} className="border-t border-line-soft">
                  <td className="whitespace-nowrap px-5 py-3 text-slate-500">
                    {formatDateTime(e.created_at)}</td>
                  <td className="px-5 py-3">
                    <code className="rounded bg-money-out/10 px-1.5 py-0.5 text-xs
                      font-medium text-money-out">{e.ref}</code></td>
                  <td className="px-5 py-3 text-xs text-slate-500">
                    {e.method} {e.path}</td>
                  <td className="px-5 py-3 text-slate-600">{e.exc_type}</td>
                  <td className="max-w-md truncate px-5 py-3 text-slate-600"
                    title={e.message}>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && (
        <Pagination page={page} pageSize={25} total={list.data.total}
          onChange={setPage} />
      )}
    </div>
  );
}

function HealthStripCards() {
  const q = useQuery({
    queryKey: ["system", "health"],
    queryFn: async () => (await systemApi.health()).data,
  });
  const h = q.data;
  if (!h) return null;
  const cards = [
    { label: "Errors today", value: h.errors_today, bad: h.errors_today > 0 },
    { label: "Emails failed", value: h.emails_failed_today,
      bad: h.emails_failed_today > 0 },
    { label: "API calls today", value: h.api_calls_today, bad: false },
    { label: "Overdue renewals", value: h.overdue_renewals,
      bad: h.overdue_renewals > 0 },
  ];
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <StatCard key={c.label} label={c.label} value={c.value}
          tone={c.bad ? "out" : undefined} />
      ))}
    </div>
  );
}

export default function SystemPage() {
  const [tab, setTab] = useState<"usage" | "errors">("usage");
  return (
    <div>
      <PageHeader title="System & Usage"
        subtitle="Third-party API usage/cost and server error logs (owner only)." />
      <HealthStripCards />
      <div className="mb-5 flex gap-1 border-b border-line">
        {(["usage", "errors"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === t
                ? "border-brand-600 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-600"}`}>
            {t === "usage" ? "API Usage & Cost" : "Error Logs"}</button>
        ))}
      </div>
      {tab === "usage" ? <UsageTab /> : <ErrorsTab />}
    </div>
  );
}
