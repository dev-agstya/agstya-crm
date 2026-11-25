import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit,
  Plus,
  Sun,
  Trash2,
} from "lucide-react";
import { holidaysApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { DateInput } from "../../components/DateInput";
import { DataTable, Column } from "../../components/shared/DataTable";
import { FilterToolbar } from "../../components/shared/FilterToolbar";
import { FormField } from "../../components/shared/FormSection";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatDate } from "../../lib/format";
import { todayKey } from "../../lib/hr";
import { useAuth } from "../../store/auth";
import type { Holiday } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

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
    onSuccess: (r) => {
      toast.success(r.detail);
      qc.invalidateQueries({ queryKey: ["hr"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const copy = useMutation({
    mutationFn: async () => (await holidaysApi.copyYear(year - 1, year)).data,
    onSuccess: (r) => {
      toast.success(
        `Copied ${r.holidays.length} holiday${
          r.holidays.length === 1 ? "" : "s"
        } into ${year}.`
      );
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
      toast.success("Added national holidays.");
      qc.invalidateQueries({ queryKey: ["hr", "holidays"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const askRemove = async (h: Holiday) => {
    const ok = await confirmDialog({
      title: `Remove ${h.name}?`,
      message: `${formatDate(
        h.date
      )} becomes a normal working day again, and anybody with no attendance on it will read as absent.`,
      confirmLabel: "Remove it",
      danger: true,
    });
    if (ok) remove.mutate(h);
  };

  const upcoming = useMemo(
    () => (d?.holidays ?? []).filter((h) => !h.is_past),
    [d?.holidays]
  );
  const next = upcoming[0];

  const columns: Column<Holiday>[] = [
    {
      key: "name",
      header: "Holiday",
      cell: (h) => (
        <div className={h.is_past ? "text-muted-foreground" : ""}>
          <div className="flex items-center gap-2 font-medium">
            <span>{h.name}</span>
            {h.is_past ? (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                Past
              </Badge>
            ) : (
              <Badge className="h-4 bg-emerald-600 px-1.5 text-[10px] text-white hover:bg-emerald-600">
                Upcoming
              </Badge>
            )}
          </div>
          {h.note && <p className="text-xs text-muted-foreground">{h.note}</p>}
        </div>
      ),
    },
    {
      key: "date",
      header: "Date",
      cell: (h) => (
        <span className="whitespace-nowrap tabular-nums text-foreground">
          {formatDate(h.date)}
        </span>
      ),
    },
    {
      key: "day",
      header: "Day",
      cell: (h) => (
        <div>
          <span>{WEEKDAYS[h.weekday]}</span>
          {h.falls_on_week_off && (
            <span className="ml-2 text-xs text-muted-foreground">
              (week off)
            </span>
          )}
        </div>
      ),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "Actions",
            align: "right" as const,
            mobileLabel: false as const,
            cell: (h: Holiday) => (
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setEditing(h)}
                >
                  <Edit className="mr-1 h-3 w-3" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  aria-label={`Remove ${h.name}`}
                  onClick={() => askRemove(h)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Holidays"
        subtitle="Paid non-working days"
        info="A holiday is never counted against anybody's attendance, and a leave spanning one does not spend a leave day on it."
        actions={
          canManage ? (
            <Button size="sm" className="h-8" onClick={() => setAdding(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add holiday
            </Button>
          ) : undefined
        }
      />

      <FilterToolbar
        right={
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>
              Declared:{" "}
              <strong className="text-foreground tabular-nums">
                {d?.holidays.length ?? 0}
              </strong>
            </span>
            <span>·</span>
            <span>
              Upcoming:{" "}
              <strong className="text-foreground tabular-nums">
                {upcoming.length}
              </strong>
            </span>
            {next && (
              <>
                <span>·</span>
                <span>
                  Next:{" "}
                  <strong className="text-foreground">{next.name}</strong> (
                  {formatDate(next.date)})
                </span>
              </>
            )}
          </div>
        }
      >
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 bg-card"
            aria-label="Previous year"
            onClick={() => setYear(year - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[3.5rem] text-center text-sm font-semibold tabular-nums">
            {year}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 bg-card"
            aria-label="Next year"
            onClick={() => setYear(year + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {year !== new Date().getFullYear() && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => setYear(new Date().getFullYear())}
            >
              This year
            </Button>
          )}
          {canManage && (d?.holidays.length ?? 0) === 0 && (
            <Button
              variant="outline"
              size="sm"
              className="ml-2 h-8 text-xs"
              disabled={copy.isPending}
              onClick={() => copy.mutate()}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              {copy.isPending ? "Copying..." : `Copy ${year - 1}`}
            </Button>
          )}
        </div>
      </FilterToolbar>

      <DataTable
        data={d?.holidays ?? []}
        columns={columns}
        keyField={(h) => h.id}
        loading={q.isLoading}
        error={q.isError ? "Could not load holidays." : null}
        onRetry={() => q.refetch()}
        emptyTitle={`No holidays declared for ${year}`}
        emptyDescription="Add office holidays so employees aren't marked absent."
        emptyAction={
          canManage ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add holiday
              </Button>
              {(d?.suggestions.length ?? 0) > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={addSuggested.isPending}
                  onClick={() => addSuggested.mutate()}
                >
                  <Sun className="mr-1 h-3.5 w-3.5" />
                  {addSuggested.isPending
                    ? "Adding..."
                    : `Add ${d!.suggestions.length} national holidays`}
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      <HolidayDialog
        open={adding || !!editing}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        holiday={editing}
        defaultYear={year}
      />
    </div>
  );
}

function HolidayDialog({
  open,
  onClose,
  holiday,
  defaultYear,
}: {
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
      const today = todayKey();
      setDate(
        today.startsWith(String(defaultYear)) ? today : `${defaultYear}-01-01`
      );
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
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {holiday ? "Edit holiday" : "Add a holiday"}
          </DialogTitle>
          <DialogDescription>
            Attendance on this date becomes a paid holiday for all employees.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <FormField label="Date" required>
            <DateInput value={date} onChange={setDate} />
          </FormField>
          <FormField label="Holiday name" htmlFor="hol-name" required>
            <Input
              id="hol-name"
              value={name}
              maxLength={80}
              placeholder="e.g. Diwali"
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField label="Note" htmlFor="hol-note" hint="Optional">
            <Input
              id="hol-note"
              value={note}
              maxLength={300}
              placeholder="Office closed"
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving..." : holiday ? "Save" : "Add holiday"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
