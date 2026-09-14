import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { useClickOutside } from "../lib/useClickOutside";

/**
 * A filter that states its own value.
 *
 * Every list page laid its filters out as a row of native `<select className=
 * "select h-10 w-40">`. Policies had four of them plus a search box plus a
 * SearchSelect: six controls, ~1150px of chrome, and — because nothing was
 * filtered yet — every one of them reading "All …". A wall of identical grey
 * boxes saying nothing is the single most template-looking thing a CRM can put
 * at the top of its main screen, and it was the first thing on every list.
 *
 * A pill is the same control with the same state, drawn to carry information:
 *
 *     unset   [ Status          ⌄ ]        quiet, border only
 *     set     [ Status: Active  × ]        ink, and clearable in one click
 *
 * Which means the filter bar now answers "what am I looking at?" at a glance
 * instead of requiring you to read six dropdowns to find the one that isn't on
 * "All". Options live in a popover, so twenty insurers cost the same width as
 * two.
 *
 * Deliberately NOT a `<select>`: a native select cannot show a clear affordance,
 * cannot be searched, and renders differently on every OS — which is exactly
 * why `.select` had to paint its own chevron to sit next to SearchSelect.
 */

export interface FilterOption {
  value: string;
  label: string;
  /** Quiet second line — a code, a count. */
  sub?: string;
}

export function FilterPill({
  label,
  value,
  options,
  onChange,
  allLabel,
  defaultValue,
  searchable,
  icon,
}: {
  /** The dimension, shown when nothing is picked: "Status", "Insurer". */
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (v: string) => void;
  /** Wording of the reset row. Defaults to "All <label lowercased>". */
  allLabel?: string;
  /**
   * The value that counts as "not filtering", when that is not `""`.
   *
   * A sort dimension has no empty state — it is always sorted by something —
   * so "Newest first" is its resting position and must read as quiet, not as
   * an applied filter. Without this every list would open with a permanently
   * ink-filled Sort pill claiming a filter nobody set.
   */
  defaultValue?: string;
  /** Adds a type-to-filter box. Defaults on past 8 options. */
  searchable?: boolean;
  icon?: keyof typeof Icon;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  useEffect(() => { if (!open) setQ(""); }, [open]);

  const base = defaultValue ?? "";
  const active = value !== base;
  const current = options.find((o) => o.value === value);
  const reset = allLabel
    ?? (defaultValue !== undefined
      ? (options.find((o) => o.value === base)?.label ?? "Default")
      : `All ${label.toLowerCase()}`);
  const canSearch = searchable ?? options.length > 8;
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) =>
      o.label.toLowerCase().includes(needle)
        || (o.sub ?? "").toLowerCase().includes(needle))
    : options;

  const Glyph = icon ? Icon[icon] : null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex h-9 max-w-[15rem] items-center gap-1.5
          whitespace-nowrap rounded-control border px-2.5 text-[13px]
          font-medium transition-colors ${active
            ? "border-ink bg-ink text-white hover:bg-ink-hover"
            : "border-line bg-white text-slate-600 hover:border-slate-300 "
              + "hover:bg-slate-50 hover:text-slate-900"}`}
      >
        {Glyph && <Glyph size={14} className="shrink-0" />}
        <span className="truncate">
          {active ? `${label}: ${current?.label ?? value}` : label}
        </span>
        {active ? (
          // A nested <button> is invalid HTML, so the clear is a span that
          // stops the click from reaching the trigger.
          <span
            role="button"
            tabIndex={0}
            aria-label={`Clear ${label} filter`}
            title={`Clear ${label} filter`}
            onClick={(e) => { e.stopPropagation(); onChange(base); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onChange(base);
              }
            }}
            className="-mr-0.5 ml-0.5 shrink-0 rounded p-0.5 text-white/70
              transition-colors hover:bg-white/15 hover:text-white"
          >
            <Icon.X size={13} />
          </span>
        ) : (
          <Icon.ChevronDown size={14} className="shrink-0 text-slate-400" />
        )}
      </button>

      {open && (
        <div role="listbox"
          className="absolute left-0 top-full z-menu mt-1.5 max-h-[19rem] w-60
            overflow-hidden rounded-card border border-line bg-white shadow-pop
            animate-slide-up">
          {canSearch && (
            <div className="border-b border-line p-2">
              <input
                autoFocus
                className="input text-[13px]"
                placeholder={`Search ${label.toLowerCase()}…`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          )}
          <div className="scrollbar-light max-h-64 overflow-y-auto p-1">
            <Row selected={!active}
              onPick={() => { onChange(base); setOpen(false); }}
              label={reset} />
            {shown.filter((o) => o.value !== base).map((o) => (
              <Row key={o.value} selected={o.value === value}
                onPick={() => { onChange(o.value); setOpen(false); }}
                label={o.label} sub={o.sub} />
            ))}
            {shown.length === 0 && (
              <p className="px-2.5 py-3 text-center text-[13px] text-slate-500">
                Nothing matches “{q}”.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, sub, selected, onPick }: {
  label: ReactNode;
  sub?: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={`flex w-full items-center gap-2 rounded-control px-2.5 py-1.5
        text-left text-[13px] transition-colors hover:bg-slate-100 ${selected
          ? "font-medium text-slate-900" : "text-slate-600"}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sub && (
          <span className="block truncate text-[11px] text-slate-500">
            {sub}
          </span>
        )}
      </span>
      {selected && (
        <Icon.Check size={14} className="shrink-0 text-slate-900" />
      )}
    </button>
  );
}
