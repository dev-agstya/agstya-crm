import { create } from "zustand";

// A session-scoped mirror of the toast messages so anything that flashes as a
// toast is also findable in the notification bell (owner 2026-07-26). These live
// only in memory — they are NOT persisted to the server (no DB spam) and clear
// on a page refresh; the real server notifications are unaffected.

export type SessionKind = "success" | "error" | "info";

export interface SessionNotification {
  id: string;
  kind: SessionKind;
  title: string;
  created_at: string; // ISO
  is_read: boolean;
  local: true;
}

// Pure acknowledgement toasts not worth logging in the bell (owner: "avoid
// saved/copied noise"). Matched case-insensitively at the start of the message.
// Expanded to filter out "trash" login/profile updates.
const TRIVIAL = /^(saved|copied|profile|logged in|signed in|welcome|password|email|updated|deleted)\b/i;

interface State {
  items: SessionNotification[];
  add: (kind: SessionKind, message: string) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
}

let counter = 0;

export const useSessionNotifications = create<State>((set) => ({
  items: [],
  add: (kind, message) => {
    const msg = message.trim();
    if (!msg || TRIVIAL.test(msg)) return;
    const n: SessionNotification = {
      id: `local-${++counter}`,
      kind,
      title: msg,
      created_at: new Date().toISOString(),
      is_read: false,
      local: true,
    };
    set((s) => ({ items: [n, ...s.items].slice(0, 50) }));
  },
  markRead: (id) =>
    set((s) => ({
      items: s.items.map((n) => (n.id === id ? { ...n, is_read: true } : n)),
    })),
  markAllRead: () =>
    set((s) => ({ items: s.items.map((n) => ({ ...n, is_read: true })) })),
  remove: (id) =>
    set((s) => ({ items: s.items.filter((n) => n.id !== id) })),
}));

// Fire-and-forget recorder called from the toast helper.
export const recordSessionNotification = (kind: SessionKind, message: string) =>
  useSessionNotifications.getState().add(kind, message);
