import { useEffect, type RefObject } from "react";

/**
 * Close-on-outside-click / Escape for popovers, menus and inline result panels.
 *
 * Four near-identical copies of this effect existed across the app, each with
 * its own subtly different rules (some listened on `window`, some on
 * `document`, only some handled Escape). One implementation means every
 * floating surface dismisses the same way.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose, active]);
}
