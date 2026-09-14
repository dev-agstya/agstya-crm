import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { Menu, MenuItem } from "../Menu";
import { DateInput } from "../DateInput";
import { toDmy } from "../../lib/format";

export type PeriodValue = {
  period: string;
  date_from?: string;
  date_to?: string;
};

export const PERIOD_OPTIONS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "this_week", label: "This Week" },
  { value: "current_month", label: "Current Month" },
  { value: "last_month", label: "Last Month" },
  { value: "last_3_months", label: "Last 3 Months" },
  { value: "this_year", label: "This Year" },
  { value: "last_year", label: "Last Year" },
  { value: "till_date", label: "Till Date (everything)" },
  { value: "custom", label: "Custom Date Range" },
];

export function periodLabel(v: PeriodValue): string {
  if (v.period === "custom") {
    if (v.date_from || v.date_to)
      // Day-first on the button too — the range reads back in the same format
      // it was typed in, not the yyyy-mm-dd the API happens to want.
      return `${toDmy(v.date_from) || "…"} → ${toDmy(v.date_to) || "…"}`;
    return "Custom Range";
  }
  return PERIOD_OPTIONS.find((o) => o.value === v.period)?.label ?? "Filter";
}

// Turn a PeriodValue into the query params the finance API expects.
export function periodParams(v: PeriodValue): {
  period: string; date_from?: string; date_to?: string;
} {
  if (v.period === "custom")
    return { period: "custom", date_from: v.date_from || undefined,
      date_to: v.date_to || undefined };
  return { period: v.period };
}

// A single date-filter button with the six presets + a custom range popover.
// `variant` controls the trigger's look: "secondary" (default) is the bordered
// header pill; "field" matches the form-field controls in a filter toolbar.
export function DateFilter({ value, onChange, variant = "secondary" }: {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
  variant?: "secondary" | "field";
}) {
  const [from, setFrom] = useState(value.date_from ?? "");
  const [to, setTo] = useState(value.date_to ?? "");

  // Keep the custom-range inputs in step with the active value — otherwise the
  // popover can show a stale range after the period is changed elsewhere.
  useEffect(() => {
    setFrom(value.date_from ?? "");
    setTo(value.date_to ?? "");
  }, [value.date_from, value.date_to]);

  const pick = (period: string) => {
    if (period === "custom") return; // handled by the range inputs
    onChange({ period });
  };

  const applyCustom = () => {
    onChange({ period: "custom", date_from: from || undefined,
      date_to: to || undefined });
  };

  return (
    <Menu variant={variant}
      label={<span className="max-w-[180px] truncate">{periodLabel(value)}</span>}
      icon={<Icon.Calendar size={16} />} width="w-64" panelClassName="p-1.5">
      {(close) => (
        <>
          {PERIOD_OPTIONS.filter((o) => o.value !== "custom").map((o) => (
            <MenuItem key={o.value}
              trailing={value.period === o.value
                ? <Icon.Check size={15} className="text-slate-900" /> : undefined}
              onClick={() => { pick(o.value); close(); }}>
              <span className={value.period === o.value
                ? "font-semibold text-slate-900" : ""}>{o.label}</span>
            </MenuItem>
          ))}
          <div className="mt-1 border-t border-line/70 px-2 pb-1 pt-2">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide
              text-slate-500">Custom range</p>
            <div className="flex flex-col gap-2">
              <label className="text-xs text-slate-500">From
                <DateInput className="input mt-0.5 w-full text-sm"
                  value={from} onChange={setFrom} />
              </label>
              <label className="text-xs text-slate-500">To
                <DateInput className="input mt-0.5 w-full text-sm"
                  value={to} onChange={setTo} />
              </label>
              <button className="btn-primary mt-1 w-full justify-center"
                onClick={() => { applyCustom(); close(); }}
                disabled={!from && !to}>
                Apply range
              </button>
            </div>
          </div>
        </>
      )}
    </Menu>
  );
}
