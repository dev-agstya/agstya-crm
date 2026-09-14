import { Icon } from "../Icon";
import {
  EmptyState, Ledger, LedgerCell, LedgerRow, LTh, ListShell, MobileCard,
  StatCard, StatRow,
} from "../ui";
import {
  STATUS_LABELS, dayLabel, formatDuration, formatTime, isOffDay, statusBadge,
  statusRail,
} from "../../lib/hr";
import type { AttendanceDay, AttendanceSummary } from "../../lib/types";

/*
  One person's month, as a LEDGER.

  The 2026-08-07 direction applies exactly: no card around the list, the figure
  (hours worked) is the typography, and urgency is the LEFT EDGE rather than a
  status column. A month is thirty-one rows of which two or three matter, and
  the whole job of this screen is making those two or three findable in a
  glance — an edge does that; a chip on every row does not.

  Six columns, not eleven. Date and status stack in the primary cell; in, out
  and break stack into one "Timings" cell; hours are the hero figure; the note
  column carries whatever the row still owes an answer on.
*/

/**
 * The one line of context a row is allowed under its date.
 *
 * Related facts STACK, they do not get columns (the ledger rule). A holiday's
 * name, the leave code, who edited the day and why — these are all details OF
 * the day, and giving each a column is how a table gets to eleven of them.
 */
function daySub(d: AttendanceDay): string {
  if (d.holiday_name) return d.holiday_name;
  if (d.leave_worked) return "Worked on approved leave — day given back";
  if (d.leave_code) return `${d.leave_code}${d.leave_reason
    ? ` · ${d.leave_reason}` : ""}`;
  if (d.missed_punch_out) return "No clock-out — closed at shift end";
  if (d.edited_by_name) return `Edited by ${d.edited_by_name}`;
  return STATUS_LABELS[d.status];
}

export function AttendanceMonthTable({
  days, onEdit, canEdit, onRaiseCorrection,
}: {
  days: AttendanceDay[];
  /** A manager fixing the day. Absent without `manage_attendance`. */
  onEdit?: (day: AttendanceDay) => void;
  canEdit?: boolean;
  /** The employee's own route to a fix — always their own days. */
  onRaiseCorrection?: (day: AttendanceDay) => void;
}) {
  if (days.length === 0) {
    return (
      <EmptyState title="Nothing to show"
        icon={<Icon.Calendar size={20} />}
        hint="There is no attendance for this month yet." />
    );
  }

  return (
    <ListShell
      bare
      cards={days.map((d) => (
        <MobileCard key={d.day} to="#"
          rail={statusRail(d.status, { missedPunchOut: d.missed_punch_out })}
          title={dayLabel(d.day)}
          meta={daySub(d)}
          right={
            <>
              <span className="block whitespace-nowrap text-metric-sm
                tabular-nums text-slate-900">
                {formatDuration(d.worked_minutes)}
              </span>
              <span className={statusBadge(d.status)}>
                {STATUS_LABELS[d.status]}
              </span>
            </>
          }
          footer={d.clock_in
            ? `${formatTime(d.clock_in)} – ${formatTime(d.clock_out)}`
            : undefined}
        />
      ))}
      table={
        <Ledger
          head={
            <>
              <LTh>Date</LTh>
              <LTh>Status</LTh>
              <LTh>Timings</LTh>
              <LTh align="right">Worked</LTh>
              <LTh>Flags</LTh>
              <LTh />
            </>
          }
        >
          {days.map((d) => (
            <LedgerRow key={d.day}
              className={isOffDay(d.status) ? "text-slate-400" : ""}>
              <LedgerCell
                rail={statusRail(d.status,
                  { missedPunchOut: d.missed_punch_out })}
                title={dayLabel(d.day)}
                sub={daySub(d)} />
              <td>
                <span className={statusBadge(d.status)}>
                  {STATUS_LABELS[d.status]}
                </span>
              </td>
              <td className="whitespace-nowrap">
                {d.clock_in ? (
                  <>
                    <span className="block text-[13px] tabular-nums
                      text-slate-700">
                      {formatTime(d.clock_in)} – {formatTime(d.clock_out)}
                    </span>
                    {d.break_minutes > 0 && (
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {formatDuration(d.break_minutes)} break
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-[13px] text-slate-400">—</span>
                )}
              </td>
              {/* The row's hero figure. Hours are what somebody scans a month
                  for; everything else steps down to 13px around it. */}
              <td>
                <span className="ledger-figure">
                  {formatDuration(d.worked_minutes)}
                </span>
              </td>
              <td>
                <div className="flex flex-wrap gap-1">
                  {d.is_late && (
                    <span className="badge-due">
                      Late {formatDuration(d.late_minutes)}
                    </span>
                  )}
                  {d.is_early_out && (
                    <span className="badge-neutral">
                      Left early {formatDuration(d.early_out_minutes)}
                    </span>
                  )}
                  {d.missed_punch_out && (
                    <span className="badge-due">No clock-out</span>
                  )}
                </div>
              </td>
              <td>
                <div className="flex justify-end gap-1.5">
                  {/* A future day has nothing to fix yet, and offering the
                      control would invite somebody to pre-approve a day that
                      has not happened. */}
                  {!d.is_future && onRaiseCorrection && !canEdit && (
                    <button className="btn-ghost btn-sm"
                      onClick={() => onRaiseCorrection(d)}>
                      Ask to fix
                    </button>
                  )}
                  {!d.is_future && canEdit && onEdit && (
                    <button className="btn-secondary btn-sm"
                      onClick={() => onEdit(d)}>
                      <Icon.Edit size={13} /> Edit
                    </button>
                  )}
                </div>
              </td>
            </LedgerRow>
          ))}
        </Ledger>
      }
    />
  );
}

/**
 * The month's counts — the figures a manager works pay out from BY HAND.
 *
 * Deliberately in days and hours, with no rupee anywhere (owner 2026-08-20).
 * `payable_days` is the hero because it is the number that gets multiplied; the
 * rest of the tiles are what it was derived from, so the arithmetic can be
 * checked without leaving the page.
 */
export function AttendanceSummaryTiles({ summary, compact = false }: {
  summary: AttendanceSummary;
  compact?: boolean;
}) {
  return (
    <>
      <StatRow cols={compact ? 3 : 4}>
        <StatCard label="Payable days"
          value={String(summary.payable_days)}
          hint={`of ${summary.total_days} calendar days`} />
        <StatCard label="Present" value={String(summary.present
          + summary.wfh)} icon="Check"
          hint={summary.half_days
            ? `+ ${summary.half_days} half day${
              summary.half_days === 1 ? "" : "s"}` : undefined} />
        <StatCard label="Leave"
          value={String(summary.on_leave + summary.leave_unpaid)}
          tone={summary.leave_unpaid > 0 ? "due" : undefined}
          hint={summary.leave_unpaid > 0
            ? `${summary.leave_unpaid} unpaid` : "all paid"} />
        <StatCard label="Hours worked"
          value={summary.worked_hours ? `${summary.worked_hours}h` : "—"}
          icon="Clock" />
      </StatRow>

      {/* The second row is the deductions, and it only appears when there ARE
          deductions. A permanent row of zeroes trains people to stop reading
          the tiles that matter. */}
      {(summary.absent > 0 || summary.late_marks > 0
        || summary.unresolved_days > 0) && (
        <StatRow cols={3}>
          <StatCard label="Absent" value={String(summary.absent)}
            tone={summary.absent > 0 ? "out" : undefined} />
          <StatCard label="Late marks" value={String(summary.late_marks)}
            tone={summary.late_penalty_days > 0 ? "due" : undefined}
            hint={summary.late_penalty_days > 0
              ? `${summary.late_penalty_days} day off the payable count`
              : "no penalty yet"} />
          <StatCard label="Needs a decision"
            value={String(summary.unresolved_days)}
            tone={summary.unresolved_days > 0 ? "due" : undefined}
            hint="missed clock-outs and unmarked past days" />
        </StatRow>
      )}
    </>
  );
}
