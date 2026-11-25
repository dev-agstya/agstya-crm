import { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "info";
  onClick?: () => void;
  className?: string;
}

const TONE_CLASS: Record<NonNullable<StatCardProps["tone"]>, string> = {
  default: "text-foreground",
  success: "text-emerald-600",
  warning: "text-amber-600",
  danger: "text-red-600",
  info: "text-primary",
};

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
  onClick,
  className = "",
}: StatCardProps) {
  return (
    <Card
      onClick={onClick}
      className={`transition-colors ${onClick ? "cursor-pointer hover:border-primary/40 hover:bg-accent/30" : ""} ${className}`}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </p>
            <p className={`mt-1.5 text-2xl font-bold tracking-tight tabular-nums ${TONE_CLASS[tone]}`}>
              {value}
            </p>
          </div>
          {icon && (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {icon}
            </div>
          )}
        </div>
        {hint && <div className="mt-2 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
