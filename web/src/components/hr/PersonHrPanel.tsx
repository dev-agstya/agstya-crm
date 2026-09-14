import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { attendanceApi, leaveApi, payslipsApi } from "../../api/endpoints";
import { Icon } from "../Icon";
import {
  CardSkeleton, DetailItem, EmptyState, ErrorState, Section, StatCard, StatRow,
  TableSkeleton,
} from "../ui";
import { AttendanceMonthTable } from "./AttendanceMonth";
import { AdjustBalanceDialog } from "./LeaveForm";
import { EditDayDialog } from "./DayEditors";
import {
  LEAVE_STATUS_LABELS, balanceTone, formatDays, isCurrentMonth,
  leaveRangeLabel, leaveStatusBadge, monthKey, monthLabel, shiftMonth,
} from "../../lib/hr";
import {
  PAYSLIP_STATUS_LABELS, payDays, payslipBadge, payslipMonthLabel,
} from "../../lib/payroll";
import { formatINR } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { AttendanceDay, UserRow } from "../../lib/types";

/*
  The HR tab on an employee's record (owner H7).

  A TAB, NOT A PAGE — the owner has been explicit twice about not wanting
  "random pages for each and every shit thing", and this is the same call the
  Team tab got: everything about ONE person belongs on that person's record,
  rather than making a manager filter three separate screens by their name.

  It answers the four questions a manager has about somebody at month end, in
  the order they ask them: what does this month add up to, how much leave do
  they have, what is on their register, and have they been paid.

  THE SALARY IS NO LONGER A REFERENCE FIGURE. It was, from 2026-08-20 to
  2026-08-24 — stored and read by nothing, because the owner had dropped the
  calculation. They reversed that, so the salary at the top is now the INPUT to
  the payslips at the bottom, and a record with no salary on it is a record the
  pay run will stop on. That is why the empty case says so.

  The salary is ABSENT from the payload without `view_salary` — the server
  strips it rather than the client hiding it — so `undefined` here means "not
  allowed to see" as often as it means "not set", and the copy says so rather
  than rendering a confident blank.
*/

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
    <div className="space-y-6">
      {/* ------------------------------------------------- the reference -- */}
      <Section title="Employment">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <DetailItem label="Joined"
            value={profile?.date_of_joining
              ? new Date(profile.date_of_joining).toLocaleDateString("en-IN", {
                day: "2-digit", month: "short", year: "numeric" })
              : <span className="text-slate-400">not recorded</span>} />
          <DetailItem label="Monthly salary"
            value={canSeeSalary
              ? (profile?.monthly_salary_paise != null
                ? formatINR(profile.monthly_salary_paise)
                : <span className="text-slate-400">not set</span>)
              : <span className="text-slate-400">hidden</span>} />
          <DetailItem label="Shift"
            value={profile?.shift_start && profile?.shift_end
              ? `${profile.shift_start} – ${profile.shift_end}`
              : <span className="text-slate-400">agency default</span>} />
          <DetailItem label="Leave earned"
            value={b ? `${b.monthly_accrual} a month`
              : <span className="text-slate-400">—</span>} />
        </div>
        {canSeeSalary && profile?.monthly_salary_paise == null && (
          // Said here rather than left blank, because this is the field the pay
          // run will stop on. A payslip with no salary comes out at zero and
          // cannot be finalised.
          <p className="note-out mt-3">
            No salary on this record, so no payslip can be worked out. Set it on
            the Profile tab.
          </p>
        )}
      </Section>

      {/* --------------------------------------------------- the payslip -- */}
      <PayslipStrip user={user} />

      {/* ----------------------------------------------------- the month -- */}
      <Section title="This month"
        action={
          <div className="flex items-center gap-1">
            <button className="icon-btn" aria-label="Previous month" title="Previous month"
              onClick={() => setMonth(shiftMonth(month, -1))}>
              <Icon.ChevronLeft size={14} />
            </button>
            <span className="min-w-[8rem] text-center text-sm text-slate-700">
              {monthLabel(month)}
            </span>
            <button className="icon-btn" aria-label="Next month" title="Next month"
              disabled={isCurrentMonth(month)}
              onClick={() => setMonth(shiftMonth(month, 1))}>
              <Icon.ChevronRight size={14} />
            </button>
          </div>
        }>
        {attendance.isError ? (
          <ErrorState onRetry={() => attendance.refetch()} />
        ) : attendance.isLoading ? (
          <CardSkeleton count={4} />
        ) : s ? (
          <>
            <StatRow cols={4}>
              <StatCard label="Payable days" value={String(s.payable_days)}
                hint={`of ${s.total_days} calendar days`} />
              <StatCard label="Present" value={String(s.present + s.wfh)}
                hint={s.half_days
                  ? `+ ${s.half_days} half day${s.half_days === 1 ? "" : "s"}`
                  : undefined} />
              <StatCard label="Absent" value={String(s.absent)}
                tone={s.absent > 0 ? "out" : undefined} />
              <StatCard label="Late marks" value={String(s.late_marks)}
                tone={s.late_penalty_days > 0 ? "due" : undefined}
                hint={s.late_penalty_days > 0
                  ? `${s.late_penalty_days} day off the count` : undefined} />
            </StatRow>
            {s.unresolved_days > 0 && (
              <div className="note-due mt-4">
                {s.unresolved_days} day{s.unresolved_days === 1 ? "" : "s"} in
                this month still {s.unresolved_days === 1 ? "needs" : "need"} a
                decision — a missed clock-out, or a past day with nothing on it.
                Clear {s.unresolved_days === 1 ? "it" : "them"} before working
                out the month.
              </div>
            )}
          </>
        ) : null}
      </Section>

      {/* ---------------------------------------------------- the leave -- */}
      <Section title="Leave"
        action={canManageLeave ? (
          <button className="btn-secondary btn-sm"
            onClick={() => setAdjusting(true)}>
            Adjust balance
          </button>
        ) : undefined}>
        {balance.isError ? (
          <ErrorState onRetry={() => balance.refetch()} />
        ) : balance.isLoading ? (
          <CardSkeleton count={3} />
        ) : b ? (
          <>
            <StatRow cols={3}>
              <StatCard label="Available" value={formatDays(b.available)}
                tone={balanceTone(b.available)} hint={b.leave_year_label} />
              <StatCard label="Taken" value={formatDays(b.used)} />
              <StatCard label="Waiting" value={formatDays(b.pending_days)}
                tone={b.pending_days > 0 ? "due" : undefined} />
            </StatRow>

            {(leaves.data?.items ?? []).length > 0 && (
              <div className="mt-4 overflow-x-auto scrollbar-light">
                <table className="table table-dense">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Reason</th>
                      <th className="num">Days</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(leaves.data?.items ?? []).slice(0, 8).map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap">
                          {leaveRangeLabel(r.start_date, r.end_date,
                            r.day_part)}
                        </td>
                        <td className="truncate" title={r.reason}>{r.reason}</td>
                        <td className="num">{r.days}</td>
                        <td>
                          <span className={leaveStatusBadge(r.status)}>
                            {LEAVE_STATUS_LABELS[r.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </Section>

      {/* -------------------------------------------------- the register -- */}
      <Section title="Register"
        action={
          <Link className="btn-ghost btn-sm"
            to={`/hr/attendance?view=today`}>
            Open Attendance <Icon.ChevronRight size={13} />
          </Link>
        }>
        {attendance.isError ? (
          <ErrorState onRetry={() => attendance.refetch()} />
        ) : attendance.isLoading ? (
          <TableSkeleton cols={6} />
        ) : (attendance.data?.days.length ?? 0) === 0 ? (
          <EmptyState title="Nothing recorded"
            icon={<Icon.Calendar size={20} />}
            hint="No attendance for this month yet." />
        ) : (
          <AttendanceMonthTable
            days={attendance.data!.days}
            canEdit={canManageAttendance}
            onEdit={canManageAttendance ? (d) => setEditing(d) : undefined}
          />
        )}
      </Section>

      <EditDayDialog
        open={!!editing} onClose={() => setEditing(null)} day={editing}
        userId={user.id} userName={user.full_name} />
      <AdjustBalanceDialog
        open={adjusting} onClose={() => setAdjusting(false)}
        user={{ id: user.id, name: user.full_name }} />
    </div>
  );
}

/* --------------------------------------------------------------- payslips -- */

/**
 * This person's last few payslips, on their own record.
 *
 * A STRIP, not a table: the question here is "have they been paid", which is
 * three rows and a link. The full history and everything you can DO to a
 * payslip live on /hr/payslips, and putting a second pay desk on a record tab
 * is how the two start disagreeing about what "finalised" means.
 *
 * Shown only to somebody who may read this person's payslips — their own record
 * needs no flag, anybody else's needs `view_payslips`. Without it the server
 * 403s, so the strip is not drawn rather than drawn and refused.
 */
function PayslipStrip({ user }: { user: UserRow }) {
  const { has, user: me } = useAuth();
  const mine = me?.id === user.id;
  const allowed = mine || has("view_payslips");

  const slips = useQuery({
    queryKey: ["payslips", "of", user.id],
    queryFn: async () =>
      (await payslipsApi.list({ user_id: user.id })).data,
    enabled: allowed,
  });

  if (!allowed) return null;

  const rows = (slips.data?.items ?? []).slice(0, 4);
  return (
    <Section title="Payslips"
      action={
        <Link to={mine ? "/hr/payslips" : "/hr/payslips?view=run"}
          className="btn-ghost btn-sm">
          All payslips <Icon.ChevronRight size={14} />
        </Link>
      }>
      {slips.isError ? (
        <ErrorState onRetry={() => slips.refetch()} />
      ) : slips.isLoading ? (
        <TableSkeleton cols={3} rows={2} />
      ) : rows.length === 0 ? (
        <EmptyState title="No payslips yet"
          hint="The first one is generated on the 1st of next month, from this
            month's attendance." />
      ) : (
        <div className="overflow-hidden rounded-control border border-line">
          <table className="w-full">
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}
                  className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2 text-sm text-slate-700">
                    <Link to={`/hr/payslips?slip=${p.id}`}
                      className="font-medium text-slate-900 hover:underline">
                      {payslipMonthLabel(p.month)}
                    </Link>
                    <span className="ml-2 text-xs text-slate-500">
                      {payDays(p.payable_days)} payable days
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-sm tabular-nums
                    text-slate-800">
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
        </div>
      )}
    </Section>
  );
}
