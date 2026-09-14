import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../store/auth";
import { Icon } from "../Icon";
import { NotificationBell } from "../notifications/NotificationBell";
import { TopBarSearch } from "./TopBarSearch";
import { initials } from "../../lib/format";
import { HELP_ITEMS, crumbsForPath } from "../../lib/access";

/*
  THE TOP BAR (2026-08-07).

  There wasn't one. The app shell drew a `lg:hidden` header for phones and,
  above `lg`, nothing at all — so on the screen everybody actually uses there
  was no breadcrumb, no search field, no notification bell and no account chip.
  Search was a button inside the sidebar; notifications were an item buried in
  the sidebar's user dropdown, two clicks from anywhere.

  That is most of why the right-hand side read as "a page floating in grey"
  rather than an application: a window needs a frame at the top, not only down
  one side. Every product the owner referenced has one.

  What it carries, left to right:

    * WHERE YOU ARE — the breadcrumb, derived from the nav config (lib/access
      crumbsForPath) so it can never disagree with the sidebar. It stops at the
      section and lets the page's own <PageHeader> be the leaf; repeating the
      H1 12px above itself is noise.
    * WHAT YOU WANT — the search field, centred, opening the existing ⌘K
      palette. It is a real-looking field rather than an icon because a search
      box that looks like a search box is found without being taught.
    * WHO YOU ARE — notifications and the account menu, top right, where every
      user of every other tool already looks for them.

  The sidebar keeps the logo, the nav and the collapse tab, and nothing else.
*/

export function TopBar({ onOpenNav }: {
  /** Opens the mobile drawer. Only rendered below `lg`. */
  onOpenNav: () => void;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const crumbs = crumbsForPath(location.pathname);
  const isPartner = user?.account_type === "channel_partner";

  useEffect(() => { if (!menuOpen) setHelpOpen(false); }, [menuOpen]);

  // Close the account menu on outside click / Escape. The trigger counts as
  // "inside" so a second click toggles rather than racing this handler.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Navigating closes the menu — otherwise it hangs open over the new page.
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  const go = (to: string) => { setMenuOpen(false); navigate(to); };
  const doLogout = async () => { await logout(); navigate("/login"); };

  const menuRow = "flex w-full items-center gap-2.5 rounded-control px-2.5 "
    + "py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100";

  return (
    <header className="sticky top-0 z-nav flex h-14 shrink-0 items-center gap-3
      border-b border-line bg-white/85 px-3 backdrop-blur-md sm:px-4 lg:px-6">
      {/* Drawer toggle — phones only; the sidebar is always present above lg. */}
      <button onClick={onOpenNav} aria-label="Open menu" title="Open menu"
        className="icon-btn shrink-0 border-transparent lg:hidden">
        <Icon.Menu size={20} />
      </button>

      {/* WHERE YOU ARE. Hidden on phones, where the space is worth more to the
          search field and there is a back link on every record page anyway. */}
      <nav aria-label="Breadcrumb" className="hidden min-w-0 lg:block">
        <ol className="flex items-center gap-1.5 text-secondary">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${c.label}-${i}`}
                className="flex min-w-0 items-center gap-1.5">
                {i > 0 && (
                  <Icon.ChevronRight size={13}
                    className="shrink-0 text-slate-400" aria-hidden="true" />
                )}
                {c.to && !last ? (
                  <Link to={c.to}
                    className="truncate text-slate-500 transition-colors
                      hover:text-slate-900">
                    {c.label}
                  </Link>
                ) : (
                  <span className={`truncate ${last
                    ? "font-medium text-slate-900" : "text-slate-500"}`}
                    aria-current={last ? "page" : undefined}>
                    {c.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Logo on phones, where there is no sidebar to carry it. */}
      <Link to="/dashboard" className="flex min-w-0 items-center lg:hidden">
        <img src="/agastya_hindi_full_logo.png" alt="Agstya Associate"
          className="h-7 w-auto object-contain" />
      </Link>

      {/* WHAT YOU WANT. A real input, with its results anchored underneath —
          it was a button that opened a dialog carrying a SECOND search box, so
          the app showed two of them and the one you clicked was the disabled
          one behind the dim. Staff only: /api/search is staff-only, so a
          partner would get nothing but a 403 out of it. */}
      {!isPartner && <TopBarSearch />}

      {/* WHO YOU ARE. */}
      <div className={`flex shrink-0 items-center gap-1
        ${isPartner ? "ml-auto" : ""}`}>
        {/* The bell owns its own panel, anchored to itself. It used to dispatch
            an event to a floating widget pinned to the BOTTOM-right, so the
            control was up here and the answer appeared down there. */}
        <NotificationBell />

        <div className="relative" ref={menuRef}>
          <button type="button"
            onClick={() => setMenuOpen((m) => !m)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Account menu" title="Account menu"
            className="flex h-9 items-center gap-2 rounded-control pl-1 pr-1.5
              transition-colors hover:bg-slate-100">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center
              rounded-full bg-ink text-[11px] font-semibold text-white">
              {initials(user?.full_name || "")}
            </span>
            <Icon.ChevronDown size={14}
              className={`shrink-0 text-slate-500 transition-transform
                ${menuOpen ? "rotate-180" : ""}`} />
          </button>

          {menuOpen && (
            <div role="menu"
              className="absolute right-0 top-full z-panel mt-1.5 w-60
                overflow-hidden rounded-card border border-line bg-white
                shadow-pop animate-slide-up">
              <div className="border-b border-line px-3 py-2.5">
                <p className="truncate text-sm font-semibold text-slate-900">
                  {user?.full_name}
                </p>
                <p className="truncate text-xs text-slate-500">{user?.email}</p>
              </div>

              <div className="scrollbar-light max-h-[60vh] overflow-y-auto p-1">
                <button type="button" onClick={() => go("/settings")}
                  className={menuRow} role="menuitem">
                  <Icon.Settings size={17} className="text-slate-500" />
                  Settings
                </button>

                <button type="button" onClick={() => setHelpOpen((o) => !o)}
                  className={`${menuRow} justify-between`} role="menuitem"
                  aria-expanded={helpOpen}>
                  <span className="flex items-center gap-2.5">
                    <Icon.Help size={17} className="text-slate-500" /> Help
                  </span>
                  <Icon.ChevronDown size={14}
                    className={`text-slate-400 transition-transform
                      ${helpOpen ? "" : "-rotate-90"}`} />
                </button>
                {helpOpen && (
                  <div className="ml-[26px] flex flex-col border-l border-line
                    pl-2">
                    {HELP_ITEMS.map((h) => (
                      h.locked ? (
                        <span key={h.to} aria-disabled="true"
                          title={`${h.label} — coming soon`}
                          className="flex cursor-not-allowed items-center gap-1.5
                            px-2.5 py-1.5 text-[13px] text-slate-400">
                          {h.label}
                          <Icon.Lock size={11} aria-label="Coming soon" />
                        </span>
                      ) : (
                        <button key={h.to} type="button" role="menuitem"
                          onClick={() => go(h.to)}
                          className="rounded-control px-2.5 py-1.5 text-left
                            text-[13px] text-slate-600 transition-colors
                            hover:bg-slate-100 hover:text-slate-900">
                          {h.label}
                        </button>
                      )
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-line p-1">
                <button type="button" onClick={doLogout} role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-control
                    px-2.5 py-2 text-sm text-money-out transition-colors
                    hover:bg-money-out/10">
                  <Icon.Logout size={17} /> Log out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// The shortcut label lives with the field that shows it.
export { SEARCH_SHORTCUT } from "./TopBarSearch";
