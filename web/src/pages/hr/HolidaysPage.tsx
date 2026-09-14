import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { holidaysApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import { DateInput } from "../../components/DateInput";
import {
  EmptyState, ErrorState, Field, Ledger, LedgerCell, LedgerRow, LTh, ListShell,
  MobileCard, Modal, StatCard, StatRow, TableSkeleton,
} from "../../components/ui";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatDate } from "../../lib/format";
import { todayKey } from "../../lib/hr";
import { useAuth } from "../../store/auth";
import type { Holiday } from "../../lib/types";

/*
  Holidays — the year an admin enters once and everybody reads.

  A HOLIDAY IS A PAID NON-WORKING DAY. It cannot make anybody absent, it is
  never deducted, and a leave range spanning one does not spend a leave day on
  it. Entering this list is how the attendance register stops reporting
  Republic Day as the entire agency failing to come to work.

  READING IS OPEN TO EVERY EMPLOYEE. A holiday list is not sensitive and
  everybody needs it to plan; hiding it behind a flag would mean a new joiner
  cannot find out whether the office is open on the 15th. `manage_holidays` is
  the part that matters — declaring a day off changes the attendance of the
  whole agency, retroactively.

  NOTHING IS SEEDED, deliberately: Diwali moves every year and half of any real
  Indian list is regional. On an EMPTY year the server offers the three fixed
  national holidays as one-click suggestions — a suggestion the owner accepts,
  never a row that appeared by itself.
*/

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
  "Saturday", "Sunday"];

export default function HolidaysPage() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const canManage = has("manage_holidays");

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [editing, setEditing] = useState<Holiday | null>(null);
  const [adding, setAdding] = useState(false);

  const q = useQuery({
    queryKey: ["hr", "holidays", year],
    queryFn: async () => (await holidaysApi.year(year)).data,
  });
  const d = q.data;

  const remove = useMutation({
    mutationFn: async (h: Holiday) => (await holidaysApi.remove(h.id)).data,
    // The server counts the approved leaves that span the date and says so in
    // its own sentence. Surfaced verbatim rather than replaced with a generic
    // "deleted": removing a holiday turns it back into a working day, which can
    // change somebody's attendance and what an approved leave cost.
    onSuccess: (r) => {
      toast.success(r.detail);
      qc.invalidateQueries({ queryKey: ["hr"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const copy = useMutation({
    mutationFn: async () => (await holidaysApi.copyYear(year - 1, year)).data,
    onSuccess: (r) => {
      toast.success(`Copied ${r.holidays.length} holiday${
        r.holidays.length === 1 ? "" : "s"} into ${year}. Check the dates that
        move each year.`);
      qc.invalidateQueries({ queryKey: ["hr", "holidays"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const addSuggested = useMutation({
    mutationFn: async () => {
      for (const s of d?.suggestions ?? []) {
        await holidaysApi.add({ date: s.date, name: s.name });
      }
    },
    onSuccess: () => {
      toast.success("Added. Now add the ones that matter to your office.");
      qc.invalidateQueries({ queryKey: ["hr", "holidays"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const askRemove = async (h: Holiday) => {
    const ok = await confirmDialog({
      title: `Remove ${h.name}?`,
      message: `${formatDate(h.date)} becomes a normal working day again, and
        anybody with no attendance on it will read as absent.`,
      confirmLabel: "Remove it",
      danger: true,
    });
    if (ok) remove.mutate(h);
  };

  const upcoming = useMemo(
    () => (d?.holidays ?? []).filter((h) => !h.is_past), [d?.holidays]);
  const next = upcoming[0];

  return (
    <div>
      <PageHeader
        title="Holidays"
        subtitle="The days the office is closed. A holiday is never counted
          against anybody's attendance, and a leave that spans one does not
          spend a leave day on it."
        eyebrow="Workplace HR"
        actions={canManage ? (
          <button className="btn-primary" onClick={() => setAdding(true)}>
            <Icon.Plus size={15} /> Add a holiday
          </button>
        ) : undefined}
      />

      <StatRow cols={3}>
        <StatCard label={`Declared in ${year}`}
          value={String(d?.holidays.length ?? 0)} icon="Sun" />
        <StatCard label="Still to come" value={String(upcoming.length)} />
        <StatCard label="Next one"
          value={next ? next.name : "—"}
          hint={next ? formatDate(next.date) : "nothing left this year"} />
      </StatRow>

      <div className="mt-5">
        <div className="ledger-bar">
          <button className="icon-btn" aria-label="Previous year" title="Previous year"
            onClick={() => setYear(year - 1)}>
            <Icon.ChevronLeft size={15} />
          </button>
          <span className="min-w-[4rem] text-center text-sm font-medium
            text-slate-900">{year}</span>
          <button className="icon-btn" aria-label="Next year" title="Next year"
            onClick={() => setYear(year + 1)}>
            <Icon.ChevronRight size={15} />
          </button>
          {year !== new Date().getFullYear() && (
            <button className="btn-ghost btn-sm"
              onClick={() => setYear(new Date().getFullYear())}>
              This year
            </button>
          )}
          <div className="ledger-bar-end">
            {canManage && (d?.holidays.length ?? 0) === 0 && (
              <button className="btn-secondary btn-sm"
                disabled={copy.isPending}
                onClick={() => copy.mutate()}>
                <Icon.Copy size={14} />
                {copy.isPending ? "Copying…" : `Copy ${year - 1}`}
              </button>
            )}
          </div>
        </div>

        {q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <TableSkeleton cols={4} />
        ) : (d?.holidays.length ?? 0) === 0 ? (
          <EmptyState
            title={`Nothing declared for ${year}`}
            icon={<Icon.Sun size={20} />}
            hint="Until a holiday is on this list, the attendance register
              counts that day as a working day like any other."
            action={canManage ? (
              <div className="flex flex-wrap justify-center gap-2">
                <button className="btn-primary" onClick={() => setAdding(true)}>
                  Add a holiday
                </button>
                {(d?.suggestions.length ?? 0) > 0 && (
                  <button className="btn-secondary"
                    disabled={addSuggested.isPending}
                    onClick={() => addSuggested.mutate()}>
                    {addSuggested.isPending
                      ? "Adding…"
                      : `Add the ${d!.suggestions.length} national holidays`}
                  </button>
                )}
              </div>
            ) : undefined}
          />
        ) : (
          <ListShell
            bare
            cards={(d?.holidays ?? []).map((h) => (
              <MobileCard key={h.id} to="#"
                title={h.name}
                meta={formatDate(h.date)}
                right={h.is_past
                  ? <span className="badge-neutral">Past</span>
                  : <span className="badge-in">Upcoming</span>}
                footer={h.note ?? undefined} />
            ))}
            table={
              <Ledger
                head={
                  <>
                    <LTh>Holiday</LTh>
                    <LTh>Date</LTh>
                    <LTh>Day</LTh>
                    <LTh />
                  </>
                }>
                {(d?.holidays ?? []).map((h) => (
                  <LedgerRow key={h.id}
                    className={h.is_past ? "text-slate-400" : ""}>
                    <LedgerCell title={h.name} sub={h.note ?? undefined} />
                    <td className="whitespace-nowrap text-[13px]
                      text-slate-700">
                      {formatDate(h.date)}
                    </td>
                    <td>
                      <span className="text-[13px] text-slate-700">
                        {WEEKDAYS[h.weekday]}
                      </span>
                      {/* Says so on the row rather than letting somebody add it
                          twice wondering why it had no effect. */}
                      {h.falls_on_week_off && (
                        <span className="mt-0.5 block text-xs text-slate-500">
                          already a week off — no effect
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        {canManage && (
                          <>
                            <button className="btn-ghost btn-sm"
                              onClick={() => setEditing(h)}>
                              <Icon.Edit size={13} /> Edit
                            </button>
                            <button className="icon-btn icon-btn-danger"
                              aria-label={`Remove ${h.name}`} title={`Remove ${h.name}`}
                              onClick={() => askRemove(h)}>
                              <Icon.Trash size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </LedgerRow>
                ))}
              </Ledger>
            }
          />
        )}
      </div>

      <HolidayDialog
        open={adding || !!editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        holiday={editing}
        defaultYear={year}
      />
    </div>
  );
}

/* ------------------------------------------------------------ add / edit -- */

function HolidayDialog({ open, onClose, holiday, defaultYear }: {
  open: boolean;
  onClose: () => void;
  holiday: Holiday | null;
  defaultYear: number;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    if (holiday) {
      setDate(holiday.date);
      setName(holiday.name);
      setNote(holiday.note ?? "");
    } else {
      // Default into the year being viewed, not into today — somebody setting up
      // next year's calendar in December should not have to retype the year on
      // every row.
      const today = todayKey();
      setDate(today.startsWith(String(defaultYear))
        ? today : `${defaultYear}-01-01`);
      setName("");
      setNote("");
    }
  }, [open, holiday?.id, defaultYear]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { date, name: name.trim(), note: note.trim() || null };
      if (holiday) return (await holidaysApi.update(holiday.id, body)).data;
      return (await holidaysApi.add(body)).data;
    },
    onSuccess: () => {
      toast.success(holiday ? "Holiday updated." : `${name.trim()} added.`);
      qc.invalidateQueries({ queryKey: ["hr"] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canSave = !!date && name.trim().length >= 2 && !save.isPending;

  return (
    <Modal open={open} onClose={onClose} size="sm"
      title={holiday ? "Edit holiday" : "Add a holiday"}
      subtitle="Everybody's attendance for that day becomes a holiday, including
        months that have already been through."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSave}
            onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : holiday ? "Save" : "Add it"}
          </button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Date" required>
          <DateInput value={date} onChange={setDate} />
        </Field>
        <Field label="What is it?" required>
          <input className="input" value={name} maxLength={80}
            placeholder="Diwali" autoFocus
            onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Note" hint="Optional — shown under the name.">
          <input className="input" value={note} maxLength={300}
            placeholder="Office closed, phones diverted"
            onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
