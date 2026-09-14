import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { attendanceApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Field, Modal } from "../ui";
import { toast } from "../Toast";
import { STATUS_LABELS, dayLabel, toTimeInput } from "../../lib/hr";
import type { AttendanceDay } from "../../lib/types";

/*
  The two ways a wrong day gets fixed.

  They are deliberately DIFFERENT dialogs rather than one with a mode, because
  they are different acts:

    * A MANAGER'S EDIT writes the day immediately and demands a REASON. It is
      one person making a claim about another person's working hours, and at
      month end it is what the pay is worked out from — so the audit row and
      that sentence are the only evidence of why the register says what it says.

    * AN EMPLOYEE'S CORRECTION asks for the change. It cannot force a status, it
      is always about their own day, and it lands in a queue. There is no
      `user_id` on the request at all — raising one for somebody else IS the
      manager's edit, and the two must not be reachable from the same form.

  One dialog with a `canEdit` branch would blur that, and the blur is exactly
  how "ask" quietly becomes "set".
*/

// The statuses a manager may force. A subset of AttendanceStatus on purpose:
// `not_marked` is what a day is when nothing has happened (you CLEAR an
// override rather than setting one), and holiday / week off belong to the
// calendar — forcing one for a single person would leave that day looking like
// a holiday nobody else got.
const MANUAL_STATUSES: { value: string; label: string }[] = [
  { value: "", label: "Let the timings decide" },
  { value: "present", label: STATUS_LABELS.present },
  { value: "half_day", label: STATUS_LABELS.half_day },
  { value: "absent", label: STATUS_LABELS.absent },
  { value: "wfh", label: STATUS_LABELS.wfh },
  { value: "on_leave", label: STATUS_LABELS.on_leave },
];

/* ------------------------------------------------------- a manager's edit -- */

export function EditDayDialog({
  open, onClose, day, userId, userName, onSaved,
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
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  // Re-seed whenever a different day is opened. Without this the dialog carries
  // the previous row's times into the next one, which is a very quiet way to
  // write the wrong hours onto somebody's Tuesday.
  useEffect(() => {
    if (!day) return;
    setClockIn(toTimeInput(day.clock_in));
    setClockOut(toTimeInput(day.clock_out));
    setStatus(day.status === "not_marked" ? "" : "");
    setNote(day.note ?? "");
    setReason("");
  }, [day?.day, day?.record_id]);

  const save = useMutation({
    mutationFn: async () => (await attendanceApi.editDay({
      user_id: userId,
      day: day!.day,
      clock_in: clockIn,
      clock_out: clockOut,
      status,
      note,
      reason: reason.trim(),
    })).data,
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
    <Modal open={open} onClose={onClose}
      title={`Edit ${dayLabel(day.day)}`}
      subtitle={`${userName} — this is recorded in the audit trail.`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSave}
            onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save the day"}
          </button>
        </>
      }>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Clock in"
          hint="Leave blank to clear it.">
          <input type="time" className="input" value={clockIn}
            onChange={(e) => setClockIn(e.target.value)} />
        </Field>
        <Field label="Clock out">
          <input type="time" className="input" value={clockOut}
            onChange={(e) => setClockOut(e.target.value)} />
        </Field>
        <Field label="Force the status" className="sm:col-span-2"
          hint="Only when the timings cannot say it — a client visit, or a day
            somebody worked from home.">
          <select className="select" value={status}
            onChange={(e) => setStatus(e.target.value)}>
            {MANUAL_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Note" className="sm:col-span-2"
          hint="Shown on the day itself. Optional.">
          <input className="input" value={note} maxLength={500}
            onChange={(e) => setNote(e.target.value)} />
        </Field>
        {/* MANDATORY, and the server refuses without it. This is the only
            evidence of why somebody's hours were changed. */}
        <Field label="Why are you changing this?" required
          className="sm:col-span-2"
          hint="Recorded against your name in the audit trail, and shown to the
            employee.">
          <textarea className="input" rows={2} value={reason} maxLength={300}
            placeholder="Forgot to clock out — confirmed they left at 19:10"
            onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------- an employee's correction -- */

export function RaiseCorrectionDialog({ open, onClose, day, onSaved }: {
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
    mutationFn: async () => (await attendanceApi.raiseCorrection({
      day: day!.day,
      clock_in: clockIn || null,
      clock_out: clockOut || null,
      reason: reason.trim(),
    })).data,
    onSuccess: () => {
      toast.success("Sent. Your manager will see it in their queue.");
      qc.invalidateQueries({ queryKey: ["hr"] });
      onSaved?.();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!day) return null;
  // The server enforces all three of these; the button follows them so nobody
  // presses it into a 422 they could have been told about while typing.
  const hasTime = !!(clockIn || clockOut);
  const canSend = hasTime && reason.trim().length >= 3 && !send.isPending;

  return (
    <Modal open={open} onClose={onClose}
      title={`Ask to fix ${dayLabel(day.day)}`}
      subtitle="Your manager approves it, and the change is applied for you."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSend}
            onClick={() => send.mutate()}>
            {send.isPending ? "Sending…" : "Send the request"}
          </button>
        </>
      }>
      {day.missed_punch_out && (
        <div className="note-due mb-4">
          This day was closed automatically at the end of your shift because
          there was no clock-out. Put the time you actually left below.
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Clock in"
          hint="Leave it as it is if this one was right.">
          <input type="time" className="input" value={clockIn}
            onChange={(e) => setClockIn(e.target.value)} />
        </Field>
        <Field label="Clock out">
          <input type="time" className="input" value={clockOut}
            onChange={(e) => setClockOut(e.target.value)} />
        </Field>
        <Field label="What happened?" required className="sm:col-span-2">
          <textarea className="input" rows={2} value={reason} maxLength={300}
            placeholder="Left at 19:10 for a client visit and forgot to clock
              out"
            onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
