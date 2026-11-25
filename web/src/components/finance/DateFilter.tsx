import { useEffect, useState } from "react";
import { Calendar, Check } from "lucide-react";
import { Menu, MenuItem } from "../Menu";
import { DateInput } from "../DateInput";
import { toDmy } from "../../lib/format";
import { Button } from "@/components/ui/button";

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
      return `${toDmy(v.date_from) || "…"} → ${toDmy(v.date_to) || "…"}`;
    return "Custom Range";
  }
  return PERIOD_OPTIONS.find((o) => o.value === v.period)?.label ?? "Filter";
}

export function periodParams(v: PeriodValue): {
  period: string;
  date_from?: string;
  date_to?: string;
} {
  if (v.period === "custom")
    return {
      period: "custom",
      date_from: v.date_from || undefined,
      date_to: v.date_to || undefined,
    };
  return { period: v.period };
}

export function DateFilter({
  value,
  onChange,
  variant = "secondary",
}: {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
  variant?: "secondary" | "field";
}) {
  const [from, setFrom] = useState(value.date_from ?? "");
  const [to, setTo] = useState(value.date_to ?? "");

  useEffect(() => {
    setFrom(value.date_from ?? "");
    setTo(value.date_to ?? "");
  }, [value.date_from, value.date_to]);

  const pick = (period: string) => {
    if (period === "custom") return;
    onChange({ period });
  };

  const applyCustom = () => {
    onChange({
      period: "custom",
      date_from: from || undefined,
      date_to: to || undefined,
    });
  };

  return (
    <Menu
      variant={variant}
      label={<span className="max-w-[180px] truncate">{periodLabel(value)}</span>}
      icon={<Calendar className="h-3.5 w-3.5" />}
      width="w-64"
      panelClassName="p-1.5"
    >
      {(close) => (
        <>
          {PERIOD_OPTIONS.filter((o) => o.value !== "custom").map((o) => (
            <MenuItem
              key={o.value}
              trailing={
                value.period === o.value ? (
                  <Check className="h-3.5 w-3.5 text-primary" />
                ) : undefined
              }
              onClick={() => {
                pick(o.value);
                close();
              }}
            >
              <span
                className={
                  value.period === o.value ? "font-semibold text-foreground" : ""
                }
              >
                {o.label}
              </span>
            </MenuItem>
          ))}
          <div className="mt-1 border-t border-border px-2 pb-1 pt-2">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Custom range
            </p>
            <div className="flex flex-col gap-2">
              <label className="text-xs text-muted-foreground">
                From
                <DateInput
                  className="mt-0.5 w-full text-xs"
                  value={from}
                  onChange={setFrom}
                />
              </label>
              <label className="text-xs text-muted-foreground">
                To
                <DateInput
                  className="mt-0.5 w-full text-xs"
                  value={to}
                  onChange={setTo}
                />
              </label>
              <Button
                type="button"
                size="sm"
                className="mt-1 w-full"
                onClick={() => {
                  applyCustom();
                  close();
                }}
                disabled={!from && !to}
              >
                Apply range
              </Button>
            </div>
          </div>
        </>
      )}
    </Menu>
  );
}
