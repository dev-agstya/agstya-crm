import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock } from "lucide-react";
import { attendanceApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { ErrorState } from "../shared/ErrorState";
import { CardGridSkeleton } from "../shared/LoadingSkeleton";
import { toast } from "../Toast";
import { formatDuration, formatTime } from "../../lib/hr";
import type { PunchState } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const TICK_MS = 1000;

function useServerClock(state: PunchState | undefined): number {
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

function minutesSince(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

export function PunchPanel({ onChanged }: { onChanged?: () => void }) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["hr", "punch"],
    queryFn: async () => (await attendanceApi.today()).data,
    refetchOnWindowFocus: true,
  });
  const d = state.data;
  const now = useServerClock(d);

  const act = useMutation({
    mutationFn: async (what: "in" | "out" | "break-start" | "break-end") => {
      const call =
        what === "in"
          ? attendanceApi.punchIn
          : what === "out"
            ? attendanceApi.punchOut
            : what === "break-start"
              ? attendanceApi.breakStart
              : attendanceApi.breakEnd;
      return (await call()).data;
    },
    onSuccess: (next, what) => {
      qc.setQueryData(["hr", "punch"], next);
      qc.invalidateQueries({ queryKey: ["hr", "month"] });
      onChanged?.();
      if (what === "in") toast.success("Clocked in. Have a good day.");
      if (what === "out") toast.success("Clocked out.");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (state.isLoading) return <CardGridSkeleton count={1} />;
  if (state.isError || !d) {
    return (
      <ErrorState
        onRetry={() => state.refetch()}
        message="Couldn't load today's attendance. Nothing has been recorded or changed."
      />
    );
  }

  if (!d.can_punch) return null;

  const working = !!d.clock_in && !d.clock_out;
  const done = !!d.clock_out;
  const breakMins =
    d.on_break && d.break_started_at
      ? d.break_minutes + minutesSince(d.break_started_at, now)
      : d.break_minutes;
  const workedMins = working
    ? Math.max(0, minutesSince(d.clock_in, now) - breakMins)
    : d.worked_minutes;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Today
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
          </div>

          <p className="mt-0.5 text-2xl font-bold tabular-nums text-foreground">
            {workedMins > 0 ? formatDuration(workedMins) : "Not started"}
          </p>

          <p className="mt-0.5 text-xs text-muted-foreground">
            {d.holiday_name ? (
              <>Today is {d.holiday_name} — a holiday. Nothing to record.</>
            ) : d.is_week_off ? (
              <>Today is a week off. Nothing to record.</>
            ) : d.on_leave ? (
              <>
                You are on approved leave today
                {d.leave_code ? ` (${d.leave_code})` : ""}. Clocking in still
                counts as a day worked and gives the leave day back.
              </>
            ) : done ? (
              <>
                {formatTime(d.clock_in)} – {formatTime(d.clock_out)}
                {breakMins > 0 ? ` · ${formatDuration(breakMins)} of breaks` : ""}
              </>
            ) : working ? (
              <>
                Since {formatTime(d.clock_in)}
                {breakMins > 0 ? ` · ${formatDuration(breakMins)} of breaks` : ""}
              </>
            ) : (
              <>
                Your shift is {d.shift_start} to {d.shift_end}.
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!d.clock_in && (
            <Button
              type="button"
              disabled={act.isPending}
              onClick={() => act.mutate("in")}
            >
              <Clock className="mr-1.5 h-4 w-4" /> Clock in
            </Button>
          )}
          {working && !d.on_break && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={act.isPending}
                onClick={() => act.mutate("break-start")}
              >
                Start break
              </Button>
              <Button
                type="button"
                disabled={act.isPending}
                onClick={() => act.mutate("out")}
              >
                <Clock className="mr-1.5 h-4 w-4" /> Clock out
              </Button>
            </>
          )}
          {working && d.on_break && (
            <>
              <Button
                type="button"
                disabled={act.isPending}
                onClick={() => act.mutate("break-end")}
              >
                End break
              </Button>
              <span className="text-xs text-muted-foreground">
                Break running ·{" "}
                {formatDuration(minutesSince(d.break_started_at, now))}
              </span>
            </>
          )}
          {done && (
            <Badge
              variant="outline"
              className="border-emerald-200 bg-emerald-50 text-emerald-700"
            >
              <Check className="mr-1 h-3.5 w-3.5" /> Day recorded
            </Badge>
          )}
        </div>
      </div>

      {done && (
        <div className="grid grid-cols-3 divide-x divide-border border-t border-border bg-muted/20 text-center">
          {[
            ["In", formatTime(d.clock_in)],
            ["Out", formatTime(d.clock_out)],
            ["Breaks", formatDuration(d.break_minutes)],
          ].map(([label, value]) => (
            <div key={label} className="px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </p>
              <p className="mt-0.5 text-xs font-medium tabular-nums text-foreground">
                {value}
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
