import { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { InfoTooltip } from "./InfoTooltip";

export function FormSection({
  title,
  description,
  children,
  columns = 2,
  actions,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  columns?: 1 | 2 | 3;
  actions?: ReactNode;
  className?: string;
}) {
  const gridClass =
    columns === 1
      ? "grid-cols-1"
      : columns === 3
        ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
        : "grid-cols-1 md:grid-cols-2";

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 px-4 py-3 pb-2">
        <div>
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          {description && (
            <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </CardHeader>
      <CardContent className={`grid gap-x-4 gap-y-3 px-4 pb-4 pt-1 ${gridClass}`}>
        {children}
      </CardContent>
    </Card>
  );
}

export function FormField({
  label,
  htmlFor,
  required,
  hint,
  tooltip,
  error,
  children,
  className = "",
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  tooltip?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex items-center gap-1">
        <Label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
        {tooltip && <InfoTooltip content={tooltip} />}
      </div>
      {children}
      {hint && !error && (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
      {error && (
        <p role="alert" className="text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
