import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { ErrorState, PageLoader } from "./ui";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/**
 * THE shell for a full-page record view or form — what used to be a popup.
 *
 * The app is moving off dialogs for anything with substance (owner 2026-08-03):
 * a record you can link to, refresh, and open in a second tab beats one that
 * only exists while a dialog is on screen. This component is the pattern every
 * converted screen uses, so they cannot drift apart the way the filter bars did.
 *
 * Deliberate choices:
 *
 *  - BACK IS A LINK, NOT `history.back()`. Someone arriving from a pasted URL
 *    has no history to go back to, and a Back button that does nothing is worse
 *    than no Back button. `backTo` always points at the parent list, so it can
 *    never dead-end (owner Q5.4). Browser back still works normally on top of
 *    that.
 *  - LOADING AND ERROR LIVE HERE. A dialog could get away with rendering
 *    nothing until data arrived; a page cannot, because the URL is already
 *    committed. Passing `loading` / `error` gets the standard states for free.
 *  - The tab title comes from the record's own name, so five open tabs are
 *    tellable apart.
 */
export function RecordPage({
  backTo,
  backLabel,
  title,
  subtitle,
  meta,
  badges,
  actions,
  loading = false,
  error,
  onRetry,
  notFound,
  documentTitle,
  children,
}: {
  /** Where Back goes. Always the parent list, never history. */
  backTo: string;
  backLabel: string;
  title: string;
  subtitle?: string;
  /** Small right-aligned detail beside the title — usually the record code. */
  meta?: ReactNode;
  /** Status pills under the title. */
  badges?: ReactNode;
  actions?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Shown instead of the body when the record does not exist. */
  notFound?: boolean;
  documentTitle?: string;
  children: ReactNode;
}) {
  useDocumentTitle(documentTitle ?? (loading ? "" : title));

  return (
    <div>
      <Link
        to={backTo}
        className="mb-4 inline-flex items-center gap-1.5 text-secondary
          font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <Icon.ChevronLeft size={15} />
        {backLabel}
      </Link>

      {loading ? (
        <PageLoader />
      ) : error ? (
        <div className="card"><ErrorState onRetry={onRetry} /></div>
      ) : notFound ? (
        <div className="card">
          <div className="flex flex-col items-center justify-center px-6 py-16
            text-center">
            <div className="mb-3 rounded-full bg-slate-100 p-3.5 text-slate-500">
              <Icon.Search size={24} />
            </div>
            <p className="font-semibold text-slate-800">Not found</p>
            <p className="mt-1 max-w-sm text-sm leading-relaxed text-slate-500">
              This record may have been deleted, or the link is wrong.
            </p>
            <Link to={backTo} className="btn-secondary mt-4">{backLabel}</Link>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start
            sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-page-title text-slate-900">{title}</h1>
                {meta}
              </div>
              {subtitle && (
                <p className="mt-1 text-sm leading-relaxed text-slate-500">
                  {subtitle}</p>
              )}
              {badges && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {badges}
                </div>
              )}
            </div>
            {actions && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {actions}
              </div>
            )}
          </div>
          {children}
        </>
      )}
    </div>
  );
}

/**
 * Underlined tabs for the sections of one record.
 *
 * Distinct from `Tabs` in ui.tsx, which is a segmented control for FILTERING a
 * list — these switch between views of the same thing and read as part of the
 * page rather than as a control sitting on it.
 *
 * Backed by a query parameter so a tab is part of the URL: refreshing, or
 * sending someone "the documents tab of this customer", both work.
 */
export function RecordTabs({ tabs, value, onChange }: {
  tabs: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    // THE RULE THAT LOOKS LIKE A DETAIL: the bottom border belongs to this
    // wrapper, and the negative margin that pulls the active underline onto it
    // belongs to the SCROLLER — never to the buttons.
    //
    // `overflow-x: auto` also makes overflow-y compute to auto, so a child that
    // hangs 1px below its scroller (which is exactly what `-mb-px` on each tab
    // used to do) produces a 1px vertical overflow and the browser draws a
    // vertical scrollbar in the tab strip for it (owner 2026-08-04, customer
    // page). Moving the offset up one level keeps the underline sitting on the
    // rule while the buttons fit their scroller exactly, so there is nothing to
    // scroll vertically. Horizontal scrolling — the thing this is actually for
    // when a record has more tabs than fit — still works.
    <div className="border-b border-line">
      <div role="tablist"
        className="-mb-px flex gap-1 overflow-x-auto scrollbar-light">
        {tabs.map((t) => {
          const active = t.value === value;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.value)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2
                px-4 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "border-ink text-slate-900"
                    : "border-transparent text-slate-500 hover:text-slate-800"}`}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="rounded bg-slate-100 px-1.5 py-px text-[11px]
                  font-semibold tabular-nums text-slate-600">{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A full-page FORM (add / edit), the counterpart of RecordPage for the screens
 * that used to be a dialog with a footer.
 *
 * The narrow column is the point: a form stretched across a 1600px monitor is
 * unreadable, and the old dialogs were at least bounded. Actions sit at the
 * bottom of the card where the dialog footer used to be, so the muscle memory
 * survives the change.
 */
export function FormPage({
  backTo,
  backLabel,
  title,
  subtitle,
  onSubmit,
  submitLabel,
  submitting = false,
  disabled = false,
  secondaryAction,
  loading = false,
  error,
  onRetry,
  notFound,
  wide = false,
  children,
}: {
  backTo: string;
  backLabel: string;
  title: string;
  subtitle?: string;
  onSubmit: () => void;
  submitLabel: string;
  submitting?: boolean;
  disabled?: boolean;
  /** Extra control on the left of the footer — e.g. Delete on an edit form. */
  secondaryAction?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  notFound?: boolean;
  /** For forms with genuinely two columns of fields. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <RecordPage
      backTo={backTo}
      backLabel={backLabel}
      title={title}
      subtitle={subtitle}
      loading={loading}
      error={error}
      onRetry={onRetry}
      notFound={notFound}
    >
      <form
        className={`card ${wide ? "max-w-4xl" : "max-w-2xl"}`}
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      >
        <div className="px-6 py-5">{children}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t
          border-line bg-slate-50/60 px-6 py-3.5">
          {secondaryAction && (
            <div className="mr-auto">{secondaryAction}</div>
          )}
          <Link to={backTo} className="btn-secondary">Cancel</Link>
          <button type="submit" className="btn-primary"
            disabled={disabled || submitting}>
            {submitting ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </RecordPage>
  );
}
