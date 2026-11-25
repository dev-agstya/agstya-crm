import { Calendar, Check, Clock, Pencil } from "lucide-react";
import { DataTable, Column } from "../shared/DataTable";
import { EmptyState } from "../shared/EmptyState";
import { InfoTooltip } from "../shared/InfoTooltip";
import {
  STATUS_LABELS,
  dayLabel,
  formatDuration,
  formatTime,
  isOffDay,
  statusBadge,
} from "../../lib/hr";
import type { AttendanceDay, AttendanceSummary } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function daySub(d: AttendanceDay): string {
  if (d.holiday_name) return d.holiday_name;
  if (d.leave_worked) return "Worked on approved leave — day given back";
  if (d.leave_code)
    return `${d.leave_code}${d.leave_reason ? ` · ${d.leave_reason}` : ""}`;
  if (d.missed_punch_out) return "No clock-out — closed at shift end";
  if (d.edited_by_name) return `Edited by ${d.edited_by_name}`;
  return STATUS_LABELS[d.status];
}

export function AttendanceMonthTable({
  days,
  onEdit,
  canEdit,
  onRaiseCorrection,
}: {
  days: AttendanceDay[];
  onEdit?: (day: AttendanceDay) => void;
  canEdit?: boolean;
  onRaiseCorrection?: (day: AttendanceDay) => void;
}) {
  if (days.length === 0) {
    return (
      <EmptyState
        icon={<Calendar className="h-5 w-5" />}
        title="Nothing to show"
        description="There is no attendance for this month yet."
      />
    );
  }

  const columns: Column<AttendanceDay>[] = [
    {
      key: "date",
      header: "Date",
      cell: (d) => (
        <div className={isOffDay(d.status) ? "opacity-60" : ""}>
          <p className="font-medium text-foreground">{dayLabel(d.day)}</p>
          <p className="text-xs text-muted-foreground">{daySub(d)}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (d) => (
        <span className={statusBadge(d.status)}>{STATUS_LABELS[d.status]}</span>
      ),
    },
    {
      key: "timings",
      header: "Timings",
      cell: (d) =>
        d.clock_in ? (
          <div className="whitespace-nowrap">
            <span className="text-[13px] tabular-nums text-foreground">
              {formatTime(d.clock_in)} – {formatTime(d.clock_out)}
            </span>
            {d.break_minutes > 0 && (
              <span className="block text-[11px] text-muted-foreground">
                {formatDuration(d.break_minutes)} break
              </span>
            )}
          </div>
        ) : (
          <span className="text-[13px] text-muted-foreground">—</span>
        ),
    },
    {
      key: "worked",
      header: "Worked",
      align: "right",
      cell: (d) => (
        <span className="font-semibold tabular-nums text-foreground">
          {formatDuration(d.worked_minutes)}
        </span>
      ),
    },
    {
      key: "flags",
      header: "Flags",
      cell: (d) => (
        <div className="flex flex-wrap gap-1">
          {d.is_late && (
            <Badge
              variant="outline"
              className="h-5 border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800"
            >
              Late {formatDuration(d.late_minutes)}
            </Badge>
          )}
          {d.is_early_out && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              Left early {formatDuration(d.early_out_minutes)}
            </Badge>
          )}
          {d.missed_punch_out && (
            <Badge
              variant="outline"
              className="h-5 border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800"
            >
              No clock-out
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (d) => (
        <div className="flex justify-end gap-1">
          {!d.is_future && onRaiseCorrection && !canEdit && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onRaiseCorrection(d)}
            >
              Ask to fix
            </Button>
          )}
          {!d.is_future && canEdit && onEdit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onEdit(d)}
            >
              <Pencil className="mr-1 h-3 w-3" /> Edit
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      data={days}
      columns={columns}
      keyField={(d) => d.day}
      renderMobileCard={(d) => (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              {dayLabel(d.day)}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {daySub(d)}
            </p>
            {d.clock_in && (
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {formatTime(d.clock_in)} – {formatTime(d.clock_out)}
              </p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <span className="block text-sm font-semibold tabular-nums text-foreground">
              {formatDuration(d.worked_minutes)}
            </span>
            <span className={`mt-0.5 inline-block ${statusBadge(d.status)}`}>
              {STATUS_LABELS[d.status]}
            </span>
          </div>
        </div>
      )}
    />
  );
}

export function AttendanceSummaryTiles({
  summary,
  compact = false,
}: {
  summary: AttendanceSummary;
  compact?: boolean;
}) {
  const hasDeductions =
    summary.absent > 0 ||
    summary.late_marks > 0 ||
    summary.unresolved_days > 0;

  return (
    <div className="space-y-2">
      <div
        className={`grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-card sm:divide-x sm:divide-y-0 ${
          compact ? "sm:grid-cols-3" : "sm:grid-cols-4"
        }`}
      >
        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <span>Payable days</span>
            <InfoTooltip content="Total calendar days credited for salary calculation after present days, paid leaves, and approved holidays" />
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {summary.payable_days}
            </span>
            <span className="text-[11px] text-muted-foreground">
              of {summary.total_days} days
            </span>
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <Check className="h-3 w-3 text-emerald-600" />
            <span>Present</span>
            <InfoTooltip content="Days the employee clocked in and completed shift hours" />
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {summary.present + summary.wfh}
            </span>
            {summary.half_days > 0 && (
              <span className="text-[11px] text-muted-foreground">
                + {summary.half_days} half
              </span>
            )}
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <span>Leave</span>
            <InfoTooltip content="Casual, medical, or other approved paid leaves taken this month" />
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span
              className={`text-lg font-semibold tabular-nums ${
                summary.leave_unpaid > 0
                  ? "text-amber-700"
                  : "text-foreground"
              }`}
            >
              {summary.on_leave + summary.leave_unpaid}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {summary.leave_unpaid > 0
                ? `${summary.leave_unpaid} unpaid`
                : "all paid"}
            </span>
          </div>
        </div>

        {!compact && (
          <div className="px-3.5 py-2.5">
            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Hours worked</span>
              <InfoTooltip content="Total productive duration logged across all completed shifts this month" />
            </div>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
              {summary.worked_hours ? `${summary.worked_hours}h` : "—"}
            </p>
          </div>
        )}
      </div>

      {hasDeductions && (
        <div className="grid grid-cols-1 divide-y divide-border rounded-lg border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="px-3.5 py-2">
            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <span>Absent</span>
              <InfoTooltip content="Days scheduled to work without clocking in" />
            </div>
            <p
              className={`mt-0.5 text-base font-semibold tabular-nums ${
                summary.absent > 0 ? "text-destructive" : "text-foreground"
              }`}
            >
              {summary.absent}
            </p>
          </div>
          <div className="px-3.5 py-2">
            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <span>Late marks</span>
              <InfoTooltip content="Days arrived after grace period" />
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span
                className={`text-base font-semibold tabular-nums ${
                  summary.late_penalty_days > 0
                    ? "text-amber-700"
                    : "text-foreground"
                }`}
              >
                {summary.late_marks}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {summary.late_penalty_days > 0
                  ? `${summary.late_penalty_days}d penalty`
                  : "no penalty"}
              </span>
            </div>
          </div>
          <div className="px-3.5 py-2">
            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <span>Needs decision</span>
              <InfoTooltip content="Missed clock-outs or unmarked past days" />
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span
                className={`text-base font-semibold tabular-nums ${
                  summary.unresolved_days > 0
                    ? "text-amber-700"
                    : "text-foreground"
                }`}
              >
                {summary.unresolved_days}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                missed punch / unmarked
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
