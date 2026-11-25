import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { remindersApi, usersApi } from "../../api/endpoints";
import { api, apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { DateTimeInput } from "../../components/DateInput";
import { MultiSelect } from "../../components/MultiSelect";
import { toast } from "../../components/Toast";
import { isDueInFuture, todayForPicker } from "../../lib/reminderTiming";
import { useAuth } from "../../store/auth";
import type { Lead, Reminder } from "../../lib/types";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const MAX_ASSIGNEES = 20;

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

  const colleagues = useQuery({
    queryKey: ["users", "with-permission", "view_leads"],
    queryFn: async () => (await usersApi.withPermission("view_leads")).data,
  });

  const existing = useQuery({
    queryKey: ["reminder", reminderId],
    enabled: editing,
    queryFn: async () => {
      const rows = (
        await remindersApi.list({
          scope: "entity",
          entity_type: "lead",
          entity_id: id,
          status: "open",
        })
      ).data;
      return rows.find((r) => r.id === reminderId) ?? null;
    },
  });

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
        : (
            await remindersApi.create({
              entity_type: "lead",
              entity_id: id,
              ...body,
            })
          ).data;
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

  const untouchedDue =
    editing && !!existing.data && toLocalInput(existing.data.due_at) === dueAt;
  const duePast = !!dueAt && !untouchedDue && !isDueInFuture(dueAt);

  const valid =
    title.trim().length >= 2 && assignees.length > 0 && !!dueAt && !duePast;
  const shared = assignees.length > 1;

  return (
    <FormPage
      backTo={backTo}
      backLabel={lead.data ? `Back to ${lead.data.name}` : "Back to lead"}
      title={editing ? "Edit reminder" : "Add a reminder"}
      subtitle={
        lead.data
          ? `Follow-up on ${lead.data.name}, get a notification reminder.`
          : undefined
      }
      onSubmit={() => save.mutate()}
      submitLabel={editing ? "Save changes" : "Set reminder"}
      submitting={save.isPending}
      disabled={!valid}
      loading={editing && existing.isLoading}
      wide
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <FormField label="What needs doing?" required>
          <Input
            autoFocus
            value={title}
            placeholder="e.g. Call back about the motor quote"
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>

        <FormField
          label="When"
          required
          error={
            duePast
              ? "Pick a date and time in the future — a past follow-up would arrive already overdue."
              : undefined
          }
        >
          <DateTimeInput
            value={dueAt}
            onChange={setDueAt}
            minDate={todayForPicker()}
          />
        </FormField>

        <FormField
          label="Who is it for"
          required
          className="sm:col-span-2"
          hint={
            shared
              ? "Shared — whoever marks it done closes it for everyone."
              : "Add more than one person to share this follow-up. Only people who can open Leads are listed."
          }
        >
          <MultiSelect
            options={options}
            values={assignees}
            onChange={setAssignees}
            max={MAX_ASSIGNEES}
            placeholder="Choose who this is for"
            searchPlaceholder="Search colleagues…"
            emptyHint={
              colleagues.isLoading
                ? "Loading…"
                : "No colleagues can open the Leads page yet."
            }
          />
        </FormField>

        <FormField label="Note" className="sm:col-span-2">
          <Textarea
            rows={3}
            value={note}
            placeholder="Anything the person should know before they call"
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
      </div>
    </FormPage>
  );
}
