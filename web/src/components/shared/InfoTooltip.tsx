import { ReactNode, useState } from "react";
import { HelpCircle } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Tap-friendly info tooltip. Uses Popover under the hood so it works identically
 * on desktop click/focus AND mobile tap without requiring hover.
 */
export function InfoTooltip({
  content,
  label = "More information",
}: {
  content: ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="max-w-xs p-3 text-xs leading-relaxed text-foreground shadow-md"
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
