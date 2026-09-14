import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../store/auth";
import { Icon } from "../Icon";
import { TopBar } from "./TopBar";
import { NAV, canAccess } from "../../lib/access";
import type { Gate, NavItem } from "../../lib/access";

/* ---------------------------------------------------------------- palette -- */
// Near-black sidebar over a light content area. The sidebar is the only dark
// surface in the product. These track the `ink` / `ink-hover` tokens in
// tailwind.config.js — they are literals only because the sidebar sets them as
// inline styles, and they must be changed together.
const SIDEBAR_BG = "#18181b";
const MENU_BG = "#27272a";
const RAIL_W = 80; // collapsed sidebar width in px (Tailwind lg:w-20)
const EXPANDED_W = 256; // expanded sidebar width in px (Tailwind lg:w-64)

// Lives with the field that renders it (layout/TopBarSearch). Re-exported here
// because pages importing it from the layout predate the top bar existing.
export { SEARCH_SHORTCUT } from "./TopBar";

// Nav config + the visibility rules live in lib/access.ts so the sidebar and
// the router share one source of truth (a hidden link and its guarded route
// can never drift apart).

/* ---------------------------------------------------------------- helpers -- */

// Tracks whether we're at lg+ width, so "collapsed" only affects desktop and
// the mobile drawer always renders full width.
function useIsDesktop() {
  const [desktop, setDesktop] = useState(
    () => typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => setDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return desktop;
}

export function AppLayout() {
  const { user, has } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isDesktop = useIsDesktop();

  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("crm.sidebar.collapsed") === "1",
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // The account menu, search and notifications moved to the top bar with the
  // tile they belonged to, so the only popover this file still owns is the rail
  // flyout: a collapsed nav item's sub-sections. Rendered at
  // the shell level with a measured `fixed` position so it escapes the nav's
  // overflow clipping (the aside itself has a transform, so it can't host it).
  const [railFlyout, setRailFlyout] =
    useState<{ item: NavItem; top: number; trigger: HTMLElement } | null>(null);
  const railFlyoutRef = useRef<HTMLDivElement>(null);

  // Rail (icon-only) mode is desktop-only; the mobile drawer shows full labels.
  const rail = collapsed && isDesktop;

  const toggleCollapsed = () => {
    setRailFlyout(null);
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("crm.sidebar.collapsed", next ? "1" : "0");
      return next;
    });
  };

  // Leaving rail mode dismisses any open flyout.
  useEffect(() => {
    if (!rail) setRailFlyout(null);
  }, [rail]);

  // Close the rail flyout on outside click / Escape. Its trigger counts as
  // "inside" so a second click on it toggles rather than racing this handler.
  useEffect(() => {
    if (!railFlyout) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        railFlyoutRef.current &&
        !railFlyoutRef.current.contains(t) &&
        !railFlyout.trigger.contains(t)
      )
        setRailFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailFlyout(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [railFlyout]);

  const canSee = (g: Gate): boolean =>
    canAccess(g, user?.account_type, has);

  // The browser-tab title is NOT set here. It used to be derived from the nav
  // config, which left every page that is not a nav entry — a 404, onboarding,
  // anything opened by URL — wearing the last matched page's name. It now
  // belongs to whichever page draws the heading (lib/useDocumentTitle, used by
  // PageHeader). Two effects both writing document.title race on navigation and
  // the parent's runs last, so this one always won and pages could not opt out.

  // Filter nav by permission and drop empty sections.
  const sections = NAV.map((s) => ({
    title: s.title,
    items: s.items
      .filter(canSee)
      .map((i) => ({ ...i, children: i.children?.filter(canSee) })),
  })).filter((s) => s.items.length > 0);

  const goto = (to: string) => {
    navigate(to);
    setOpen(false);
    setRailFlyout(null);
  };

  const currentTab = new URLSearchParams(location.search).get("tab");

  // A nav route is active when its pathname matches and, if it carries a ?tab=,
  // the current tab matches too.
  const routeActive = (to: string) => {
    const p = to.split("?")[0];
    const t = new URLSearchParams(to.split("?")[1] || "").get("tab");
    return location.pathname === p && (t ? currentTab === t : true);
  };

  /* ----------------------------------------------------------- nav render -- */

  // A coming-soon entry: dimmed, lock-badged, and genuinely inert — a plain
  // <div>, so there is nothing to click, nothing to tab to and no hover state
  // suggesting otherwise. There is no route behind it either (owner A4).
  const renderLocked = (item: NavItem) => {
    const IconCmp = Icon[item.icon];
    return (
      <div
        key={item.to}
        title={`${item.label} — coming soon`}
        aria-disabled="true"
        className={`flex h-10 w-full cursor-not-allowed select-none items-center
          rounded-control text-sm font-medium text-white/30 ${
            rail ? "justify-center px-2" : "gap-3 px-3"}`}
      >
        <IconCmp size={19} className="shrink-0" />
        {!rail && (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate">{item.label}</span>
            <Icon.Lock size={13} className="shrink-0 text-white/30"
              aria-label="Coming soon" />
          </span>
        )}
      </div>
    );
  };

  const renderItem = (item: NavItem) => {
    if (item.locked) return renderLocked(item);
    const IconCmp = Icon[item.icon];
    const hasKids = !!item.children && item.children.length > 0;
    // A route is active when its pathname matches and (if it carries a ?tab=)
    // the current tab matches. A parent with children matches any child route.
    const parentActive = hasKids
      ? item.children!.some((c) => routeActive(c.to))
      : routeActive(item.to);
    const hasChildren = hasKids && !rail; // inline expander (expanded sidebar)
    const isOpen = expanded[item.to] ?? parentActive;

    // 40px rows with a 3px white bar on the active one (design system). The bar
    // is what makes the current page findable at a glance in a list of twenty.
    const rowBase =
      "group relative flex h-10 w-full items-center rounded-control text-sm " +
      "font-medium transition-colors " +
      (rail ? "justify-center px-2" : "gap-3 px-3");
    const flyoutActive = railFlyout?.item.to === item.to;
    const isActive = parentActive || flyoutActive;
    const rowState = isActive
      ? "bg-[#1a1b1f] text-white"
      : "text-white/65 hover:bg-white/[0.06] hover:text-white";

    return (
      <div key={item.to}>
        <div className={`${rowBase} ${rowState}`}>
          {isActive && (
            <span aria-hidden="true"
              className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2
                rounded-r-full bg-white" />
          )}
          <button
            type="button"
            title={rail ? item.label : undefined}
            onClick={(e) => {
              // In rail mode a parent with sub-sections opens a side flyout
              // (like the profile menu) instead of navigating.
              if (rail && hasKids) {
                e.stopPropagation();
                const trigger = e.currentTarget;
                const r = trigger.getBoundingClientRect();
                const estH = 46 + item.children!.length * 44;
                const top = Math.max(
                  8, Math.min(r.top, window.innerHeight - estH - 12),
                );
                setRailFlyout((prev) =>
                  prev && prev.item.to === item.to
                    ? null
                    : { item, top, trigger });
              } else {
                goto(item.to);
              }
            }}
            className={
              rail
                ? "flex w-full items-center justify-center"
                : "flex min-w-0 flex-1 items-center gap-3 text-left"
            }
          >
            <IconCmp size={19} className="shrink-0" />
            {!rail && (
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            )}
          </button>
          {hasChildren && (
            <button
              type="button"
              aria-label={isOpen ? "Collapse" : "Expand"}
              title={isOpen ? "Collapse" : "Expand"}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((x) => ({ ...x, [item.to]: !isOpen }));
              }}
              className="ml-1 shrink-0 rounded p-0.5 text-current/80
                hover:bg-white/10"
            >
              <Icon.ChevronDown
                size={16}
                className={`transition-transform ${isOpen ? "" : "-rotate-90"}`}
              />
            </button>
          )}
        </div>

        {/* Sub-items with a connector line, like the reference. */}
        {hasChildren && isOpen && (
          <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l
            border-white/10 pl-3">
            {item.children!.map((child) => (
              child.locked ? (
                <div key={child.to} aria-disabled="true"
                  title={`${child.label} — coming soon`}
                  className="flex cursor-not-allowed select-none items-center
                    gap-1.5 rounded-md px-3 py-1.5 text-[13px] text-white/30">
                  {child.label}
                  <Icon.Lock size={11} aria-label="Coming soon" />
                </div>
              ) : (
                <button
                  key={child.to}
                  type="button"
                  onClick={() => goto(child.to)}
                  className={`rounded-md px-3 py-1.5 text-left text-[13px]
                    transition-colors ${
                      routeActive(child.to)
                        ? "bg-white/10 font-medium text-white"
                        : "text-white/55 hover:bg-white/[0.04] hover:text-white/90"
                    }`}
                >
                  {child.label}
                </button>
              )
            ))}
          </div>
        )}
      </div>
    );
  };

  /*
    The account tile, the search trigger and the notification bell used to
    live in the sidebar — the tile pinned to its bottom edge, notifications
    an item INSIDE that tile's dropdown. They are in the top bar now
    (components/layout/TopBar), where every other tool puts them.

    The sidebar is one thing again: navigation. That is what lets the rail
    mode read as a rail rather than a squeezed control panel, and it is why
    `menuOpen` / `helpOpen` / `menuRef` are gone from this file.
  */

  return (
    // Full-height shell: only the main content scrolls; the sidebar stays fixed.
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* Sidebar */}
      <aside
        style={{ backgroundColor: SIDEBAR_BG }}
        className={`fixed inset-y-0 left-0 z-nav flex h-full w-72 shrink-0
          transform flex-col text-white transition-all duration-200 lg:static
          lg:translate-x-0
          ${rail ? "lg:w-20" : "lg:w-64"} ${
            open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
          }`}
      >
        {/* Header: centered logo (full when expanded, mark when collapsed).
            The collapse/expand control is the edge tab rendered below. */}
        <div className="flex h-16 shrink-0 items-center justify-center
          border-b border-white/10 px-3">
          <Link to="/dashboard" onClick={() => setOpen(false)}
            className="flex items-center justify-center">
            <img
              src={rail
                ? "/agastya_hindi_half_logo.png"
                : "/agastya_hindi_full_logo.png"}
              alt="Agstya Associate"
              className={rail
                ? "h-9 w-9 object-contain"
                : "h-9 w-auto object-contain"}
            />
          </Link>
        </div>

        {/* Sections. The search trigger that used to sit above these is the
            field in the top bar now. */}
        <nav
          onScroll={() => railFlyout && setRailFlyout(null)}
          className="scrollbar-dark flex min-h-0 flex-1 flex-col gap-4
          overflow-y-auto overflow-x-hidden px-3 py-4"
        >
          {sections.map((section) => (
            <div key={section.title} className="flex flex-col gap-0.5">
              {rail ? (
                <div className="mx-2 mb-1 border-t border-white/10" />
              ) : (
                <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase
                  tracking-[0.1em] text-white/35">
                  {section.title}
                </p>
              )}
              {section.items.map(renderItem)}
            </div>
          ))}
        </nav>

      </aside>

      {/* Collapse / expand control — a tab sitting just outside the sidebar's
          right edge (desktop only): flat on the sidebar side, rounded on the
          outer side. Dark in light mode, white in dark mode. Rendered at the
          shell level; its x tracks the sidebar width. */}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
        title={rail ? "Expand sidebar" : "Collapse sidebar"}
        style={{ left: rail ? RAIL_W : EXPANDED_W, top: 32 }}
        className="fixed z-menu hidden h-[18px] w-3 -translate-y-1/2 items-center
          justify-center rounded-l-none rounded-r-md bg-ink text-white
          shadow-md transition-all duration-200 hover:bg-ink-hover lg:flex"
      >
        {rail ? <Icon.ChevronRight size={13} /> : <Icon.ChevronLeft size={13} />}
      </button>

      {/* Rail sub-section flyout: shown when a collapsed parent (e.g. My
          Organization) is clicked. Rendered here (outside the transformed
          aside / overflow nav) so it is not clipped. */}
      {railFlyout && (
        <div
          ref={railFlyoutRef}
          style={{ backgroundColor: MENU_BG, top: railFlyout.top, left: RAIL_W + 8 }}
          className="fixed z-menu w-56 overflow-hidden rounded-card border
            border-white/10 text-white shadow-pop shadow-black/40"
        >
          <div className="border-b border-white/10 px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-white">
              {railFlyout.item.label}
            </p>
          </div>
          {(railFlyout.item.children || []).map((child) => (
            child.locked ? (
              <div key={child.to} aria-disabled="true"
                title={`${child.label} — coming soon`}
                className="flex w-full cursor-not-allowed select-none
                  items-center gap-1.5 px-3 py-2.5 text-sm text-white/30">
                {child.label}
                <Icon.Lock size={12} aria-label="Coming soon" />
              </div>
            ) : (
              <button
                key={child.to}
                type="button"
                onClick={() => goto(child.to)}
                className={`flex w-full items-center px-3 py-2.5 text-left text-sm
                  transition-colors ${
                    routeActive(child.to)
                      ? "bg-white/10 font-medium text-white"
                      : "text-white/80 hover:bg-white/[0.06]"
                  }`}
              >
                {child.label}
              </button>
            )
          ))}
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-scrim bg-slate-900/40 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Main column: content scrolls, and the top bar is sticky INSIDE it so
          the breadcrumb and search stay put while a long ledger scrolls under
          them. The bar is one component at every width now — it used to exist
          only below `lg`, which left the desktop with no frame at all. */}
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <main className="scrollbar-light flex-1 overflow-y-auto">
          <TopBar onOpenNav={() => setOpen(true)} />
          {/* Canvas padding, and a max width so a 27" monitor does not stretch
              a table to 2000px of unreadable line length. */}
          <div className="mx-auto w-full max-w-[1560px] p-4 sm:p-5 lg:px-8
            lg:py-6">
            <Outlet />
          </div>
        </main>
      </div>

    </div>
  );
}
