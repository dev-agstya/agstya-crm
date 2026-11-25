import { AlertCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = "Could not load this information",
  message = "Something went wrong while fetching the data. Please try again.",
  onRetry,
  className = "",
}: ErrorStateProps) {
  return (
    <Alert variant="destructive" className={`bg-destructive/5 ${className}`}>
      <AlertCircle className="h-4 w-4" />
      <AlertTitle className="font-semibold">{title}</AlertTitle>
      <AlertDescription className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm">{message}</span>
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="w-fit border-destructive/30 bg-background text-destructive hover:bg-destructive/10"
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
