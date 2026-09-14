import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { attendanceApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Icon } from "../Icon";
import { CardSkeleton, ErrorState } from "../ui";
import { toast } from "../Toast";
import { formatDuration, formatTime } from "../../lib/hr";
import type { PunchState } from "../../lib/types";

/*
  The punch clock.

  THE ONE CONTROL THIS MODULE EXISTS FOR, so it is the largest thing on the
  page and there is never more than one obvious thing to press. Three states,
  each with one primary action:

      not started  ->  [Clock in]
      working      ->  [Start break]   [Clock out]
      on break     ->  [End break]                     (clock out is disabled)

  THE COUNTER RUNS OFF THE SERVER'S CLOCK, not the browser's. `PunchState`
  carries `server_now`, and the offset between that and the laptop is measured
  once and applied to every tick. A machine eleven minutes fast would otherwise
  display eleven minutes of work the register does not have — and the first
  person to notice the tile and the month disagreeing would be right to
  distrust the whole screen.

  It is a CARD, not a ledger row. The ledger direction (2026-08-07) is for
  lists; this is a single bounded object with one action on it, which is exactly
  what a card is still for.
*/

/** How often the running figure repaints. A minute would visibly lag a press. */
const TICK_MS = 1000;

function useServerClock(state: PunchState | undefined): number {
  // ms to ADD to Date.now() to get the server's idea of now. Measured from the
  // payload rather than assumed zero, and re-measured on every refetch so a
  // laptop waking from sleep re-syncs instead of drifting for the rest of the
  // day.
  const offset = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    if (state?.server_now) {
      offset.current = new Date(state.server_now).getTime() - Date.now();
    }
  }, [state?.server_now]);

  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return Date.now() + offset.current;
}

/** Minutes elapsed since an instant, floored at zero. */
function minutesSince(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

export function PunchPanel({ onChanged }: { onChanged?: () => void }) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["hr", "punch"],
    queryFn: async () => (await attendanceApi.today()).data,
    // Someone else may have edited today's row, and a laptop that slept through
    // lunch should not show a stale "on break".
    refetchOnWindowFocus: true,
  });
  const d = state.data;
  const now = useServerClock(d);

  const act = useMutation({
    mutationFn: async (what: "in" | "out" | "break-start" | "break-end") => {
      const call = what === "in" ? attendanceApi.punchIn
        : what === "out" ? attendanceApi.punchOut
          : what === "break-start" ? attendanceApi.breakStart
            : attendanceApi.breakEnd;
      return (await call()).data;
    },
    // Every punch endpoint answers with the whole PunchState, so the panel
    // updates from the response rather than refetching — one round trip, and no
    // flicker between the press and the new state.
    onSuccess: (next, what) => {
      qc.setQueryData(["hr", "punch"], next);
      qc.invalidateQueries({ queryKey: ["hr", "month"] });
      onChanged?.();
      if (what === "in") toast.success("Clocked in. Have a good day.");
      if (what === "out") toast.success("Clocked out.");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (state.isLoading) return <CardSkeleton count={1} />;
  // The error branch comes FIRST, before loading and before empty. A failed
  // fetch rendering "not clocked in" would invite somebody to clock in twice.
  if (state.isError || !d) {
    return (
      <div className="card">
        <ErrorState onRetry={() => state.refetch()}
          message="Couldn't load today's attendance. Nothing has been recorded
            or changed." />
      </div>
    );
  }

  // Accounts that do not clock in (the owner, and channel partners). Says why
  // rather than drawing a button that will 400.
  if (!d.can_punch) {
    return (
      <div className="card card-body">
        <p className="text-card-title text-slate-900">Attendance</p>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
          Attendance is recorded for employees. Your account does not clock in —
          use the Team view to see everybody else's.
        </p>
      </div>
    );
  }

  const working = !!d.clock_in && !d.clock_out;
  const done = !!d.clock_out;
  // Live figures while the day runs; the stored ones once it has closed.
  const breakMins = d.on_break && d.break_started_at
    ? d.break_minutes + minutesSince(d.break_started_at, now)
    : d.break_minutes;
  const workedMins = working
    ? Math.max(0, minutesSince(d.clock_in, now) - breakMins)
    : d.worked_minutes;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-col gap-5 px-5 py-5 sm:flex-row
        sm:items-center sm:justify-between">
        {/* --- The state, in words and then in figures --- */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-caption uppercase text-slate-500">Today</p>
            {d.is_late && (
              <span className="badge-due">
                Late by {formatDuration(d.late_minutes)}
              </span>
            )}
            {d.on_break && <span className="badge-neutral">On a break</span>}
          </div>

          {/* ONE hero figure, `metric-lg` — the top of the figure ladder, and
              only one thing per screen may wear it. Here it is the number the
              person opened the page to see. */}
          <p className="mt-1 text-metric-lg tabular-nums text-slate-900">
            {workedMins > 0 ? formatDuration(workedMins) : "Not started"}
          </p>

          <p className="mt-1 text-sm text-slate-500">
            {d.holiday_name ? (
              <>Today is {d.holiday_name} — a holiday. Nothing to record.</>
            ) : d.is_week_off ? (
              <>Today is a week off. Nothing to record.</>
            ) : d.on_leave ? (
              <>You are on approved leave today
                {d.leave_code ? ` (${d.leave_code})` : ""}. Clocking in still
                counts as a day worked and gives the leave day back.</>
            ) : done ? (
              <>{formatTime(d.clock_in)} – {formatTime(d.clock_out)}
                {breakMins > 0
                  ? ` · ${formatDuration(breakMins)} of breaks` : ""}</>
            ) : working ? (
              <>Since {formatTime(d.clock_in)}
                {breakMins > 0
                  ? ` · ${formatDuration(breakMins)} of breaks` : ""}</>
            ) : (
              <>Your shift is {d.shift_start} to {d.shift_end}.</>
            )}
          </p>
        </div>

        {/* --- The action. Never more than one obvious thing to press. --- */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!d.clock_in && (
            <button className="btn-primary btn-lg"
              disabled={act.isPending}
              onClick={() => act.mutate("in")}>
              <Icon.Clock size={16} /> Clock in
            </button>
          )}
          {working && !d.on_break && (
            <>
              <button className="btn-secondary"
                disabled={act.isPending}
                onClick={() => act.mutate("break-start")}>
                Start break
              </button>
              <button className="btn-primary btn-lg"
                disabled={act.isPending}
                onClick={() => act.mutate("out")}>
                <Icon.Clock size={16} /> Clock out
              </button>
            </>
          )}
          {working && d.on_break && (
            <>
              {/* Clock-out is deliberately NOT offered while a break runs. The
                  service would close the break for you, but a button that
                  silently does two things is a button people press by mistake
                  and then have to have corrected. */}
              <button className="btn-primary btn-lg"
                disabled={act.isPending}
                onClick={() => act.mutate("break-end")}>
                End break
              </button>
              <span className="text-sm text-slate-500">
                Break running · {formatDuration(
                  minutesSince(d.break_started_at, now))}
              </span>
            </>
          )}
          {done && (
            <span className="badge-in">
              <Icon.Check size={13} /> Day recorded
            </span>
          )}
        </div>
      </div>

      {/* A day that has closed shows what it added up to, so the person does
          not have to scroll to the register to find out whether it counted. */}
      {done && (
        <div className="grid grid-cols-3 gap-px border-t border-line
          bg-line-soft text-center">
          {[
            ["In", formatTime(d.clock_in)],
            ["Out", formatTime(d.clock_out)],
            ["Breaks", formatDuration(d.break_minutes)],
          ].map(([label, value]) => (
            <div key={label} className="bg-white px-3 py-3">
              <p className="text-caption uppercase text-slate-500">{label}</p>
              <p className="mt-0.5 text-sm tabular-nums text-slate-900">
                {value}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
