import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { notificationsApi } from "../../api/endpoints";
import { Icon } from "../Icon";
import { Modal } from "../ui";
import { useAuth } from "../../store/auth";
import { formatDateTime } from "../../lib/format";
import { useSessionNotifications } from "../../lib/sessionNotifications";

/*
  THE BELL, AND ITS PANEL (2026-08-07).

  This used to be a Facebook-style floating circle pinned to the BOTTOM-RIGHT of
  the viewport, which opened a panel above itself. So the control lived in the
  top bar and the thing it opened appeared at the other end of the screen — you
  clicked up here and the answer arrived down there, over whatever you were
  reading.

  It is now a normal popover hanging off the bell that opened it.

  THE PANEL IS A FIXED SIZE and that is deliberate, not incidental:

    * the list area is a fixed height (~7 rows) whatever it contains. A panel
      that shrinks as you dismiss things moves the row under your cursor, so
      clearing four notifications means chasing the list up the screen.
    * past that it SCROLLS. It does not grow.
    * empty, it stays the same size and centres its message, so opening the bell
      always produces the same shape in the same place.
*/

type Row = {
  id: string;
  title: string;
  body?: string | null;
  created_at: string;
  is_read: boolean;
  link?: string | null;
  local?: boolean;
};

// Anything can open the panel: window.dispatchEvent(new Event("notifications:open"))
const OPEN_EVENT = "notifications:open";

// Seven rows at ~62px. Fixed so the box never resizes under the cursor.
const LIST_HEIGHT = "h-[27.5rem]";

export function NotificationBell() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Row | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const session = useSessionNotifications();

  const list = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await notificationsApi.list({ limit: 30 })).data,
    enabled: !!user,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const markAll = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => notificationsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, h);
    return () => window.removeEventListener(OPEN_EVENT, h);
  }, []);

  /*
    Outside click / Escape. BOTH are suspended while a detail dialog is up, and
    the mousedown half of that is not optional (2026-08-21).

    The dialog is `Modal`, which now portals to <body> — it had to, or it
    rendered behind this panel (see the note in components/ui.tsx). That moves
    it OUT of `ref.current`, so every click inside the dialog — its buttons, its
    text, its backdrop — became an "outside" click and slammed the panel shut
    behind the thing you had just opened. Reading it as outside is technically
    correct about the DOM and wrong about the app: the dialog IS this panel's
    own, and closing its owner while it is up leaves you looking at a dialog
    that came from nowhere.

    Escape was already guarded on `active` for the same reason — the dialog owns
    that key while it is open. This is the mouse saying the same thing.
  */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (active) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !active) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, active]);

  if (!user) return null;

  // Persisted server notifications merged with the session-only toast mirror,
  // newest first. Session ones (local: true) are read / dismissed locally.
  const server: Row[] = (list.data ?? []) as Row[];
  const items: Row[] = [...server, ...session.items].sort((a, b) =>
    b.created_at.localeCompare(a.created_at));
  const unread = items.filter((n) => !n.is_read).length;

  const openDetail = (n: Row) => {
    setActive(n);
    if (!n.is_read) {
      if (n.local) session.markRead(n.id);
      else markRead.mutate(n.id);
    }
  };
  const dismiss = (n: Row) => {
    if (n.local) session.remove(n.id);
    else remove.mutate(n.id);
  };
  const markAllRead = () => {
    session.markAllRead();
    if (server.some((n) => !n.is_read)) markAll.mutate();
  };
  const goToLink = (n: Row) => {
    setActive(null);
    setOpen(false);
    if (n.link) nav(n.link);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"}
        title={unread ? `Notifications (${unread} unread)` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`icon-btn relative border-transparent
          ${open ? "bg-slate-100 text-slate-900" : ""}`}
      >
        <Icon.Bell size={19} />
        {unread > 0 && (
          // A count, not a dot: "three things happened" and "one thing
          // happened" are different amounts of urgency.
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4
            items-center justify-center rounded-full bg-money-out px-1
            text-[10px] font-bold leading-none text-white ring-2 ring-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-panel mt-1.5 flex w-[24rem]
            max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-card
            border border-line bg-white shadow-pop animate-slide-up"
        >
          <div className="flex shrink-0 items-center justify-between border-b
            border-line px-4 py-3">
            <h2 className="text-card-title text-slate-900">
              Notifications
              {unread > 0 && (
                <span className="ml-2 text-secondary font-normal
                  text-slate-500">{unread} unread</span>
              )}
            </h2>
            {unread > 0 && (
              <button className="btn-ghost btn-sm" onClick={markAllRead}>
                Mark all read
              </button>
            )}
          </div>

          {/* FIXED height, always. Scrolls past seven; centres when empty. */}
          <div className={`${LIST_HEIGHT} shrink-0 overflow-y-auto
            scrollbar-light`}>
            {items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center
                px-6 text-center">
                <div className="mb-3 flex h-11 w-11 items-center justify-center
                  rounded-full bg-slate-50 text-slate-500 ring-1 ring-inset
                  ring-slate-200/70">
                  <Icon.Bell size={19} />
                </div>
                <p className="text-sm font-medium text-slate-900">
                  You're all caught up</p>
                <p className="mt-1 text-secondary text-slate-500">
                  New alerts land here.</p>
              </div>
            ) : (
              /*
                TWO SIBLING BUTTONS, not a button inside a button. Nested
                interactive elements are invalid HTML: the inner control is not
                reliably keyboard-reachable however many tabIndexes it claims,
                and a screen reader announces one control where there are two.
              */
              items.map((n) => (
                <div key={n.id}
                  className={`flex w-full items-start gap-2.5 border-b
                    border-line-soft px-4 py-3 text-left transition-colors
                    last:border-0 ${n.is_read
                      ? "hover:bg-slate-50" : "bg-slate-50/70 hover:bg-slate-100"}`}>
                  <span aria-hidden="true"
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      n.is_read ? "bg-transparent" : "bg-ink"}`} />
                  <button type="button" onClick={() => openDetail(n)}
                    className="min-w-0 flex-1 rounded text-left">
                    <span title={n.title} className={`block truncate text-sm ${n.is_read
                      ? "text-slate-700" : "font-medium text-slate-900"}`}>
                      {n.title}
                    </span>
                    {n.body && (
                      <span title={n.body} className="mt-0.5 block truncate text-secondary
                        text-slate-500">{n.body}</span>
                    )}
                    <span className="mt-1 block text-[11px] text-slate-500">
                      {formatDateTime(n.created_at)}</span>
                  </button>
                  <button type="button" title="Dismiss" aria-label="Dismiss"
                    className="icon-btn shrink-0 border-transparent
                      hover:text-money-out"
                    onClick={() => dismiss(n)}>
                    <Icon.X size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {active && (
        <Modal open title={active.title} onClose={() => setActive(null)}>
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              {formatDateTime(active.created_at)}</p>
            <p className="whitespace-pre-wrap text-sm text-slate-700">
              {active.body || "No further details."}</p>
              {active.body || "There are no further details for this notification."}</p>
            <div className="flex justify-end gap-2">
              {active.link && (
                <button className="btn-primary" onClick={() => goToLink(active)}>
                  Open</button>
              )}
              <button className="btn-secondary" onClick={() => setActive(null)}>
                Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
