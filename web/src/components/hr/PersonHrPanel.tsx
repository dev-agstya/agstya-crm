import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { attendanceApi, leaveApi, payslipsApi } from "../../api/endpoints";
import { DataTable } from "../shared/DataTable";
import { EmptyState } from "../shared/EmptyState";
import { ErrorState } from "../shared/ErrorState";
import { FormSection } from "../shared/FormSection";
import { CardGridSkeleton, TableSkeleton } from "../shared/LoadingSkeleton";
import { AttendanceMonthTable } from "./AttendanceMonth";
import { AdjustBalanceDialog } from "./LeaveForm";
import { EditDayDialog } from "./DayEditors";
import {
  LEAVE_STATUS_LABELS,
  formatDays,
  isCurrentMonth,
  leaveRangeLabel,
  leaveStatusBadge,
  monthKey,
  monthLabel,
  shiftMonth,
} from "../../lib/hr";
import {
  PAYSLIP_STATUS_LABELS,
  payDays,
  payslipBadge,
  payslipMonthLabel,
} from "../../lib/payroll";
import { formatINR } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { AttendanceDay, LeaveRequest, UserRow } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function PersonHrPanel({ user }: { user: UserRow }) {
  const { has, user: me } = useAuth();
  const canManageAttendance = has("manage_attendance");
  const canManageLeave = has("manage_leave");
  const canSeeSalary = has("view_salary") || me?.id === user.id;

  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [editing, setEditing] = useState<AttendanceDay | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  const attendance = useQuery({
    queryKey: ["hr", "month", month, user.id],
    queryFn: async () =>
      (await attendanceApi.month({ month, user_id: user.id })).data,
  });

  const balance = useQuery({
    queryKey: ["hr", "leave-balance", user.id],
    queryFn: async () => (await leaveApi.balance({ user_id: user.id })).data,
  });

  const leaves = useQuery({
    queryKey: ["hr", "leave-of", user.id],
    queryFn: async () =>
      (await leaveApi.requests({ mine: false, user_id: user.id })).data,
  });

  const s = attendance.data?.summary;
  const b = balance.data;
  const profile = user.employee_profile;

  return (
    <div className="space-y-4">
      <FormSection title="Employment">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">
              Joined
            </p>
            <p className="mt-0.5 text-sm font-medium text-foreground">
              {profile?.date_of_joining ? (
                new Date(profile.date_of_joining).toLocaleDateString("en-IN", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })
              ) : (
                <span className="text-muted-foreground">not recorded</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">
              Monthly salary
            </p>
            <p className="mt-0.5 text-sm font-medium tabular-nums text-foreground">
              {canSeeSalary ? (
                profile?.monthly_salary_paise != null ? (
                  formatINR(profile.monthly_salary_paise)
                ) : (
                  <span className="text-muted-foreground">not set</span>
                )
              ) : (
                <span className="text-muted-foreground">hidden</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">
              Shift
            </p>
            <p className="mt-0.5 text-sm font-medium text-foreground">
              {profile?.shift_start && profile?.shift_end ? (
                `${profile.shift_start} – ${profile.shift_end}`
              ) : (
                <span className="text-muted-foreground">agency default</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-muted-foreground">
              Leave earned
            </p>
            <p className="mt-0.5 text-sm font-medium text-foreground">
              {b ? (
                `${b.monthly_accrual} a month`
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </p>
          </div>
        </div>
        {canSeeSalary && profile?.monthly_salary_paise == null && (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            No salary on this record, so no payslip can be worked out. Set it on
            the Profile tab.
          </p>
        )}
      </FormSection>

      <PayslipStrip user={user} />

      <FormSection
        title="This month"
        actions={
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="Previous month"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="min-w-[7.5rem] text-center text-xs font-medium text-foreground">
              {monthLabel(month)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="Next month"
              disabled={isCurrentMonth(month)}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        }
      >
        {attendance.isError ? (
          <ErrorState onRetry={() => attendance.refetch()} />
        ) : attendance.isLoading ? (
          <CardGridSkeleton count={4} />
        ) : s ? (
          <>
            <div className="grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-muted/20 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
              <div className="px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Payable days
                </p>
                <p className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {s.payable_days}
                  <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                    / {s.total_days}
                  </span>
                </p>
              </div>
              <div className="px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Present
                </p>
                <p className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {s.present + s.wfh}
                  {s.half_days > 0 && (
                    <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                      + {s.half_days} half
                    </span>
                  )}
                </p>
              </div>
              <div className="px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Absent
                </p>
                <p
                  className={`mt-0.5 text-base font-semibold tabular-nums ${
                    s.absent > 0 ? "text-destructive" : "text-foreground"
                  }`}
                >
                  {s.absent}
                </p>
              </div>
              <div className="px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Late marks
                </p>
                <p
                  className={`mt-0.5 text-base font-semibold tabular-nums ${
                    s.late_penalty_days > 0
                      ? "text-amber-700"
                      : "text-foreground"
                  }`}
                >
                  {s.late_marks}
                  {s.late_penalty_days > 0 && (
                    <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                      ({s.late_penalty_days}d off)
                    </span>
                  )}
                </p>
              </div>
            </div>
            {s.unresolved_days > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
                {s.unresolved_days} day{s.unresolved_days === 1 ? "" : "s"} in
                this month still {s.unresolved_days === 1 ? "needs" : "need"} a
                decision — a missed clock-out, or a past day with nothing on it.
              </div>
            )}
          </>
        ) : null}
      </FormSection>

      <FormSection
        title="Leave"
        actions={
          canManageLeave ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setAdjusting(true)}
            >
              Adjust balance
            </Button>
          ) : undefined
        }
      >
        {balance.isError ? (
          <ErrorState onRetry={() => balance.refetch()} />
        ) : balance.isLoading ? (
          <CardGridSkeleton count={3} />
        ) : b ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-muted/20">
              <div className="px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Available
                </p>
                <p
                  className={`mt-0.5 text-base font-semibold tabular-nums ${
                    b.available > 0
                      ? "text-emerald-700"
                      : b.available < 0
                        ? "text-destructive"
                        : "text-foreground"
                  }`}
                >
                  {formatDays(b.available)}
                </p>
              </div>
              <div className="px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Taken
                </p>
                <p className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                  {formatDays(b.used)}
                </p>
              </div>
              <div className="px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Waiting
                </p>
                <p
                  className={`mt-0.5 text-base font-semibold tabular-nums ${
                    b.pending_days > 0 ? "text-amber-700" : "text-foreground"
                  }`}
                >
                  {formatDays(b.pending_days)}
                </p>
              </div>
            </div>

            {(leaves.data?.items ?? []).length > 0 && (
              <DataTable
                data={(leaves.data?.items ?? []).slice(0, 8)}
                keyField={(r: LeaveRequest) => r.id}
                columns={[
                  {
                    key: "when",
                    header: "When",
                    cell: (r) => (
                      <span className="whitespace-nowrap text-xs font-medium text-foreground">
                        {leaveRangeLabel(r.start_date, r.end_date, r.day_part)}
                      </span>
                    ),
                  },
                  {
                    key: "reason",
                    header: "Reason",
                    cell: (r) => (
                      <span
                        className="block max-w-[220px] truncate text-xs text-muted-foreground"
                        title={r.reason}
                      >
                        {r.reason}
                      </span>
                    ),
                  },
                  {
                    key: "days",
                    header: "Days",
                    align: "right",
                    cell: (r) => (
                      <span className="text-xs font-medium tabular-nums text-foreground">
                        {r.days}
                      </span>
                    ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    cell: (r) => (
                      <span className={leaveStatusBadge(r.status)}>
                        {LEAVE_STATUS_LABELS[r.status]}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </div>
        ) : null}
      </FormSection>

      <FormSection
        title="Register"
        actions={
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <Link to="/hr/attendance?view=today">
              Open Attendance <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      >
        {attendance.isError ? (
          <ErrorState onRetry={() => attendance.refetch()} />
        ) : attendance.isLoading ? (
          <TableSkeleton cols={6} />
        ) : (attendance.data?.days.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Calendar className="h-5 w-5" />}
            title="Nothing recorded"
            description="No attendance for this month yet."
          />
        ) : (
          <AttendanceMonthTable
            days={attendance.data!.days}
            canEdit={canManageAttendance}
            onEdit={canManageAttendance ? (d) => setEditing(d) : undefined}
          />
        )}
      </FormSection>

      <EditDayDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        day={editing}
        userId={user.id}
        userName={user.full_name}
      />
      <AdjustBalanceDialog
        open={adjusting}
        onClose={() => setAdjusting(false)}
        user={{ id: user.id, name: user.full_name }}
      />
    </div>
  );
}

function PayslipStrip({ user }: { user: UserRow }) {
  const { has, user: me } = useAuth();
  const mine = me?.id === user.id;
  const allowed = mine || has("view_payslips");

  const slips = useQuery({
    queryKey: ["payslips", "of", user.id],
    queryFn: async () => (await payslipsApi.list({ user_id: user.id })).data,
    enabled: allowed,
  });

  if (!allowed) return null;

  const rows = (slips.data?.items ?? []).slice(0, 4);
  return (
    <FormSection
      title="Payslips"
      actions={
        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
          <Link to={mine ? "/hr/payslips" : "/hr/payslips?view=run"}>
            All payslips <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
      }
    >
      {slips.isError ? (
        <ErrorState onRetry={() => slips.refetch()} />
      ) : slips.isLoading ? (
        <TableSkeleton cols={3} rows={2} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No payslips yet"
          description="The first one is generated on the 1st of next month, from this month's attendance."
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full">
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="px-3 py-2 text-[13px]">
                    <Link
                      to={`/hr/payslips?slip=${p.id}`}
                      className="font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {payslipMonthLabel(p.month)}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {payDays(p.payable_days)} payable days
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-[13px] font-medium tabular-nums text-foreground">
                    {formatINR(p.net_payable_paise)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className={`badge ${payslipBadge(p.status)}`}>
                      {PAYSLIP_STATUS_LABELS[p.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </FormSection>
  );
}
