import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { attendanceApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import {
  EmptyState, ErrorState, Ledger, LedgerCell, LedgerRow, LTh, ListShell,
  MobileCard, Pagination, PersonCell, Segmented, TableSkeleton,
} from "../../components/ui";
import { PunchPanel } from "../../components/hr/PunchPanel";
import {
  AttendanceMonthTable, AttendanceSummaryTiles,
} from "../../components/hr/AttendanceMonth";
import {
  EditDayDialog, RaiseCorrectionDialog,
} from "../../components/hr/DayEditors";
import {
  TeamDayBoard, TeamMonthGrid,
} from "../../components/hr/TeamAttendance";
import { toast } from "../../components/Toast";
import { blobError, downloadBlob } from "../../lib/download";
import {
  LEAVE_STATUS_LABELS, dayLabel, formatTime, isCurrentMonth, leaveStatusBadge,
  monthKey, monthLabel, shiftMonth, todayKey,
} from "../../lib/hr";
import { formatDateTime } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { AttendanceDay } from "../../lib/types";

/*
  Attendance — ONE page, four views.

  The owner has been explicit twice about not wanting "random pages for each and
  every shit thing", and this is the shape that answer takes here: my month,
  today's board, the month grid and the correction queue are four questions
  about one subject, switched with the app's own `Segmented` control exactly as
  Employees switches between Directory and Performance.

  WHAT NEEDS NO PERMISSION: "My attendance". Every employee reaches their own
  register and the punch clock with no flag at all — the rule targets already
  follow. The other three views need `view_attendance`, and the server refuses
  them independently, so hiding the tab is UX rather than the gate.

  The punch panel sits ABOVE the view switch, not inside "My attendance",
  because it is the thing most people open this page to press and it should not
  disappear when somebody glances at the team.
*/

type View = "mine" | "today" | "month" | "corrections";

const PAGE_SIZE = 25;

export default function AttendancePage() {
  const { user, has } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  const canSeeTeam = has("view_attendance");
  const canManage = has("manage_attendance");
  const canExport = has("export_data") && canSeeTeam;

  const requested = params.get("view") as View | null;
  const [view, setView] = useState<View>(
    requested && canSeeTeam ? requested : "mine");
  const [month, setMonth] = useState(
    () => params.get("month") || monthKey(new Date()));
  const [day, setDay] = useState(todayKey());
  // Whose month is on screen. Empty = mine; set by clicking a person on the
  // team board, which is what makes "the board" and "one person's month" one
  // page rather than two.
  const [whose, setWhose] = useState<string>("");

  const [editing, setEditing] = useState<AttendanceDay | null>(null);
  const [correcting, setCorrecting] = useState<AttendanceDay | null>(null);
  const [correctionsPage, setCorrectionsPage] = useState(1);

  const setView2 = (v: View) => {
    setView(v);
    setWhose("");
    const next = new URLSearchParams(params);
    if (v === "mine") next.delete("view"); else next.set("view", v);
    setParams(next, { replace: true });
  };

  /* ------------------------------------------------------------- queries -- */

  const mine = useQuery({
    queryKey: ["hr", "month", month, whose],
    queryFn: async () =>
      (await attendanceApi.month({ month, user_id: whose || undefined })).data,
    enabled: view === "mine",
  });

  const today = useQuery({
    queryKey: ["hr", "team-day", day],
    queryFn: async () => (await attendanceApi.teamDay({ day })).data,
    enabled: view === "today" && canSeeTeam,
  });

  const grid = useQuery({
    queryKey: ["hr", "team-month", month],
    queryFn: async () => (await attendanceApi.teamMonth({ month })).data,
    enabled: view === "month" && canSeeTeam,
  });

  // Paginated (owner 2026-09-12) — a queue running for months easily passes 25.
  const corrections = useQuery({
    queryKey: ["hr", "corrections", canSeeTeam, correctionsPage],
    queryFn: async () => (await attendanceApi.corrections({
      mine: !canSeeTeam, page: correctionsPage, page_size: PAGE_SIZE })).data,
    enabled: view === "corrections",
  });

  // My own pending corrections, so the "Ask to fix" affordance can say when a
  // request is already in flight rather than letting somebody raise a second.
  const myPending = useQuery({
    queryKey: ["hr", "my-corrections"],
    queryFn: async () =>
      (await attendanceApi.corrections({ mine: true, status: "pending" })).data,
  });
  const pendingDays = useMemo(
    () => new Set((myPending.data?.items ?? []).map((c) => c.day)),
    [myPending.data]);

  // The "Corrections" tab badge counts EVERY pending request, not just the
  // ones on the current page — a cheap page_size:1 query for the total.
  const pendingTotal = useQuery({
    queryKey: ["hr", "corrections-pending-total", canSeeTeam],
    queryFn: async () => (await attendanceApi.corrections({
      mine: !canSeeTeam, status: "pending", page: 1, page_size: 1,
    })).data.total,
    enabled: canSeeTeam,
  });

  const decide = useMutation({
    mutationFn: async (v: { id: string; approve: boolean }) =>
      (await attendanceApi.decideCorrection(v.id, v.approve)).data,
    onSuccess: (_r, v) => {
      toast.success(v.approve
        ? "Approved, and the day has been updated."
        : "Rejected.");
      qc.invalidateQueries({ queryKey: ["hr"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const exportRegister = useMutation({
    mutationFn: async () => {
      const res = await attendanceApi.exportRegister({ month });
      downloadBlob(res.data as Blob, `attendance-${month}.xlsx`);
    },
    // `blobError`, not `apiError`: a request made with responseType "blob"
    // hands the ERROR body back as a Blob too, so the usual reader finds no
    // `detail` and every failure reports the same generic sentence.
    onError: async (e) => toast.error(await blobError(e)),
  });

  /* ---------------------------------------------------------------- view -- */

  const monthBar = (
    <div className="ledger-bar">
      <button className="icon-btn"
        aria-label="Previous month" title="Previous month"
        onClick={() => setMonth(shiftMonth(month, -1))}>
        <Icon.ChevronLeft size={15} />
      </button>
      <span className="min-w-[9rem] text-center text-sm font-medium
        text-slate-900">
        {monthLabel(month)}
      </span>
      <button className="icon-btn"
        aria-label="Next month" title="Next month"
        disabled={isCurrentMonth(month)}
        onClick={() => setMonth(shiftMonth(month, 1))}>
        <Icon.ChevronRight size={15} />
      </button>
      {!isCurrentMonth(month) && (
        <button className="btn-ghost btn-sm"
          onClick={() => setMonth(monthKey(new Date()))}>
          This month
        </button>
      )}
      <div className="ledger-bar-end">
        {canExport && view === "month" && (
          <button className="btn-secondary btn-sm"
            disabled={exportRegister.isPending}
            onClick={() => exportRegister.mutate()}>
            <Icon.Download size={14} />
            {exportRegister.isPending ? "Preparing…" : "Register"}
          </button>
        )}
      </div>
    </div>
  );

  const pendingCount = pendingTotal.data ?? 0;

  return (
    <div>
      <PageHeader
        title="Attendance"
        subtitle="Clock in when you start, clock out when you finish. The month
          adds up to the days your pay is worked out from."
        eyebrow="Workplace HR"
        actions={
          <button className="btn-secondary"
            onClick={() => navigate("/hr/leave")}>
            <Icon.Calendar size={15} /> Leave
          </button>
        }
      />

      {/* Always on screen, whichever view is showing — it is the thing most
          people open this page to press. */}
      <PunchPanel onChanged={() => qc.invalidateQueries({
        queryKey: ["hr", "month"] })} />

      {canSeeTeam && (
        <div className="mt-5">
          <Segmented
            semantics="tabs"
            value={view}
            onChange={(v) => setView2(v as View)}
            options={[
              ...(user?.account_type !== "owner" ? [{ value: "mine", label: "My attendance", icon: "User" as const }] : []),
              { value: "today", label: "Today", icon: "Users" },
              { value: "month", label: "Month grid", icon: "Grid" },
              {
                value: "corrections", label: "Corrections",
                icon: "CheckSquare",
                count: pendingCount || undefined,
              },
            ]}
          />
        </div>
      )}

      {/* ------------------------------------------------ my / one person -- */}
      {view === "mine" && (
        <div className="mt-5">
          {whose && mine.data && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <PersonCell name={mine.data.user_name} />
              <button className="btn-ghost btn-sm"
                onClick={() => setWhose("")}>
                Back to my own
              </button>
            </div>
          )}
          {mine.data && (
            <AttendanceSummaryTiles summary={mine.data.summary} />
          )}
          <div className="mt-5">
            {monthBar}
            {mine.isError ? (
              <ErrorState onRetry={() => mine.refetch()} />
            ) : mine.isLoading ? (
              <TableSkeleton cols={6} />
            ) : (
              <AttendanceMonthTable
                days={mine.data?.days ?? []}
                canEdit={canManage && !!whose}
                onEdit={canManage && whose
                  ? (d) => setEditing(d) : undefined}
                onRaiseCorrection={whose ? undefined : (d) => {
                  if (pendingDays.has(d.day)) {
                    toast.info("You already have a correction waiting for "
                      + `${dayLabel(d.day)}.`);
                    return;
                  }
                  setCorrecting(d);
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* --------------------------------------------------- today's board -- */}
      {view === "today" && canSeeTeam && (
        <div className="mt-5">
          <div className="ledger-bar mb-5">
            <button className="icon-btn" aria-label="Previous day" title="Previous day"
              onClick={() => setDay(shiftDay(day, -1))}>
              <Icon.ChevronLeft size={15} />
            </button>
            <span className="min-w-[9rem] text-center text-sm font-medium
              text-slate-900">
              {dayLabel(day)} · {monthLabel(day.slice(0, 7))}
            </span>
            <button className="icon-btn" aria-label="Next day" title="Next day"
              disabled={day >= todayKey()}
              onClick={() => setDay(shiftDay(day, 1))}>
              <Icon.ChevronRight size={15} />
            </button>
            {day !== todayKey() && (
              <button className="btn-ghost btn-sm"
                onClick={() => setDay(todayKey())}>Today</button>
            )}
          </div>
          {today.isError ? (
            <ErrorState onRetry={() => today.refetch()} />
          ) : today.isLoading ? (
            <TableSkeleton cols={6} />
          ) : today.data ? (
            <TeamDayBoard data={today.data} onOpen={(id) => {
              setWhose(id);
              setMonth(day.slice(0, 7));
              setView2("mine");
              setWhose(id);
            }} />
          ) : null}
        </div>
      )}

      {/* ----------------------------------------------------- month grid -- */}
      {view === "month" && canSeeTeam && (
        <div className="mt-5">
          {monthBar}
          <div className="mt-5">
            {grid.isError ? (
              <ErrorState onRetry={() => grid.refetch()} />
            ) : grid.isLoading ? (
              <TableSkeleton cols={8} />
            ) : grid.data ? (
              <TeamMonthGrid data={grid.data} onOpen={(id) => {
                setView2("mine");
                setWhose(id);
              }} />
            ) : null}
          </div>
        </div>
      )}

      {/* ----------------------------------------------------- corrections -- */}
      {view === "corrections" && (
        <div className="mt-5">
          {corrections.isError ? (
            <ErrorState onRetry={() => corrections.refetch()} />
          ) : corrections.isLoading ? (
            <TableSkeleton cols={5} />
          ) : (corrections.data?.items ?? []).length === 0 ? (
            <EmptyState title="Nothing waiting"
              icon={<Icon.Check size={20} />}
              hint="A correction is how somebody asks for a day to be fixed —
                a forgotten clock-out, usually. None are open." />
          ) : (
            <ListShell
              bare
              cards={(corrections.data?.items ?? []).map((c) => (
                <MobileCard key={c.id} to="#"
                  rail={c.status === "pending" ? "due" : undefined}
                  title={c.user_name}
                  meta={`${dayLabel(c.day)} · ${c.reason}`}
                  right={
                    <span className={leaveStatusBadge(c.status)}>
                      {LEAVE_STATUS_LABELS[c.status]}
                    </span>
                  } />
              ))}
              table={
                <Ledger
                  head={
                    <>
                      <LTh>Who</LTh>
                      <LTh>Day</LTh>
                      <LTh>Asked for</LTh>
                      <LTh>Status</LTh>
                      <LTh />
                    </>
                  }>
                  {(corrections.data?.items ?? []).map((c) => (
                    <LedgerRow key={c.id}>
                      <td className={c.status === "pending" ? "rail-due" : ""}>
                        <PersonCell name={c.user_name}
                          sub={formatDateTime(c.created_at)} />
                      </td>
                      <LedgerCell title={dayLabel(c.day)} sub={c.reason} />
                      <td className="whitespace-nowrap text-[13px]
                        tabular-nums text-slate-700">
                        {c.requested_clock_in
                          ? formatTime(c.requested_clock_in) : "—"}
                        {" – "}
                        {c.requested_clock_out
                          ? formatTime(c.requested_clock_out) : "—"}
                      </td>
                      <td>
                        <span className={leaveStatusBadge(c.status)}>
                          {LEAVE_STATUS_LABELS[c.status]}
                        </span>
                        {c.decided_by_name && (
                          <span className="mt-0.5 block text-xs
                            text-slate-500">
                            by {c.decided_by_name}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          {c.status === "pending" && canManage
                            && c.user_id !== String(user?.id) && (
                            <>
                              <button className="btn-secondary btn-sm"
                                disabled={decide.isPending}
                                onClick={() => decide.mutate({
                                  id: c.id, approve: false })}>
                                Reject
                              </button>
                              <button className="btn-primary btn-sm"
                                disabled={decide.isPending}
                                onClick={() => decide.mutate({
                                  id: c.id, approve: true })}>
                                Approve
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </LedgerRow>
                  ))}
                </Ledger>
              }
            />
          )}
          {(corrections.data?.total ?? 0) > PAGE_SIZE && (
            <Pagination page={correctionsPage} pageSize={PAGE_SIZE}
              total={corrections.data?.total ?? 0}
              onChange={setCorrectionsPage} />
          )}
        </div>
      )}

      <EditDayDialog
        open={!!editing} onClose={() => setEditing(null)} day={editing}
        userId={whose || String(user?.id ?? "")}
        userName={mine.data?.user_name ?? ""}
      />
      <RaiseCorrectionDialog
        open={!!correcting} onClose={() => setCorrecting(null)}
        day={correcting}
      />
    </div>
  );
}

/** "2026-08-13" + n days, staying on the calendar. */
function shiftDay(key: string, delta: number): string {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")}`;
}
