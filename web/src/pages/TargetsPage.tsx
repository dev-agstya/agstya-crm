import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { targetsApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  Avatar, CardSkeleton, EmptyState, ErrorState, Modal, SearchInput, Segmented,
} from "../components/ui";
import { FilterPill } from "../components/FilterPill";
import {
  MetricBars, TargetRing, pctLabel, toneFor,
} from "../components/TargetProgress";
import { TargetGoalsForm } from "../components/TargetGoalsForm";
import { ManagerRosterPanel } from "../components/ManagerRosterPanel";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { formatINR, formatMonthYear } from "../lib/format";
import { refreshFinance } from "../lib/live";
import { canSeeProfitTargets } from "../lib/targets";
import { useAuth } from "../store/auth";
import type { PerformanceReport, PerformanceRow } from "../lib/types";

/*
  Targets — the month's goals for everyone, and where they are set.

  THE SHAPE (2026-08-07 rebuild). This page was two tabs: a Performance table of
  eight columns, and an Assign tab that was a spreadsheet of bare number inputs,
  one row per person and one column per metric. Both were correct and neither
  was usable — a grid of forty identical empty boxes asks you to decide forty
  numbers with nothing on screen to decide them from, and it made "set one
  person's target" the same amount of work as setting everybody's.

  The owner's instruction was to assign "by clicking on them". So the page is a
  ROSTER: one card per person carrying their ring, their goals and what they
  have actually done, and clicking one opens the dialog for that person alone.

  Two things kept from the old page because they were genuinely load-bearing:
  the coverage summary (who has NO target is the question this page exists to
  answer) and Copy last month, which is how a month gets set up in one action
  rather than forty.
*/

type Kind = "employee" | "channel_partner";
type Status = "" | "on_track" | "close" | "behind" | "none";

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

const statusOf = (r: PerformanceRow): Status => {
  if (!r.has_target) return "none";
  const tone = toneFor(r.attainment_pct);
  return tone === "done" ? "on_track" : tone === "close" ? "close" : "behind";
};

/*
  WHO SEES WHAT ON THIS PAGE (2026-08-21).

  The owner asked where an employee sees their own target, and how they give one
  to a channel partner under them. Both already worked — their number was on the
  dashboard, and the server has let a relationship manager set their own
  roster's targets without `manage_targets` since owner F1 in July. What did not
  work was FINDING either: this page needed `view_targets`, so the one entry in
  the sidebar actually called "Targets" was hidden from the people carrying
  them, and the way to set a partner's number was three levels down a page
  called Channel Partners.

  So the page is `employeeAny` now (lib/access) and answers to two audiences,
  the same shape Attendance uses:

    with view_targets / manage_targets   EVERYONE — the roster below, unchanged
    without                              MY TARGETS — their own number and the
                                         partners on their own roster

  The split is a real one, not a hidden column: `GET /api/targets/performance`
  refuses a caller without the flag ("You can't view the team's targets"), and
  it is right to. The personal view is built from the two endpoints such a
  caller may already call — their own progress, and their own roster — so the
  page never issues a request it knows will 403.
*/
export default function TargetsPage() {
  const { has } = useAuth();
  // The owner passes `has` on every flag, so this is the whole-agency view for
  // them without a special case.
  const seesEveryone = has("view_targets") || has("manage_targets");
  return seesEveryone ? <EveryoneTargets /> : <MyTargets />;
}

/**
 * MY TARGETS — for an employee with no targets permission at all.
 *
 * Deliberately NOT a new screen. `ManagerRosterPanel` already opens with "My
 * target" and already carries the Set button on each partner (gated by the
 * server's own `can_manage_targets`, so a relationship manager gets it and
 * anybody else does not). Rendering it here is opening a door, not building a
 * room — and it means this view and the My Team tab can never disagree, because
 * they are the same component reading the same serialiser.
 *
 * An employee with NOBODY under them still gets this page (owner C3): it still
 * answers "what is my number this month", which is the question most staff have.
 */
function MyTargets() {
  return (
    <div>
      <PageHeader
        title="Targets"
        eyebrow="Workplace"
        subtitle="Your target for the month, and the channel partners you set
          targets for." />
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
  const [status, setStatus] = useState<Status>("");
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
      if (status && statusOf(r) !== status) return false;
      if (!needle) return true;
      return r.name.toLowerCase().includes(needle)
        || (r.code ?? "").toLowerCase().includes(needle);
    });
  }, [rows, q, status]);

  // Copy last month — the one bulk action worth keeping. A month is usually
  // "the same as last month, adjusted", and without this that is forty dialogs.
  const copyLastMonth = useMutation({
    mutationFn: async () => {
      const prev = (await targetsApi.performance({
        month: shiftMonth(month, -1), kind })).data;
      const withGoals = prev.rows.filter((r) => r.metrics.length > 0);
      if (withGoals.length === 0) {
        throw new Error(`Nobody had a target in ${monthLabel(
          shiftMonth(month, -1))}.`);
      }
      await targetsApi.bulk({
        period: "month",
        period_start: `${month}-01T00:00:00Z`,
        rows: withGoals.map((r) => ({
          assignee_id: r.assignee_id,
          assignee_type: kind,
          metrics: Object.fromEntries(
            r.metrics.map((m) => [m.metric, m.target_value])),
        })),
      });
      return withGoals.length;
    },
    onSuccess: (n) => {
      toast.success(`Copied ${n} ${n === 1 ? "target" : "targets"} into `
        + `${monthLabel(month)}.`);
      qc.invalidateQueries({ queryKey: ["targets"] });
      refreshFinance(qc);
    },
    onError: (e) => toast.error(
      e instanceof Error && !("response" in e) ? e.message : apiError(e)),
  });

  const counts = useMemo(() => {
    const base = { "": rows.length, on_track: 0, close: 0, behind: 0, none: 0 };
    rows.forEach((r) => { base[statusOf(r)] += 1; });
    return base as Record<Status, number>;
  }, [rows]);

  return (
    <div>
      <PageHeader
        title="Targets"
        eyebrow="Workplace"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <button className="btn-secondary"
                onClick={() => copyLastMonth.mutate()}
                disabled={copyLastMonth.isPending}>
                <Icon.Refresh size={16} />
                {copyLastMonth.isPending ? "Copying…" : "Copy last month"}
              </button>
            )}
            <div className="flex items-center gap-1">
              <button className="icon-btn" title="Previous month"
                onClick={() => setMonth((m) => shiftMonth(m, -1))}>
                <Icon.ChevronLeft size={16} />
              </button>
              <span className="min-w-[120px] text-center text-sm font-semibold
                text-slate-800">{monthLabel(month)}</span>
              <button className="icon-btn" title="Next month"
                onClick={() => setMonth((m) => shiftMonth(m, 1))}>
                <Icon.ChevronRight size={16} />
              </button>
            </div>
          </div>
        } />

      {report.isError ? (
        <ErrorState onRetry={() => report.refetch()} />
      ) : (
        <div className="space-y-4">
          <CoverageStrip report={d} loading={report.isLoading}
            canSeeProfit={canSeeProfit} />

          <div className="ledger-bar">
            <Segmented<Kind> value={kind} onChange={setKind} options={[
              { value: "employee", label: "Employees" },
              { value: "channel_partner", label: "Channel Partners" },
            ]} />
            <SearchInput value={q} onChange={setQ} className="w-full sm:w-56"
              placeholder="Search name or code…" />
            {/* The counts say what you are about to hide — and "no target" is
                the one people come here to find. */}
            <FilterPill label="Status" value={status}
              onChange={(v) => setStatus(v as Status)}
              allLabel={`Everyone (${counts[""]})`}
              options={[
                { value: "none", label: `No target (${counts.none})` },
                { value: "behind", label: `Behind (${counts.behind})` },
                { value: "close", label: `Close (${counts.close})` },
                { value: "on_track", label: `On target (${counts.on_track})` },
              ]} />
          </div>

          {report.isLoading ? (
            <CardSkeleton count={6} className="sm:grid-cols-2 xl:grid-cols-3" />
          ) : rows.length === 0 ? (
            <EmptyState title="Nobody to show"
              icon={<Icon.Users size={22} />}
              hint={kind === "employee"
                ? "Add an employee to start setting targets."
                : "Add a channel partner to start setting targets."} />
          ) : filtered.length === 0 ? (
            <EmptyState title="Nobody matches these filters"
              action={<button className="btn-secondary"
                onClick={() => { setQ(""); setStatus(""); }}>
                Clear filters</button>} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2
              xl:grid-cols-3">
              {filtered.map((r) => (
                <PersonTargetCard key={r.assignee_id} row={r}
                  canSeeProfit={canSeeProfit}
                  canManage={canManage}
                  onOpen={() => setEditing(r)} />
              ))}
            </div>
          )}
        </div>
      )}

      {editing && (
        <TargetEditor row={editing} kind={kind} month={month}
          onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the summary -- */

function CoverageStrip({ report, loading, canSeeProfit }: {
  report?: PerformanceReport;
  loading: boolean;
  canSeeProfit: boolean;
}) {
  const people = report?.rows.length ?? 0;
  const withTarget = report?.with_target ?? 0;
  const onTrack = report?.on_track ?? 0;
  const missing = people - withTarget;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <SummaryTile label="Covered"
        value={loading ? "—" : `${withTarget} of ${people}`}
        sub={missing > 0
          ? `${missing} without a target`
          : people > 0 ? "everyone has a number" : "nobody to cover"}
        tone={missing > 0 && people > 0 ? "due" : "in"} />
      <SummaryTile label="On target"
        value={loading || !withTarget ? "—" : `${onTrack} of ${withTarget}`}
        sub={withTarget ? "hit their number" : "no targets set"}
        tone={withTarget && onTrack === withTarget ? "in" : "plain"} />
      <SummaryTile label="Policies booked"
        value={loading ? "—" : String(report?.totals.policies ?? 0)}
        sub={`${report?.totals.renewals ?? 0} renewals`} tone="plain" />
      {/* No `?? 0` on money: formatINR(null) is an em-dash, and a report that
          failed to load must not claim the house made nothing. */}
      <SummaryTile
        label={canSeeProfit ? "House profit" : "Premium booked"}
        value={loading ? "—" : formatINR(
          canSeeProfit ? report?.totals.profit : report?.totals.premium)}
        sub={report?.period_label ?? ""} tone="plain" />
    </div>
  );
}

function SummaryTile({ label, value, sub, tone }: {
  label: string; value: string; sub: string;
  tone: "in" | "due" | "plain";
}) {
  return (
    <div className="card p-4">
      <p className="text-caption uppercase text-slate-500">{label}</p>
      <p className={`metric-sm mt-1 tabular-nums ${
        tone === "in" ? "text-money-in"
          : tone === "due" ? "text-due" : "text-slate-900"}`}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- the card -- */

function PersonTargetCard({ row, canSeeProfit, canManage, onOpen }: {
  row: PerformanceRow;
  canSeeProfit: boolean;
  canManage: boolean;
  onOpen: () => void;
}) {
  const tone = toneFor(row.attainment_pct);

  return (
    // A real button, so the whole card is one keyboard stop with one label —
    // a div with onClick is thirty cards a keyboard user cannot reach.
    <button type="button" onClick={onOpen}
      aria-label={row.has_target
        ? `${row.name}, ${pctLabel(row.attainment_pct)} of target`
        : `${row.name}, no target set`}
      className="card group p-4 text-left transition-colors
        hover:border-slate-300 hover:bg-slate-50/60">
      <div className="flex items-start gap-3">
        <Avatar name={row.name} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-800">{row.name}</p>
          <p className="truncate text-xs text-slate-500">
            {row.code ?? "—"}
          </p>
        </div>
        {row.has_target ? (
          <TargetRing pct={row.attainment_pct} size={52} stroke={5} />
        ) : (
          <span className="badge-neutral shrink-0">No target</span>
        )}
      </div>

      {row.has_target ? (
        <div className="mt-3.5">
          <MetricBars rows={row.metrics} compact />
        </div>
      ) : (
        <p className="mt-3.5 flex items-center gap-1.5 text-xs text-slate-500">
          <Icon.Target size={14} className="shrink-0 text-slate-400" />
          {canManage
            ? "Click to set one for this month."
            : "Nobody has set a target for this month."}
        </p>
      )}

      {/* What they have actually done, target or not. A person with no goal
          still has a month, and hiding it is how somebody gets forgotten. */}
      <div className="mt-3.5 flex items-center gap-4 border-t border-line/70
        pt-2.5 text-xs text-slate-500">
        <span className="tabular-nums">
          <b className="font-semibold text-slate-700">{row.policies}</b> policies
        </span>
        <span className="tabular-nums">
          <b className="font-semibold text-slate-700">{row.renewals}</b> renewals
        </span>
        <span className="ml-auto tabular-nums">
          {canSeeProfit ? formatINR(row.profit) : formatINR(row.premium)}
        </span>
      </div>

      {row.has_target && tone === "done" && (
        <p className="mt-2 text-xs font-medium text-money-in">
          Target achieved
        </p>
      )}
    </button>
  );
}

/* -------------------------------------------------------------- the dialog -- */

function TargetEditor({ row, kind, month, onClose }: {
  row: PerformanceRow; kind: Kind; month: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const { has } = useAuth();
  // A relationship manager may set their OWN partners' targets without
  // manage_targets (owner F1). The server is the enforcement
  // (routers/targets._may_assign); this decides whether to draw the form.
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
    <Modal open onClose={onClose}
      title={row.has_target ? "Update target" : "Set target"} size="lg">
      {canManage ? (
        <TargetGoalsForm
          assigneeId={row.assignee_id}
          assigneeType={kind}
          assigneeName={row.name}
          assigneeCode={row.code}
          existingMetrics={row.metrics}
          // The roster knows the month it is showing, and the form defaults to
          // the target's own month — but a row with NO target has no month to
          // read, so pass the one on screen rather than letting it fall back to
          // today and set a target for the wrong month.
          target={row.target_id
            ? ({ id: row.target_id, metrics: row.metrics,
                 period_start: `${month}-01T00:00:00Z` } as never)
            : null}
          onDone={onClose}
          onCancel={onClose}
          onDelete={row.target_id ? async () => {
            if (await confirmDialog({
              message: `Remove ${row.name}'s target for this month?`,
              danger: true,
            })) del.mutate(row.target_id!);
          } : undefined}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            You can see {row.name}'s target but not change it.
          </p>
          {row.has_target
            ? <MetricBars rows={row.metrics} />
            : <EmptyState title="No target set"
                hint="Ask an owner or a manager to set one." />}
          <div className="flex justify-end">
            <button className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
