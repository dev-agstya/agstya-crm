import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Pencil, Plus, Trash2 } from "lucide-react";
import { remindersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { ErrorState } from "../../components/shared/ErrorState";
import { AvatarStack } from "../../components/ui";
import { toast } from "../../components/Toast";
import { formatDateTime } from "../../lib/format";
import { TIMING_TONE_CLASS, timingOf } from "../../lib/reminderTiming";
import type { Reminder } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";

const SNOOZE_OPTIONS = [
  { days: 1, label: "Tomorrow" },
  { days: 3, label: "In 3 days" },
  { days: 7, label: "Next week" },
  { days: 14, label: "In 2 weeks" },
];

export function LeadRemindersPanel({
  leadId,
  canEdit,
  onChanged,
}: {
  leadId: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["reminders", "lead", leadId],
    queryFn: async () =>
      (
        await remindersApi.list({
          scope: "entity",
          entity_type: "lead",
          entity_id: leadId,
          status: "open",
        })
      ).data,
  });

  const after = () => {
    qc.invalidateQueries({ queryKey: ["reminders"] });
    onChanged();
  };

  const done = useMutation({
    mutationFn: (id: string) => remindersApi.done(id),
    onSuccess: () => {
      toast.success("Marked done.");
      after();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const snooze = useMutation({
    mutationFn: ({ id, days }: { id: string; days: number }) =>
      remindersApi.snooze(id, days),
    onSuccess: () => {
      toast.success("Pushed back.");
      after();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => remindersApi.remove(id),
    onSuccess: () => {
      toast.success("Reminder removed.");
      after();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const items = list.data ?? [];

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Reminders</h2>
          {items.length > 0 && (
            <Badge
              variant="secondary"
              className="h-5 px-1.5 text-[11px] tabular-nums"
            >
              {items.length}
            </Badge>
          )}
        </div>
        {canEdit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => navigate(`/leads/${leadId}/reminders/new`)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>

      <div className="space-y-2 p-3.5">
        {list.isError ? (
          <ErrorState onRetry={() => list.refetch()} />
        ) : list.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-4 text-center text-xs text-muted-foreground">
            No reminders yet.
          </p>
        ) : (
          items.map((r) => (
            <ReminderCard
              key={r.id}
              reminder={r}
              canEdit={canEdit}
              onEdit={() => navigate(`/leads/${leadId}/reminders/${r.id}`)}
              onDone={() => done.mutate(r.id)}
              onSnooze={(days) => snooze.mutate({ id: r.id, days })}
              onRemove={() => remove.mutate(r.id)}
            />
          ))
        )}
      </div>
    </>
  );
}

function ReminderCard({
  reminder: r,
  canEdit,
  onEdit,
  onDone,
  onSnooze,
  onRemove,
}: {
  reminder: Reminder;
  canEdit: boolean;
  onEdit: () => void;
  onDone: () => void;
  onSnooze: (days: number) => void;
  onRemove: () => void;
}) {
  const timing = timingOf(r);
  const names = r.assignees.map((a) => a.name).filter(Boolean);
  const shared = names.length > 1;

  return (
    <div
      className={`rounded-md border px-3 py-2.5 ${
        r.is_overdue
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-background"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] font-medium text-foreground">
          {r.title}
        </p>
        <span
          className={`shrink-0 whitespace-nowrap text-[11px] font-medium ${
            TIMING_TONE_CLASS[timing.tone]
          }`}
        >
          {timing.label}
        </span>
      </div>

      <p
        className="mt-0.5 text-[11px] text-muted-foreground"
        title={formatDateTime(r.due_at)}
      >
        {formatDateTime(r.due_at)}
      </p>

      {names.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <AvatarStack names={names} />
          <span className="truncate text-[11px] text-muted-foreground">
            {shared ? `${names.length} people` : names[0]}
          </span>
        </div>
      )}

      {r.note && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {r.note}
        </p>
      )}

      {canEdit && (
        <div className="mt-2 flex items-center gap-1 border-t border-border/70 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
            onClick={onDone}
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            {shared ? "Done for all" : "Done"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
              >
                <Clock className="mr-1 h-3.5 w-3.5" /> Snooze
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-36">
              {SNOOZE_OPTIONS.map((o) => (
                <DropdownMenuItem
                  key={o.days}
                  className="text-xs"
                  onClick={() => onSnooze(o.days)}
                >
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onEdit}
            aria-label="Edit reminder"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onRemove}
            aria-label="Remove reminder"
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
