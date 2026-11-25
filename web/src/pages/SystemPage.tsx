import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { systemApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { ErrorState } from "../components/shared/ErrorState";
import {
  CardGridSkeleton,
  TableSkeleton,
} from "../components/shared/LoadingSkeleton";
import { Pagination } from "../components/ui";
import { toast } from "../components/Toast";
import { KpiTile } from "../components/finance/KpiTile";
import { C } from "../components/finance/charts";
import { downloadBlob } from "../lib/download";
import { formatDateTime, formatINR } from "../lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setExporting(false);
    }
  };

  if (summary.isLoading || !s) return <CardGridSkeleton count={4} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="API calls (30d)"
          value={String(s.total_calls)}
          accent={C.ink}
        />
        <KpiTile
          label="Failed calls"
          value={String(s.total_errors)}
          accent={s.total_errors ? C.red : C.green}
        />
        <KpiTile
          label="Estimated cost"
          value={formatINR(s.total_cost_paise)}
          sub="paid APIs only; free tiers show ₹0"
        />
        <KpiTile label="Services used" value={String(s.by_service.length)} />
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Usage by service (last 30 days)
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={exporting}
            onClick={doExport}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export
          </Button>
        </div>
        {s.by_service.length === 0 ? (
          <EmptyState
            title="No API activity yet"
            description="Third-party calls (email, storage, and future paid APIs) will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="h-9 text-xs">Service</TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    Calls
                  </TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    Errors
                  </TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    Units
                  </TableHead>
                  <TableHead className="h-9 text-right text-xs">Data</TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    Avg ms
                  </TableHead>
                  <TableHead className="h-9 text-right text-xs">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.by_service.map((r) => (
                  <TableRow key={r.service}>
                    <TableCell className="py-2 text-[13px] font-medium text-foreground">
                      {r.service}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] tabular-nums text-muted-foreground">
                      {r.calls}
                    </TableCell>
                    <TableCell
                      className={`py-2 text-right text-[13px] tabular-nums ${
                        r.errors
                          ? "font-medium text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {r.errors}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] tabular-nums text-muted-foreground">
                      {r.units}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] tabular-nums text-muted-foreground">
                      {bytesH(r.bytes_transferred)}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] tabular-nums text-muted-foreground">
                      {r.avg_duration_ms}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] font-medium tabular-nums text-foreground">
                      {formatINR(r.cost_paise)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}

function ErrorsTab() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["system", "errors", page, q],
    queryFn: async () =>
      (
        await systemApi.errors({
          page,
          page_size: 25,
          q: q || undefined,
        })
      ).data,
  });
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border p-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            value={q}
            placeholder="Search ref (ERR-…), path, message…"
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
        </div>
      </div>
      {list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : list.isLoading ? (
        <TableSkeleton cols={4} />
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No errors logged"
          description="Unexpected server errors would show here with their reference code."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="h-9 text-xs">Time</TableHead>
                <TableHead className="h-9 text-xs">Reference</TableHead>
                <TableHead className="h-9 text-xs">Where</TableHead>
                <TableHead className="h-9 text-xs">Type</TableHead>
                <TableHead className="h-9 text-xs">Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap py-2 text-xs text-muted-foreground">
                    {formatDateTime(e.created_at)}
                  </TableCell>
                  <TableCell className="py-2">
                    <code className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                      {e.ref}
                    </code>
                  </TableCell>
                  <TableCell className="py-2 text-xs text-muted-foreground">
                    {e.method} {e.path}
                  </TableCell>
                  <TableCell className="py-2 text-xs text-foreground">
                    {e.exc_type}
                  </TableCell>
                  <TableCell
                    className="max-w-md truncate py-2 text-xs text-muted-foreground"
                    title={e.message}
                  >
                    {e.message}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {list.data && (
        <div className="border-t border-border px-4">
          <Pagination
            page={page}
            pageSize={25}
            total={list.data.total}
            onChange={setPage}
          />
        </div>
      )}
    </Card>
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
    {
      label: "Emails failed",
      value: h.emails_failed_today,
      bad: h.emails_failed_today > 0,
    },
    { label: "API calls today", value: h.api_calls_today, bad: false },
    {
      label: "Overdue renewals",
      value: h.overdue_renewals,
      bad: h.overdue_renewals > 0,
    },
  ];
  return (
    <div className="grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-y-0">
      {cards.map((c) => (
        <div key={c.label} className="px-3.5 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            {c.label}
          </p>
          <p
            className={`mt-0.5 text-lg font-semibold tabular-nums ${
              c.bad ? "text-destructive" : "text-foreground"
            }`}
          >
            {c.value}
          </p>
        </div>
      ))}
    </div>
  );
}

export default function SystemPage() {
  const [tab, setTab] = useState<"usage" | "errors">("usage");
  return (
    <div className="space-y-3">
      <PageHeader
        title="System & Usage"
        subtitle="Third-party API usage/cost and server error logs (owner only)."
      />
      <HealthStripCards />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "usage" | "errors")}
      >
        <TabsList className="h-9">
          <TabsTrigger value="usage" className="text-xs">
            API Usage &amp; Cost
          </TabsTrigger>
          <TabsTrigger value="errors" className="text-xs">
            Error Logs
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "usage" ? <UsageTab /> : <ErrorsTab />}
    </div>
  );
}
