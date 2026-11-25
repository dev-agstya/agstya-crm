import { ChevronRight, Users } from "lucide-react";
import { DataTable, Column } from "../shared/DataTable";
import { EmptyState } from "../shared/EmptyState";
import {
  STATUS_LABELS,
  STATUS_LETTER,
  formatDuration,
  formatTime,
  statusBadge,
  statusCellTone,
} from "../../lib/hr";
import { initials } from "../../lib/format";
import type {
  AttendanceStatus,
  TeamDay,
  TeamMemberDay,
  TeamMonth,
  TeamMonthRow,
} from "../../lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const URGENCY: Record<AttendanceStatus, number> = {
  absent: 0,
  leave_unpaid: 1,
  not_marked: 2,
  half_day: 3,
  on_leave: 4,
  present: 5,
  wfh: 5,
  week_off: 6,
  holiday: 6,
};

export function TeamDayBoard({
  data,
  onOpen,
}: {
  data: TeamDay;
  onOpen: (userId: string) => void;
}) {
  if (data.members.length === 0) {
    return (
      <EmptyState
        icon={<Users className="h-6 w-6" />}
        title="No employees yet"
        description="Attendance is recorded for employee accounts. Add somebody on the Employees page and they will appear here."
      />
    );
  }

  const rows = [...data.members].sort((a, b) => {
    const d = (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });

  const columns: Column<TeamMemberDay>[] = [
    {
      key: "employee",
      header: "Employee",
      cell: (m) => (
        <div className="flex items-center gap-2.5">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="bg-primary/10 text-[11px] font-semibold text-primary">
              {initials(m.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{m.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {m.designation || m.code}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (m) => (
        <div className="flex flex-wrap items-center gap-1">
          <span className={statusBadge(m.status)}>
            {STATUS_LABELS[m.status]}
          </span>
          {m.on_break && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              On break
            </Badge>
          )}
          {m.is_late && (
            <Badge
              variant="secondary"
              className="h-4 bg-amber-100 px-1.5 text-[10px] text-amber-800"
            >
              {formatDuration(m.late_minutes)} late
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "in",
      header: "In",
      align: "center",
      cell: (m) => (
        <span className="whitespace-nowrap tabular-nums text-foreground">
          {formatTime(m.clock_in) || "—"}
        </span>
      ),
    },
    {
      key: "out",
      header: "Out",
      align: "center",
      cell: (m) => (
        <span className="whitespace-nowrap tabular-nums text-foreground">
          {m.clock_in && !m.clock_out ? (
            <span className="text-muted-foreground">Still in</span>
          ) : (
            formatTime(m.clock_out) || "—"
          )}
        </span>
      ),
    },
    {
      key: "worked",
      header: "Worked",
      align: "right",
      cell: (m) => (
        <span className="font-medium tabular-nums text-foreground">
          {formatDuration(m.worked_minutes) || "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      mobileLabel: false,
      cell: (m) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(m.user_id);
          }}
        >
          Month
          <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {/* Slim summary strip instead of 4 big KPI cards */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border border-border bg-card px-3.5 py-2 text-xs text-muted-foreground">
        <span>
          Clocked in:{" "}
          <strong className="text-foreground tabular-nums">
            {data.in_count}
          </strong>
        </span>
        <span>
          Late:{" "}
          <strong
            className={`tabular-nums ${
              data.late_count > 0 ? "text-amber-600" : "text-foreground"
            }`}
          >
            {data.late_count}
          </strong>
        </span>
        <span>
          On leave:{" "}
          <strong className="text-foreground tabular-nums">
            {data.leave_count}
          </strong>
        </span>
        <span>
          Not in yet:{" "}
          <strong
            className={`tabular-nums ${
              data.absent_count > 0 ? "text-red-600" : "text-foreground"
            }`}
          >
            {data.not_in_count + data.absent_count}
          </strong>
          {data.absent_count > 0 && ` (${data.absent_count} absent)`}
        </span>
      </div>

      {(data.is_week_off || data.holiday_name) && (
        <div className="rounded-md border border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
          {data.holiday_name
            ? `${data.holiday_name} — the office is closed today.`
            : "Week off — the office is closed today."}
        </div>
      )}

      <DataTable
        data={rows}
        columns={columns}
        keyField={(m) => m.user_id}
        onRowClick={(m) => onOpen(m.user_id)}
      />
    </div>
  );
}

export function TeamMonthGrid({
  data,
  onOpen,
}: {
  data: TeamMonth;
  onOpen: (userId: string) => void;
}) {
  if (data.rows.length === 0) {
    return (
      <EmptyState
        icon={<Users className="h-6 w-6" />}
        title="No employees yet"
        description="Attendance is recorded for employee accounts."
      />
    );
  }
  const dayCount = data.rows[0]?.days.length ?? 0;

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="sticky left-0 z-raised bg-muted/95 px-3 py-2 text-left">
                Employee
              </th>
              {Array.from({ length: dayCount }, (_, i) => (
                <th
                  key={i}
                  className="px-1 py-2 text-center font-medium tabular-nums"
                >
                  {i + 1}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Payable</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.rows.map((r: TeamMonthRow) => (
              <tr
                key={r.user_id}
                onClick={() => onOpen(r.user_id)}
                className="cursor-pointer transition-colors hover:bg-muted/40"
              >
                <td className="sticky left-0 z-raised bg-card px-3 py-2 font-medium text-foreground">
                  <span className="block max-w-[10rem] truncate">{r.name}</span>
                </td>
                {r.days.map((d) => (
                  <td
                    key={d.day}
                    title={`${d.day}: ${STATUS_LABELS[d.status]}`}
                    className={`px-1 py-2 text-center font-semibold ${statusCellTone(
                      d.status
                    )}`}
                  >
                    {STATUS_LETTER[d.status]}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">
                  {r.summary.payable_days}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
