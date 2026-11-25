import { ReactNode } from "react";
import { ChevronRight, Target, TrendingUp, Users } from "lucide-react";
import { EmptyState } from "./shared/EmptyState";
import { ErrorState } from "./shared/ErrorState";
import { TableSkeleton } from "./shared/LoadingSkeleton";
import { initials } from "../lib/format";
import type { UserRow } from "../lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function PeopleTable({
  rows,
  loading,
  error = false,
  onRetry,
  kind,
  onTeam,
  inactive = false,
  onView,
  onTargets,
  onAnalytics,
  toolbar,
}: {
  rows: UserRow[];
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
  toolbar?: ReactNode;
  kind: "employee" | "channel_partner";
  onTeam?: (u: UserRow) => void;
  inactive?: boolean;
  onView: (u: UserRow) => void;
  onTargets?: (u: UserRow) => void;
  onAnalytics?: (u: UserRow) => void;
}) {
  const noun = kind === "employee" ? "employee" : "channel partner";
  const isEmp = kind === "employee";

  const shell = (children: ReactNode) => (
    <Card className="overflow-hidden">
      {toolbar && (
        <div className="border-b border-border px-3.5 py-2.5">{toolbar}</div>
      )}
      {children}
    </Card>
  );

  if (error) {
    return shell(<ErrorState onRetry={onRetry} />);
  }
  if (loading) {
    return shell(<TableSkeleton cols={4} />);
  }
  if (rows.length === 0) {
    return shell(
      <EmptyState
        icon={<Users className="h-5 w-5" />}
        title={inactive ? `No deactivated ${noun}s` : `No ${noun}s yet`}
        description={
          inactive
            ? "Accounts that have been switched off appear here."
            : `Add your first ${noun} to get started.`
        }
      />
    );
  }

  return shell(
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30">
            <TableHead className="h-9 text-xs">Name</TableHead>
            <TableHead className="h-9 text-xs">Contact</TableHead>
            {isEmp && <TableHead className="h-9 text-xs">Designation</TableHead>}
            {isEmp && onTeam && (
              <TableHead className="h-9 text-xs">Team</TableHead>
            )}
            {!isEmp && (
              <TableHead className="h-9 text-xs">
                Relationship manager
              </TableHead>
            )}
            <TableHead className="h-9 w-24 text-right text-xs" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((u) => {
            const openable = !u.is_deleted;
            return (
              <TableRow
                key={u.id}
                className={`group ${openable ? "cursor-pointer" : ""} ${
                  inactive ? "opacity-70" : ""
                }`}
                tabIndex={openable ? 0 : undefined}
                onKeyDown={
                  openable
                    ? (e) => {
                        if (e.key === "Enter") onView(u);
                      }
                    : undefined
                }
                onClick={openable ? () => onView(u) : undefined}
              >
                <TableCell className="py-2">
                  <div className="flex items-center gap-2.5">
                    <Avatar className="h-7 w-7 shrink-0">
                      <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                        {initials(u.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {u.full_name}
                        </span>
                        {u.is_deleted && (
                          <Badge
                            variant="secondary"
                            className="h-4 px-1.5 text-[10px]"
                          >
                            removed
                          </Badge>
                        )}
                        {!u.is_deleted && inactive && (
                          <Badge
                            variant="outline"
                            className="h-4 border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800"
                          >
                            deactivated
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] font-mono text-muted-foreground">
                        {u.code}
                      </p>
                    </div>
                  </div>
                </TableCell>

                <TableCell className="py-2">
                  <p className="text-[13px] text-foreground">
                    {u.mobile || "—"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {u.email}
                  </p>
                </TableCell>

                {isEmp && (
                  <TableCell className="py-2 text-[13px] text-muted-foreground">
                    {u.employee_profile?.designation || "—"}
                  </TableCell>
                )}

                {isEmp && onTeam && (
                  <TableCell
                    className="py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {u.partners_under ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        title={`Open ${u.full_name}'s team`}
                        onClick={() => onTeam(u)}
                      >
                        <Users className="mr-1 h-3 w-3" />
                        {u.partners_under} partner
                        {u.partners_under === 1 ? "" : "s"}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No partners
                      </span>
                    )}
                  </TableCell>
                )}

                {!isEmp && (
                  <TableCell className="py-2 text-[13px] text-muted-foreground">
                    {u.relationship_manager_name || "—"}
                  </TableCell>
                )}

                <TableCell className="py-2 text-right">
                  <div
                    className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!inactive && onAnalytics && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Analytics"
                        aria-label={`Analytics for ${u.full_name}`}
                        onClick={() => onAnalytics(u)}
                      >
                        <TrendingUp className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {!inactive && onTargets && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Targets"
                        aria-label={`Targets for ${u.full_name}`}
                        onClick={() => onTargets(u)}
                      >
                        <Target className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {openable && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="View profile"
                        aria-label={`View ${u.full_name}`}
                        onClick={() => onView(u)}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
