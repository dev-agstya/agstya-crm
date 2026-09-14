import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { remindersApi, usersApi } from "../../api/endpoints";
import { api, apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { DateTimeInput } from "../../components/DateInput";
import { MultiSelect } from "../../components/MultiSelect";
import { Field } from "../../components/ui";
import { toast } from "../../components/Toast";
import { isDueInFuture, todayForPicker } from "../../lib/reminderTiming";
import { useAuth } from "../../store/auth";
import type { Lead, Reminder } from "../../lib/types";

// Matches MAX_ASSIGNEES in server/app/schemas/reminder.py.
const MAX_ASSIGNEES = 20;

// Default a new reminder to 10am tomorrow (local) — the time somebody actually
// wants to be told to ring a prospect, rather than "now", which is never useful.
function defaultDue(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Add or edit a follow-up on a lead — a page, not a dialog (owner 2026-08-03).
 *
 * The people picker lists only colleagues who hold `view_leads` (owner Q4.2).
 * Assigning a lead follow-up to someone who cannot open the Leads page would
 * put a task on a screen they get a 403 from.
 */
export default function LeadReminderFormPage() {
  const { id = "", reminderId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const editing = !!reminderId;
  const backTo = `/leads/${id}`;

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [dueAt, setDueAt] = useState(defaultDue());
  const [assignees, setAssignees] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  const lead = useQuery({
    queryKey: ["lead", id],
    queryFn: async () => (await api.get<Lead>(`/api/leads/${id}`)).data,
  });

  // Only people who can actually open this page. `usersApi.list` would return
  // every employee regardless of permission, and would also need view_employees,
  // which someone working the pipeline may not have.
  const colleagues = useQuery({
    queryKey: ["users", "with-permission", "view_leads"],
    queryFn: async () =>
      (await usersApi.withPermission("view_leads")).data,
  });

  const existing = useQuery({
    queryKey: ["reminder", reminderId],
    enabled: editing,
    queryFn: async () => {
      const rows = (await remindersApi.list({
        scope: "entity", entity_type: "lead", entity_id: id, status: "open",
      })).data;
      return rows.find((r) => r.id === reminderId) ?? null;
    },
  });

  // Prefill once. Keyed on `loaded` rather than the query data so typing is
  // never overwritten by a background refetch.
  useEffect(() => {
    if (loaded) return;
    if (editing) {
      const r = existing.data as Reminder | null | undefined;
      if (r === undefined) return;
      if (r) {
        setTitle(r.title);
        setNote(r.note ?? "");
        setDueAt(toLocalInput(r.due_at));
        setAssignees(r.assignee_ids);
      }
      setLoaded(true);
    } else if (user) {
      // Default to me: an empty list means "me" on the server anyway, and
      // showing it is clearer than leaving the field looking unset.
      setAssignees([user.id]);
      setLoaded(true);
    }
  }, [loaded, editing, existing.data, user]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        title: title.trim(),
        note: note.trim() || undefined,
        due_at: new Date(dueAt).toISOString(),
        assignee_ids: assignees,
      };
      return editing
        ? (await remindersApi.update(reminderId!, body)).data
        : (await remindersApi.create({
          entity_type: "lead", entity_id: id, ...body })).data;
    },
    onSuccess: () => {
      toast.success(editing ? "Reminder updated." : "Reminder set.");
      qc.invalidateQueries({ queryKey: ["reminders"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      navigate(backTo);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const options = (colleagues.data ?? []).map((c) => ({
    value: c.id,
    label: c.id === user?.id ? `${c.full_name} (me)` : c.full_name,
    sub: c.email ?? undefined,
  }));

  // A reminder is a promise about the future — a past due date would be born
  // overdue and the bell for it has no moment left to ring in (owner
  // 2026-08-04). The API refuses it too; this is what stops anyone reaching
  // that error. An already-overdue reminder being edited keeps its stored date,
  // so fixing a typo on something due yesterday doesn't force a new date.
  const untouchedDue = editing
    && !!existing.data && toLocalInput(existing.data.due_at) === dueAt;
  const duePast = !!dueAt && !untouchedDue && !isDueInFuture(dueAt);

  const valid = title.trim().length >= 2 && assignees.length > 0 && !!dueAt
    && !duePast;
  const shared = assignees.length > 1;

  return (
    <FormPage
      backTo={backTo}
      backLabel={lead.data ? `Back to ${lead.data.name}` : "Back to lead"}
      title={editing ? "Edit reminder" : "Add a reminder"}
      subtitle={lead.data
        ? `Follow-up on ${lead.data.name}, get a notification reminder.`
          
        : undefined}
      onSubmit={() => save.mutate()}
      submitLabel={editing ? "Save changes" : "Set reminder"}
      submitting={save.isPending}
      disabled={!valid}
      loading={editing && existing.isLoading}
      // Wide (owner 2026-08-04): at the narrow width the date and time fields
      // shared one line with nothing to spare and the clock got clipped.
      wide
    >
      <div className="space-y-5">
        <Field label="What needs doing?" required>
          <input className="input" autoFocus value={title}
            placeholder="e.g. Call back about the motor quote"
            onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <Field label="When" required
          error={duePast
            ? "Pick a date and time in the future — a follow-up you set for "
              + "the past would arrive already overdue."
            : undefined}>
          <DateTimeInput value={dueAt} onChange={setDueAt}
            minDate={todayForPicker()} />
        </Field>

        <Field
          label="Who is it for"
          required
          hint={shared
            ? "Shared — whoever marks it done closes it for everyone."
            : "Add more than one person to share this follow-up. Only people "
              + "who can open the Leads page are listed."}
        >
          <MultiSelect
            options={options}
            values={assignees}
            onChange={setAssignees}
            max={MAX_ASSIGNEES}
            placeholder="Choose who this is for"
            searchPlaceholder="Search colleagues…"
            emptyHint={colleagues.isLoading
              ? "Loading…" : "No colleagues can open the Leads page yet."}
          />
        </Field>

        <Field label="Note">
          <textarea className="input" rows={3} value={note}
            placeholder="Anything the person should know before they call"
            onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </FormPage>
  );
}
