import { ReactNode } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface FilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

interface FilterToolbarProps {
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /** Primary inline dropdowns (max 2-3 compact controls) */
  children?: ReactNode;
  /** Secondary filters inside "More filters" popover */
  moreFilters?: ReactNode;
  moreCount?: number;
  chips?: FilterChip[];
  onClearAll?: () => void;
  right?: ReactNode;
}

export function FilterToolbar({
  search,
  children,
  moreFilters,
  moreCount = 0,
  chips = [],
  onClearAll,
  right,
}: FilterToolbarProps) {
  const hasActive = chips.length > 0 || (search && search.value.length > 0);

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {search && (
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? "Search..."}
              className="h-9 bg-card pl-8 text-sm sm:h-8"
            />
          </div>
        )}

        {children}

        {moreFilters && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 bg-card sm:h-8"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>More filters</span>
                {moreCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="h-4 min-w-4 px-1 text-[10px] font-semibold"
                  >
                    {moreCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-3 p-3.5">
              {moreFilters}
            </PopoverContent>
          </Popover>
        )}

        {hasActive && onClearAll && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClearAll}
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <X className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        )}

        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <Badge
              key={c.key}
              variant="secondary"
              className="gap-1 px-2 py-0.5 text-xs font-normal"
            >
              <span>{c.label}</span>
              <button
                type="button"
                onClick={c.onRemove}
                aria-label={`Remove ${c.label}`}
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
