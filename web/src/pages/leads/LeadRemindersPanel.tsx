import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { remindersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Icon } from "../../components/Icon";
import { Menu, MenuItem } from "../../components/Menu";
import { ErrorState, AvatarStack, Skeleton } from "../../components/ui";
import { toast } from "../../components/Toast";
import { formatDateTime } from "../../lib/format";
import { TIMING_TONE_CLASS, timingOf } from "../../lib/reminderTiming";
import type { Reminder } from "../../lib/types";

const SNOOZE_OPTIONS = [
  { days: 1, label: "Tomorrow" },
  { days: 3, label: "In 3 days" },
  { days: 7, label: "Next week" },
  { days: 14, label: "In 2 weeks" },
];

/**
 * The reminders on one lead, inside the lead's page.
 *
 * Adding and editing are their own PAGES (owner 2026-08-03), not a dialog on
 * top of a page — the form has a people picker and a date-time field, which is
 * more than belongs in a popover. This panel is the list plus the quick actions
 * that need no form at all: done, snooze, remove.
 *
 * A reminder is SHARED: everyone named gets the bell and the 8am digest, and
 * the first to mark it done closes it for all of them. The button says so.
 */
export function LeadRemindersPanel({ leadId, canEdit, onChanged }: {
  leadId: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["reminders", "lead", leadId],
    queryFn: async () => (await remindersApi.list({
      scope: "entity", entity_type: "lead", entity_id: leadId, status: "open",
    })).data,
  });

  const after = () => {
    qc.invalidateQueries({ queryKey: ["reminders"] });
    onChanged();
  };

  const done = useMutation({
    mutationFn: (id: string) => remindersApi.done(id),
    onSuccess: () => { toast.success("Marked done."); after(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const snooze = useMutation({
    mutationFn: ({ id, days }: { id: string; days: number }) =>
      remindersApi.snooze(id, days),
    onSuccess: () => { toast.success("Pushed back."); after(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => remindersApi.remove(id),
    onSuccess: () => { toast.success("Reminder removed."); after(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const items = list.data ?? [];

  return (
    <>
      <div className="card-head">
        <h2 className="card-title">
          Reminders
          {items.length > 0 && (
            <span className="chip ml-2 tabular-nums">{items.length}</span>
          )}
        </h2>
        {canEdit && (
          <button className="btn-secondary btn-sm"
            onClick={() => navigate(`/leads/${leadId}/reminders/new`)}>
            <Icon.Plus size={14} /> Add
          </button>
        )}
      </div>

      <div className="space-y-2 px-5 py-4">
        {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        ) : items.length === 0 ? (
          // No second "Set a follow-up" button here (owner 2026-08-04): Add is
          // already in the card head, two paces away, and two buttons that do
          // the same thing on the same card just read as a mistake.
          <p className="rounded-control border border-dashed border-line
            px-4 py-5 text-center text-sm text-slate-500">
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
  reminder: r, canEdit, onEdit, onDone, onSnooze, onRemove,
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
    <div className={`rounded-control border px-3.5 py-3 ${
      r.is_overdue ? "border-money-out/25 bg-money-out/10" : "border-line"}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm font-medium text-slate-900">
          {r.title}</p>
        <span className={`shrink-0 whitespace-nowrap text-xs ${
          TIMING_TONE_CLASS[timing.tone]}`}>
          {timing.label}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-500" title={formatDateTime(r.due_at)}>
        {formatDateTime(r.due_at)}
      </p>

      {names.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5">
          <AvatarStack names={names} />
          <span className="truncate text-xs text-slate-500">
            {shared ? `${names.length} people` : names[0]}
          </span>
        </div>
      )}

      {r.note && (
        <p className="mt-2 text-xs leading-relaxed text-slate-600">{r.note}</p>
      )}

      {canEdit && (
        <div className="mt-2.5 flex items-center gap-1 border-t border-line/70
          pt-2.5">
          <button className="btn-ghost btn-sm text-money-in hover:bg-money-in/10
            hover:text-money-in" onClick={onDone}>
            <Icon.Check size={14} />
            {/* A shared reminder closing for everyone is the whole contract —
                without saying so, people assume they are closing their own copy
                and the task quietly dies for the rest of the desk. */}
            {shared ? "Done for all" : "Done"}
          </button>
          <Menu variant="ghost" width="w-40" align="left"
            label={<span className="flex items-center gap-1">
              <Icon.Clock size={14} /> Snooze
            </span>}>
            {(close) => SNOOZE_OPTIONS.map((o) => (
              <MenuItem key={o.days}
                onClick={() => { onSnooze(o.days); close(); }}>
                {o.label}
              </MenuItem>
            ))}
          </Menu>
          <button className="btn-ghost btn-sm" onClick={onEdit}
            aria-label="Edit reminder" title="Edit">
            <Icon.Edit size={14} />
          </button>
          <button className="btn-ghost btn-sm ml-auto text-slate-500
            hover:bg-money-out/10 hover:text-money-out" onClick={onRemove}
            aria-label="Remove reminder" title="Remove">
            <Icon.Trash size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
