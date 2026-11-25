import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, Loader2, Search } from "lucide-react";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { ErrorState } from "./shared/ErrorState";
import { FormSkeleton } from "./shared/LoadingSkeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
  backTo: string;
  backLabel: string;
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  notFound?: boolean;
  documentTitle?: string;
  children: ReactNode;
}) {
  useDocumentTitle(documentTitle ?? (loading ? "" : title));

  return (
    <div className="space-y-3">
      <Link
        to={backTo}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        {backLabel}
      </Link>

      {loading ? (
        <FormSkeleton sections={2} />
      ) : error ? (
        <ErrorState onRetry={onRetry} />
      ) : notFound ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Search className="h-5 w-5" />
            </div>
            <p className="font-semibold text-foreground">Record not found</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              This record may have been deleted, or the link is wrong.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link to={backTo}>{backLabel}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">
                  {title}
                </h1>
                {meta}
                {badges}
              </div>
              {subtitle && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {subtitle}
                </p>
              )}
            </div>
            {actions && (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
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

export function RecordTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="border-b border-border">
      <div
        role="tablist"
        className="-mb-px flex flex-wrap gap-1 sm:flex-nowrap"
      >
        {tabs.map((t) => {
          const active = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.value)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors sm:text-sm ${
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {t.count !== undefined && (
                <Badge
                  variant="secondary"
                  className="h-4 px-1.5 text-[10px] font-semibold tabular-nums"
                >
                  {t.count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
  maxWidth = "w-full",
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
  secondaryAction?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  notFound?: boolean;
  wide?: boolean;
  maxWidth?: string;
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
      <Card className={maxWidth}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <CardContent className="p-4 sm:p-5">{children}</CardContent>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3 sm:px-5">
            {secondaryAction && (
              <div className="mr-auto">{secondaryAction}</div>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to={backTo}>Cancel</Link>
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={disabled || submitting}
            >
              {submitting && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {submitting ? "Saving..." : submitLabel}
            </Button>
          </div>
        </form>
      </Card>
    </RecordPage>
  );
}
