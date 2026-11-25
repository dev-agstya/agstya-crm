import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, MapPin } from "lucide-react";
import { attendanceApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { toast } from "../Toast";
import {
  LOCATION_LABELS,
  formatDistance,
  formatDuration,
  formatTime,
} from "../../lib/hr";
import { currentFix } from "../../lib/geo";
import type { PunchState } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

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
    mutationFn: async (what: "in" | "out") => {
      const where = d?.geofence.enabled ? await currentFix() : null;
      return (
        await (what === "in"
          ? attendanceApi.punchIn(where)
          : attendanceApi.punchOut(where))
      ).data;
    },
    onSuccess: (next, what) => {
      qc.setQueryData(["hr", "punch"], next);
      qc.invalidateQueries({ queryKey: ["hr", "month"] });
      if (what !== "in") {
        toast.success("Clocked out.");
        return;
      }
      const at = next.work_location;
      toast.success(
        at === "remote"
          ? "Clocked in from outside the office — recorded as work from home."
          : at === "unknown" && next.geofence.enabled
            ? "Clocked in. We could not check your location, so your manager will confirm this day."
            : "Clocked in. Have a good day."
      );
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (state.isLoading || state.isError || !d || !d.can_punch) return null;
  if (d.is_week_off || d.holiday_name) return null;

  const working = !!d.clock_in && !d.clock_out;
  const done = !!d.clock_out;
  const worked = working
    ? Math.max(
        0,
        Math.floor((now - new Date(d.clock_in!).getTime()) / 60000) -
          d.break_minutes
      )
    : d.worked_minutes;

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Attendance
          </span>
          {d.is_late && (
            <Badge
              variant="outline"
              className="h-5 border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800"
            >
              Late by {formatDuration(d.late_minutes)}
            </Badge>
          )}
          {d.on_break && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              On a break
            </Badge>
          )}
          {d.on_leave && !d.clock_in && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              On approved leave
            </Badge>
          )}
          {d.clock_in && d.work_location && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {LOCATION_LABELS[d.work_location]}
              {d.work_location === "remote" &&
                d.distance_m != null &&
                ` · ${formatDistance(d.distance_m)} away`}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
          {done
            ? formatDuration(worked)
            : working
              ? formatDuration(worked)
              : "Not started"}
        </p>
        <p className="text-xs text-muted-foreground">
          {done
            ? `${formatTime(d.clock_in)} – ${formatTime(d.clock_out)}`
            : working
              ? `Since ${formatTime(d.clock_in)}`
              : `Shift ${d.shift_start} – ${d.shift_end}`}
        </p>
        {!d.clock_in && d.geofence.enabled && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" />
            Clocking in checks your location. Away from{" "}
            {d.geofence.office_label} it is recorded as work from home.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {!d.clock_in && (
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={act.isPending}
            onClick={() => act.mutate("in")}
          >
            <Clock className="mr-1.5 h-3.5 w-3.5" /> Clock in
          </Button>
        )}
        {working && !d.on_break && (
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={act.isPending}
            onClick={() => act.mutate("out")}
          >
            <Clock className="mr-1.5 h-3.5 w-3.5" /> Clock out
          </Button>
        )}
        <Button asChild variant="outline" size="sm" className="h-8">
          <Link to="/hr/attendance">
            {d.on_break ? "End break" : "Open"}
          </Link>
        </Button>
      </div>
    </Card>
  );
}
