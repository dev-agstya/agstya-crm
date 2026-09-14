import { Icon } from "../Icon";
import {
  EmptyState, Ledger, LedgerRow, LTh, ListShell, MobileCard,
  PersonCell, StatCard, StatRow,
} from "../ui";
import {
  STATUS_LABELS, STATUS_LETTER, formatDuration, formatTime, statusBadge,
  statusCellTone, statusRail,
} from "../../lib/hr";
import type {
  AttendanceStatus, TeamDay, TeamMonth, TeamMonthRow,
} from "../../lib/types";

/*
  The two team views.

  TODAY'S BOARD answers "who is in", which is a question with a five-second
  shelf life — so it is a list of people with the clock on it, sorted so the
  rows that need attention are already at the top rather than needing a filter.

  THE MONTH GRID answers "what does this month add up to", which is the question
  the pay is worked out from. It is people down the side and days across the
  top, one letter per day, with the payable-days figure at the end of the row —
  so a manager reads thirty people's months without opening thirty records.

  The grid is the ONE place in this module that scrolls sideways. That is
  deliberate and it is the exception the ledger rule allows for: thirty-one
  columns is not "too many columns" in the sense the rule is about (facts that
  should have stacked) — they are one fact repeated thirty-one times, and there
  is no stacking that makes a month shorter than a month.
*/

/* --------------------------------------------------------- today's board -- */

// Rows that need attention first. Absent and unpaid leave at the top, then the
// people who have not arrived, then late, then everybody who is simply working.
// A board sorted alphabetically makes you read all thirty rows to find the two
// that matter.
const URGENCY: Record<AttendanceStatus, number> = {
  absent: 0, leave_unpaid: 1, not_marked: 2, half_day: 3,
  on_leave: 4, present: 5, wfh: 5, week_off: 6, holiday: 6,
};

export function TeamDayBoard({ data, onOpen }: {
  data: TeamDay;
  onOpen: (userId: string) => void;
}) {
  if (data.members.length === 0) {
    return (
      <EmptyState title="No employees yet"
        icon={<Icon.Users size={20} />}
        hint="Attendance is recorded for employee accounts. Add somebody on the
          Employees page and they will appear here." />
    );
  }

  const rows = [...data.members].sort((a, b) => {
    const d = (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });

  return (
    <>
      {/* Counted server-side and read here. The tiles and the rows under them
          are the same screen; two derivations of "how many are late" is how
          they end up saying different things. */}
      <StatRow cols={4}>
        <StatCard label="Clocked in" value={String(data.in_count)}
          icon="Check" />
        <StatCard label="Late" value={String(data.late_count)}
          tone={data.late_count > 0 ? "due" : undefined} />
        <StatCard label="On leave" value={String(data.leave_count)} />
        <StatCard label="Not in yet"
          value={String(data.not_in_count + data.absent_count)}
          tone={data.absent_count > 0 ? "out" : undefined}
          hint={data.absent_count > 0
            ? `${data.absent_count} marked absent` : undefined} />
      </StatRow>

      {(data.is_week_off || data.holiday_name) && (
        <div className="note mt-4">
          {data.holiday_name
            ? `${data.holiday_name} — the office is closed, so nobody is
               expected in.`
            : "A week off — the office is closed, so nobody is expected in."}
        </div>
      )}

      <div className="mt-5">
        <ListShell
          bare
          cards={rows.map((m) => (
            <MobileCard key={m.user_id} to={`/people/employees/${m.user_id}`}
              rail={statusRail(m.status,
                { missedPunchOut: m.missed_punch_out })}
              title={m.name}
              meta={m.designation || m.code}
              right={
                <span className={statusBadge(m.status)}>
                  {STATUS_LABELS[m.status]}
                </span>
              }
              footer={m.clock_in
                ? `In ${formatTime(m.clock_in)}${m.clock_out
                  ? ` · Out ${formatTime(m.clock_out)}` : ""}`
                : undefined}
            />
          ))}
          table={
            <Ledger
              head={
                <>
                  <LTh>Employee</LTh>
                  <LTh>Status</LTh>
                  <LTh>In</LTh>
                  <LTh>Out</LTh>
                  <LTh align="right">Worked</LTh>
                  <LTh />
                </>
              }
            >
              {rows.map((m) => (
                <LedgerRow key={m.user_id} onClick={() => onOpen(m.user_id)}>
                  <td className={statusRail(m.status,
                    { missedPunchOut: m.missed_punch_out })
                    ? `rail-${statusRail(m.status,
                      { missedPunchOut: m.missed_punch_out })}` : ""}>
                    <PersonCell name={m.name}
                      sub={m.designation || m.code} />
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={statusBadge(m.status)}>
                        {STATUS_LABELS[m.status]}
                      </span>
                      {m.on_break && (
                        <span className="badge-neutral">On a break</span>
                      )}
                      {m.is_late && (
                        <span className="badge-due">
                          {formatDuration(m.late_minutes)} late
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-[13px] tabular-nums
                    text-slate-700">
                    {formatTime(m.clock_in)}
                  </td>
                  <td className="whitespace-nowrap text-[13px] tabular-nums
                    text-slate-700">
                    {m.clock_in && !m.clock_out
                      ? <span className="text-slate-400">still in</span>
                      : formatTime(m.clock_out)}
                  </td>
                  <td>
                    <span className="ledger-figure">
                      {formatDuration(m.worked_minutes)}
                    </span>
                  </td>
                  <td>
                    <div className="flex justify-end">
                      <button className="btn-ghost btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(m.user_id);
                        }}>
                        Month <Icon.ChevronRight size={13} />
                      </button>
                    </div>
                  </td>
                </LedgerRow>
              ))}
            </Ledger>
          }
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------ month grid -- */

export function TeamMonthGrid({ data, onOpen }: {
  data: TeamMonth;
  onOpen: (userId: string) => void;
}) {
  if (data.rows.length === 0) {
    return (
      <EmptyState title="No employees yet"
        icon={<Icon.Users size={20} />}
        hint="Attendance is recorded for employee accounts." />
    );
  }
  const dayCount = data.rows[0]?.days.length ?? 0;

  return (
    <div className="card overflow-hidden">
      {/* The exception, and the only one in this module: thirty-one columns are
          one fact repeated, not facts that should have stacked. The name column
          is sticky so a row stays identifiable at the far end of the month. */}
      <div className="overflow-x-auto scrollbar-light">
        <table className="table table-dense min-w-[52rem]">
          <thead>
            <tr>
              <th className="sticky left-0 z-raised bg-white">Employee</th>
              {Array.from({ length: dayCount }, (_, i) => (
                <th key={i} className="px-1 text-center">{i + 1}</th>
              ))}
              <th className="text-right">Payable</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r: TeamMonthRow) => (
              <tr key={r.user_id} className="row-link"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpen(r.user_id);
                }}
                onClick={() => onOpen(r.user_id)}>
                <td className="sticky left-0 z-raised bg-white">
                  <span className="block truncate font-medium text-slate-900">
                    {r.name}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {r.designation || r.code}
                  </span>
                </td>
                {r.days.map((d) => (
                  <td key={d.day} className="p-0.5 text-center">
                    <span title={`${d.day} — ${STATUS_LABELS[d.status]}`}
                      className={`inline-flex h-6 w-6 items-center
                        justify-center rounded text-[10px] font-semibold
                        ${statusCellTone(d.status)}`}>
                      {STATUS_LETTER[d.status]}
                    </span>
                  </td>
                ))}
                <td className="num">
                  <span className="font-semibold tabular-nums text-slate-900">
                    {r.summary.payable_days}
                  </span>
                  <span className="block text-xs text-slate-500">
                    of {r.summary.total_days}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t
        border-line px-5 py-3 text-xs text-slate-500">
        <span><b className="text-money-in">P</b> Present</span>
        <span><b className="text-due">H</b> Half day</span>
        <span><b className="text-money-out">A</b> Absent</span>
        <span><b>L</b> Paid leave</span>
        <span><b className="text-money-out">LU</b> Unpaid leave</span>
        <span><b className="text-money-in">W</b> Work from home</span>
        <span><b>HO</b> Holiday</span>
        <span><b>·</b> Week off</span>
        <span><b>–</b> Not marked</span>
      </div>
    </div>
  );
}
