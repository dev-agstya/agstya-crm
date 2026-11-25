import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { servicesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { FormField, FormSection } from "../../components/shared/FormSection";
import { CardGridSkeleton } from "../../components/shared/LoadingSkeleton";
import { toast } from "../../components/Toast";
import type { HrSettings } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const DAYS = [
  { value: 0, label: "Mon" },
  { value: 1, label: "Tue" },
  { value: 2, label: "Wed" },
  { value: 3, label: "Thu" },
  { value: 4, label: "Fri" },
  { value: 5, label: "Sat" },
  { value: 6, label: "Sun" },
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function AttendanceSettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["services"],
    queryFn: async () => (await servicesApi.get()).data,
  });
  const stored = settings.data?.hr;

  const [form, setForm] = useState<HrSettings | null>(null);
  const [tab, setTab] = useState<string>("shift");
  useEffect(() => {
    if (stored && !form) setForm({ ...stored });
  }, [stored]);

  const save = useMutation({
    mutationFn: (patch: Partial<HrSettings>) =>
      servicesApi.update({ hr: patch }),
    onSuccess: () => {
      toast.success("Saved. It applies to every month, including past ones.");
      qc.invalidateQueries({ queryKey: ["services"] });
      qc.invalidateQueries({ queryKey: ["hr"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const set = <K extends keyof HrSettings>(key: K, value: HrSettings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const num =
    (key: keyof HrSettings) => (e: { target: { value: string } }) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v)) set(key, v as never);
    };

  const toggleDay = (day: number) => {
    if (!form) return;
    const held = new Set(form.week_off_days);
    if (held.has(day)) held.delete(day);
    else held.add(day);
    if (held.size === 7) return;
    set("week_off_days", [...held].sort((a, b) => a - b));
  };

  const badThresholds =
    !!form && form.half_day_minutes > form.full_day_minutes;

  return (
    <RecordPage
      backTo="/settings"
      backLabel="Back to settings"
      title="Attendance & leave"
      subtitle="The shift, the thresholds and the leave policy. Set once, for the whole agency."
    >
      {settings.isLoading || !form ? (
        <CardGridSkeleton count={3} />
      ) : (
        <div className="space-y-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-9 flex-wrap">
              <TabsTrigger value="shift" className="text-xs">
                Shift &amp; Hours
              </TabsTrigger>
              <TabsTrigger value="location" className="text-xs">
                Location Tracking
              </TabsTrigger>
              <TabsTrigger value="payroll" className="text-xs">
                Payroll &amp; Penalties
              </TabsTrigger>
              <TabsTrigger value="leave" className="text-xs">
                Leave Policy
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900">
            Changing anything here re-reads <strong>every</strong> month,
            including ones that have already been through.
          </div>

          {tab === "shift" && (
            <div className="space-y-4">
              <FormSection
                title="The working week"
                description="Pick the days the office is closed. Everything else is a working day."
              >
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((d) => {
                    const off = form.week_off_days.includes(d.value);
                    return (
                      <Button
                        key={d.value}
                        type="button"
                        size="sm"
                        variant={off ? "default" : "outline"}
                        aria-pressed={off}
                        onClick={() => toggleDay(d.value)}
                      >
                        {d.label}
                      </Button>
                    );
                  })}
                </div>
              </FormSection>

              <FormSection
                title="The shift"
                description="Leave per-employee shift blank on their record to follow this default."
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <FormField label="Starts at" required>
                    <Input
                      type="time"
                      value={form.shift_start}
                      onChange={(e) => set("shift_start", e.target.value)}
                    />
                  </FormField>
                  <FormField label="Ends at" required>
                    <Input
                      type="time"
                      value={form.shift_end}
                      onChange={(e) => set("shift_end", e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="Grace before a late mark"
                    hint="Minutes. Inside this is on time."
                  >
                    <Input
                      type="number"
                      min={0}
                      max={240}
                      value={form.late_grace_minutes}
                      onChange={num("late_grace_minutes")}
                    />
                  </FormField>
                  <FormField
                    label="Grace before an early out"
                    hint="Minutes. Flagged only."
                  >
                    <Input
                      type="number"
                      min={0}
                      max={240}
                      value={form.early_out_grace_minutes}
                      onChange={num("early_out_grace_minutes")}
                    />
                  </FormField>
                </div>
              </FormSection>

              <FormSection title="What a day has to be worth">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <FormField
                    label="A full day is"
                    required
                    hint="Minutes of WORK (breaks subtracted)."
                    error={
                      badThresholds
                        ? "A half day cannot be longer than a full day."
                        : undefined
                    }
                  >
                    <Input
                      type="number"
                      min={30}
                      max={960}
                      value={form.full_day_minutes}
                      onChange={num("full_day_minutes")}
                    />
                  </FormField>
                  <FormField
                    label="A half day is"
                    required
                    hint="Below this, the day does not count."
                  >
                    <Input
                      type="number"
                      min={15}
                      max={960}
                      value={form.half_day_minutes}
                      onChange={num("half_day_minutes")}
                    />
                  </FormField>
                  <FormField
                    label="Expected break"
                    hint="Minutes subtracted from working total."
                  >
                    <Input
                      type="number"
                      min={0}
                      max={480}
                      value={form.max_break_minutes}
                      onChange={num("max_break_minutes")}
                    />
                  </FormField>
                </div>
              </FormSection>
            </div>
          )}

          {tab === "location" && (
            <FormSection
              title="Where the punch came from"
              description="Clocking in inside the circle is recorded as present. Anywhere else is recorded as work from home — a full paid day either way."
            >
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-border px-3.5 py-2.5">
                    <div>
                      <p className="text-xs font-medium text-foreground">
                        Check location on clock-in
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {form.geofence_enabled
                          ? "On — clock-ins are placed against the office"
                          : "Off — every clock-in is recorded the same way"}
                      </p>
                    </div>
                    <Switch
                      checked={form.geofence_enabled}
                      onCheckedChange={(v) => set("geofence_enabled", v)}
                    />
                  </label>
                </div>

                <FormField
                  label="What to call this place"
                  required
                  hint="Shown to staff on the clock-in tile."
                >
                  <Input
                    maxLength={80}
                    value={form.office_label}
                    onChange={(e) => set("office_label", e.target.value)}
                  />
                </FormField>
                <FormField
                  label="Allowed distance"
                  required
                  hint="Metres from the point below (e.g. 150 m)."
                >
                  <Input
                    type="number"
                    min={20}
                    max={5000}
                    step={10}
                    value={form.office_radius_m}
                    onChange={num("office_radius_m")}
                  />
                </FormField>

                <FormField label="Latitude" required>
                  <Input
                    type="number"
                    className="tabular-nums"
                    step="0.000001"
                    min={-90}
                    max={90}
                    value={form.office_lat}
                    onChange={num("office_lat")}
                  />
                </FormField>
                <FormField label="Longitude" required>
                  <Input
                    type="number"
                    className="tabular-nums"
                    step="0.000001"
                    min={-180}
                    max={180}
                    value={form.office_lng}
                    onChange={num("office_lng")}
                  />
                </FormField>

                <div className="sm:col-span-2">
                  <Button asChild variant="outline" size="sm" className="h-8">
                    <a
                      target="_blank"
                      rel="noreferrer"
                      href={`https://www.google.com/maps/search/?api=1&query=${form.office_lat},${form.office_lng}`}
                    >
                      <MapPin className="mr-1.5 h-3.5 w-3.5" /> Check this point
                      on a map
                    </a>
                  </Button>
                </div>

                <FormField
                  label="Ignore readings vaguer than"
                  hint="Metres. Vague readings are recorded as unchecked."
                >
                  <Input
                    type="number"
                    min={0}
                    max={10000}
                    step={10}
                    value={form.max_accuracy_m}
                    onChange={num("max_accuracy_m")}
                  />
                </FormField>
                <FormField
                  label="When the location is unknown"
                  hint="Applies when browser refuses or reading is vague."
                >
                  <Select
                    value={form.unknown_counts_as_office ? "office" : "remote"}
                    onValueChange={(v) =>
                      set("unknown_counts_as_office", v === "office")
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="remote">
                        Record as work from home
                      </SelectItem>
                      <SelectItem value="office">Record as present</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>

                <div className="sm:col-span-2">
                  <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-border px-3.5 py-2.5">
                    <div>
                      <p className="text-xs font-medium text-foreground">
                        Refuse a clock-in with no location
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {form.require_location
                          ? "Clock-in is blocked without a location"
                          : "Clock-in always works; the day is flagged instead (recommended)"}
                      </p>
                    </div>
                    <Switch
                      checked={form.require_location}
                      onCheckedChange={(v) => set("require_location", v)}
                    />
                  </label>
                </div>
              </div>
            </FormSection>
          )}

          {tab === "payroll" && (
            <div className="space-y-4">
              <FormSection title="Late marks">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField
                    label="Late marks per penalty"
                    hint="In a calendar month."
                  >
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={form.late_marks_per_penalty}
                      onChange={num("late_marks_per_penalty")}
                    />
                  </FormField>
                  <FormField
                    label="Each penalty costs"
                    hint="DAYS off the payable count — not money."
                  >
                    <Input
                      type="number"
                      step="0.5"
                      min={0}
                      max={5}
                      value={form.late_penalty_days}
                      onChange={num("late_penalty_days")}
                    />
                  </FormField>
                </div>
              </FormSection>

              <FormSection
                title="When pay locks"
                description="Payslips are generated as drafts on the 1st. This is how long the register stays open for corrections before locking."
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField
                    label="Correction window"
                    hint="WORKING days after month ends (0 = manual finalise)."
                  >
                    <Input
                      type="number"
                      min={0}
                      max={15}
                      value={form.payroll_auto_finalise_days}
                      onChange={num("payroll_auto_finalise_days")}
                    />
                  </FormField>
                  <div className="self-end pb-1 text-xs text-muted-foreground">
                    {form.payroll_auto_finalise_days > 0 ? (
                      <>
                        A month ending on a Sunday locks on the{" "}
                        <strong className="text-foreground">
                          {form.payroll_auto_finalise_days === 1
                            ? "second"
                            : form.payroll_auto_finalise_days === 2
                              ? "third"
                              : `${form.payroll_auto_finalise_days + 1}th`}
                        </strong>{" "}
                        working day of the new month. Unresolved registers stay
                        drafts.
                      </>
                    ) : (
                      <>
                        Automatic locking is{" "}
                        <strong className="text-foreground">off</strong>.
                        Payslips wait until somebody presses Finalise.
                      </>
                    )}
                  </div>
                </div>
              </FormSection>
            </div>
          )}

          {tab === "leave" && (
            <FormSection title="Leave">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <FormField
                  label="Days earned per month"
                  required
                  hint="Credited on the 1st."
                >
                  <Input
                    type="number"
                    step="0.5"
                    min={0}
                    max={10}
                    value={form.monthly_leave_accrual}
                    onChange={num("monthly_leave_accrual")}
                  />
                </FormField>
                <FormField
                  label="Most anybody can hold"
                  hint="Days cap inside the leave year."
                >
                  <Input
                    type="number"
                    step="0.5"
                    min={0}
                    max={120}
                    value={form.max_leave_balance}
                    onChange={num("max_leave_balance")}
                  />
                </FormField>
                <FormField
                  label="The leave year starts in"
                  hint="April matches the Indian financial year."
                >
                  <Select
                    value={String(form.leave_year_start_month)}
                    onValueChange={(v) =>
                      set("leave_year_start_month", Number(v))
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m, i) => (
                        <SelectItem key={m} value={String(i + 1)}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
            </FormSection>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setForm(stored ? { ...stored } : null)}
            >
              Undo changes
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={save.isPending || badThresholds}
              onClick={() => save.mutate(form)}
            >
              {save.isPending ? "Saving…" : "Save the policy"}
            </Button>
          </div>
        </div>
      )}
    </RecordPage>
  );
}
