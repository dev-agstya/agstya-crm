import { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { crumbsForPath } from "../lib/access";
import { InfoTooltip } from "./shared/InfoTooltip";

export function PageHeader({
  title,
  subtitle,
  info,
  actions,
  documentTitle,
  backTo,
  backLabel,
  figure,
}: {
  title: string;
  subtitle?: string;
  /** Optional longer guidance moved into an info icon tooltip */
  info?: string;
  actions?: ReactNode;
  documentTitle?: string;
  /** Kept in props for backwards compatibility; ignored visually per single-line header rule */
  eyebrow?: string;
  backTo?: string;
  backLabel?: string;
  figure?: {
    label: string;
    value: ReactNode;
    tone?: "in" | "out" | "due";
  };
}) {
  useDocumentTitle(documentTitle ?? title);
  const { pathname } = useLocation();
  const crumbs = crumbsForPath(pathname);
  const lastCrumb = crumbs[crumbs.length - 1]?.label?.trim().toLowerCase();
  const duplicatesCrumb = !backTo && lastCrumb === title.trim().toLowerCase();

  const figureTone =
    figure?.tone === "in"
      ? "text-emerald-600"
      : figure?.tone === "out"
        ? "text-red-600"
        : figure?.tone === "due"
          ? "text-amber-600"
          : "text-foreground";

  const hasContent =
    !!backTo || !duplicatesCrumb || !!info || !!actions || !!figure;
  if (!hasContent) return null;

  return (
    <div className="mb-3">
      {backTo && (
        <Link
          to={backTo}
          className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <h1
            className={`text-lg font-bold tracking-tight text-foreground sm:text-xl ${
              duplicatesCrumb ? "lg:hidden" : ""
            }`}
          >
            {title}
          </h1>
          {subtitle && (
            <span
              className={`truncate text-xs text-muted-foreground ${
                duplicatesCrumb ? "lg:hidden" : ""
              }`}
            >
              {subtitle}
            </span>
          )}
          {info && <InfoTooltip content={info} />}
        </div>
        {(actions || figure) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {figure && (
              <div className="flex items-baseline gap-2 rounded-md border border-border bg-card px-2.5 py-1">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {figure.label}
                </span>
                <span className={`text-sm font-bold tabular-nums ${figureTone}`}>
                  {figure.value}
                </span>
              </div>
            )}
            {actions && (
              <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
