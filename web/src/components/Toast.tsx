import { create } from "zustand";
import { Icon } from "./Icon";
import { recordSessionNotification } from "../lib/sessionNotifications";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

let counter = 0;

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = ++counter;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    // Mirror the toast into the notification bell (session-only; trivial
    // acknowledgements like "Saved."/"Copied" are filtered out there).
    recordSessionNotification(kind, message);
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Convenience helpers.
export const toast = {
  success: (m: string) => useToast.getState().push("success", m),
  error: (m: string) => useToast.getState().push("error", m),
  info: (m: string) => useToast.getState().push("info", m),
};

// White card with a coloured icon, rather than a fully tinted panel: a wall of
// green or red is louder than the message deserves, and it reads as an error
// state for the whole page rather than a note about one action.
const ICON_TONE: Record<ToastKind, string> = {
  success: "bg-money-in/10 text-money-in",
  error: "bg-money-out/10 text-money-out",
  info: "bg-slate-100 text-slate-600",
};

export function ToastHost() {
  const { toasts, dismiss } = useToast();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-toast flex w-full
      max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex items-start gap-3 rounded-card
            border border-line bg-white px-4 py-3 shadow-pop animate-modal-in"
        >
          <span className={`mt-px shrink-0 rounded-full p-1.5 ${
            ICON_TONE[t.kind]}`}>
            {t.kind === "success" ? (
              <Icon.Check size={14} />
            ) : t.kind === "error" ? (
              <Icon.Alert size={14} />
            ) : (
              <Icon.Bell size={14} />
            )}
          </span>
          <p className="flex-1 pt-1 text-sm leading-snug text-slate-800">
            {t.message}</p>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" title="Dismiss"
            className="mt-1 shrink-0 rounded p-0.5 text-slate-500
              transition-colors hover:bg-slate-100 hover:text-slate-700">
            <Icon.X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
