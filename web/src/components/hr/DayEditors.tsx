import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { attendanceApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormField } from "../shared/FormSection";
import { toast } from "../Toast";
import { STATUS_LABELS, dayLabel, toTimeInput } from "../../lib/hr";
import type { AttendanceDay } from "../../lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const MANUAL_STATUSES: { value: string; label: string }[] = [
  { value: "__auto__", label: "Let the timings decide" },
  { value: "present", label: STATUS_LABELS.present },
  { value: "half_day", label: STATUS_LABELS.half_day },
  { value: "absent", label: STATUS_LABELS.absent },
  { value: "wfh", label: STATUS_LABELS.wfh },
  { value: "on_leave", label: STATUS_LABELS.on_leave },
];

export function EditDayDialog({
  open,
  onClose,
  day,
  userId,
  userName,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  day: AttendanceDay | null;
  userId: string;
  userName: string;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [status, setStatus] = useState("__auto__");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!day) return;
    setClockIn(toTimeInput(day.clock_in));
    setClockOut(toTimeInput(day.clock_out));
    setStatus("__auto__");
    setNote(day.note ?? "");
    setReason("");
  }, [day?.day, day?.record_id]);

  const save = useMutation({
    mutationFn: async () =>
      (
        await attendanceApi.editDay({
          user_id: userId,
          day: day!.day,
          clock_in: clockIn,
          clock_out: clockOut,
          status: status === "__auto__" ? "" : status,
          note,
          reason: reason.trim(),
        })
      ).data,
    onSuccess: () => {
      toast.success(`${dayLabel(day!.day)} updated.`);
      qc.invalidateQueries({ queryKey: ["hr"] });
      onSaved?.();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!day) return null;
  const canSave = reason.trim().length >= 3 && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {dayLabel(day.day)}</DialogTitle>
          <DialogDescription>
            {userName} — this is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2">
          <FormField label="Clock in" hint="Leave blank to clear it.">
            <Input
              type="time"
              value={clockIn}
              onChange={(e) => setClockIn(e.target.value)}
            />
          </FormField>
          <FormField label="Clock out">
            <Input
              type="time"
              value={clockOut}
              onChange={(e) => setClockOut(e.target.value)}
            />
          </FormField>
          <FormField
            label="Force the status"
            className="sm:col-span-2"
            hint="Only when the timings cannot say it — a client visit, or a day somebody worked from home."
          >
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label="Note"
            className="sm:col-span-2"
            hint="Shown on the day itself. Optional."
          >
            <Input
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
          <FormField
            label="Why are you changing this?"
            required
            className="sm:col-span-2"
            hint="Recorded against your name in the audit trail, and shown to the employee."
          >
            <Textarea
              rows={2}
              value={reason}
              maxLength={300}
              placeholder="Forgot to clock out — confirmed they left at 19:10"
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save the day"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RaiseCorrectionDialog({
  open,
  onClose,
  day,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  day: AttendanceDay | null;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!day) return;
    setClockIn(toTimeInput(day.clock_in));
    setClockOut(toTimeInput(day.clock_out));
    setReason("");
  }, [day?.day, day?.record_id]);

  const send = useMutation({
    mutationFn: async () =>
      (
        await attendanceApi.raiseCorrection({
          day: day!.day,
          clock_in: clockIn || null,
          clock_out: clockOut || null,
          reason: reason.trim(),
        })
      ).data,
    onSuccess: () => {
      toast.success("Sent. Your manager will see it in their queue.");
      qc.invalidateQueries({ queryKey: ["hr"] });
      onSaved?.();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!day) return null;
  const hasTime = !!(clockIn || clockOut);
  const canSend = hasTime && reason.trim().length >= 3 && !send.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ask to fix {dayLabel(day.day)}</DialogTitle>
          <DialogDescription>
            Your manager approves it, and the change is applied for you.
          </DialogDescription>
        </DialogHeader>

        {day.missed_punch_out && (
          <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
            This day was closed automatically at the end of your shift because
            there was no clock-out. Put the time you actually left below.
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2">
          <FormField
            label="Clock in"
            hint="Leave it as it is if this one was right."
          >
            <Input
              type="time"
              value={clockIn}
              onChange={(e) => setClockIn(e.target.value)}
            />
          </FormField>
          <FormField label="Clock out">
            <Input
              type="time"
              value={clockOut}
              onChange={(e) => setClockOut(e.target.value)}
            />
          </FormField>
          <FormField label="What happened?" required className="sm:col-span-2">
            <Textarea
              rows={2}
              value={reason}
              maxLength={300}
              placeholder="Left at 19:10 for a client visit and forgot to clock out"
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSend}
            onClick={() => send.mutate()}
          >
            {send.isPending ? "Sending…" : "Send request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
