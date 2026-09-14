import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "../Icon";
import { SearchResults } from "../SearchResults";

/*
  THE SEARCH FIELD (2026-08-07).

  It used to be a BUTTON that looked like a field. Clicking it dimmed the page
  and opened a command palette carrying a SECOND search box — so the app showed
  two search boxes at once, and the one you had just clicked was the greyed-out
  one behind the overlay. The palette's input also sat lower and further left
  than the field that spawned it, so the caret appeared somewhere other than
  where you clicked.

  Now the field in the bar IS the input. You type where you clicked, and the
  results open in a panel anchored directly beneath it. No backdrop, no second
  box, no jump.

  What survives from the palette, because it was worth keeping:
    * ⌘K / Ctrl-K, which now FOCUSES the field rather than opening a dialog.
    * Escape to dismiss.
    * Arrow-key navigation with Enter to open — the panel is a listbox, and a
      dropdown you can only reach with a mouse is worse than the dialog was.
*/

export function TopBarSearch() {
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  // Phones have no room for a persistent field, so below `sm:` the icon expands
  // it. Still in the bar; still not a dialog.
  const [expanded, setExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl-K focuses the field. Escape gives the page back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setExpanded(true);
        // The field may be display:none until `expanded` lands, so focus after
        // the paint rather than in the same tick.
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    // Kept so anything still dispatching the old event kicks the field instead
    // of silently doing nothing.
    const onOpen = () => {
      setExpanded(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("search:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("search:open", onOpen);
    };
  }, []);

  // Close on an outside click. The wrapper covers the field AND the panel, so
  // clicking a result is "inside" and does not race the navigation.
  useEffect(() => {
    if (!open && !expanded) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, expanded]);

  // Navigating away closes and clears — a stale query hanging over the page you
  // just opened from it is noise.
  useEffect(() => { setOpen(false); setQ(""); setExpanded(false); },
    [location.pathname]);

  const go = (link: string) => {
    setOpen(false);
    setQ("");
    setExpanded(false);
    inputRef.current?.blur();
    navigate(link);
  };

  const dismiss = () => {
    setOpen(false);
    setExpanded(false);
    inputRef.current?.blur();
  };

  // Arrow keys drive the panel. The results are plain buttons rendered by
  // SearchResults, so the keyboard walks the DOM rather than a parallel index —
  // one list, and it cannot fall out of step with what is on screen.
  const move = (delta: number) => {
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>(
      "button[data-result]");
    if (!items || items.length === 0) return;
    const list = Array.from(items);
    const at = list.findIndex((el) => el === document.activeElement);
    const next = at === -1
      ? (delta > 0 ? 0 : list.length - 1)
      : (at + delta + list.length) % list.length;
    list[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); dismiss(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  };

  return (
    <div ref={wrapRef}
      className={`relative ml-auto flex min-w-0 justify-end lg:mx-auto
        lg:w-full lg:max-w-md lg:justify-center
        ${expanded ? "w-full" : ""}`}>

      {/* Below `sm:`, the collapsed state is an icon. Pressing it expands the
          field in place — the bar rearranges, nothing overlays. */}
      {!expanded && (
        <button type="button" aria-label="Search" title="Search"
          onClick={() => {
            setExpanded(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className="icon-btn border-transparent sm:hidden">
          <Icon.Search size={19} />
        </button>
      )}

      <div className={`${expanded ? "flex" : "hidden sm:flex"}
        h-9 w-full items-center gap-2 rounded-control border bg-slate-50/80 px-3
        transition-colors focus-within:border-slate-300 focus-within:bg-white
        ${open ? "border-slate-300 bg-white" : "border-line"}`}>
        <Icon.Search size={16} className="shrink-0 text-slate-400" />
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search…"
          aria-label="Search customers, policies, leads and pages"
          aria-expanded={open}
          aria-controls="topbar-search-results"
          role="combobox"
          // The browser's own history dropdown would cover ours.
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-800
            outline-none placeholder:text-slate-500
            [&::-webkit-search-cancel-button]:hidden" />
        {q ? (
          <button type="button" aria-label="Clear search" title="Clear search"
            onClick={() => { setQ(""); inputRef.current?.focus(); }}
            className="shrink-0 rounded p-0.5 text-slate-400
              transition-colors hover:text-slate-700">
            <Icon.X size={14} />
          </button>
        ) : (
          <kbd className="hidden shrink-0 rounded border border-line bg-white
            px-1.5 py-0.5 text-[10px] font-medium text-slate-500 lg:block">
            {SEARCH_SHORTCUT}
          </kbd>
        )}
      </div>

      {/* The panel. Anchored to the field, never a backdrop: the page behind it
          stays readable, which is most of the point of searching from a page
          you are already working on. */}
      {open && (
        <div
          id="topbar-search-results"
          ref={panelRef}
          role="listbox"
          onKeyDown={onKeyDown}
          className="scrollbar-light absolute left-0 right-0 top-full z-panel mt-1.5
            max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto rounded-card
            border border-line bg-white p-2 shadow-pop animate-slide-up">
          <SearchResults query={q} onNavigate={go} />
        </div>
      )}
    </div>
  );
}

// Platform-aware search shortcut label: ⌘ K on macOS, Ctrl K elsewhere.
const IS_MAC = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
export const SEARCH_SHORTCUT = IS_MAC ? "⌘ K" : "Ctrl K";
