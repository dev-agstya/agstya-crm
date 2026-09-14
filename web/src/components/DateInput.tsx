// The app's date field. India writes dates day-first (26/07/2026), but a native
// <input type="date"> renders in the browser's own locale, so the same form read
// 07/26/2026 on a US-configured machine — and there is no HTML or CSS switch for
// that. The owner's rule (2026-07-26) is dd/mm/yyyy everywhere, so every date
// input in the app is this component instead.
//
// It is a text box that always reads and accepts dd/mm/yyyy, with the browser's
// real calendar still one click away behind the icon — replacing the native
// input shouldn't cost anyone the picker they are used to.
//
// The value contract is deliberately identical to the input it replaces:
// yyyy-mm-dd in, yyyy-mm-dd out, "" when empty. Call sites only change how they
// read the callback — `(v) => …` instead of `(e) => e.target.value`.

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  fromDmy, joinLocalDateTime, maskDmy, splitLocalDateTime, toDmy,
} from "../lib/format";

export interface DateInputProps {
  value: string;                       // yyyy-mm-dd ("" when unset)
  onChange: (value: string) => void;   // yyyy-mm-dd ("" when cleared)
  className?: string;
  required?: boolean;
  disabled?: boolean;
  title?: string;
  min?: string;
  max?: string;
  id?: string;
  name?: string;
  placeholder?: string;
}

export function DateInput({
  value, onChange, className = "input", required, disabled, title,
  min, max, id, name, placeholder = "dd/mm/yyyy",
}: DateInputProps) {
  const [text, setText] = useState(() => toDmy(value));
  const picker = useRef<HTMLInputElement>(null);

  // Follow the parent whenever it moves the value elsewhere — a form reset, a
  // record finishing loading, the calendar. Skipped while the box already spells
  // the same day, so a re-render can't yank the caret out of a half-typed date.
  useEffect(() => {
    if (fromDmy(text) !== (value || "")) setText(toDmy(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const type = (raw: string) => {
    const masked = maskDmy(raw);
    setText(masked);
    const iso = fromDmy(masked);
    // Only a complete, real date reaches the form. A half-typed one leaves the
    // stored value alone rather than blanking it on every keystroke.
    if (iso) onChange(iso);
    else if (masked === "") onChange("");
  };

  // Half-finished or impossible text (31/02/2026) snaps back to what the form
  // actually holds, so what is on screen is always what will be saved.
  const settle = () => {
    if (text !== "" && !fromDmy(text)) setText(toDmy(value));
  };

  const openPicker = () => {
    const el = picker.current;
    if (!el || disabled) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        /* no user activation / unsupported input type — fall through */
      }
    }
    el.focus();
    el.click();
  };

  return (
    <div
      className={`${className} relative flex items-center px-0 py-0
        focus-within:border-brand-500 focus-within:ring-1
        focus-within:ring-brand-500 ${disabled ? "bg-slate-100" : ""}`}
      title={title}
    >
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onChange={(e) => type(e.target.value)}
        onBlur={settle}
        className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm
          text-slate-800 placeholder:text-slate-500 focus:outline-none
          disabled:cursor-not-allowed"
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={openPicker}
        aria-label="Open calendar"
        title="Open calendar"
        className="mr-1 shrink-0 rounded p-1.5 text-slate-500 transition
          hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
      >
        <Icon.Calendar size={16} />
      </button>
      {/* The browser's calendar, invisible but real: showPicker() has to be
          called on an actual date input, and anchoring it at the bottom-right
          drops the popup exactly where the icon is. */}
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="native-picker"
        min={min}
        max={max}
        value={value || ""}
        onChange={(e) => {
          setText(toDmy(e.target.value));
          onChange(e.target.value);
        }}
        className="pointer-events-none absolute bottom-0 right-8 h-px w-px
          border-0 p-0 opacity-0"
      />
    </div>
  );
}

// Date + time, replacing <input type="datetime-local"> (which is day-first only
// by the browser's locale, same problem). Value is the same local
// "yyyy-mm-ddThh:mm" string the native control uses. The clock half stays
// native: 12-hour vs 24-hour is a preference, not an ambiguity.
//
// The time box is 150px, not the 120px it started at: a 12-hour browser renders
// "10:00 AM" plus its own clock button in there, and at 120px the meridiem was
// clipped (owner 2026-08-04). Widening the field is the fix — the width of a
// native control's internals is not something CSS can reach into.
export function DateTimeInput({
  value, onChange, className = "input", disabled, minDate,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  /** Earliest selectable day (yyyy-mm-dd) — passed to the calendar popup. */
  minDate?: string;
}) {
  const { date, time } = splitLocalDateTime(value);
  return (
    <div className="flex gap-2">
      <DateInput
        className={`${className} flex-1`}
        value={date}
        min={minDate}
        disabled={disabled}
        onChange={(d) => onChange(d ? joinLocalDateTime(d, time) : "")}
      />
      <input
        type="time"
        className={`${className} w-[150px] shrink-0`}
        value={time}
        disabled={disabled}
        aria-label="Time"
        onChange={(e) => onChange(joinLocalDateTime(date, e.target.value))}
      />
    </div>
  );
}
