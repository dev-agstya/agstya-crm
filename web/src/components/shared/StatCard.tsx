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
      className={`h-full transition-colors ${onClick ? "cursor-pointer hover:border-primary/40 hover:bg-accent/30" : ""} ${className}`}
    >
      <CardContent className="flex h-full flex-col justify-between p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </p>
            <p className={`mt-1 text-xl font-bold tracking-tight tabular-nums ${TONE_CLASS[tone]}`}>
              {value}
            </p>
          </div>
          {icon && (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {icon}
            </div>
          )}
        </div>
        {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
