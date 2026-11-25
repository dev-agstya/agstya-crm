import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Target,
  Users,
} from "lucide-react";
import { targetsApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { ErrorState } from "../components/shared/ErrorState";
import { CardGridSkeleton } from "../components/shared/LoadingSkeleton";
import {
  MetricBars,
  TargetRing,
  pctLabel,
  toneFor,
} from "../components/TargetProgress";
import { TargetGoalsForm } from "../components/TargetGoalsForm";
import { ManagerRosterPanel } from "../components/ManagerRosterPanel";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { formatINR, formatMonthYear, initials } from "../lib/format";
import { refreshFinance } from "../lib/live";
import { canSeeProfitTargets } from "../lib/targets";
import { useAuth } from "../store/auth";
import type { PerformanceReport, PerformanceRow } from "../lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/*
  Targets UX pattern: Lattice/Linear style — compact 1-line PageHeader with month stepper
  and Copy last month button, slim 4-metric coverage strip, compact single-row toolbar
  (Employees / Channel Partners tabs + search + status select), and 3-column target cards.
*/

type Kind = "employee" | "channel_partner";
type Status = "all" | "on_track" | "close" | "behind" | "none";

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return formatMonthYear(new Date(y, m - 1, 1));
}

const statusOf = (r: PerformanceRow): Exclude<Status, "all"> => {
  if (!r.has_target) return "none";
  const tone = toneFor(r.attainment_pct);
  return tone === "done" ? "on_track" : tone === "close" ? "close" : "behind";
};

export default function TargetsPage() {
  const { has } = useAuth();
  const seesEveryone = has("view_targets") || has("manage_targets");
  return seesEveryone ? <EveryoneTargets /> : <MyTargets />;
}

function MyTargets() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Targets"
        subtitle="Your target for the month, and the channel partners you set targets for."
      />
      <ManagerRosterPanel />
    </div>
  );
}

function EveryoneTargets() {
  const { user, has } = useAuth();
  const qc = useQueryClient();
  const canManage = has("manage_targets");
  const canSeeProfit = canSeeProfitTargets(user);

  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [kind, setKind] = useState<Kind>("employee");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [editing, setEditing] = useState<PerformanceRow | null>(null);

  const report = useQuery({
    queryKey: ["targets", "performance", month, kind],
    queryFn: async () =>
      (await targetsApi.performance({ month, kind })).data,
  });
  const d = report.data;
  const rows = d?.rows ?? [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "all" && statusOf(r) !== status) return false;
      if (!needle) return true;
      return (
        r.name.toLowerCase().includes(needle) ||
        (r.code ?? "").toLowerCase().includes(needle)
      );
    });
  }, [rows, q, status]);

  const copyLastMonth = useMutation({
    mutationFn: async () => {
      const prev = (
        await targetsApi.performance({
          month: shiftMonth(month, -1),
          kind,
        })
      ).data;
      const withGoals = prev.rows.filter((r) => r.metrics.length > 0);
      if (withGoals.length === 0) {
        throw new Error(
          `Nobody had a target in ${monthLabel(shiftMonth(month, -1))}.`
        );
      }
      await targetsApi.bulk({
        period: "month",
        period_start: `${month}-01T00:00:00Z`,
        rows: withGoals.map((r) => ({
          assignee_id: r.assignee_id,
          assignee_type: kind,
          metrics: Object.fromEntries(
            r.metrics.map((m) => [m.metric, m.target_value])
          ),
        })),
      });
      return withGoals.length;
    },
    onSuccess: (n) => {
      toast.success(
        `Copied ${n} ${n === 1 ? "target" : "targets"} into ${monthLabel(
          month
        )}.`
      );
      qc.invalidateQueries({ queryKey: ["targets"] });
      refreshFinance(qc);
    },
    onError: (e) =>
      toast.error(
        e instanceof Error && !("response" in e) ? e.message : apiError(e)
      ),
  });

  const counts = useMemo(() => {
    const base = { all: rows.length, on_track: 0, close: 0, behind: 0, none: 0 };
    rows.forEach((r) => {
      base[statusOf(r)] += 1;
    });
    return base as Record<Status, number>;
  }, [rows]);

  return (
    <div className="space-y-3">
      <PageHeader
        title="Targets"
        subtitle="Monthly goals and attainment."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => copyLastMonth.mutate()}
                disabled={copyLastMonth.isPending}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {copyLastMonth.isPending ? "Copying…" : "Copy last month"}
              </Button>
            )}
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8"
                title="Previous month"
                onClick={() => setMonth((m) => shiftMonth(m, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[110px] text-center text-xs font-semibold text-foreground">
                {monthLabel(month)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8"
                title="Next month"
                onClick={() => setMonth((m) => shiftMonth(m, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        }
      />

      {report.isError ? (
        <ErrorState onRetry={() => report.refetch()} />
      ) : (
        <div className="space-y-3">
          <CoverageStrip
            report={d}
            loading={report.isLoading}
            canSeeProfit={canSeeProfit}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <TabsList className="h-9">
                <TabsTrigger value="employee" className="text-xs">
                  Employees
                </TabsTrigger>
                <TabsTrigger value="channel_partner" className="text-xs">
                  Channel Partners
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="relative w-full sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name or code…"
                className="pl-8"
              />
            </div>

            <Select
              value={status}
              onValueChange={(v) => setStatus(v as Status)}
            >
              <SelectTrigger className="h-9 w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone ({counts.all})</SelectItem>
                <SelectItem value="none">No target ({counts.none})</SelectItem>
                <SelectItem value="behind">
                  Behind ({counts.behind})
                </SelectItem>
                <SelectItem value="close">Close ({counts.close})</SelectItem>
                <SelectItem value="on_track">
                  On target ({counts.on_track})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {report.isLoading ? (
            <CardGridSkeleton count={6} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Users className="h-5 w-5" />}
              title="Nobody to show"
              description={
                kind === "employee"
                  ? "Add an employee to start setting targets."
                  : "Add a channel partner to start setting targets."
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="Nobody matches these filters"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQ("");
                    setStatus("all");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((r) => (
                <PersonTargetCard
                  key={r.assignee_id}
                  row={r}
                  canSeeProfit={canSeeProfit}
                  canManage={canManage}
                  onOpen={() => setEditing(r)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {editing && (
        <TargetEditor
          row={editing}
          kind={kind}
          month={month}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CoverageStrip({
  report,
  loading,
  canSeeProfit,
}: {
  report?: PerformanceReport;
  loading: boolean;
  canSeeProfit: boolean;
}) {
  const people = report?.rows.length ?? 0;
  const withTarget = report?.with_target ?? 0;
  const onTrack = report?.on_track ?? 0;
  const missing = people - withTarget;

  return (
    <div className="grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-y-0">
      <div className="px-3.5 py-2.5">
        <p className="text-[11px] font-medium text-muted-foreground">Covered</p>
        <p
          className={`mt-0.5 text-lg font-semibold tabular-nums ${
            missing > 0 && people > 0 ? "text-amber-700" : "text-emerald-700"
          }`}
        >
          {loading ? "—" : `${withTarget} of ${people}`}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {missing > 0
            ? `${missing} without a target`
            : people > 0
              ? "everyone has a number"
              : "nobody to cover"}
        </p>
      </div>
      <div className="px-3.5 py-2.5">
        <p className="text-[11px] font-medium text-muted-foreground">
          On target
        </p>
        <p
          className={`mt-0.5 text-lg font-semibold tabular-nums ${
            withTarget && onTrack === withTarget
              ? "text-emerald-700"
              : "text-foreground"
          }`}
        >
          {loading || !withTarget ? "—" : `${onTrack} of ${withTarget}`}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {withTarget ? "hit their number" : "no targets set"}
        </p>
      </div>
      <div className="px-3.5 py-2.5">
        <p className="text-[11px] font-medium text-muted-foreground">
          Policies booked
        </p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
          {loading ? "—" : String(report?.totals.policies ?? 0)}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {report?.totals.renewals ?? 0} renewals
        </p>
      </div>
      <div className="px-3.5 py-2.5">
        <p className="text-[11px] font-medium text-muted-foreground">
          {canSeeProfit ? "House profit" : "Premium booked"}
        </p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
          {loading
            ? "—"
            : formatINR(
                canSeeProfit ? report?.totals.profit : report?.totals.premium
              )}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {report?.period_label ?? ""}
        </p>
      </div>
    </div>
  );
}

function PersonTargetCard({
  row,
  canSeeProfit,
  canManage,
  onOpen,
}: {
  row: PerformanceRow;
  canSeeProfit: boolean;
  canManage: boolean;
  onOpen: () => void;
}) {
  const tone = toneFor(row.attainment_pct);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={
        row.has_target
          ? `${row.name}, ${pctLabel(row.attainment_pct)} of target`
          : `${row.name}, no target set`
      }
      className="group rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/20"
    >
      <div className="flex items-start gap-2.5">
        <Avatar className="h-9 w-9 shrink-0">
          <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
            {initials(row.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {row.name}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {row.code ?? "—"}
          </p>
        </div>
        {row.has_target ? (
          <TargetRing pct={row.attainment_pct} size={48} stroke={5} />
        ) : (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            No target
          </Badge>
        )}
      </div>

      {row.has_target ? (
        <div className="mt-3">
          <MetricBars rows={row.metrics} compact />
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Target className="h-3.5 w-3.5 shrink-0" />
          {canManage
            ? "Click to set one for this month."
            : "Nobody has set a target for this month."}
        </p>
      )}

      <div className="mt-3 flex items-center gap-4 border-t border-border/70 pt-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          <strong className="font-semibold text-foreground">
            {row.policies}
          </strong>{" "}
          policies
        </span>
        <span className="tabular-nums">
          <strong className="font-semibold text-foreground">
            {row.renewals}
          </strong>{" "}
          renewals
        </span>
        <span className="ml-auto font-medium tabular-nums text-foreground">
          {canSeeProfit ? formatINR(row.profit) : formatINR(row.premium)}
        </span>
      </div>

      {row.has_target && tone === "done" && (
        <p className="mt-1.5 text-[11px] font-medium text-emerald-700">
          Target achieved
        </p>
      )}
    </button>
  );
}

function TargetEditor({
  row,
  kind,
  month,
  onClose,
}: {
  row: PerformanceRow;
  kind: Kind;
  month: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { has } = useAuth();
  const canManage = has("manage_targets");

  const del = useMutation({
    mutationFn: (id: string) => targetsApi.remove(id),
    onSuccess: () => {
      toast.success("Target removed.");
      qc.invalidateQueries({ queryKey: ["targets"] });
      refreshFinance(qc);
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {row.has_target ? "Update target" : "Set target"}
          </DialogTitle>
        </DialogHeader>
        {canManage ? (
          <TargetGoalsForm
            assigneeId={row.assignee_id}
            assigneeType={kind}
            assigneeName={row.name}
            assigneeCode={row.code}
            existingMetrics={row.metrics}
            target={
              row.target_id
                ? ({
                    id: row.target_id,
                    metrics: row.metrics,
                    period_start: `${month}-01T00:00:00Z`,
                  } as never)
                : null
            }
            onDone={onClose}
            onCancel={onClose}
            onDelete={
              row.target_id
                ? async () => {
                    if (
                      await confirmDialog({
                        message: `Remove ${row.name}'s target for this month?`,
                        danger: true,
                      })
                    )
                      del.mutate(row.target_id!);
                  }
                : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              You can see {row.name}&apos;s target but not change it.
            </p>
            {row.has_target ? (
              <MetricBars rows={row.metrics} />
            ) : (
              <EmptyState
                title="No target set"
                description="Ask an owner or a manager to set one."
              />
            )}
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
