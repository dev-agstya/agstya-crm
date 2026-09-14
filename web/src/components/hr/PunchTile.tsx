import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { attendanceApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Icon } from "../Icon";
import { toast } from "../Toast";
import {
  LOCATION_LABELS, formatDistance, formatDuration, formatTime,
} from "../../lib/hr";
import { currentFix } from "../../lib/geo";
import type { PunchState } from "../../lib/types";

/*
  The clock-in tile on the employee dashboard (owner H3).

  IF CLOCKING IN NEEDS A NAVIGATION, PEOPLE FORGET — and then somebody spends
  their morning approving correction requests instead. The dashboard is the
  screen an employee lands on, so the one action they take every single day is
  one press from where they already are.

  DELIBERATELY THINNER THAN THE PANEL on /hr/attendance. It shows the state and
  offers the single next action, and it does NOT offer breaks: a tile with four
  buttons is a tile nobody reads, and the break flow belongs on the page that
  also shows what the breaks did to the day. Everything else links through.

  Like the panel, the running figure is drawn from the SERVER's clock
  (`server_now`), not the browser's, so the tile and the register cannot
  disagree by however many minutes a laptop is out.
*/

function useServerNow(state: PunchState | undefined): number {
  const offset = useRef(0);
  const [, force] = useState(0);
  useEffect(() => {
    if (state?.server_now) {
      offset.current = new Date(state.server_now).getTime() - Date.now();
    }
  }, [state?.server_now]);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return Date.now() + offset.current;
}

export function PunchTile() {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["hr", "punch"],
    queryFn: async () => (await attendanceApi.today()).data,
    refetchOnWindowFocus: true,
  });
  const d = state.data;
  const now = useServerNow(d);

  const act = useMutation({
    /*
      ASK WHERE FIRST, BUT ONLY WHEN IT MATTERS (owner 2026-08-21).

      `geofence.enabled` gates the lookup so a browser is never asked for a
      location the agency has no use for — a permission prompt with nothing
      behind it is how people learn to click Block, and then the feature is dead
      on the day it IS switched on.

      `currentFix()` never throws and never blocks: denied, unavailable or slow
      all resolve to null within ten seconds, and the punch goes ahead without
      coordinates. What the position MEANS is decided server-side; this only
      reports it.
    */
    mutationFn: async (what: "in" | "out") => {
      const where = d?.geofence.enabled ? await currentFix() : null;
      return (await (what === "in" ? attendanceApi.punchIn(where)
        : attendanceApi.punchOut(where))).data;
    },
    onSuccess: (next, what) => {
      qc.setQueryData(["hr", "punch"], next);
      qc.invalidateQueries({ queryKey: ["hr", "month"] });
      if (what !== "in") {
        toast.success("Clocked out.");
        return;
      }
      // SAY WHAT WAS RECORDED, not just that something was. Somebody clocking
      // in from home needs to know the day went down as work-from-home now —
      // finding out at month end, from a register they cannot edit, is how this
      // feature would generate correction requests instead of removing them.
      const at = next.work_location;
      toast.success(
        at === "remote"
          ? "Clocked in from outside the office — recorded as work from home."
          : at === "unknown" && next.geofence.enabled
            ? "Clocked in. We could not check your location, so your manager "
              + "will confirm this day."
            : "Clocked in. Have a good day.");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Nothing at all while it loads, and nothing when the account does not clock
  // in (the owner, a partner). A tile that flickers in and out of a dashboard
  // grid is worse than one that arrives a beat late.
  if (state.isLoading || state.isError || !d || !d.can_punch) return null;
  // A day the office was never open needs no prompt and no button.
  if (d.is_week_off || d.holiday_name) return null;

  const working = !!d.clock_in && !d.clock_out;
  const done = !!d.clock_out;
  const worked = working
    ? Math.max(0, Math.floor((now - new Date(d.clock_in!).getTime()) / 60000)
      - d.break_minutes)
    : d.worked_minutes;

  return (
    <div className="card flex flex-wrap items-center justify-between gap-4
      px-5 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-caption uppercase text-slate-500">Attendance</p>
          {d.is_late && (
            <span className="badge-due">
              Late by {formatDuration(d.late_minutes)}
            </span>
          )}
          {d.on_break && <span className="badge-neutral">On a break</span>}
          {d.on_leave && !d.clock_in && (
            <span className="badge-neutral">On approved leave</span>
          )}
          {/* WHERE the day was recorded, once it has been. Grey, like every
              other chip here: a badge earns colour by meaning money or meaning
              time, and remote is a full ordinary paid day. */}
          {d.clock_in && d.work_location && (
            <span className="badge-neutral">
              {LOCATION_LABELS[d.work_location]}
              {d.work_location === "remote" && d.distance_m != null
                && ` · ${formatDistance(d.distance_m)} away`}
            </span>
          )}
        </div>
        <p className="mt-1 text-metric-sm tabular-nums text-slate-900">
          {done ? formatDuration(worked)
            : working ? formatDuration(worked)
              : "Not started"}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {done ? `${formatTime(d.clock_in)} – ${formatTime(d.clock_out)}`
            : working ? `Since ${formatTime(d.clock_in)}`
              : `Shift ${d.shift_start} – ${d.shift_end}`}
        </p>
        {/* Said BEFORE the button, not after. The browser is about to ask for
            location and a prompt with no explanation is one people dismiss —
            and clocking in from home quietly files the day differently, which
            nobody should discover at month end. */}
        {!d.clock_in && d.geofence.enabled && (
          <p className="mt-1 text-xs text-slate-500">
            <Icon.MapPin size={12} className="mr-1 inline align-[-2px]" />
            Clocking in checks your location. Away from{" "}
            {d.geofence.office_label} it is recorded as work from home.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {!d.clock_in && (
          <button className="btn-primary" disabled={act.isPending}
            onClick={() => act.mutate("in")}>
            <Icon.Clock size={15} /> Clock in
          </button>
        )}
        {working && !d.on_break && (
          <button className="btn-primary" disabled={act.isPending}
            onClick={() => act.mutate("out")}>
            <Icon.Clock size={15} /> Clock out
          </button>
        )}
        {/* Breaks are not offered here — see the note at the top. The link is
            how you reach them, and it is the same link either way. */}
        <Link to="/hr/attendance" className="btn-secondary">
          {d.on_break ? "End break" : "Open"}
        </Link>
      </div>
    </div>
  );
}
