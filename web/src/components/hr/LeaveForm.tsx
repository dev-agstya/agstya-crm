import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { leaveApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { DateInput } from "../DateInput";
import { FormField } from "../shared/FormSection";
import { toast } from "../Toast";
import { DAY_PART_LABELS, REASON_LABELS, formatDays, todayKey } from "../../lib/hr";
import type { LeaveDayPart, LeaveRequest, LeaveReasonType } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

export function LeaveFormDialog({
  open,
  onClose,
  editing,
  onBehalfOf,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing?: LeaveRequest | null;
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

  const singleDay = start === end;
  useEffect(() => {
    if (!singleDay && dayPart !== "full") setDayPart("full");
  }, [singleDay, dayPart]);

  const valid = !!start && !!end && end >= start;

  const preview = useQuery({
    queryKey: ["hr", "leave-preview", start, end, dayPart, onBehalfOf?.id],
    queryFn: async () =>
      (
        await leaveApi.preview({
          start_date: start,
          end_date: end,
          day_part: dayPart,
          user_id: onBehalfOf?.id,
        })
      ).data,
    enabled: open && valid,
  });
  const p = preview.data;

  const submit = useMutation({
    mutationFn: async () => {
      const body = {
        start_date: start,
        end_date: end,
        day_part: dayPart,
        reason_type: reasonType,
        reason: reason.trim(),
      };
      if (editing) return (await leaveApi.edit(editing.id, body)).data;
      return (
        await leaveApi.apply({
          ...body,
          user_id: onBehalfOf?.id,
        })
      ).data;
    },
    onSuccess: (r) => {
      toast.success(
        editing
          ? `${r.code} updated.`
          : onBehalfOf
            ? `Recorded for ${onBehalfOf.name}.`
            : "Sent. Your manager will see it in their queue."
      );
      qc.invalidateQueries({ queryKey: ["hr"] });
      onSaved?.();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canSend =
    valid && reason.trim().length >= 3 && !submit.isPending && (p?.days ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit ${editing.code}`
              : onBehalfOf
                ? `Record leave for ${onBehalfOf.name}`
                : "Apply for leave"}
          </DialogTitle>
          <DialogDescription>
            {onBehalfOf
              ? "Recorded as approved straight away — you are the one approving it."
              : "Sundays and declared holidays inside the dates cost you nothing."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2">
          <FormField label="From" required>
            <DateInput
              value={start}
              onChange={(v) => {
                setStart(v);
                if (v && end < v) setEnd(v);
              }}
            />
          </FormField>
          <FormField label="To" required>
            <DateInput value={end} min={start} onChange={setEnd} />
          </FormField>

          {singleDay && (
            <FormField label="How much of the day?" className="sm:col-span-2">
              <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
                {(["full", "first_half", "second_half"] as LeaveDayPart[]).map(
                  (v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setDayPart(v)}
                      className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                        dayPart === v
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {DAY_PART_LABELS[v]}
                    </button>
                  )
                )}
              </div>
            </FormField>
          )}

          <FormField label="Reason" required>
            <Select
              value={reasonType}
              onValueChange={(v) => setReasonType(v as LeaveReasonType)}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REASON_LABELS) as LeaveReasonType[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {REASON_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="Anything else?" required hint="Your manager sees this.">
            <Input
              value={reason}
              maxLength={500}
              placeholder="Family function out of town"
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
        </div>

        {p && (
          <div
            className={`rounded-md border px-3 py-2.5 text-xs ${
              p.unpaid_days > 0
                ? "border-amber-200 bg-amber-50/70 text-amber-950"
                : "border-border bg-muted/40 text-foreground"
            }`}
          >
            <p className="font-medium">This is {formatDays(p.days)} of leave.</p>
            <p className="mt-0.5 text-muted-foreground">
              You have {formatDays(p.available)} available.
              {p.unpaid_days > 0 ? (
                <>
                  {" "}
                  {formatDays(p.paid_days)} would come off your balance and{" "}
                  <span className="font-semibold text-foreground">
                    {formatDays(p.unpaid_days)} would be unpaid
                  </span>
                  .
                </>
              ) : (
                <> All of it comes off your balance.</>
              )}
            </p>
            {p.skipped_days.length > 0 && (
              <p className="mt-1 text-muted-foreground">
                {p.skipped_days.length} day
                {p.skipped_days.length === 1 ? "" : "s"} in that range{" "}
                {p.skipped_days.length === 1 ? "is" : "are"} a week off or a
                holiday, so{" "}
                {p.skipped_days.length === 1 ? "it costs" : "they cost"} nothing.
              </p>
            )}
            {p.is_backdated && (
              <p className="mt-1 text-muted-foreground">
                This is for a date that has already passed — that is fine, and
                your manager will see it flagged.
              </p>
            )}
            {p.conflict && (
              <p className="mt-1 font-medium text-destructive">{p.conflict}</p>
            )}
          </div>
        )}
        {valid && p && p.days === 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
            Every day in that range is a week off or a holiday, so there is no
            leave to apply for.
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSend}
            onClick={() => submit.mutate()}
          >
            {submit.isPending
              ? "Sending…"
              : editing
                ? "Save changes"
                : onBehalfOf
                  ? "Record it"
                  : "Send the request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdjustBalanceDialog({
  open,
  onClose,
  user,
  onSaved,
}: {
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
    if (open) {
      setDays("1");
      setReason("");
      setIsOpening(false);
    }
  }, [open, user?.id]);

  const value = Number(days);
  const validDays =
    Number.isFinite(value) && value !== 0 && Math.round(value * 2) === value * 2;

  const save = useMutation({
    mutationFn: async () =>
      (
        await leaveApi.adjust({
          user_id: user!.id,
          days: value,
          reason: reason.trim(),
          is_opening: isOpening,
        })
      ).data,
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
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Adjust {user.name}&apos;s balance</DialogTitle>
          <DialogDescription>
            Recorded as a row on their leave statement, with your name on it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <FormField
            label="Days"
            required
            error={
              days && !validDays
                ? "Leave is counted in halves — use 0.5, 1, 1.5 and so on."
                : undefined
            }
            hint="Negative takes days away."
          >
            <Input
              type="number"
              step="0.5"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </FormField>
          <FormField label="Why?" required>
            <Input
              value={reason}
              maxLength={300}
              placeholder="Carried over from before we started using this"
              onChange={(e) => setReason(e.target.value)}
            />
          </FormField>
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-muted-foreground">
            <Checkbox
              checked={isOpening}
              onCheckedChange={(c) => setIsOpening(Boolean(c))}
              className="mt-0.5"
            />
            <span>
              This is their <strong className="text-foreground">opening balance</strong> — what
              they were already carrying when this system started.
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!validDays || reason.trim().length < 3 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
