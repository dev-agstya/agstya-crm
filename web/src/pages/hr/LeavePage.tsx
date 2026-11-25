import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  User,
  Users,
} from "lucide-react";
import { leaveApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, Column } from "../../components/shared/DataTable";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import {
  AdjustBalanceDialog,
  LeaveFormDialog,
} from "../../components/hr/LeaveForm";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import {
  LEAVE_STATUS_LABELS,
  REASON_LABELS,
  formatDays,
  leaveRangeLabel,
} from "../../lib/hr";
import { formatDate, initials } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { HrRequestStatus, LeaveRequest } from "../../lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/*
  Leave UX pattern: Workday/Linear style — compact single-line PageHeader with info tooltip,
  a slim 4-metric balance strip, clean Tabs (My leave / Requests / Who is off), and compact
  DataTable rows with inline action buttons and collapsible balance ledger.
*/

type View = "mine" | "requests" | "who";

const PAGE_SIZE = 25;

const STATUS_BADGE_CLS: Record<HrRequestStatus, string> = {
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  cancelled: "bg-muted text-muted-foreground border-border",
};

const LEDGER_LABELS: Record<string, string> = {
  opening: "Opening balance",
  accrual: "Monthly leave",
  usage: "Leave taken",
  refund: "Given back",
  adjustment: "Adjusted by hand",
  lapse: "Lapsed at the end of the leave year",
};

export default function LeavePage() {
  const { user, has } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  const canSeeAll = has("view_leave");
  const canManage = has("manage_leave");

  const requested = params.get("view") as View | null;
  const [view, setView] = useState<View>(
    requested === "requests" && canSeeAll
      ? "requests"
      : requested === "who"
        ? "who"
        : "mine"
  );
  const [applying, setApplying] = useState(false);
  const [editing, setEditing] = useState<LeaveRequest | null>(null);
  const [onBehalf, setOnBehalf] = useState<{ id: string; name: string } | null>(
    null
  );
  const [adjusting, setAdjusting] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [showLedger, setShowLedger] = useState(false);
  const [minePage, setMinePage] = useState(1);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [queuePage, setQueuePage] = useState(1);

  const setView2 = (v: View) => {
    setView(v);
    const next = new URLSearchParams(params);
    if (v === "mine") next.delete("view");
    else next.set("view", v);
    setParams(next, { replace: true });
  };

  const changeStatusFilter = (v: string) => {
    setStatusFilter(v);
    setQueuePage(1);
  };

  const balance = useQuery({
    queryKey: ["hr", "leave-balance"],
    queryFn: async () => (await leaveApi.balance()).data,
  });

  const mine = useQuery({
    queryKey: ["hr", "leave-mine", minePage],
    queryFn: async () =>
      (
        await leaveApi.requests({
          mine: true,
          page: minePage,
          page_size: PAGE_SIZE,
        })
      ).data,
    enabled: view === "mine",
  });

  const ledger = useQuery({
    queryKey: ["hr", "leave-ledger", ledgerPage],
    queryFn: async () =>
      (
        await leaveApi.ledger({
          page: ledgerPage,
          page_size: PAGE_SIZE,
        })
      ).data,
    enabled: view === "mine",
  });

  const queue = useQuery({
    queryKey: ["hr", "leave-queue", statusFilter, queuePage],
    queryFn: async () =>
      (
        await leaveApi.requests({
          mine: false,
          status: statusFilter || undefined,
          page: queuePage,
          page_size: PAGE_SIZE,
        })
      ).data,
    enabled: view === "requests" && canSeeAll,
  });

  const pendingTotal = useQuery({
    queryKey: ["hr", "leave-pending-total"],
    queryFn: async () =>
      (
        await leaveApi.requests({
          mine: false,
          status: "pending",
          page: 1,
          page_size: 1,
        })
      ).data.total,
    enabled: canSeeAll,
  });

  const who = useQuery({
    queryKey: ["hr", "who-is-off"],
    queryFn: async () => (await leaveApi.whoIsOff(14)).data,
    enabled: view === "who",
  });

  const employees = useQuery({
    queryKey: ["hr", "employees-for-leave"],
    queryFn: async () =>
      (await usersApi.list({ account_type: "employee", page_size: 200 })).data,
    enabled: canManage && view === "requests",
  });

  const decide = useMutation({
    mutationFn: async (v: { id: string; approve: boolean; note?: string }) =>
      (await leaveApi.decide(v.id, v.approve, v.note)).data,
    onSuccess: (r, v) => {
      toast.success(
        v.approve
          ? `Approved — ${formatDays(r.days)}${
              r.unpaid_days > 0
                ? `, of which ${formatDays(r.unpaid_days)} unpaid`
                : ""
            }.`
          : "Rejected."
      );
      qc.invalidateQueries({ queryKey: ["hr"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => (await leaveApi.cancel(id)).data,
    onSuccess: () => {
      toast.success("Withdrawn. Any balance it used has gone back.");
      qc.invalidateQueries({ queryKey: ["hr"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const askCancel = async (r: LeaveRequest) => {
    const ok = await confirmDialog({
      title: `Withdraw ${r.code}?`,
      message:
        r.status === "approved"
          ? `${formatDays(r.paid_days)} will go back onto the balance.`
          : "The request will be withdrawn before anybody decides it.",
      confirmLabel: "Withdraw it",
    });
    if (ok) cancel.mutate(r.id);
  };

  const b = balance.data;
  const pendingCount = pendingTotal.data ?? 0;

  const buildColumns = (showWho: boolean): Column<LeaveRequest>[] => [
    {
      key: "who",
      header: showWho ? "Who" : "Dates",
      cell: (r) =>
        showWho ? (
          <div className="flex items-center gap-2.5">
            <Avatar className="h-7 w-7 shrink-0">
              <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                {initials(r.user_name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">
                {r.user_name}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {leaveRangeLabel(r.start_date, r.end_date, r.day_part)}
              </p>
            </div>
          </div>
        ) : (
          <div>
            <p className="font-medium text-foreground">
              {leaveRangeLabel(r.start_date, r.end_date, r.day_part)}
            </p>
            <p className="text-xs text-muted-foreground">{r.code}</p>
          </div>
        ),
    },
    {
      key: "reason",
      header: "Reason",
      cell: (r) => (
        <div className="max-w-[260px]">
          <p className="text-[13px] text-foreground">
            {REASON_LABELS[r.reason_type]}
          </p>
          <p
            className="truncate text-xs text-muted-foreground"
            title={r.reason}
          >
            {r.reason}
          </p>
        </div>
      ),
    },
    {
      key: "days",
      header: "Days",
      align: "right",
      cell: (r) => (
        <div className="text-right">
          <span className="font-semibold tabular-nums text-foreground">
            {formatDays(r.days)}
          </span>
          {r.status === "approved" && r.unpaid_days > 0 && (
            <span className="block text-[11px] font-medium text-destructive">
              {formatDays(r.unpaid_days)} unpaid
            </span>
          )}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <div>
          <div className="flex flex-wrap items-center gap-1">
            <Badge
              variant="outline"
              className={`h-5 px-1.5 text-[11px] font-medium ${
                STATUS_BADGE_CLS[r.status]
              }`}
            >
              {LEAVE_STATUS_LABELS[r.status]}
            </Badge>
            {r.is_backdated && r.status === "pending" && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                Backdated
              </Badge>
            )}
            {r.on_behalf && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                by {r.applied_by_name}
              </Badge>
            )}
          </div>
          {r.decided_by_name && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {r.decided_by_name}
              {r.decision_note ? ` · ${r.decision_note}` : ""}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          {r.can_edit && r.user_id === String(user?.id) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setEditing(r)}
            >
              <Pencil className="mr-1 h-3 w-3" /> Edit
            </Button>
          )}
          {r.status === "pending" &&
            canManage &&
            r.user_id !== String(user?.id) && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: r.id, approve: false })}
                >
                  Reject
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: r.id, approve: true })}
                >
                  Approve
                </Button>
              </>
            )}
          {r.can_cancel && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => askCancel(r)}
            >
              Withdraw
            </Button>
          )}
        </div>
      ),
    },
  ];

  const renderRequestTable = (
    rows: LeaveRequest[],
    showWho: boolean,
    page: number,
    total: number,
    onPageChange: (p: number) => void,
    loading: boolean
  ) => (
    <DataTable
      data={rows}
      columns={buildColumns(showWho)}
      keyField={(r) => r.id}
      loading={loading}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={onPageChange}
      renderMobileCard={(r) => (
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {showWho
                  ? r.user_name
                  : leaveRangeLabel(r.start_date, r.end_date, r.day_part)}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {showWho
                  ? leaveRangeLabel(r.start_date, r.end_date, r.day_part)
                  : `${REASON_LABELS[r.reason_type]} · ${r.reason}`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <span className="block text-sm font-semibold tabular-nums text-foreground">
                {formatDays(r.days)}
              </span>
              <Badge
                variant="outline"
                className={`mt-0.5 h-5 px-1.5 text-[10px] ${
                  STATUS_BADGE_CLS[r.status]
                }`}
              >
                {LEAVE_STATUS_LABELS[r.status]}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5 pt-1">
            {r.can_edit && r.user_id === String(user?.id) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setEditing(r)}
              >
                Edit
              </Button>
            )}
            {r.status === "pending" &&
              canManage &&
              r.user_id !== String(user?.id) && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: r.id, approve: false })}
                  >
                    Reject
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: r.id, approve: true })}
                  >
                    Approve
                  </Button>
                </>
              )}
            {r.can_cancel && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => askCancel(r)}
              >
                Withdraw
              </Button>
            )}
          </div>
        </div>
      )}
    />
  );

  return (
    <div className="space-y-3">
      <PageHeader
        title="Leave"
        subtitle="Apply for time off and track your balance."
        info="Sundays and declared holidays inside a date range never cost you a leave day."
        actions={
          user?.account_type !== "owner" ? (
            <Button
              size="sm"
              className="h-8"
              onClick={() => {
                setOnBehalf(null);
                setApplying(true);
              }}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Apply for leave
            </Button>
          ) : undefined
        }
      />

      {balance.isError ? (
        <ErrorState
          onRetry={() => balance.refetch()}
          message="Couldn't load your leave balance."
        />
      ) : b ? (
        <div className="grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          <div className="px-3.5 py-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Available
            </p>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span
                className={`text-lg font-semibold tabular-nums ${
                  b.available > 0
                    ? "text-emerald-700"
                    : b.available < 0
                      ? "text-destructive"
                      : "text-foreground"
                }`}
              >
                {formatDays(b.available)}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {b.leave_year_label}
              </span>
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Earned this year
            </p>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="text-lg font-semibold tabular-nums text-foreground">
                {formatDays(b.accrued)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {b.monthly_accrual}/mo
              </span>
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Taken
            </p>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="text-lg font-semibold tabular-nums text-foreground">
                {formatDays(b.used)}
              </span>
              {b.refunded > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  {formatDays(b.refunded)} given back
                </span>
              )}
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Waiting decision
            </p>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span
                className={`text-lg font-semibold tabular-nums ${
                  b.pending_days > 0 ? "text-amber-700" : "text-foreground"
                }`}
              >
                {formatDays(b.pending_days)}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                not deducted yet
              </span>
            </div>
          </div>
        </div>
      ) : null}

      <Tabs value={view} onValueChange={(v) => setView2(v as View)}>
        <TabsList className="h-9 flex-wrap">
          <TabsTrigger value="mine" className="gap-1.5 text-xs">
            <User className="h-3.5 w-3.5" /> My leave
          </TabsTrigger>
          {canSeeAll && (
            <TabsTrigger value="requests" className="gap-1.5 text-xs">
              <CheckSquare className="h-3.5 w-3.5" /> Requests
              {pendingCount > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-0.5 h-4 px-1.5 text-[10px]"
                >
                  {pendingCount}
                </Badge>
              )}
            </TabsTrigger>
          )}
          <TabsTrigger value="who" className="gap-1.5 text-xs">
            <Users className="h-3.5 w-3.5" /> Who is off
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "mine" && (
        <div className="space-y-3">
          {mine.isError ? (
            <ErrorState onRetry={() => mine.refetch()} />
          ) : !mine.isLoading && (mine.data?.items ?? []).length === 0 ? (
            <EmptyState
              icon={<Calendar className="h-5 w-5" />}
              title="No leave yet"
              description="When you apply for time off it will show here with its status."
              action={
                user?.account_type !== "owner" ? (
                  <Button size="sm" onClick={() => setApplying(true)}>
                    Apply for leave
                  </Button>
                ) : undefined
              }
            />
          ) : (
            renderRequestTable(
              mine.data?.items ?? [],
              false,
              minePage,
              mine.data?.total ?? 0,
              setMinePage,
              mine.isLoading
            )
          )}

          {(ledger.data?.items ?? []).length > 0 &&
            (showLedger ? (
              <Card className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">
                      How your balance got here
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {b?.leave_year_label}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setShowLedger(false)}
                  >
                    Hide <ChevronUp className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </div>
                <DataTable
                  data={ledger.data?.items ?? []}
                  keyField={(row) => row.id}
                  page={ledgerPage}
                  pageSize={PAGE_SIZE}
                  total={ledger.data?.total ?? 0}
                  onPageChange={setLedgerPage}
                  columns={[
                    {
                      key: "when",
                      header: "When",
                      cell: (row) => (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDate(row.created_at)}
                        </span>
                      ),
                    },
                    {
                      key: "what",
                      header: "What",
                      cell: (row) => (
                        <div>
                          <span className="text-[13px] text-foreground">
                            {row.note || LEDGER_LABELS[row.entry_type]}
                          </span>
                          {row.created_by_name && (
                            <span className="block text-[11px] text-muted-foreground">
                              by {row.created_by_name}
                            </span>
                          )}
                        </div>
                      ),
                    },
                    {
                      key: "days",
                      header: "Days",
                      align: "right",
                      cell: (row) => (
                        <span
                          className={`font-semibold tabular-nums ${
                            row.days >= 0
                              ? "text-emerald-700"
                              : "text-destructive"
                          }`}
                        >
                          {row.days > 0 ? "+" : ""}
                          {row.days}
                        </span>
                      ),
                    },
                  ]}
                />
              </Card>
            ) : (
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                onClick={() => setShowLedger(true)}
                title="Every accrual, use and refund your balance is built from"
              >
                <span>
                  How your balance got here — {ledger.data?.total ?? 0}{" "}
                  {(ledger.data?.total ?? 0) === 1 ? "entry" : "entries"}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </button>
            ))}
        </div>
      )}

      {view === "requests" && canSeeAll && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
              {[
                { value: "pending", label: "Waiting" },
                { value: "approved", label: "Approved" },
                { value: "", label: "All" },
              ].map((opt) => (
                <button
                  key={opt.value || "all"}
                  type="button"
                  onClick={() => changeStatusFilter(opt.value)}
                  className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                    statusFilter === opt.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {canManage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  const list = employees.data?.items ?? [];
                  if (list.length === 0) {
                    toast.info("No employees to record leave for.");
                    return;
                  }
                  setOnBehalf({ id: list[0].id, name: list[0].full_name });
                  setApplying(true);
                }}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Record for someone
              </Button>
            )}
          </div>

          {queue.isError ? (
            <ErrorState onRetry={() => queue.refetch()} />
          ) : !queue.isLoading && (queue.data?.items ?? []).length === 0 ? (
            <EmptyState
              icon={<Check className="h-5 w-5" />}
              title="Nothing waiting"
              description={
                statusFilter === "pending"
                  ? "No leave requests need a decision right now."
                  : "Nothing matches this filter."
              }
            />
          ) : (
            renderRequestTable(
              queue.data?.items ?? [],
              true,
              queuePage,
              queue.data?.total ?? 0,
              setQueuePage,
              queue.isLoading
            )
          )}
        </div>
      )}

      {view === "who" && (
        <div>
          {who.isError ? (
            <ErrorState onRetry={() => who.refetch()} />
          ) : !who.isLoading && (who.data ?? []).length === 0 ? (
            <EmptyState
              icon={<Users className="h-5 w-5" />}
              title="Everybody is in"
              description="Nobody has approved leave in the next two weeks."
            />
          ) : (
            <div className="space-y-2">
              <DataTable
                data={who.data ?? []}
                loading={who.isLoading}
                keyField={(w) => `${w.user_id}-${w.start_date}-${w.day_part}`}
                columns={[
                  {
                    key: "who",
                    header: "Who",
                    cell: (w) => (
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-7 w-7 shrink-0">
                          <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                            {initials(w.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium text-foreground">
                          {w.name}
                        </span>
                      </div>
                    ),
                  },
                  {
                    key: "when",
                    header: "When",
                    cell: (w) => (
                      <span className="text-[13px] text-foreground">
                        {leaveRangeLabel(w.start_date, w.end_date, w.day_part)}
                      </span>
                    ),
                  },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                Names and dates only — why somebody is off stays between them
                and whoever approved it.
              </p>
            </div>
          )}
        </div>
      )}

      <LeaveFormDialog
        open={applying || !!editing}
        onClose={() => {
          setApplying(false);
          setEditing(null);
        }}
        editing={editing}
        onBehalfOf={onBehalf}
      />
      <AdjustBalanceDialog
        open={!!adjusting}
        onClose={() => setAdjusting(null)}
        user={adjusting}
      />
    </div>
  );
}
