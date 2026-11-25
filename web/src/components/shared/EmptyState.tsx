import { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <Card className={`border-dashed bg-card/60 ${className}`}>
      <CardContent className="flex flex-col items-center justify-center px-6 py-12 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon ?? <Inbox className="h-6 w-6" />}
        </div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            {description}
          </p>
        )}
        {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
      </CardContent>
    </Card>
  );
}
