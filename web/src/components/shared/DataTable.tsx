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
  /** Render cell content for desktop table */
  cell: (row: T) => ReactNode;
  /** Optional label for mobile card layout (defaults to header; set false to hide on mobile card) */
  mobileLabel?: string | false;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyField: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Optional custom mobile card renderer; if omitted, auto-renders a clean stacked card from columns */
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
    return <TableSkeleton rows={6} cols={Math.min(columns.length, 6)} />;
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
    total !== undefined && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : undefined;

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Desktop Table */}
      <Card className="hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    className={`whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-muted-foreground ${
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
                      className={`py-3.5 text-sm ${
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
      <div className="space-y-3 md:hidden">
        {data.map((row) => (
          <Card
            key={keyField(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`p-4 ${onRowClick ? "cursor-pointer active:bg-muted/50" : ""}`}
          >
            {renderMobileCard ? (
              renderMobileCard(row)
            ) : (
              <div className="space-y-2.5">
                {columns.map((col, idx) => {
                  if (col.mobileLabel === false) return null;
                  const label = col.mobileLabel ?? col.header;
                  if (idx === 0) {
                    return (
                      <div key={col.key} className="font-semibold text-foreground">
                        {col.cell(row)}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={col.key}
                      className="flex items-center justify-between gap-3 border-t border-border/50 pt-2 text-sm"
                    >
                      <span className="text-xs font-medium text-muted-foreground">
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

      {/* Pagination */}
      {page !== undefined && totalPages !== undefined && totalPages > 1 && onPageChange && (
        <div className="flex flex-col items-center justify-between gap-3 pt-1 sm:flex-row">
          <p className="text-xs text-muted-foreground tabular-nums">
            Page {page} of {totalPages} ({total} total)
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
