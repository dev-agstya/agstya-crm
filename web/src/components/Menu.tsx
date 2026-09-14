import { useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { useClickOutside } from "../lib/useClickOutside";

/**
 * The app's one dropdown-menu surface.
 *
 * Every floating panel hung off a button — the Add Policy split button, the
 * date-range picker, the policy "Notify" menu — used to be its own div with its
 * own radius, shadow, width, z-index and dismiss logic. They now share this
 * one, so a menu looks and behaves the same wherever it is opened.
 *
 * `children` may be a render prop receiving `close`, so an item can dismiss the
 * menu after acting.
 */
// `field` renders the trigger as a form-field (like `.input`, 40px, neutral
// weight, chevron pushed right) so a menu-backed control — e.g. the date filter
// — lines up with the SearchSelect / SearchInput controls in a filter toolbar
// instead of looking like a heavier button next to them.
type MenuVariant = "primary" | "secondary" | "field" | "ghost";

const TRIGGER_CLASS: Record<MenuVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  field: "input flex h-10 w-full items-center justify-between gap-2 font-normal "
    + "text-slate-700",
  // For a menu sitting in a row of borderless actions (a card footer), where a
  // bordered button would read as the important one.
  ghost: "btn-ghost btn-sm",
};

export function Menu({
  label,
  icon,
  variant = "secondary",
  align = "right",
  width = "w-52",
  panelClassName = "",
  disabled = false,
  children,
}: {
  label: ReactNode;
  icon?: ReactNode;
  variant?: MenuVariant;
  align?: "left" | "right";
  width?: string;
  panelClassName?: string;
  disabled?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useClickOutside(ref, close, open);
  const isField = variant === "field";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={TRIGGER_CLASS[variant]}
        onClick={() => setOpen((o) => !o)}
      >
        {isField ? (
          <>
            <span className="flex min-w-0 items-center gap-2">
              {icon}
              {label}
            </span>
            <Icon.ChevronDown size={14}
              className={`shrink-0 text-slate-500 transition-transform ${
                open ? "rotate-180" : ""}`} />
          </>
        ) : (
          <>
            {icon}
            {label}
            <Icon.ChevronDown size={14}
              className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-menu mt-1.5 ${width} overflow-hidden rounded-card
            border border-line bg-white p-1 shadow-pop
            ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

/** One row inside a `Menu`. `trailing` renders right-aligned (e.g. a "Soon" chip). */
export function MenuItem({
  icon, children, onClick, disabled = false, danger = false, trailing,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-control px-3 py-2
        text-left text-sm transition-colors disabled:cursor-not-allowed
        disabled:opacity-50 ${danger
          ? "text-money-out hover:bg-money-out/10"
          : "text-slate-700 hover:bg-slate-100"}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}

/** A "coming soon" chip for menu rows that are advertised but not built. */
export function MenuSoonChip() {
  return (
    <span className="badge shrink-0 bg-due/15 text-due">Soon</span>
  );
}
