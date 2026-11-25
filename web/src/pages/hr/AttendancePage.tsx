import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  X,
} from "lucide-react";
import { attendanceApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, Column } from "../../components/shared/DataTable";
import { ErrorState } from "../../components/shared/ErrorState";
import { TableSkeleton } from "../../components/shared/LoadingSkeleton";
import { PunchPanel } from "../../components/hr/PunchPanel";
import {
  AttendanceMonthTable,
  AttendanceSummaryTiles,
} from "../../components/hr/AttendanceMonth";
import {
  EditDayDialog,
  RaiseCorrectionDialog,
} from "../../components/hr/DayEditors";
import {
  TeamDayBoard,
  TeamMonthGrid,
} from "../../components/hr/TeamAttendance";
import { toast } from "../../components/Toast";
import { blobError, downloadBlob } from "../../lib/download";
import {
  LEAVE_STATUS_LABELS,
  dayLabel,
  formatTime,
  isCurrentMonth,
  monthKey,
  monthLabel,
  shiftMonth,
  todayKey,
} from "../../lib/hr";
import { formatDateTime } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { AttendanceCorrection, AttendanceDay } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "mine" | "today" | "month" | "corrections";

const PAGE_SIZE = 25;

function shiftDay(key: string, delta: number): string {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export default function AttendancePage() {
  const { user, has } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  const canSeeTeam = has("view_attendance");
  const canManage = has("manage_attendance");
  const canExport = has("export_data") && canSeeTeam;
  const isOwner = user?.account_type === "owner";

  const requested = params.get("view") as View | null;
  const defaultView: View = isOwner ? "today" : "mine";
  const [view, setView] = useState<View>(
    requested && (canSeeTeam || requested === "mine") ? requested : defaultView
  );
  const [month, setMonth] = useState(
    () => params.get("month") || monthKey(new Date())
  );
  const [day, setDay] = useState(todayKey());
  const [whose, setWhose] = useState<string>("");

  const [editing, setEditing] = useState<AttendanceDay | null>(null);
  const [correcting, setCorrecting] = useState<AttendanceDay | null>(null);
  const [correctionsPage, setCorrectionsPage] = useState(1);

  const setView2 = (v: View) => {
    setView(v);
    setWhose("");
    const next = new URLSearchParams(params);
    if (v === "mine") next.delete("view");
    else next.set("view", v);
    setParams(next, { replace: true });
  };

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

  const corrections = useQuery({
    queryKey: ["hr", "corrections", canSeeTeam, correctionsPage],
    queryFn: async () =>
      (
        await attendanceApi.corrections({
          mine: !canSeeTeam,
          page: correctionsPage,
          page_size: PAGE_SIZE,
        })
      ).data,
    enabled: view === "corrections",
  });

  const myPending = useQuery({
    queryKey: ["hr", "my-corrections"],
    queryFn: async () =>
      (await attendanceApi.corrections({ mine: true, status: "pending" })).data,
  });
  const pendingDays = useMemo(
    () => new Set((myPending.data?.items ?? []).map((c) => c.day)),
    [myPending.data]
  );

  const pendingTotal = useQuery({
    queryKey: ["hr", "corrections-pending-total", canSeeTeam],
    queryFn: async () =>
      (
        await attendanceApi.corrections({
          mine: !canSeeTeam,
          status: "pending",
          page: 1,
          page_size: 1,
        })
      ).data.total,
    enabled: canSeeTeam,
  });

  const decide = useMutation({
    mutationFn: async (v: { id: string; approve: boolean }) =>
      (await attendanceApi.decideCorrection(v.id, v.approve)).data,
    onSuccess: (_r, v) => {
      toast.success(
        v.approve ? "Approved, and the day has been updated." : "Rejected."
      );
      qc.invalidateQueries({ queryKey: ["hr"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const exportRegister = useMutation({
    mutationFn: async () => {
      const res = await attendanceApi.exportRegister({ month });
      downloadBlob(res.data as Blob, `attendance-${month}.xlsx`);
    },
    onError: async (e) => toast.error(await blobError(e)),
  });

  const pendingCount = pendingTotal.data ?? 0;

  const monthBar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-card"
          aria-label="Previous month"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[8.5rem] text-center text-sm font-semibold text-foreground">
          {monthLabel(month)}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-card"
          aria-label="Next month"
          disabled={isCurrentMonth(month)}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        {!isCurrentMonth(month) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => setMonth(monthKey(new Date()))}
          >
            This month
          </Button>
        )}
      </div>
      {canExport && view === "month" && (
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={exportRegister.isPending}
          onClick={() => exportRegister.mutate()}
        >
          <Download className="mr-1 h-3.5 w-3.5" />
          {exportRegister.isPending ? "Preparing..." : "Export register"}
        </Button>
      )}
    </div>
  );

  const correctionCols: Column<AttendanceCorrection>[] = [
    {
      key: "who",
      header: "Employee",
      cell: (c) => (
        <div>
          <p className="font-medium text-foreground">{c.user_name}</p>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(c.created_at)}
          </p>
        </div>
      ),
    },
    {
      key: "day",
      header: "Date & Reason",
      cell: (c) => (
        <div>
          <p className="font-medium text-foreground">{dayLabel(c.day)}</p>
          <p className="text-xs text-muted-foreground">{c.reason}</p>
        </div>
      ),
    },
    {
      key: "time",
      header: "Requested Time",
      cell: (c) => (
        <span className="whitespace-nowrap tabular-nums text-foreground">
          {c.requested_clock_in ? formatTime(c.requested_clock_in) : "—"} –{" "}
          {c.requested_clock_out ? formatTime(c.requested_clock_out) : "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (c) => (
        <div>
          <Badge
            variant={
              c.status === "approved"
                ? "default"
                : c.status === "rejected"
                  ? "destructive"
                  : "secondary"
            }
            className={`h-5 px-1.5 text-[10px] ${
              c.status === "approved"
                ? "bg-emerald-600 text-white hover:bg-emerald-600"
                : ""
            }`}
          >
            {LEAVE_STATUS_LABELS[c.status]}
          </Badge>
          {c.decided_by_name && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              by {c.decided_by_name}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      mobileLabel: false,
      cell: (c) =>
        c.status === "pending" &&
        canManage &&
        c.user_id !== String(user?.id) ? (
          <div className="flex justify-end gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: c.id, approve: false })}
            >
              <X className="mr-1 h-3 w-3" />
              Reject
            </Button>
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: c.id, approve: true })}
            >
              <Check className="mr-1 h-3 w-3" />
              Approve
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        title="Attendance"
        subtitle={
          isOwner
            ? "Team status & monthly register"
            : "Daily clock-in & attendance log"
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => navigate("/hr/leave")}
          >
            <Calendar className="mr-1 h-3.5 w-3.5" />
            Leave
          </Button>
        }
      />

      {!isOwner && (
        <PunchPanel
          onChanged={() => qc.invalidateQueries({ queryKey: ["hr", "month"] })}
        />
      )}

      {canSeeTeam && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs value={view} onValueChange={(v) => setView2(v as View)}>
            <TabsList className="h-8 flex-wrap">
              {!isOwner && (
                <TabsTrigger value="mine" className="h-6 px-2.5 text-xs">
                  My Attendance
                </TabsTrigger>
              )}
              <TabsTrigger value="today" className="h-6 px-2.5 text-xs">
                Today's Status
              </TabsTrigger>
              <TabsTrigger value="month" className="h-6 px-2.5 text-xs">
                Monthly Register
              </TabsTrigger>
              <TabsTrigger
                value="corrections"
                className="h-6 gap-1.5 px-2.5 text-xs"
              >
                Corrections
                {pendingCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="h-4 px-1 text-[10px]"
                  >
                    {pendingCount}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {view === "today" && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 bg-card"
                aria-label="Previous day"
                onClick={() => setDay(shiftDay(day, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[9.5rem] text-center text-sm font-semibold text-foreground">
                {dayLabel(day)} · {monthLabel(day.slice(0, 7))}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 bg-card"
                aria-label="Next day"
                disabled={day >= todayKey()}
                onClick={() => setDay(shiftDay(day, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              {day !== todayKey() && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => setDay(todayKey())}
                >
                  Today
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {view === "mine" && (
        <div className="space-y-3">
          {whose && mine.data && (
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-foreground">
                Viewing: {mine.data.user_name}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => setWhose("")}
              >
                Back to {isOwner ? "team" : "my attendance"}
              </Button>
            </div>
          )}
          {mine.data && <AttendanceSummaryTiles summary={mine.data.summary} />}
          {monthBar}
          {mine.isError ? (
            <ErrorState onRetry={() => mine.refetch()} />
          ) : mine.isLoading ? (
            <TableSkeleton cols={6} />
          ) : (
            <AttendanceMonthTable
              days={mine.data?.days ?? []}
              canEdit={canManage && !!whose}
              onEdit={canManage && whose ? (d) => setEditing(d) : undefined}
              onRaiseCorrection={
                whose
                  ? undefined
                  : (d) => {
                      if (pendingDays.has(d.day)) {
                        toast.info(
                          `You already have a correction waiting for ${dayLabel(
                            d.day
                          )}.`
                        );
                        return;
                      }
                      setCorrecting(d);
                    }
              }
            />
          )}
        </div>
      )}

      {view === "today" && canSeeTeam && (
        <div>
          {today.isError ? (
            <ErrorState onRetry={() => today.refetch()} />
          ) : today.isLoading ? (
            <TableSkeleton cols={6} />
          ) : today.data ? (
            <TeamDayBoard
              data={today.data}
              onOpen={(id) => {
                setWhose(id);
                setMonth(day.slice(0, 7));
                setView2("mine");
                setWhose(id);
              }}
            />
          ) : null}
        </div>
      )}

      {view === "month" && canSeeTeam && (
        <div className="space-y-3">
          {monthBar}
          {grid.isError ? (
            <ErrorState onRetry={() => grid.refetch()} />
          ) : grid.isLoading ? (
            <TableSkeleton cols={8} />
          ) : grid.data ? (
            <TeamMonthGrid
              data={grid.data}
              onOpen={(id) => {
                setView2("mine");
                setWhose(id);
              }}
            />
          ) : null}
        </div>
      )}

      {view === "corrections" && (
        <DataTable
          data={corrections.data?.items ?? []}
          columns={correctionCols}
          keyField={(c) => c.id}
          loading={corrections.isLoading}
          error={
            corrections.isError ? "Could not load correction requests." : null
          }
          onRetry={() => corrections.refetch()}
          emptyTitle="No correction requests"
          emptyDescription="When someone asks to fix a missed clock-in or clock-out, it appears here."
          page={correctionsPage}
          pageSize={PAGE_SIZE}
          total={corrections.data?.total ?? 0}
          onPageChange={setCorrectionsPage}
        />
      )}

      <EditDayDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        day={editing}
        userId={whose || String(user?.id ?? "")}
        userName={mine.data?.user_name ?? ""}
      />
      <RaiseCorrectionDialog
        open={!!correcting}
        onClose={() => setCorrecting(null)}
        day={correcting}
      />
    </div>
  );
}
