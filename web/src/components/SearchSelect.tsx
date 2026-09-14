import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
} from "react";
import { Icon } from "./Icon";
import { Spinner } from "./ui";

export interface SearchSelectOption {
  value: string;
  label: string;
  sub?: string;      // secondary line (code / mobile)
  badge?: string;    // right-hand chip (e.g. the entity kind on a mixed list)
}

/**
 * THE picker for choosing one record — customers, brokers, partners, insurers,
 * anything. There is deliberately only one of these in the app: before this,
 * three separate implementations existed side by side (a shared one, a bespoke
 * customer picker with a "Change" button, and a party picker inside the payment
 * modal), so two fields doing the same job looked and behaved differently on
 * the same screen.
 *
 * Two modes, one appearance:
 *   - LOCAL  (default) — `options` holds the whole list and typing filters it.
 *   - REMOTE (`onSearch`) — the caller fetches on each debounced keystroke and
 *     feeds the results back in as `options`. Because the picked record may not
 *     be in the current result page, pass `selectedLabel` so the trigger can
 *     still name it.
 *
 * Behaves like a real combobox: arrow keys move, Enter picks, Escape closes,
 * Home/End jump, the active option scrolls into view, and the whole thing is
 * announced correctly to screen readers.
 */
export function SearchSelect({
  options,
  value,
  placeholder = "Select…",
  onChange,
  onSearch,
  loading = false,
  selectedLabel,
  searchPlaceholder = "Type to search…",
  emptyHint,
  onAddNew,
  addNewLabel,
  disabled = false,
  allowClear = false,
  clearLabel = "— None —",
  debounceMs = 250,
  triggerClassName = "",
}: {
  options: SearchSelectOption[];
  value: string;
  placeholder?: string;
  onChange: (value: string, option?: SearchSelectOption) => void;
  /** Remote mode: called with the debounced query. Filtering is the caller's. */
  onSearch?: (query: string) => void;
  loading?: boolean;
  /** Remote mode: label for the current value when it isn't in `options`. */
  selectedLabel?: string;
  searchPlaceholder?: string;
  /** Shown in place of "No matches" before the user has typed (remote mode). */
  emptyHint?: string;
  onAddNew?: (query: string) => void;
  addNewLabel?: string;
  disabled?: boolean;
  allowClear?: boolean;
  clearLabel?: string;
  debounceMs?: number;
  /** Extra classes for the trigger button — e.g. `h-10` to align in a toolbar. */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const remote = !!onSearch;

  // Remote mode: debounce the keystrokes into one fetch.
  useEffect(() => {
    if (!onSearch) return;
    const t = setTimeout(() => onSearch(query.trim()), debounceMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, debounceMs, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // In local mode we filter here; in remote mode `options` IS the result set.
  const filtered = useMemo(() => {
    if (remote) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q)
      || (o.sub ?? "").toLowerCase().includes(q));
  }, [remote, options, query]);

  // Rows the arrow keys can land on: the optional clear row, then the options.
  const showClearRow = allowClear && !query;
  const rowCount = filtered.length + (showClearRow ? 1 : 0);

  const selected = options.find((o) => o.value === value);
  const triggerLabel = selected?.label ?? (value ? selectedLabel : "") ?? "";

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const pick = useCallback((option?: SearchSelectOption) => {
    onChange(option?.value ?? "", option);
    close();
  }, [onChange, close]);

  // Keep the highlighted row in view as the arrows move through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => { setActive(0); }, [query, options]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") { close(); return; }
    if (rowCount === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % rowCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + rowCount) % rowCount);
    } else if (e.key === "Home") {
      e.preventDefault(); setActive(0);
    } else if (e.key === "End") {
      e.preventDefault(); setActive(rowCount - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showClearRow && active === 0) pick(undefined);
      else pick(filtered[active - (showClearRow ? 1 : 0)]);
    }
  };

  const rowBase = "flex w-full items-start gap-2 px-3 py-2 text-left text-sm " +
    "transition-colors";

  return (
    <div className="relative" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        className={`input flex w-full items-center justify-between gap-2
          text-left disabled:cursor-not-allowed disabled:opacity-60 ${
            triggerClassName} ${
            open ? "border-ink ring-1 ring-ink" : ""}`}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
          setQuery("");
          // Focus lands on the search box once the panel paints.
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <span className={`truncate ${triggerLabel ? "" : "text-slate-500"}`}>
          {triggerLabel || placeholder}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-slate-500">
          {/* Clearing is on the trigger itself — no separate "Change" button. */}
          {allowClear && value && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Clear selection"
              title="Clear"
              className="rounded p-0.5 hover:bg-slate-100 hover:text-slate-600"
              onClick={(e) => { e.stopPropagation(); pick(undefined); }}
            >
              <Icon.X size={13} />
            </span>
          )}
          <Icon.ChevronDown size={14}
            className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (
        <div className="absolute z-menu mt-1 w-full overflow-hidden rounded-control
          border border-line bg-white shadow-pop">
          <div className="border-b border-line/70 p-2">
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

          <div ref={listRef} id={listId} role="listbox"
            className="max-h-60 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm
                text-slate-500">
                <Spinner className="h-4 w-4" /> Searching…
              </div>
            ) : (
              <>
                {showClearRow && (
                  <button type="button" role="option"
                    aria-selected={!value}
                    data-active={active === 0}
                    className={`${rowBase} text-slate-500 ${
                      active === 0 ? "bg-slate-100" : "hover:bg-slate-50"}`}
                    onMouseEnter={() => setActive(0)}
                    onClick={() => pick(undefined)}>
                    {clearLabel}
                  </button>
                )}

                {filtered.map((o, i) => {
                  const idx = i + (showClearRow ? 1 : 0);
                  const isActive = idx === active;
                  const isSelected = o.value === value;
                  return (
                    <button type="button" key={o.value} role="option"
                      aria-selected={isSelected}
                      data-active={isActive}
                      className={`${rowBase} ${
                        isActive ? "bg-slate-100" : "hover:bg-slate-50"} ${
                        isSelected ? "font-medium text-slate-900"
                          : "text-slate-700"}`}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => pick(o)}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{o.label}</span>
                        {o.sub && (
                          <span className="block truncate text-xs
                            text-slate-500">{o.sub}</span>
                        )}
                      </span>
                      {o.badge && (
                        <span className="badge shrink-0 bg-slate-100
                          text-slate-500">{o.badge}</span>
                      )}
                      {isSelected && (
                        <Icon.Check size={15}
                          className="mt-0.5 shrink-0 text-slate-900" />
                      )}
                    </button>
                  );
                })}

                {filtered.length === 0 && (
                  <p className="px-3 py-3 text-sm text-slate-500">
                    {query
                      ? `No matches for “${query}”.`
                      : emptyHint ?? (remote ? "Type to search." : "No options.")}
                  </p>
                )}
              </>
            )}
          </div>

          {onAddNew && addNewLabel && !loading && filtered.length === 0 && (
            <button type="button"
              className="flex w-full items-center gap-1.5 border-t
                border-line/70 px-3 py-2.5 text-left text-sm font-medium
                text-slate-900 hover:bg-slate-50"
              onClick={() => { const q = query.trim(); close(); onAddNew(q); }}>
              <Icon.Plus size={14} /> {addNewLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
