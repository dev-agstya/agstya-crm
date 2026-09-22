import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { servicesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { Field, PageLoader, Section, Tabs, ToggleField } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { toast } from "../../components/Toast";
import type { HrSettings } from "../../lib/types";

/*
  Attendance & leave policy — the set-once screen (owner H6).

  Owner-only, and reached from Settings rather than the sidebar, exactly like
  the partner portal's settings: a screen you open twice a year does not earn a
  nav entry, but it must not be reachable by typing a URL either.

  EVERY VALUE HERE APPLIES RETROACTIVELY, because attendance statuses are
  DERIVED rather than stored (see the server's models/attendance). Lowering the
  full-day threshold re-reads every month at once. That is the right behaviour —
  a policy change should not leave last month computed under the old rule and
  this month under the new one — but it is surprising enough to say out loud on
  the page, which is what the note at the top does.

  ONE EXCEPTION, ADDED 2026-09-06: the correction window at the bottom is NOT
  retroactive either, in the sense that matters — it decides when a FUTURE
  month locks, and a month already finalised stays finalised whatever this says.

  NOTHING HERE IS MONEY, and that survived payroll coming back on 2026-08-24.
  Both money-adjacent values are DAY COUNTS for `services/payroll` to read:
  `late_penalty_days` is days off the payable figure, and the correction window
  is how long the register stays open before pay locks. Rupees live on the
  payslip screens.
*/

// Python's weekday(), which is what the server stores. Monday-first, because
// the working week here is Monday to Saturday and a list starting on Sunday
// puts the one day off in the middle.
const DAYS = [
  { value: 0, label: "Mon" }, { value: 1, label: "Tue" },
  { value: 2, label: "Wed" }, { value: 3, label: "Thu" },
  { value: 4, label: "Fri" }, { value: 5, label: "Sat" },
  { value: 6, label: "Sun" },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

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

  const num = (key: keyof HrSettings) => (e: { target: { value: string } }) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) set(key, v as never);
  };

  const toggleDay = (day: number) => {
    if (!form) return;
    const held = new Set(form.week_off_days);
    if (held.has(day)) held.delete(day); else held.add(day);
    // The server refuses a seven-day week off; the button follows so nobody
    // presses their way into a 422.
    if (held.size === 7) return;
    set("week_off_days", [...held].sort((a, b) => a - b));
  };

  // The one combination the server refuses outright, checked here so the
  // message arrives while the field is still under the cursor.
  const badThresholds = !!form && form.half_day_minutes > form.full_day_minutes;

  return (
    <RecordPage
      backTo="/settings"
      backLabel="Back to settings"
      title="Attendance & leave"
      subtitle="The shift, the thresholds and the leave policy. Set once, for
        the whole agency."
    >
      {settings.isLoading || !form ? <PageLoader /> : (
        <div className="max-w-2xl space-y-6">

          <Tabs
            items={[
              { value: 'shift', label: 'Shift & Hours' },
              { value: 'location', label: 'Location Tracking' },
              { value: 'payroll', label: 'Payroll & Penalties' },
              { value: 'leave', label: 'Leave Policy' }
            ]}
            value={tab}
            onChange={setTab}
          />
          <div className="note-due">
            Changing anything here re-reads <b>every</b> month, including ones
            that have already been through. That is deliberate — one policy, one
            answer — but a month somebody has already worked pay out from may
            change.
          </div>

          {tab === "shift" && (<>
          {/* ------------------------------------------------- the week -- */}
          <div className="card card-body">
            <Section title="The working week">
              <p className="mb-3 text-sm text-slate-500">
                Pick the days the office is <b>closed</b>. Everything else is a
                working day, and a working day with no attendance on it reads as
                absent.
              </p>
              <div className="flex flex-wrap gap-2">
                {DAYS.map((d) => {
                  const off = form.week_off_days.includes(d.value);
                  return (
                    <button key={d.value} type="button"
                      aria-pressed={off}
                      onClick={() => toggleDay(d.value)}
                      className={`btn ${off ? "btn-primary" : "btn-secondary"}`}>
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </Section>
          </div>

          {/* ------------------------------------------------- the shift -- */}
          <div className="card card-body">
            <Section title="The shift">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Starts at" required>
                  <input type="time" className="input" value={form.shift_start}
                    onChange={(e) => set("shift_start", e.target.value)} />
                </Field>
                <Field label="Ends at" required>
                  <input type="time" className="input" value={form.shift_end}
                    onChange={(e) => set("shift_end", e.target.value)} />
                </Field>
                <Field label="Grace before a late mark"
                  hint="Minutes. Arriving inside this is on time.">
                  <input type="number" className="input" min={0} max={240}
                    value={form.late_grace_minutes}
                    onChange={num("late_grace_minutes")} />
                </Field>
                <Field label="Grace before an early out"
                  hint="Minutes. Flagged only — it never costs anything on its
                    own.">
                  <input type="number" className="input" min={0} max={240}
                    value={form.early_out_grace_minutes}
                    onChange={num("early_out_grace_minutes")} />
                </Field>
              </div>
              <p className="hint mt-3">
                One person can be given their own shift on their employee record
                — leave it blank there and they follow this.
              </p>
            </Section>
          </div>

          {/* ------------------------------------------ what a day is worth -- */}
          <div className="card card-body">
            <Section title="What a day has to be worth">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="A full day is" required
                  hint="Minutes of WORK — breaks are already subtracted."
                  error={badThresholds
                    ? "A half day cannot be longer than a full day."
                    : undefined}>
                  <input type="number" className="input" min={30} max={960}
                    value={form.full_day_minutes}
                    onChange={num("full_day_minutes")} />
                </Field>
                <Field label="A half day is" required
                  hint="Below this, the day does not count at all.">
                  <input type="number" className="input" min={15} max={960}
                    value={form.half_day_minutes}
                    onChange={num("half_day_minutes")} />
                </Field>
                <Field label="Expected break" className="sm:col-span-2"
                  hint="Minutes. Break time comes off the working total; a long
                    lunch turns the day into a half day by itself, which is
                    consequence enough — there is no separate penalty.">
                  <input type="number" className="input" min={0} max={480}
                    value={form.max_break_minutes}
                    onChange={num("max_break_minutes")} />
                </Field>
              </div>
            </Section>
          </div>

          </>)}
          {tab === "payroll" && (<>
          {/* ------------------------------------------------ late marks -- */}
          <div className="card card-body">
            <Section title="Late marks">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Late marks per penalty"
                  hint="In a calendar month.">
                  <input type="number" className="input" min={1} max={31}
                    value={form.late_marks_per_penalty}
                    onChange={num("late_marks_per_penalty")} />
                </Field>
                <Field label="Each penalty costs"
                  hint="DAYS off the payable count — not money. Set 0 to make a
                    late mark a note and nothing more.">
                  <input type="number" className="input" step="0.5" min={0}
                    max={5} value={form.late_penalty_days}
                    onChange={num("late_penalty_days")} />
                </Field>
              </div>
            </Section>
          </div>

          </>)}
          {tab === "location" && (<>
          {/* ------------------------------------------------- location -- */}
          {/*
            WHERE THE PUNCH CAME FROM (owner 2026-08-21).

            Unlike everything else on this page, this does NOT apply
            retroactively — `work_location` is stamped onto a day when somebody
            clocks in, so switching it on changes what FUTURE punches mean and
            leaves history exactly as it was. That is the only safe reading: a
            switch that retroactively marked three months of office days as
            work-from-home would be unrecoverable.
          */}
          <div className="card card-body">
            <Section title="Where the punch came from">
              <p className="-mt-1 mb-4 text-sm text-slate-500">
                Clocking in inside the circle is recorded as present. Anywhere
                else is recorded as work from home — a full paid day either way.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Check the location on clock-in"
                  className="sm:col-span-2"
                  hint="Unlike the rest of this page, this only affects days
                    from now on — a day is stamped with where it was worked at
                    the moment somebody clocks in.">
                  <ToggleField
                    checked={form.geofence_enabled}
                    onChange={(v) => set("geofence_enabled", v)}
                    label={form.geofence_enabled
                      ? "On — clock-ins are placed against the office"
                      : "Off — every clock-in is recorded the same way"} />
                </Field>

                <Field label="What to call this place" required
                  hint="Shown to staff on the clock-in tile.">
                  <input className="input" maxLength={80}
                    value={form.office_label}
                    onChange={(e) => set("office_label", e.target.value)} />
                </Field>
                <Field label="Allowed distance" required
                  hint="Metres from the point below. 150 m covers a building and
                    its car park.">
                  <input type="number" className="input" min={20} max={5000}
                    step={10} value={form.office_radius_m}
                    onChange={num("office_radius_m")} />
                </Field>

                <Field label="Latitude" required>
                  <input type="number" className="input tabular-nums"
                    step="0.000001" min={-90} max={90} value={form.office_lat}
                    onChange={num("office_lat")} />
                </Field>
                <Field label="Longitude" required>
                  <input type="number" className="input tabular-nums"
                    step="0.000001" min={-180} max={180} value={form.office_lng}
                    onChange={num("office_lng")} />
                </Field>

                {/*
                  CHECK THE PIN BEFORE TRUSTING IT. A centre that is wrong by a
                  few hundred metres marks the entire office work-from-home and
                  nothing on any screen would explain why — so the one thing
                  this page must offer is a way to LOOK at the point.
                */}
                <div className="sm:col-span-2">
                  <a className="btn-secondary" target="_blank"
                    rel="noreferrer"
                    href={`https://www.google.com/maps/search/?api=1&query=${
                      form.office_lat},${form.office_lng}`}>
                    <Icon.MapPin size={15} /> Check this point on a map
                  </a>
                  <p className="mt-2 text-xs text-slate-500">
                    Opens the exact pin. Confirm it is the office before
                    switching the check on.
                  </p>
                </div>

                <Field label="Ignore readings vaguer than"
                  hint="Metres. A phone that only knows where it is to within
                    this much cannot be placed inside the circle, so the day is
                    recorded as unchecked instead of being guessed at.">
                  <input type="number" className="input" min={0} max={10000}
                    step={10} value={form.max_accuracy_m}
                    onChange={num("max_accuracy_m")} />
                </Field>
                <Field label="When the location is unknown"
                  hint="Applies when the browser refuses, or the reading is too
                    vague. The day is flagged for you either way.">
                  <select className="select"
                    value={form.unknown_counts_as_office ? "office" : "remote"}
                    onChange={(e) => set("unknown_counts_as_office",
                                         e.target.value === "office")}>
                    <option value="remote">Record as work from home</option>
                    <option value="office">Record as present</option>
                  </select>
                </Field>

                <Field label="Refuse a clock-in with no location"
                  className="sm:col-span-2"
                  hint="Off is recommended. A denied browser permission or an
                    old phone is not the employee's fault, and an attendance
                    system that will not let somebody clock in is worse than one
                    that records the day and flags it.">
                  <ToggleField
                    checked={form.require_location}
                    onChange={(v) => set("require_location", v)}
                    label={form.require_location
                      ? "Clock-in is blocked without a location"
                      : "Clock-in always works; the day is flagged instead"} />
                </Field>
              </div>
            </Section>
          </div>

          </>)}
          {tab === "payroll" && (<>
          {/* --------------------------------------------------- payroll -- */}
          {/*
            THE CORRECTION WINDOW (owner 2026-09-06): "we will also give one
            two days buffer for the admin or the owner or the managers to check
            the attendance or make any corrections if required, so that their
            salaries are calculated automatically and correctly."

            WORKING days, because the point of the window is that a human gets
            a chance to look, and a month ending on a Friday with a two-CALENDAR
            -day buffer would lock over the weekend having offered nobody
            anything. The date it produces is worked out on the server, with
            declared holidays included — nothing here calculates it.
          */}
          <div className="card card-body">
            <Section title="When pay locks">
              <p className="-mt-1 mb-4 text-sm text-slate-500">
                Payslips are generated as drafts on the 1st, from the month that
                just ended. This is how long the register stays open for
                corrections before those drafts finalise themselves.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Correction window"
                  hint="WORKING days after the month ends — weekends and
                    declared holidays do not count against it. Set 0 to switch
                    automatic locking off and finalise every month by hand.">
                  <input type="number" className="input" min={0} max={15}
                    value={form.payroll_auto_finalise_days}
                    onChange={num("payroll_auto_finalise_days")} />
                </Field>
                <div className="self-end pb-1 text-sm text-slate-500">
                  {form.payroll_auto_finalise_days > 0 ? (
                    <>
                      A month ending on a Sunday locks on the{" "}
                      <b>
                        {form.payroll_auto_finalise_days === 1 ? "second"
                          : form.payroll_auto_finalise_days === 2 ? "third"
                            : `${form.payroll_auto_finalise_days + 1}th`}
                      </b>{" "}
                      working day of the new month. Anyone whose register is
                      unsettled, whose salary is missing, or who has a
                      correction request waiting is left as a draft instead —
                      automatic locking never forces a figure nobody checked.
                    </>
                  ) : (
                    <>
                      Automatic locking is <b>off</b>. Payslips still generate
                      on the 1st, and wait on the pay run until somebody presses
                      Finalise.
                    </>
                  )}
                </div>
              </div>
            </Section>
          </div>

          </>)}
          {tab === "leave" && (<>
          {/* ---------------------------------------------------- leave -- */}
          <div className="card card-body">
            <Section title="Leave">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Days earned per month" required
                  hint="Credited on the 1st. Pro-rata in somebody's joining
                    month.">
                  <input type="number" className="input" step="0.5" min={0}
                    max={10} value={form.monthly_leave_accrual}
                    onChange={num("monthly_leave_accrual")} />
                </Field>
                <Field label="Most anybody can hold"
                  hint="Days. The balance carries forward inside the leave year
                    and stops growing here.">
                  <input type="number" className="input" step="0.5" min={0}
                    max={120} value={form.max_leave_balance}
                    onChange={num("max_leave_balance")} />
                </Field>
                <Field label="The leave year starts in"
                  className="sm:col-span-2"
                  hint="Balances carry forward inside it and lapse at the end.
                    April matches the Indian financial year.">
                  <select className="select" value={form.leave_year_start_month}
                    onChange={(e) =>
                      set("leave_year_start_month", Number(e.target.value))}>
                    {MONTHS.map((m, i) => (
                      <option key={m} value={i + 1}>{m}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </Section>
          </div>
          </>)}

          <div className="flex items-center justify-end gap-2">
            <button className="btn-secondary"
              onClick={() => setForm(stored ? { ...stored } : null)}>
              Undo changes
            </button>
            <button className="btn-primary"
              disabled={save.isPending || badThresholds}
              onClick={() => save.mutate(form)}>
              {save.isPending ? "Saving…" : "Save the policy"}
            </button>
          </div>
        </div>
      )}
    </RecordPage>
  );
}
