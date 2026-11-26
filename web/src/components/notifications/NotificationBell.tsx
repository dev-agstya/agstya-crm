import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Bell, Check, ExternalLink, X } from "lucide-react";
import { notificationsApi } from "../../api/endpoints";
import { useAuth } from "../../store/auth";
import { formatDateTime } from "../../lib/format";
import { useSessionNotifications } from "../../lib/sessionNotifications";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/*
  THE BELL, AND ITS PANEL (2026-08-07).

  A clean popover hanging off the bell that opened it.
  Compact and fast:
    * Compact list area with scroll for longer notification feeds.
    * Empty state fits its content neatly without wasting screen real estate.
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
    Outside click / Escape handling. Suspended while a detail dialog is open.
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
    b.created_at.localeCompare(a.created_at)
  );
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
      <Button
        variant="ghost"
        size="icon"
        type="button"
        aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"}
        title={unread ? `Notifications (${unread} unread)` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`relative h-9 w-9 ${open ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-background">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-1.5 flex w-80 sm:w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg animate-in fade-in-50 zoom-in-95"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">Notifications</span>
              {unread > 0 && (
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-medium">
                  {unread} unread
                </Badge>
              )}
            </div>
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={markAllRead}
              >
                <Check className="mr-1 h-3 w-3" />
                Mark all read
              </Button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-6 text-center">
                <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Bell className="h-4 w-4" />
                </div>
                <p className="text-xs font-semibold text-foreground">
                  You're all caught up
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  New alerts will appear here.
                </p>
              </div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  className={`flex w-full items-start gap-2.5 border-b border-border/50 px-3.5 py-2.5 text-left transition-colors last:border-0 ${
                    n.is_read
                      ? "hover:bg-muted/50"
                      : "bg-muted/30 hover:bg-muted/70 font-medium"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      n.is_read ? "bg-transparent" : "bg-primary"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => openDetail(n)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span
                      title={n.title}
                      className={`block truncate text-xs ${
                        n.is_read ? "text-muted-foreground" : "font-semibold text-foreground"
                      }`}
                    >
                      {n.title}
                    </span>
                    {n.body && (
                      <span
                        title={n.body}
                        className="mt-0.5 block truncate text-[11px] text-muted-foreground"
                      >
                        {n.body}
                      </span>
                    )}
                    <span className="mt-1 block text-[10px] text-muted-foreground/80 tabular-nums">
                      {formatDateTime(n.created_at)}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    title="Dismiss"
                    aria-label="Dismiss"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => dismiss(n)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {active && (
        <Dialog open={!!active} onOpenChange={(v) => !v && setActive(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold leading-snug">
                {active.title}
              </DialogTitle>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(active.created_at)}
              </p>
            </DialogHeader>
            <div className="py-2 text-xs leading-relaxed text-foreground whitespace-pre-wrap">
              {active.body || "There are no further details for this notification."}
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              {active.link && (
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => goToLink(active)}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setActive(null)}
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
