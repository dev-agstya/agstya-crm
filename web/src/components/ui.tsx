import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { titleCase } from "../lib/format";

/*
  The shared UI kit. The design system is `src/index.css` + `tailwind.config.js`
  — the two files that EXECUTE. There is deliberately no prose copy of them.

  Everything in here is deliberately boring and reusable. If a page needs a
  variant, add it HERE with a prop — a page that hand-rolls its own table header
  or its own filter row is how the app ended up with several of each, which is
  exactly what the 2026-08-03 pass was done to fix.
*/

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"
        className="opacity-20" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4"
        strokeLinecap="round" />
    </svg>
  );
}

export function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center text-slate-500">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

/* ------------------------------------------------------------------ badges -- */

/*
  Status tones — NEUTRAL BY DEFAULT (owner 2026-08-06).

  This map used to run on five colour families (blue, amber, green, red, grey)
  and hand-wrote every tint inline, so a policies list rendered four different
  hues at once and none of them meant anything in particular. "Active" was
  green, which is the money-in colour, on a row that had nothing to do with
  money; "New" was blue next to it.

  The rule now: a badge EARNS colour by meaning money or meaning time.

      .badge-in       money arrived / the goal was met       received, paid
      .badge-out      money lost / the thing is dead         cancelled, lapsed
      .badge-due      a clock is running on it               pending, renewal
      .badge-ink      outranks everything else on the row    owner, business
      .badge-neutral  everything else, which is most things

  Everything ordinary — active, draft, new, contacted, employee, partner — is
  quiet grey. A screen where six things are coloured is a screen where nothing
  reads; the point of the amber is that it is the only amber on the page.

  The tints themselves are `bg-money-in/10` etc. in index.css, derived from the
  SAME token as the text, so there is exactly one green in the product.
*/
const badgeColors: Record<string, string> = {
  // Money arrived, or the outcome was the good one.
  received: "badge-in",
  paid: "badge-in",
  converted: "badge-in",
  approved: "badge-in",
  settled: "badge-in",

  // Money lost, or the record is dead. Red is never "just a status".
  cancelled: "badge-out",
  lapsed: "badge-out",
  rejected: "badge-out",
  lost: "badge-out",
  failed: "badge-out",

  // A clock is running. The one thing on the row you might have to act on.
  pending: "badge-due",
  renewal_due: "badge-due",
  requested: "badge-due",
  overdue: "badge-due",
  // `suspended` and `inactive` are states somebody CHOSE, not deadlines — they
  // were amber and red respectively, which read as two different kinds of
  // alarm for what is really one kind of "switched off".
  suspended: "badge-neutral",
  inactive: "badge-neutral",

  // Outranks the rest of its row.
  owner: "badge-ink",
  business: "badge-ink",

  // Everything ordinary. Listed rather than left to the fallback so that
  // deleting a line here is a visible decision, not a silent colour change.
  active: "badge-neutral",
  draft: "badge-neutral",
  renewed: "badge-neutral",
  expired: "badge-neutral",
  paid_out: "badge-neutral",
  new: "badge-neutral",
  contacted: "badge-neutral",
  quoted: "badge-neutral",
  customer: "badge-neutral",
  channel_partner: "badge-neutral",
  manager: "badge-neutral",
  employee: "badge-neutral",
  agent: "badge-neutral",
  partner: "badge-neutral",
};

const NEUTRAL_BADGE = "badge-neutral";

export function StatusBadge({ value, label }: {
  value: string;
  /** Override the text when the raw value is not what a human should read. */
  label?: string;
}) {
  // The `.badge-*` classes already include `.badge`, so this no longer
  // concatenates one — doing both left `badge badge-neutral` on every chip.
  return (
    <span className={badgeColors[value] || NEUTRAL_BADGE}>
      {label ?? titleCase(value)}
    </span>
  );
}

/* ------------------------------------------------------------------ avatar -- */

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Initials disc. No photos anywhere in this app, so this is the only avatar. */
export function Avatar({ name, size = "md", className = "", tone = "grey" }: {
  name: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  /** `ink` for the subject of the page; `grey` for everyone in a list. */
  tone?: "grey" | "ink";
}) {
  const dims = size === "xs" ? "h-6 w-6 text-[10px]"
    : size === "sm" ? "h-7 w-7 text-[11px]"
      : size === "lg" ? "h-12 w-12 text-sm"
        : "h-9 w-9 text-xs";
  const colour = tone === "ink"
    ? "bg-ink text-white"
    : "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200";
  return (
    <span
      title={name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full
        font-semibold uppercase tracking-wide ${colour} ${dims} ${className}`}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * A person in a list: initials, name, and one quiet line of identifying detail.
 *
 * Pages about people were rendering as grey text rows with the Avatar sitting
 * unused in this file. Scanning a roster works on shape, not on re-reading
 * names, so every list of humans goes through this.
 */
export function PersonCell({ name, sub, badges, tone, size = "sm" }: {
  name: string;
  sub?: ReactNode;
  /** Status chips shown after the name. */
  badges?: ReactNode;
  tone?: "grey" | "ink";
  size?: "xs" | "sm" | "md";
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={name} size={size} tone={tone} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-slate-900">{name}</span>
          {badges}
        </div>
        {sub && (
          <div className="truncate text-xs text-slate-500">{sub}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Overlapping initials for a shared thing (a reminder with several people on
 * it). Past `max` it collapses to "+N" rather than growing without limit.
 */
export function AvatarStack({ names, max = 3 }: {
  names: string[];
  max?: number;
}) {
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="flex items-center" title={names.join(", ")}>
      {shown.map((n, i) => (
        <Avatar key={`${n}-${i}`} name={n} size="xs"
          className={`ring-2 ring-white ${i > 0 ? "-ml-1.5" : ""}`} />
      ))}
      {extra > 0 && (
        <span className="-ml-1.5 inline-flex h-6 items-center justify-center
          rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold
          text-slate-500 ring-2 ring-white">
          +{extra}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------- modal -- */

const MODAL_WIDTHS = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
} as const;

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide = false,
  size,
  headerRight,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One line under the title explaining what this dialog is for. */
  subtitle?: string;
  children: ReactNode;
  /** Pinned to the bottom, outside the scroll area — the action buttons. */
  footer?: ReactNode;
  /** Legacy alias for size="lg". */
  wide?: boolean;
  size?: keyof typeof MODAL_WIDTHS;
  // Optional slot rendered just left of the close (X) button — e.g. an entity
  // code chip (CUS-AA00008 / LED-AA00000) or an actions dropdown.
  headerRight?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // Lock the page behind the dialog. Without this the body scrolls under the
    // overlay whenever the dialog itself has nothing left to scroll, which
    // reads as the app sliding around while you type in a form.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  const width = MODAL_WIDTHS[size ?? (wide ? "lg" : "md")];

  /*
    PORTALLED TO <body>, and that is load-bearing (2026-08-21).

    A dialog was rendering BEHIND the notification panel that opened it. The
    reason was not the z-index: the top bar is `sticky z-nav`, and a positioned
    element with a z-index creates a STACKING CONTEXT — everything rendered
    inside it is sealed into that one layer of the page. The bell lives in the
    top bar, so this overlay was sealed in there with it, and no z-index could
    lift it over anything outside. `position: fixed` covers the viewport
    GEOMETRICALLY while still painting inside its ancestor's layer.

    Rendering into <body> removes the ancestor instead of fighting it, so the
    dialog behaves the same wherever it is opened from — top bar, sidebar,
    inside a sticky table head, or a page. Do not "simplify" this back to an
    inline <div>: it works everywhere the app opens a dialog TODAY and breaks
    the first time one is opened from a stacking context.

    React portals keep the React tree intact, so context, events and the parent
    component's state all still work. Only the DOM position changes — which is
    why no call site had to move, and why the one behaviour that DOES depend on
    DOM position (an outside-click handler that used to contain this subtree)
    is handled explicitly in NotificationBell.
  */
  return createPortal(
    <div
      className="fixed inset-0 z-dialog flex items-start justify-center
        overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-[1px]
        animate-fade-in sm:p-8"
      // Close on the backdrop, but only when the press STARTED there —
      // otherwise dragging to select text inside the dialog and releasing
      // outside it closes the form and loses what was typed.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={panel}
        className={`card my-4 flex max-h-[calc(100vh-4rem)] w-full flex-col
          overflow-hidden shadow-pop animate-modal-in ${width}`}
      >
        <div className="flex items-start justify-between gap-3 border-b
          border-line px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-section text-slate-900">
              {title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-secondary text-slate-500">{subtitle}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerRight}
            <button onClick={onClose} aria-label="Close" title="Close"
              className="icon-btn border-transparent">
              <Icon.X size={16} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-light px-6 py-5">
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2
            border-t border-line bg-slate-50/60 px-6 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ inputs -- */

// A single consistent on/off switch used across the whole portal (owner
// consistency request 2026-07-17): green when ON, neutral grey when OFF.
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center
        rounded-full transition-colors disabled:cursor-not-allowed
        disabled:opacity-60 ${checked ? "bg-money-in" : "bg-slate-300"}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white
        shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

/** Toggle + its caption as one clickable control. */
export function ToggleField({ checked, onChange, label, disabled = false }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={`inline-flex cursor-pointer select-none items-center
      gap-2 text-sm text-slate-600 ${disabled ? "opacity-60" : ""}`}>
      <Toggle checked={checked} onChange={onChange} label={label}
        disabled={disabled} />
      {label}
    </label>
  );
}

// Archive / Unarchive pill button. Archive is RED, Unarchive is ORANGE
// (owner global rule 2026-07-17) — used anywhere delete is replaced by archive.
export function ArchiveButton({
  archived,
  onClick,
  busy = false,
  size = "sm",
}: {
  archived: boolean;
  onClick: () => void;
  busy?: boolean;
  size?: "sm" | "md";
}) {
  const tone = archived
    ? "border-due/25 text-due hover:border-due/25 hover:bg-due/10"
    : "border-money-out/25 text-money-out hover:border-money-out/25 hover:bg-money-out/10";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`btn border bg-white ${size === "sm" ? "btn-sm" : ""} ${tone}`}
    >
      {archived ? <Icon.Refresh size={15} /> : <Icon.Archive size={15} />}
      {archived ? "Unarchive" : "Archive"}
    </button>
  );
}

/* -------------------------------------------------------------------- tabs -- */

export interface TabItem {
  value: string;
  label: string;
  /** Rendered as a pill beside the label. Pass undefined to show nothing. */
  count?: number;
}

/**
 * Segmented tabs for filtering a list by one dimension.
 *
 * A THIN ALIAS over `Segmented` since 2026-08-07 — the two were separate
 * components rendering identical markup, which is how a page ends up with the
 * wrong ARIA for free. Kept because `items`/`Tabs` reads naturally at its call
 * sites; there is one implementation underneath.
 */
export function Tabs({ items, value, onChange, className = "" }: {
  items: TabItem[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <Segmented
      semantics="tabs"
      className={className}
      value={value}
      onChange={onChange}
      options={items}
    />
  );
}

/* ------------------------------------------------------------------- table -- */

/**
 * Shared table shell. Every list in the app hand-rolled its own `<table>` with
 * slightly different header casing, padding and dividers; these primitives fix
 * one rhythm so a list looks the same whichever screen you opened it from.
 *
 * `dense` tightens it further for tables nested inside a modal or a panel.
 */
export function Table({
  head, children, dense = false,
}: {
  head: ReactNode;
  children: ReactNode;
  dense?: boolean;
}) {
  return (
    <div className="overflow-x-auto scrollbar-light">
      <table className={`table ${dense ? "table-dense" : ""}`}
        data-dense={dense || undefined}>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children, align = "left", className = "",
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  const a = align === "right" ? "text-right"
    : align === "center" ? "text-center" : "";
  return <th className={`${a} ${className}`}>{children}</th>;
}

export function Td({
  children, align = "left", className = "", colSpan,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  const a = align === "right" ? "num"
    : align === "center" ? "text-center" : "";
  return (
    <td colSpan={colSpan} className={`${a} ${className}`}>{children}</td>
  );
}

export function Tr({
  children, onClick, active = false, className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.key === "Enter") onClick();
      } : undefined}
      className={`${onClick ? "row-link" : ""} ${
        active ? "bg-slate-50" : ""} ${className}`}
    >
      {children}
    </tr>
  );
}

/* ================================================================== ledger ==
   THE LIST SURFACE (2026-08-07). See the long note in index.css for why.

   Short version: this product is a ledger and had been dressed as a dashboard.
   These primitives commit to the ledger — no card around a list, the figure is
   the biggest thing in the row, urgency is the left edge, and the row has a
   real keyboard route to the record.

   Use `Table` (above) for tables INSIDE a card — a panel on a record page, a
   modal, a report block. Use `Ledger` for a page whose whole job is the list.
   ========================================================================== */

/**
 * A full-width list.
 *
 * `head` is a row of `<LTh>`; children are `<LedgerRow>`. Renders no card, so
 * the row hover runs the full width of the content column.
 */
export function Ledger({ head, children, minWidth }: {
  head: ReactNode;
  children: ReactNode;
  /** Only when the columns genuinely cannot compress further. Prefer fewer. */
  minWidth?: number;
}) {
  return (
    <div className="ledger-wrap">
      <table className="ledger" style={minWidth ? { minWidth } : undefined}>
        <thead><tr>{head}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function LTh({ children, align = "left", className = "", title }: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  /** A short explanation for a header whose column is not self-evident. */
  title?: string;
}) {
  const a = align === "right" ? "text-right"
    : align === "center" ? "text-center" : "";
  return <th className={`${a} ${className}`} title={title}>{children}</th>;
}

/**
 * One row.
 *
 * `onClick` is a mouse convenience; the keyboard route is the `<Link>` that
 * `LedgerCell` renders, never this.
 *
 * There is deliberately NO `rail` prop here. There used to be, and it did
 * nothing: it wrote `data-rail={rail}` and no CSS rule in the project ever
 * matched that attribute. Five pages passed it and got their urgency edge only
 * because they ALSO passed `rail` to `LedgerCell`, which is what actually
 * paints it. A prop that is documented as "the ONLY place urgency is
 * expressed" and is in fact a no-op is a trap for the next page — so the rail
 * lives in exactly one place, on the cell that draws it.
 */
export function LedgerRow({ children, onClick, className = "" }: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={`${onClick ? "cursor-pointer" : ""} ${className}`}
    >
      {children}
    </tr>
  );
}

/**
 * The primary cell: what the row is about, over the context that identifies it.
 *
 * This is what replaced four columns on the Policies table. Customer, insurer,
 * broker and category were never independent facts — they are details OF the
 * policy — and stacking them under it says so while giving the figures room.
 *
 * `to` makes the title a real link. Every list must pass it: it is the row's
 * only keyboard route, and the thing that lets someone open two records in two
 * tabs.
 */
export function LedgerCell({ title, sub, to, rail, mono = false }: {
  title: ReactNode;
  sub?: ReactNode;
  to?: string;
  /** Paints this cell's leading edge. Put it on the FIRST cell of the row. */
  rail?: "due" | "out" | "in" | "ink";
  /** For codes and policy numbers. */
  mono?: boolean;
}) {
  const railClass = rail ? `rail-${rail}` : "";
  return (
    <td className={railClass}>
      {to ? (
        <Link to={to} className={`ledger-primary ledger-focus hover:underline
          decoration-slate-300 underline-offset-2 ${mono ? "font-mono" : ""}`}
          onClick={(e) => e.stopPropagation()}>
          {title}
        </Link>
      ) : (
        <span className={`ledger-primary ${mono ? "font-mono" : ""}`}>
          {title}
        </span>
      )}
      {sub && <span className="ledger-sub">{sub}</span>}
    </td>
  );
}

/** The row's hero figure, with an optional quieter second line under it. */
export function LedgerFigure({ value, sub, tone, className = "" }: {
  value: ReactNode;
  sub?: ReactNode;
  tone?: "in" | "out" | "due";
  className?: string;
}) {
  const colour = tone === "in" ? "text-money-in"
    : tone === "out" ? "text-money-out"
      : tone === "due" ? "text-due" : "";
  return (
    <td className={className}>
      <span className={`ledger-figure ${colour}`}>{value}</span>
      {sub && <span className="ledger-figure-sub">{sub}</span>}
    </td>
  );
}

/* ------------------------------------------------------------ mobile list -- */

/**
 * A list that is CARDS on a phone and a ledger on a laptop.
 *
 * Lifted out of the partner portal (2026-08-07) — it lived in
 * `pages/portal/shared.tsx` and worked well there, while all 30 staff tables
 * had no mobile treatment at all beyond `overflow-x-auto`, which on a phone
 * means a 960px sideways scroll with a sticky header that is off-screen for
 * most of its columns.
 *
 * "The staff app is desktop-first" is a real decision and it stands. But
 * desktop-first and unusable-on-a-phone are different claims, and an owner
 * checking today's collections from a car is an ordinary thing to do.
 *
 * Not a responsive table: a table squeezed to 360px is unreadable whatever the
 * CSS does. Two renderings of the same rows, chosen by breakpoint.
 */
export function ListShell({ empty, cards, table, bare = false }: {
  empty?: ReactNode;
  cards: ReactNode;
  table: ReactNode;
  /**
   * Skip the card around the desktop rendering. Pass this when `table` is a
   * `<Ledger>`, which draws no box by design; leave it off when `table` is a
   * plain `<table>` that still needs one (the portal, panels on record pages).
   */
  bare?: boolean;
}) {
  // ONE branch, not both. This used to render the cards AND the table into the
  // DOM and hide one with `sm:hidden` / `hidden sm:block`, so every list built
  // and mounted its rows twice — 50 subtrees for a 25-row page, all of which
  // the 15-second finance poll then re-reconciled. A pure display toggle is
  // never worth doubling the tree on the app's hottest screens.
  const desktop = useIsWide();
  if (empty) return <div className="card">{empty}</div>;
  if (!desktop) return <div className="space-y-2.5">{cards}</div>;
  return bare ? <>{table}</> : (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto scrollbar-light">{table}</div>
    </div>
  );
}

/**
 * True at Tailwind's `sm:` and above — the breakpoint where a list stops being
 * cards and becomes a table.
 *
 * Initialised from `matchMedia` rather than defaulting to one branch, so the
 * first paint is already correct and nothing flashes.
 */
export function useIsWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined"
      && window.matchMedia("(min-width: 640px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const on = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** One row of the phone rendering: a tappable card. 44px+ tap target. */
export function MobileCard({ to, title, meta, right, footer, rail }: {
  to: string;
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  rail?: "due" | "out" | "in" | "ink";
}) {
  return (
    <Link to={to} className={`card block px-4 py-3 transition-colors
      active:bg-slate-50 ${rail ? `rail-${rail}` : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-slate-900">{title}</p>
          {meta && <div className="mt-0.5 text-xs text-slate-500">{meta}</div>}
        </div>
        {right && <div className="shrink-0 text-right">{right}</div>}
      </div>
      {footer && (
        <div className="mt-2 border-t border-line/70 pt-2 text-xs
          text-slate-500">{footer}</div>
      )}
    </Link>
  );
}

/* ---------------------------------------------------------------- skeleton -- */

/** A grey placeholder block. Use while data loads so the layout never jumps. */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/** Rows of skeletons sized like a table body — the standard list loading state. */
export function TableSkeleton({ rows = 6, cols = 4 }: {
  rows?: number; cols?: number;
}) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r}
          className="flex items-center gap-4 border-b border-line/70 px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c}
              className={`h-3.5 ${c === 0 ? "w-1/4" : "flex-1"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a grid of cards (Bank & Cash, Teams, the KPI rows). */
export function CardSkeleton({ count = 3, className = "" }: {
  count?: number; className?: string;
}) {
  return (
    <div className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card space-y-3 p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ states -- */

export function EmptyState({ title, hint, icon, action }: {
  title: string;
  hint?: string;
  /** Defaults to a magnifier. Pass a more apt one where it helps. */
  icon?: ReactNode;
  /** The one thing to do next — usually the same button as the page header. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14
      text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center
        rounded-full bg-slate-50 text-slate-500 ring-1 ring-inset
        ring-slate-200/70">
        {icon ?? <Icon.Search size={20} />}
      </div>
      <p className="text-[15px] font-semibold tracking-[-0.011em]
        text-slate-900">{title}</p>
      {hint && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-slate-500">
          {hint}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// A consistent failed-to-load state with a Retry action. Use wherever a query
// can error (Render cold starts, dropped connections) so the UI never sits on a
// frozen spinner.
export function ErrorState({
  onRetry,
  message,
}: {
  onRetry?: () => void;
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16
      text-center">
      <div className="mb-3 rounded-full bg-money-out/10 p-3.5 text-money-out">
        <Icon.Alert size={24} />
      </div>
      <p className="font-semibold text-slate-800">Couldn't load this</p>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-slate-500">
        {message ||
          "Something went wrong loading this data. Check your connection and try again."}
      </p>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary mt-4">
          <Icon.Refresh size={15} /> Retry
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- pagination -- */

/**
 * The page numbers, with an ellipsis.
 *
 * This was prev / "3 / 16" / next, so reaching page 11 of a 240-policy book was
 * eight clicks and there was no way to reach the end at all. A record list needs
 * to be jumpable — you know roughly where the thing you want is.
 *
 * `windowed` gives first, last, and ±1 around the current page, with "…" for
 * the gaps: a fixed footprint whatever the page count, and never a row of
 * thirty numbers.
 */
function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) {
    return Array.from({ length: pages }, (_, i) => i + 1);
  }
  const out: (number | "gap")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pages - 1, page + 1);
  if (lo > 2) out.push("gap");
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < pages - 1) out.push("gap");
  out.push(pages);
  return out;
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3
        border-t border-line px-1 py-3 text-secondary text-slate-500">
      <span>
        <span className="font-medium tabular-nums text-slate-700">
          {from}–{to}
        </span>{" "}
        of <span className="tabular-nums">{total}</span>
      </span>
      <div className="flex items-center gap-1">
        <button className="icon-btn" aria-label="Previous page" title="Previous page"
          disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <Icon.ChevronLeft size={16} />
        </button>
        {pageWindow(page, pages).map((p, i) => (
          p === "gap" ? (
            <span key={`gap-${i}`} aria-hidden="true"
              className="px-1 text-slate-400">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onChange(p)}
              aria-label={`Page ${p}`}
              aria-current={p === page ? "page" : undefined}
              className={`inline-flex h-8 min-w-8 items-center justify-center
                rounded-control px-2 text-[13px] font-medium tabular-nums
                transition-colors ${p === page
                  ? "bg-ink text-white"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}
            >
              {p}
            </button>
          )
        ))}
        <button className="icon-btn" aria-label="Next page" title="Next page"
          disabled={page >= pages} onClick={() => onChange(page + 1)}>
          <Icon.ChevronRight size={16} />
        </button>
      </div>
    </nav>
  );
}

/* ---------------------------------------------------------------- row menu -- */

/**
 * The trailing "⋯" on a ledger row.
 *
 * Row actions were inconsistent to the point of absence: TransactionsPage put
 * four bare icon buttons in a trailing cell, and every other ledger page had
 * nothing at all — so renewing a policy or opening a customer's statement meant
 * opening the record first. Four icons is also four targets where one will do,
 * and it made the last column a different width on every page.
 *
 * One menu, opened from one 32px target, closing on pick. Pages supply their
 * own items; `RowMenuItem` keeps them uniform.
 */
export function RowMenu({ children, label = "Row actions" }: {
  children: ReactNode | ((close: () => void) => ReactNode);
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    // The row itself navigates on click, so every event here stops there.
    <div className="relative flex justify-end" ref={ref}
      onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`icon-btn border-transparent ${open ? "bg-slate-100" : ""}`}
      >
        <Icon.More size={16} />
      </button>
      {open && (
        <div role="menu"
          className="absolute right-0 top-full z-menu mt-1 w-48 overflow-hidden
            rounded-card border border-line bg-white p-1 shadow-pop
            animate-slide-up">
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function RowMenuItem({ icon, children, onClick, to, danger = false }: {
  icon?: keyof typeof Icon;
  children: ReactNode;
  onClick?: () => void;
  /** Renders a real link — keyboard, middle-click and copy-link for free. */
  to?: string;
  danger?: boolean;
}) {
  const Glyph = icon ? Icon[icon] : null;
  const cls = `flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5
    text-left text-[13px] transition-colors ${danger
      ? "text-money-out hover:bg-money-out/10"
      : "text-slate-700 hover:bg-slate-100"}`;
  const body = (
    <>
      {Glyph && (
        <Glyph size={15}
          className={danger ? "shrink-0" : "shrink-0 text-slate-500"} />
      )}
      {children}
    </>
  );
  return to
    ? <Link to={to} role="menuitem" className={cls}>{body}</Link>
    : <button type="button" role="menuitem" onClick={onClick} className={cls}>
      {body}</button>;
}

/* ------------------------------------------------------------------ search -- */

// THE list-page search box. Every list used to hand-roll its own (icon at a
// different size — 15/16/18 — different padding, some with no icon at all), so
// two lists side by side looked unrelated. One component now: leading search
// icon, standard 40px height, and a trailing clear (X) once there's text.
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Width/flex utilities for the wrapper (height is fixed for alignment). */
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={`relative ${className}`}>
      <span className="pointer-events-none absolute left-3 top-1/2
        -translate-y-1/2 text-slate-500">
        <Icon.Search size={16} />
      </span>
      <input
        className="input pl-9 pr-8"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5
            text-slate-300 transition-colors hover:bg-slate-100
            hover:text-slate-600"
          onClick={() => onChange("")}
        >
          <Icon.X size={14} />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ fields -- */

export function Field({
  label,
  children,
  required,
  hint,
  error,
  className = "",
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
  hint?: string;
  /** Replaces the hint and turns it red. */
  error?: string;
  /** Column span inside a form grid — `sm:col-span-2` for a wide control. */
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label">
        {label}
        {required && <span className="ml-0.5 text-money-out">*</span>}
      </label>
      {children}
      {error ? <p className="hint-error">{error}</p>
        : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

/**
 * A labelled read-only value — the detail-view counterpart of Field.
 *
 * The label is `slate-500`, not `slate-400` (2026-08-07). #9d9da5 measures
 * 2.69:1 on white and fails WCAG AA; #71717a measures 4.83:1 and passes. This
 * component labels every value on every record page in the product, so it was
 * one line for the widest contrast fix available. `slate-400` is for icons and
 * placeholders, which are exempt — never for text.
 */
export function DetailItem({ label, value, className = "" }: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-caption uppercase text-slate-500">{label}</p>
      <div className="mt-1 text-sm text-slate-800">{value}</div>
    </div>
  );
}

/** A titled block inside a modal or a page. Keeps section rhythm identical. */
export function Section({ title, action, children, className = "" }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-card-title text-slate-900">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The filter row at the top of a list card. One definition, every list. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}

/* ================================================================== metrics ==
   Added 2026-08-05. Before this, every page that wanted a headline figure
   hand-rolled a <div className="card px-4 py-3"> with its own label casing and
   its own number size — there were four different "Tile" components across the
   app and none of them agreed. One definition, used everywhere.
   ========================================================================== */

/**
 * A headline figure.
 *
 * `to` makes the whole tile a link, which is almost always right: a number the
 * user cares about is a number they want to drill into.
 */
export function StatCard({
  label, value, hint, tone, to, icon, meter,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "in" | "out" | "due";
  to?: string;
  icon?: keyof typeof Icon;
  /** 0-1. Draws a proportion bar under the figure. */
  meter?: number;
}) {
  const colour = tone === "in" ? "text-money-in"
    : tone === "out" ? "text-money-out"
      : tone === "due" ? "text-due" : "text-slate-900";
  const Glyph = icon ? Icon[icon] : null;
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption uppercase text-slate-500">{label}</p>
        {Glyph && (
          <span className="text-slate-300"><Glyph size={15} /></span>
        )}
      </div>
      <p className={`mt-2 break-words text-metric tabular-nums ${colour}`}>
        {value}
      </p>
      {meter !== undefined && (
        <div className="meter mt-2.5">
          <div className={`meter-fill ${tone === "in" ? "meter-fill-in"
            : tone === "due" ? "meter-fill-due" : ""}`}
            style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }} />
        </div>
      )}
      {hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}
    </>
  );
  return to
    ? <Link to={to} className="card-link px-5 py-4">{body}</Link>
    : <div className="card card-body">{body}</div>;
}

/** A row of stat cards. Fixed rhythm so no page invents its own grid. */
export function StatRow({ children, cols = 4 }: {
  children: ReactNode;
  cols?: 2 | 3 | 4;
}) {
  const grid = cols === 2 ? "sm:grid-cols-2"
    : cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4";
  return (
    <div className={`grid grid-cols-2 gap-3 ${grid}`}>{children}</div>
  );
}

/**
 * A proportion, drawn rather than written.
 *
 * "12 / 30" is a progress bar spelled out in text. So is a premium figure that
 * only means anything next to the other rows. Both go through this.
 */
export function Meter({ value, total, tone, className = "", title }: {
  value: number;
  total: number;
  tone?: "in" | "due";
  className?: string;
  /** A short explanation of what the bar is relative to, shown on hover. */
  title?: string;
}) {
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  return (
    <div className={`meter ${className}`} title={title}
      role="progressbar" aria-valuenow={value} aria-valuemin={0}
      aria-valuemax={total}>
      <div className={`meter-fill ${tone === "in" ? "meter-fill-in"
        : tone === "due" ? "meter-fill-due" : ""}`}
        style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

/**
 * Two parts of a whole in one bar — used for the split between business a
 * manager's partners brought in and what they sold themselves.
 *
 * This replaced two adjacent table columns, each holding a count AND a money
 * figure joined by a "·". Nobody could read those.
 */
export function SplitBar({ a, b, aLabel, bLabel }: {
  a: number; b: number; aLabel: string; bLabel: string;
}) {
  const total = a + b;
  const aPct = total > 0 ? (a / total) * 100 : 0;
  return (
    <div className="min-w-[7rem]" title={`${aLabel}: ${a} · ${bLabel}: ${b}`}>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className="bg-ink transition-[width] duration-500"
          style={{ width: `${aPct}%` }} />
        <div className="flex-1 bg-slate-300" />
      </div>
      <div className="mt-1.5 flex items-center gap-2.5 text-[11px]
        text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-ink" />{aLabel}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />{bLabel}
        </span>
      </div>
    </div>
  );
}

/**
 * A segmented control: pick ONE of a few. Filters a list, or switches a view.
 *
 * Lists were being filtered with on/off Toggles, which is wrong twice: a switch
 * means "change a setting", and two switches offer four states where the user
 * wanted one of three. The counts matter — they say what you are about to hide.
 *
 * This absorbed `Tabs` (2026-08-07). The two were near-identical — same `.seg` /
 * `.seg-item` / `.seg-item-active` classes, same count pill, same two-branch
 * styling — and differed only in ARIA: `role="tablist"`/`aria-selected` versus
 * `role="group"`/`aria-pressed`. Two components with one appearance means a page
 * picking the wrong one silently gets the wrong semantics, so `semantics` is now
 * a prop and there is one implementation.
 */
export function Segmented<T extends string>({
  options, value, onChange, semantics = "filter", fill = false, className = "",
}: {
  options: { value: T; label: string; count?: number;
    icon?: keyof typeof Icon }[];
  value: T;
  onChange: (v: T) => void;
  /**
   * `tabs` when the choice swaps the CONTENT below it (a record's tabs, a
   * page's views); `filter` when it narrows a list that stays the same thing.
   * Screen readers announce these differently and both announcements are real.
   */
  semantics?: "tabs" | "filter";
  /** Spread to the full width of the container — for a top-level view switch. */
  fill?: boolean;
  className?: string;
}) {
  const tabs = semantics === "tabs";
  return (
    <div className={`seg ${fill ? "w-full" : ""} ${className}`}
      role={tabs ? "tablist" : "group"}>
      {options.map((o) => {
        const active = o.value === value;
        const Glyph = o.icon ? Icon[o.icon] : null;
        return (
          <button key={o.value} type="button"
            role={tabs ? "tab" : undefined}
            aria-selected={tabs ? active : undefined}
            aria-pressed={tabs ? undefined : active}
            onClick={() => onChange(o.value)}
            className={`seg-item ${fill ? "flex-1 justify-center" : ""} ${
              active ? "seg-item-active" : ""}`}>
            {Glyph && <Glyph size={15} className="shrink-0" />}
            {o.label}
            {o.count !== undefined && (
              <span className={`rounded px-1.5 py-px text-[11px] font-semibold
                tabular-nums ${active ? "bg-slate-100 text-slate-600"
                  : "bg-slate-200/60 text-slate-500"}`}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A heading that separates groups of rows INSIDE one card.
 *
 * The alternative — a separate card per group — turns one list into three
 * floating boxes and loses the shared column alignment that makes a table
 * readable.
 */
export function GroupHeader({ label, count, tone }: {
  label: string; count?: number; tone?: "due" | "muted";
}) {
  return (
    <div className={`flex items-center gap-2 border-b border-line px-5 py-2
      ${tone === "due" ? "bg-due/[0.04]" : "bg-slate-50/70"}`}>
      <span className={`text-caption uppercase ${tone === "due"
        ? "text-due" : "text-slate-500"}`}>{label}</span>
      {count !== undefined && (
        <span className="text-caption tabular-nums text-slate-500">
          {count}
        </span>
      )}
    </div>
  );
}
