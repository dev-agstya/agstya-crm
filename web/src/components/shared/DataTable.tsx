import { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TableSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  className?: string;
  cell: (row: T) => ReactNode;
  mobileLabel?: string | false;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyField: (row: T) => string;
  onRowClick?: (row: T) => void;
  renderMobileCard?: (row: T) => ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  className?: string;
}

export function DataTable<T>({
  data,
  columns,
  keyField,
  onRowClick,
  renderMobileCard,
  loading = false,
  error = null,
  onRetry,
  emptyTitle = "No records found",
  emptyDescription = "Try adjusting your search or filters, or add a new record.",
  emptyAction,
  page,
  pageSize = 20,
  total,
  onPageChange,
  className = "",
}: DataTableProps<T>) {
  if (loading) {
    return <TableSkeleton rows={8} cols={Math.min(columns.length, 6)} />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }

  if (!data || data.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  const totalPages =
    total !== undefined && pageSize > 0
      ? Math.max(1, Math.ceil(total / pageSize))
      : undefined;

  return (
    <div className={`space-y-2.5 ${className}`}>
      {/* Desktop Table */}
      <Card className="hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 z-raised bg-muted/80 backdrop-blur-sm">
              <TableRow className="border-b border-border hover:bg-transparent">
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    className={`h-9 whitespace-nowrap px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground ${
                      col.align === "right"
                        ? "text-right"
                        : col.align === "center"
                          ? "text-center"
                          : "text-left"
                    } ${col.className ?? ""}`}
                  >
                    {col.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow
                  key={keyField(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={
                    onRowClick
                      ? "cursor-pointer transition-colors hover:bg-muted/50"
                      : "transition-colors hover:bg-muted/20"
                  }
                >
                  {columns.map((col) => (
                    <TableCell
                      key={col.key}
                      className={`px-3 py-2 text-[13px] leading-snug ${
                        col.align === "right"
                          ? "text-right tabular-nums"
                          : col.align === "center"
                            ? "text-center"
                            : "text-left"
                      } ${col.className ?? ""}`}
                    >
                      {col.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Mobile Stacked Cards */}
      <div className="space-y-2 md:hidden">
        {data.map((row) => (
          <Card
            key={keyField(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`p-3 ${onRowClick ? "cursor-pointer active:bg-muted/50" : ""}`}
          >
            {renderMobileCard ? (
              renderMobileCard(row)
            ) : (
              <div className="space-y-1.5">
                {columns.map((col, idx) => {
                  if (col.mobileLabel === false) return null;
                  const label = col.mobileLabel ?? col.header;
                  if (idx === 0) {
                    return (
                      <div key={col.key} className="text-sm font-semibold text-foreground">
                        {col.cell(row)}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={col.key}
                      className="flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 text-xs"
                    >
                      <span className="font-medium text-muted-foreground">
                        {label}
                      </span>
                      <span className="text-right font-medium text-foreground">
                        {col.cell(row)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* Pagination Footer */}
      {page !== undefined && totalPages !== undefined && total !== undefined && onPageChange && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs text-muted-foreground">
          <span className="tabular-nums">
            Showing page {page} of {totalPages} ({total} total)
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
              >
                <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                Prev
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={page >= totalPages}
                onClick={() => onPageChange(page + 1)}
              >
                Next
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
