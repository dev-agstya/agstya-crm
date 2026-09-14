import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { leaveApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { DateInput } from "../DateInput";
import { Field, Modal, Segmented } from "../ui";
import { toast } from "../Toast";
import { DAY_PART_LABELS, REASON_LABELS, formatDays, todayKey } from "../../lib/hr";
import type { LeaveDayPart, LeaveRequest, LeaveReasonType } from "../../lib/types";

/*
  Applying for leave.

  THE ONE THING THIS FORM MUST DO is say what the request will cost BEFORE it is
  sent (owner E17). Going short on balance is allowed and is never blocked —
  people genuinely need unpaid leave, and refusing it only means the day gets
  recorded as an absence instead, which is worse for everybody. But a deduction
  discovered later on a payslip is how an argument starts, so the cost is on
  screen while the dates are still being picked.

  The preview is computed SERVER-SIDE (`leaveApi.preview`) rather than in the
  browser, and that is not laziness. Working out what a range costs means
  knowing the week-off days, every declared holiday inside the range, and the
  current balance — three things the browser would have to fetch and then apply
  a second copy of the rule to. One call, one rule, and the number the form
  shows is by construction the number the approval will use.
*/

export function LeaveFormDialog({
  open, onClose, editing, onBehalfOf, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Editing a PENDING request rather than raising a new one. */
  editing?: LeaveRequest | null;
  /** Applying for somebody else (needs manage_leave). */
  onBehalfOf?: { id: string; name: string } | null;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [start, setStart] = useState(todayKey());
  const [end, setEnd] = useState(todayKey());
  const [dayPart, setDayPart] = useState<LeaveDayPart>("full");
  const [reasonType, setReasonType] = useState<LeaveReasonType>("personal");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setStart(editing.start_date);
      setEnd(editing.end_date);
      setDayPart(editing.day_part);
      setReasonType(editing.reason_type);
      setReason(editing.reason);
    } else {
      setStart(todayKey());
      setEnd(todayKey());
      setDayPart("full");
      setReasonType("personal");
      setReason("");
    }
  }, [open, editing?.id]);

  // A half day is a claim about ONE day, so picking a range clears it rather
  // than letting the server reject the combination after the fact.
  const singleDay = start === end;
  useEffect(() => {
    if (!singleDay && dayPart !== "full") setDayPart("full");
  }, [singleDay, dayPart]);

  const valid = !!start && !!end && end >= start;

  const preview = useQuery({
    queryKey: ["hr", "leave-preview", start, end, dayPart, onBehalfOf?.id],
    queryFn: async () => (await leaveApi.preview({
      start_date: start, end_date: end, day_part: dayPart,
      user_id: onBehalfOf?.id,
    })).data,
    enabled: open && valid,
  });
  const p = preview.data;

  const submit = useMutation({
    mutationFn: async () => {
      const body = {
        start_date: start, end_date: end, day_part: dayPart,
        reason_type: reasonType, reason: reason.trim(),
      };
      if (editing) return (await leaveApi.edit(editing.id, body)).data;
      return (await leaveApi.apply({
        ...body, user_id: onBehalfOf?.id })).data;
    },
    onSuccess: (r) => {
      toast.success(editing
        ? `${r.code} updated.`
        : onBehalfOf
          ? `Recorded for ${onBehalfOf.name}.`
          : "Sent. Your manager will see it in their queue.");
      qc.invalidateQueries({ queryKey: ["hr"] });
      onSaved?.();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canSend = valid && reason.trim().length >= 3 && !submit.isPending
    && (p?.days ?? 0) > 0;

  return (
    <Modal open={open} onClose={onClose}
      title={editing ? `Edit ${editing.code}`
        : onBehalfOf ? `Record leave for ${onBehalfOf.name}`
          : "Apply for leave"}
      subtitle={onBehalfOf
        ? "Recorded as approved straight away — you are the one approving it."
        : "Sundays and declared holidays inside the dates cost you nothing."}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSend}
            onClick={() => submit.mutate()}>
            {submit.isPending ? "Sending…"
              : editing ? "Save changes"
                : onBehalfOf ? "Record it" : "Send the request"}
          </button>
        </>
      }>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="From" required>
          <DateInput value={start} onChange={(v) => {
            setStart(v);
            // Dragging the start past the end is a typo, not an intention.
            if (v && end < v) setEnd(v);
          }} />
        </Field>
        <Field label="To" required>
          <DateInput value={end} min={start} onChange={setEnd} />
        </Field>

        {singleDay && (
          <Field label="How much of the day?" className="sm:col-span-2">
            <Segmented
              value={dayPart}
              onChange={(v) => setDayPart(v as LeaveDayPart)}
              options={(["full", "first_half", "second_half"] as LeaveDayPart[])
                .map((v) => ({ value: v, label: DAY_PART_LABELS[v] }))}
            />
          </Field>
        )}

        <Field label="Reason" required>
          <select className="select" value={reasonType}
            onChange={(e) =>
              setReasonType(e.target.value as LeaveReasonType)}>
            {(Object.keys(REASON_LABELS) as LeaveReasonType[]).map((k) => (
              <option key={k} value={k}>{REASON_LABELS[k]}</option>
            ))}
          </select>
        </Field>
        <Field label="Anything else?" required
          hint="Your manager sees this.">
          <input className="input" value={reason} maxLength={500}
            placeholder="Family function out of town"
            onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>

      {/* THE COST, before you send. Never a blocker — always a statement. */}
      {p && (
        <div className={`mt-4 ${p.unpaid_days > 0 ? "note-due" : "note"}`}>
          <p className="font-medium text-slate-900">
            This is {formatDays(p.days)} of leave.
          </p>
          <p className="mt-1">
            You have {formatDays(p.available)} available.
            {p.unpaid_days > 0 ? (
              <> {formatDays(p.paid_days)} would come off your balance and{" "}
                <b>{formatDays(p.unpaid_days)} would be unpaid</b>.</>
            ) : (
              <> All of it comes off your balance.</>
            )}
          </p>
          {p.skipped_days.length > 0 && (
            <p className="mt-1 text-slate-500">
              {p.skipped_days.length} day
              {p.skipped_days.length === 1 ? "" : "s"} in that range
              {p.skipped_days.length === 1 ? " is" : " are"} a week off or a
              holiday, so {p.skipped_days.length === 1 ? "it costs" : "they cost"}
              {" "}nothing.
            </p>
          )}
          {p.is_backdated && (
            <p className="mt-1 text-slate-500">
              This is for a date that has already passed — that is fine, and
              your manager will see it flagged.
            </p>
          )}
          {p.conflict && (
            <p className="mt-1 font-medium text-money-out">{p.conflict}</p>
          )}
        </div>
      )}
      {valid && p && p.days === 0 && (
        <div className="note-out mt-4">
          Every day in that range is a week off or a holiday, so there is no
          leave to apply for.
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------- balance adjuster -- */

/**
 * Moving a balance by hand (owner E6).
 *
 * Needed on DAY ONE: this system starts everybody at zero, which is correct and
 * is not what anybody has actually earned. "Opening balance" and "adjustment"
 * are the same movement and are stored as different entry types on purpose —
 * the statement reads very differently for each, and "what you were carrying
 * when we switched this on" is a sentence somebody will want to find later.
 */
export function AdjustBalanceDialog({ open, onClose, user, onSaved }: {
  open: boolean;
  onClose: () => void;
  user: { id: string; name: string } | null;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [days, setDays] = useState("1");
  const [reason, setReason] = useState("");
  const [isOpening, setIsOpening] = useState(false);

  useEffect(() => {
    if (open) { setDays("1"); setReason(""); setIsOpening(false); }
  }, [open, user?.id]);

  const value = Number(days);
  // Halves and nothing finer — the server refuses anything else, so the button
  // follows rather than letting somebody type 0.3 into a 422.
  const validDays = Number.isFinite(value) && value !== 0
    && Math.round(value * 2) === value * 2;

  const save = useMutation({
    mutationFn: async () => (await leaveApi.adjust({
      user_id: user!.id, days: value, reason: reason.trim(),
      is_opening: isOpening,
    })).data,
    onSuccess: () => {
      toast.success(`${user!.name}'s balance updated.`);
      qc.invalidateQueries({ queryKey: ["hr"] });
      onSaved?.();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!user) return null;

  return (
    <Modal open={open} onClose={onClose} size="sm"
      title={`Adjust ${user.name}'s balance`}
      subtitle="Recorded as a row on their leave statement, with your name on it."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary"
            disabled={!validDays || reason.trim().length < 3 || save.isPending}
            onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Apply"}
          </button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Days" required
          error={days && !validDays
            ? "Leave is counted in halves — use 0.5, 1, 1.5 and so on."
            : undefined}
          hint="Negative takes days away.">
          <input className="input" type="number" step="0.5" value={days}
            onChange={(e) => setDays(e.target.value)} />
        </Field>
        <Field label="Why?" required>
          <input className="input" value={reason} maxLength={300}
            placeholder="Carried over from before we started using this"
            onChange={(e) => setReason(e.target.value)} />
        </Field>
        <label className="flex items-start gap-2.5 text-sm text-slate-700">
          <input type="checkbox" checked={isOpening} className="mt-0.5"
            onChange={(e) => setIsOpening(e.target.checked)} />
          <span>
            This is their <b>opening balance</b> — what they were already
            carrying when this system started.
          </span>
        </label>
      </div>
    </Modal>
  );
}
