import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { useDocumentTitle } from "../lib/useDocumentTitle";

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
  documentTitle?: string;
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
  const figureTone =
    figure?.tone === "in"
      ? "text-emerald-600"
      : figure?.tone === "out"
        ? "text-red-600"
        : figure?.tone === "due"
          ? "text-amber-600"
          : "text-foreground";

  return (
    <div className="mb-6 border-b border-border/60 pb-5">
      {backTo && (
        <Link
          to={backTo}
          className="mb-2.5 inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {(actions || figure) && (
          <div className="flex shrink-0 flex-wrap items-center gap-4">
            {figure && (
              <div className="rounded-lg border border-border bg-card px-4 py-2 text-left sm:text-right">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {figure.label}
                </p>
                <p className={`text-xl font-bold tracking-tight tabular-nums ${figureTone}`}>
                  {figure.value}
                </p>
              </div>
            )}
            {actions && (
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
