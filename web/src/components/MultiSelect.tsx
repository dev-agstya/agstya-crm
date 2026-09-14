import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

export interface MultiSelectOption {
  value: string;
  label: string;
  sub?: string;
}

/**
 * Choosing SEVERAL records, styled to match SearchSelect exactly so a form
 * mixing the two does not look like it was assembled from two kits.
 *
 * Built for assigning a reminder to more than one person (owner Q3.2), which is
 * the only place that needs it today. Deliberately NOT folded into SearchSelect
 * as a `multiple` prop: that component's whole contract is "value is a string,
 * picking closes the panel", and adding a mode where neither holds is how a
 * shared component becomes two components in a trench coat.
 *
 * Picked people show as removable chips in the trigger. The panel stays OPEN
 * while picking — choosing four names should be four clicks, not four
 * open-pick-reopen cycles.
 */
export function MultiSelect({
  options,
  values,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Type to search…",
  emptyHint = "No options.",
  max,
  disabled = false,
  className = "",
}: {
  options: MultiSelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyHint?: string;
  /** Refuse to add beyond this many, and say so. */
  max?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => { setActive(0); }, [query, options]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q)
      || (o.sub ?? "").toLowerCase().includes(q));
  }, [options, query]);

  const byValue = useMemo(
    () => new Map(options.map((o) => [o.value, o])), [options]);
  // Chips follow the order they were PICKED, not the order of the option list —
  // it reads as a record of what you did.
  const picked = values.map((v) => byValue.get(v)
    ?? { value: v, label: "Unknown" });
  const full = max !== undefined && values.length >= max;

  const toggle = (value: string) => {
    if (values.includes(value)) onChange(values.filter((v) => v !== value));
    else if (!full) onChange([...values, value]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "Tab") { setOpen(false); return; }
    // Backspace on an empty search box removes the last chip — the standard
    // token-field behaviour people already have in their fingers.
    if (e.key === "Backspace" && !query && values.length > 0) {
      onChange(values.slice(0, -1));
      return;
    }
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      toggle(filtered[active].value);
    }
  };

  return (
    <div className={`relative ${className}`} ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        className={`input flex h-auto min-h-10 w-full flex-wrap items-center
          gap-1.5 py-1.5 text-left disabled:cursor-not-allowed
          disabled:opacity-60 ${open ? "border-ink ring-1 ring-ink" : ""}`}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
          setQuery("");
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        {picked.length === 0 && (
          <span className="text-slate-500">{placeholder}</span>
        )}
        {picked.map((o) => (
          <span key={o.value}
            className="inline-flex max-w-full items-center gap-1 rounded-md
              bg-slate-100 py-0.5 pl-2 pr-1 text-xs font-medium text-slate-700">
            <span className="truncate" title={o.label}>{o.label}</span>
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Remove ${o.label}`}
              title={`Remove ${o.label}`}
              className="rounded p-0.5 text-slate-500 hover:bg-slate-200
                hover:text-slate-700"
              onClick={(e) => { e.stopPropagation(); toggle(o.value); }}
            >
              <Icon.X size={11} />
            </span>
          </span>
        ))}
        <span className="ml-auto shrink-0 pl-1 text-slate-500">
          <Icon.ChevronDown size={14}
            className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (
        <div className="absolute z-menu mt-1 w-full overflow-hidden
          rounded-control border border-line bg-white shadow-pop">
          <div className="border-b border-line p-2">
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2
                -translate-y-1/2 text-slate-500">
                <Icon.Search size={14} />
              </span>
              <input
                ref={inputRef}
                className="input w-full pl-8 text-sm"
                value={query}
                placeholder={searchPlaceholder}
                autoComplete="off"
                aria-autocomplete="list"
                aria-controls={listId}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          <div ref={listRef} id={listId} role="listbox" aria-multiselectable
            className="max-h-56 overflow-y-auto scrollbar-light">
            {filtered.map((o, i) => {
              const checked = values.includes(o.value);
              const isActive = i === active;
              // A full list still renders everyone, but the ones you cannot
              // add any more are visibly inert rather than silently ignoring
              // the click.
              const blocked = full && !checked;
              return (
                <button
                  type="button"
                  key={o.value}
                  role="option"
                  aria-selected={checked}
                  data-active={isActive}
                  disabled={blocked}
                  className={`flex w-full items-center gap-2.5 px-3 py-2
                    text-left text-sm transition-colors ${
                      isActive ? "bg-slate-100" : "hover:bg-slate-50"} ${
                      blocked ? "cursor-not-allowed opacity-40" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => toggle(o.value)}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center
                    justify-center rounded border ${
                      checked ? "border-ink bg-ink text-white"
                        : "border-slate-300 bg-white"}`}>
                    {checked && <Icon.Check size={11} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-800" title={o.label}>
                      {o.label}</span>
                    {o.sub && (
                      <span className="block truncate text-xs text-slate-500" title={o.sub}>
                        {o.sub}</span>
                    )}
                  </span>
                </button>
              );
            })}

            {filtered.length === 0 && (
              <p className="px-3 py-3 text-sm text-slate-500">
                {query ? `No matches for “${query}”.` : emptyHint}
              </p>
            )}
          </div>

          {full && (
            <p className="border-t border-line bg-slate-50 px-3 py-2 text-xs
              text-slate-500">
              That is the maximum of {max}. Remove someone to add another.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
