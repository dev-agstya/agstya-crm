import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/**
 * The heading every page starts with.
 *
 * It also names the browser tab. Doing it here rather than per page means a new
 * page cannot forget — the title comes free with the heading it already
 * renders, and it is the page's own words rather than a label looked up from
 * the nav config (which left every non-nav page mis-titled).
 *
 * Rebuilt 2026-08-05: the subtitle used to be a full-width paragraph of
 * explanation that pushed the actual content below the fold and gave every
 * page the same grey wall on top. It is now capped, quieter, and optional in
 * practice — and `eyebrow` carries the "where am I" context that pages were
 * putting into the subtitle sentence.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  documentTitle,
  eyebrow,
  backTo,
  backLabel,
  figure,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Override when the tab should read differently from the heading. */
  documentTitle?: string;
  /** Small label above the title — the section this page belongs to. */
  eyebrow?: string;
  /** Renders a back link above the title. For pages opened from a list. */
  backTo?: string;
  backLabel?: string;
  /**
   * The ONE number the page is about, set opposite the title (2026-08-07).
   *
   * This is the asymmetry the ledger direction runs on: weight on the right
   * rather than a centred hero, and the figure a user opened the page FOR
   * reading before the list does. `metric-lg` is the top of the figure ladder
   * and only one thing per page may wear it — so a page with a `figure` must
   * not also put a `metric-lg` in its body.
   */
  figure?: {
    label: string;
    value: ReactNode;
    tone?: "in" | "out" | "due";
  };
}) {
  useDocumentTitle(documentTitle ?? title);
  const figureTone = figure?.tone === "in" ? "text-money-in"
    : figure?.tone === "out" ? "text-money-out"
      : figure?.tone === "due" ? "text-due" : "text-slate-900";

  return (
    <div className="mb-6">
      {backTo && (
        <Link to={backTo}
          className="mb-2 inline-flex items-center gap-1 text-secondary
            font-medium text-slate-500 transition-colors hover:text-slate-900">
          <Icon.ChevronLeft size={14} />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start
        sm:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-1 text-caption uppercase text-slate-500">
              {eyebrow}</p>
          )}
          <h1 className="text-page-title text-slate-900">{title}</h1>
          {subtitle && (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed
              text-slate-500">{subtitle}</p>
          )}
        </div>
        {(actions || figure) && (
          <div className="flex shrink-0 flex-wrap items-end gap-x-6 gap-y-3">
            {actions && (
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            )}
            {figure && (
              <div className="text-left sm:text-right">
                <p className="text-caption uppercase text-slate-500">
                  {figure.label}</p>
                <p className={`mt-0.5 text-metric-lg tabular-nums
                  ${figureTone}`}>{figure.value}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
