import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { leaveApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import {
  CardSkeleton, EmptyState, ErrorState, Ledger, LedgerCell, LedgerRow, LTh,
  ListShell, MobileCard, Pagination, PersonCell, Segmented, StatCard, StatRow,
  TableSkeleton,
} from "../../components/ui";
import {
  AdjustBalanceDialog, LeaveFormDialog,
} from "../../components/hr/LeaveForm";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import {
  LEAVE_STATUS_LABELS, REASON_LABELS, balanceTone, formatDays,
  leaveRangeLabel, leaveStatusBadge,
} from "../../lib/hr";
import { formatDate } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { LeaveRequest } from "../../lib/types";

/*
  Leave — ONE page, three views.

  MY LEAVE (everybody, no flag): the balance, the button, and my requests.
  REQUESTS (view_leave): the approval queue, pending first.
  WHO IS OFF (everybody, no flag): names and dates for the week ahead.

  That last one is deliberately open to everyone (owner G5). Everybody needs to
  know who is around to plan work, and it is not sensitive — so it carries names
  and dates and NEVER a reason. Why somebody is off stays between them and
  whoever approved it, which is why the API's schema has no field for it rather
  than the page choosing not to render one.

  THE BALANCE IS THE HERO, because "how many do I have left" is the question
  people open this page to answer. Pending days sit BESIDE it and are never
  subtracted — a request that has not been decided reserves nothing, and showing
  a smaller number than somebody actually holds would be a different lie from
  the one that avoids.
*/

type View = "mine" | "requests" | "who";

const PAGE_SIZE = 25;

export default function LeavePage() {
  const { user, has } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  const canSeeAll = has("view_leave");
  const canManage = has("manage_leave");

  const requested = params.get("view") as View | null;
  const [view, setView] = useState<View>(
    requested === "requests" && canSeeAll ? "requests"
      : requested === "who" ? "who" : "mine");
  const [applying, setApplying] = useState(false);
  const [editing, setEditing] = useState<LeaveRequest | null>(null);
  const [onBehalf, setOnBehalf] = useState<{ id: string; name: string } | null>(
    null);
  const [adjusting, setAdjusting] = useState<{ id: string; name: string } | null>(
    null);
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [showLedger, setShowLedger] = useState(false);
  const [minePage, setMinePage] = useState(1);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [queuePage, setQueuePage] = useState(1);

  const setView2 = (v: View) => {
    setView(v);
    const next = new URLSearchParams(params);
    if (v === "mine") next.delete("view"); else next.set("view", v);
    setParams(next, { replace: true });
  };

  const changeStatusFilter = (v: string) => {
    setStatusFilter(v);
    setQueuePage(1);
  };

  /* ------------------------------------------------------------- queries -- */

  const balance = useQuery({
    queryKey: ["hr", "leave-balance"],
    queryFn: async () => (await leaveApi.balance()).data,
  });

  // Paginated (owner 2026-09-12) — a personal history builds up slowly, but a
  // multi-year tenure passes 25 requests.
  const mine = useQuery({
    queryKey: ["hr", "leave-mine", minePage],
    queryFn: async () => (await leaveApi.requests({
      mine: true, page: minePage, page_size: PAGE_SIZE })).data,
    enabled: view === "mine",
  });

  // Paginated — a whole leave year of accrual + usage rows can pass 25.
  const ledger = useQuery({
    queryKey: ["hr", "leave-ledger", ledgerPage],
    queryFn: async () => (await leaveApi.ledger({
      page: ledgerPage, page_size: PAGE_SIZE })).data,
    enabled: view === "mine",
  });

  // Paginated — the approval queue across every employee's history easily
  // passes 25.
  const queue = useQuery({
    queryKey: ["hr", "leave-queue", statusFilter, queuePage],
    queryFn: async () => (await leaveApi.requests({
      mine: false, status: statusFilter || undefined,
      page: queuePage, page_size: PAGE_SIZE })).data,
    enabled: view === "requests" && canSeeAll,
  });

  // The "Requests" tab badge counts EVERY pending request, not just the ones
  // on the current page — a cheap page_size:1 query that reads the server's
  // own total.
  const pendingTotal = useQuery({
    queryKey: ["hr", "leave-pending-total"],
    queryFn: async () => (await leaveApi.requests({
      mine: false, status: "pending", page: 1, page_size: 1 })).data.total,
    enabled: canSeeAll,
  });

  const who = useQuery({
    queryKey: ["hr", "who-is-off"],
    queryFn: async () => (await leaveApi.whoIsOff(14)).data,
    enabled: view === "who",
  });

  // Only for the "record on somebody's behalf" picker. Employees only —
  // channel partners are not covered by this module at all.
  const employees = useQuery({
    queryKey: ["hr", "employees-for-leave"],
    queryFn: async () =>
      (await usersApi.list({ account_type: "employee", page_size: 200 })).data,
    enabled: canManage && view === "requests",
  });

  /* ----------------------------------------------------------- mutations -- */

  const decide = useMutation({
    mutationFn: async (v: { id: string; approve: boolean; note?: string }) =>
      (await leaveApi.decide(v.id, v.approve, v.note)).data,
    onSuccess: (r, v) => {
      toast.success(v.approve
        ? `Approved — ${formatDays(r.days)}${r.unpaid_days > 0
          ? `, of which ${formatDays(r.unpaid_days)} unpaid` : ""}.`
        : "Rejected.");
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
      message: r.status === "approved"
        ? `${formatDays(r.paid_days)} will go back onto the balance.`
        : "The request will be withdrawn before anybody decides it.",
      confirmLabel: "Withdraw it",
    });
    if (ok) cancel.mutate(r.id);
  };

  const b = balance.data;
  const pendingCount = pendingTotal.data ?? 0;

  /* ---------------------------------------------------------------- rows -- */

  const requestRows = (rows: LeaveRequest[], showWho: boolean) => (
    <ListShell
      bare
      cards={rows.map((r) => (
        <MobileCard key={r.id} to="#"
          rail={r.status === "pending" ? "due"
            : r.status === "approved" ? "in" : undefined}
          title={showWho ? r.user_name
            : leaveRangeLabel(r.start_date, r.end_date, r.day_part)}
          meta={showWho
            ? leaveRangeLabel(r.start_date, r.end_date, r.day_part)
            : `${REASON_LABELS[r.reason_type]} · ${r.reason}`}
          right={
            <>
              <span className="block whitespace-nowrap text-metric-sm
                tabular-nums text-slate-900">
                {formatDays(r.days)}
              </span>
              <span className={leaveStatusBadge(r.status)}>
                {LEAVE_STATUS_LABELS[r.status]}
              </span>
            </>
          } />
      ))}
      table={
        <Ledger
          head={
            <>
              <LTh>{showWho ? "Who" : "Dates"}</LTh>
              <LTh>Reason</LTh>
              <LTh align="right">Days</LTh>
              <LTh>Status</LTh>
              <LTh />
            </>
          }>
          {rows.map((r) => (
            <LedgerRow key={r.id}>
              {showWho ? (
                <td className={r.status === "pending" ? "rail-due" : ""}>
                  <PersonCell name={r.user_name}
                    sub={leaveRangeLabel(r.start_date, r.end_date,
                      r.day_part)} />
                </td>
              ) : (
                <LedgerCell
                  rail={r.status === "pending" ? "due" : undefined}
                  title={leaveRangeLabel(r.start_date, r.end_date, r.day_part)}
                  sub={r.code} />
              )}
              <td>
                <span className="block text-[13px] text-slate-700">
                  {REASON_LABELS[r.reason_type]}
                </span>
                <span className="mt-0.5 block truncate text-xs text-slate-500"
                  title={r.reason}>
                  {r.reason}
                </span>
              </td>
              {/* The hero figure. Unpaid days sit underneath rather than in a
                  column of their own — related facts stack. */}
              <td>
                <span className="ledger-figure">{formatDays(r.days)}</span>
                {r.status === "approved" && r.unpaid_days > 0 && (
                  <span className="ledger-figure-sub text-money-out">
                    {formatDays(r.unpaid_days)} unpaid
                  </span>
                )}
              </td>
              <td>
                <div className="flex flex-wrap items-center gap-1">
                  <span className={leaveStatusBadge(r.status)}>
                    {LEAVE_STATUS_LABELS[r.status]}
                  </span>
                  {r.is_backdated && r.status === "pending" && (
                    <span className="badge-neutral">Backdated</span>
                  )}
                  {r.on_behalf && (
                    <span className="badge-neutral">
                      by {r.applied_by_name}
                    </span>
                  )}
                </div>
                {r.decided_by_name && (
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {r.decided_by_name}
                    {r.decision_note ? ` · ${r.decision_note}` : ""}
                  </span>
                )}
              </td>
              <td>
                <div className="flex justify-end gap-1.5">
                  {/* Both come from the SERVER (`can_edit` / `can_cancel`), not
                      from the browser re-deriving the rule. Three screens
                      re-implementing "is this still mine to withdraw" is three
                      chances to draw a button that 403s. */}
                  {r.can_edit && r.user_id === String(user?.id) && (
                    <button className="btn-ghost btn-sm"
                      onClick={() => setEditing(r)}>
                      <Icon.Edit size={13} /> Edit
                    </button>
                  )}
                  {r.status === "pending" && canManage
                    && r.user_id !== String(user?.id) && (
                    <>
                      <button className="btn-secondary btn-sm"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({
                          id: r.id, approve: false })}>
                        Reject
                      </button>
                      <button className="btn-primary btn-sm"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({
                          id: r.id, approve: true })}>
                        Approve
                      </button>
                    </>
                  )}
                  {r.can_cancel && (
                    <button className="btn-ghost btn-sm"
                      onClick={() => askCancel(r)}>
                      Withdraw
                    </button>
                  )}
                </div>
              </td>
            </LedgerRow>
          ))}
        </Ledger>
      }
    />
  );

  return (
    <div>
      <PageHeader
        title="Leave"
        subtitle="Apply for time off, and see what you have left. Sundays and
          holidays inside a date range never cost you a leave day."
        eyebrow="Workplace HR"
        figure={b ? {
          label: "Available",
          value: formatDays(b.available),
          tone: balanceTone(b.available),
        } : undefined}
        actions={
          <button className="btn-primary" onClick={() => {
            setOnBehalf(null);
            setApplying(true);
          }}>
            <Icon.Plus size={15} /> Apply for leave
          </button>
        }
      />

      {/* ------------------------------------------------------- balance -- */}
      {balance.isError ? (
        <div className="card">
          <ErrorState onRetry={() => balance.refetch()}
            message="Couldn't load your leave balance." />
        </div>
      ) : balance.isLoading ? (
        <CardSkeleton count={4} />
      ) : b ? (
        <StatRow cols={4}>
          <StatCard label="Available" value={formatDays(b.available)}
            tone={balanceTone(b.available)}
            hint={b.leave_year_label} />
          <StatCard label="Earned this year" value={formatDays(b.accrued)}
            hint={`${b.monthly_accrual} a month`} />
          <StatCard label="Taken" value={formatDays(b.used)}
            hint={b.refunded > 0
              ? `${formatDays(b.refunded)} given back` : undefined} />
          <StatCard label="Waiting on a decision"
            value={formatDays(b.pending_days)}
            tone={b.pending_days > 0 ? "due" : undefined}
            hint="not taken off your balance yet" />
        </StatRow>
      ) : null}

      <div className="mt-5">
        <Segmented
          semantics="tabs"
          value={view}
          onChange={(v) => setView2(v as View)}
          options={[
            { value: "mine", label: "My leave", icon: "User" },
            ...(canSeeAll ? [{
              value: "requests" as View, label: "Requests",
              icon: "CheckSquare" as const,
              count: pendingCount || undefined,
            }] : []),
            { value: "who", label: "Who is off", icon: "Users" },
          ]}
        />
      </div>

      {/* ------------------------------------------------------ my leave -- */}
      {view === "mine" && (
        <div className="mt-5 space-y-6">
          {mine.isError ? (
            <ErrorState onRetry={() => mine.refetch()} />
          ) : mine.isLoading ? (
            <TableSkeleton cols={5} />
          ) : (mine.data?.items ?? []).length === 0 ? (
            <EmptyState title="No leave yet"
              icon={<Icon.Calendar size={20} />}
              hint="When you apply for time off it will show here with its
                status."
              action={
                <button className="btn-primary"
                  onClick={() => setApplying(true)}>
                  Apply for leave
                </button>
              } />
          ) : (
            <>
              {requestRows(mine.data?.items ?? [], false)}
              {(mine.data?.total ?? 0) > PAGE_SIZE && (
                <Pagination page={minePage} pageSize={PAGE_SIZE}
                  total={mine.data?.total ?? 0} onChange={setMinePage} />
              )}
            </>
          )}

          {/* The balance is a SUM of these rows and nothing else, so this is the
              explanation rather than a report about it — "why do I have 4.5
              days" is a question this answers. Collapsed by default (owner
              2026-09-12: "too many numbers everywhere") — most visits are
              "apply / check status", not "audit my accrual", so the ledger
              is one click away instead of always taking the bottom of the
              page. */}
          {(ledger.data?.items ?? []).length > 0 && (
            showLedger ? (
              <div className="card">
                <div className="card-head">
                  <h2 className="card-title">How your balance got here</h2>
                  <div className="flex items-center gap-3">
                    <span className="text-secondary text-slate-500">
                      {b?.leave_year_label}
                    </span>
                    <button type="button" className="btn-ghost btn-sm"
                      onClick={() => setShowLedger(false)}>
                      Hide
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto scrollbar-light">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>What</th>
                        <th className="num">Days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(ledger.data?.items ?? []).map((row) => (
                        <tr key={row.id}>
                          <td className="whitespace-nowrap text-slate-500">
                            {formatDate(row.created_at)}
                          </td>
                          <td>
                            <span className="block text-slate-800">
                              {row.note || LEDGER_LABELS[row.entry_type]}
                            </span>
                            {row.created_by_name && (
                              <span className="text-xs text-slate-500">
                                by {row.created_by_name}
                              </span>
                            )}
                          </td>
                          <td className={`num font-medium ${row.days >= 0
                            ? "text-money-in" : "text-money-out"}`}>
                            {row.days > 0 ? "+" : ""}{row.days}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(ledger.data?.total ?? 0) > PAGE_SIZE && (
                  <Pagination page={ledgerPage} pageSize={PAGE_SIZE}
                    total={ledger.data?.total ?? 0} onChange={setLedgerPage} />
                )}
              </div>
            ) : (
              <button type="button"
                className="flex w-full items-center justify-between rounded-control
                  border border-line px-3 py-2 text-sm text-slate-600
                  hover:bg-slate-50"
                onClick={() => setShowLedger(true)}
                title="Every accrual, use and refund your balance is built from">
                <span>How your balance got here — {ledger.data?.total ?? 0}{" "}
                  {(ledger.data?.total ?? 0) === 1 ? "entry" : "entries"}</span>
                <Icon.ChevronDown size={14} className="shrink-0 text-slate-400" />
              </button>
            )
          )}
        </div>
      )}

      {/* ------------------------------------------------------- requests -- */}
      {view === "requests" && canSeeAll && (
        <div className="mt-5">
          <div className="ledger-bar">
            <Segmented
              value={statusFilter}
              onChange={changeStatusFilter}
              options={[
                { value: "pending", label: "Waiting" },
                { value: "approved", label: "Approved" },
                { value: "", label: "All" },
              ]}
            />
            <div className="ledger-bar-end">
              {canManage && (
                <button className="btn-secondary btn-sm" onClick={() => {
                  const list = employees.data?.items ?? [];
                  if (list.length === 0) {
                    toast.info("No employees to record leave for.");
                    return;
                  }
                  setOnBehalf({ id: list[0].id, name: list[0].full_name });
                  setApplying(true);
                }}>
                  <Icon.Plus size={14} /> Record for someone
                </button>
              )}
            </div>
          </div>
          {queue.isError ? (
            <ErrorState onRetry={() => queue.refetch()} />
          ) : queue.isLoading ? (
            <TableSkeleton cols={5} />
          ) : (queue.data?.items ?? []).length === 0 ? (
            <EmptyState title="Nothing waiting"
              icon={<Icon.Check size={20} />}
              hint={statusFilter === "pending"
                ? "No leave requests need a decision right now."
                : "Nothing matches this filter."} />
          ) : (
            <>
              {requestRows(queue.data?.items ?? [], true)}
              {(queue.data?.total ?? 0) > PAGE_SIZE && (
                <Pagination page={queuePage} pageSize={PAGE_SIZE}
                  total={queue.data?.total ?? 0} onChange={setQueuePage} />
              )}
            </>
          )}
        </div>
      )}

      {/* ----------------------------------------------------- who is off -- */}
      {view === "who" && (
        <div className="mt-5">
          {who.isError ? (
            <ErrorState onRetry={() => who.refetch()} />
          ) : who.isLoading ? (
            <TableSkeleton cols={2} />
          ) : (who.data ?? []).length === 0 ? (
            <EmptyState title="Everybody is in"
              icon={<Icon.Users size={20} />}
              hint="Nobody has approved leave in the next two weeks." />
          ) : (
            <div className="card">
              <div className="card-head">
                <h2 className="card-title">Off in the next two weeks</h2>
              </div>
              <div className="overflow-x-auto scrollbar-light">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Who</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(who.data ?? []).map((w, i) => (
                      <tr key={`${w.user_id}-${i}`}>
                        <td><PersonCell name={w.name} /></td>
                        <td className="text-slate-700">
                          {leaveRangeLabel(w.start_date, w.end_date,
                            w.day_part)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Says out loud what is deliberately missing, so nobody goes
                  looking for a bug. */}
              <div className="border-t border-line px-5 py-3 text-xs
                text-slate-500">
                Names and dates only — why somebody is off stays between them
                and whoever approved it.
              </div>
            </div>
          )}
        </div>
      )}

      <LeaveFormDialog
        open={applying || !!editing}
        onClose={() => { setApplying(false); setEditing(null); }}
        editing={editing}
        onBehalfOf={onBehalf}
      />
      <AdjustBalanceDialog
        open={!!adjusting} onClose={() => setAdjusting(null)}
        user={adjusting} />
    </div>
  );
}

// What a balance movement is called when the row carries no note of its own.
const LEDGER_LABELS: Record<string, string> = {
  opening: "Opening balance",
  accrual: "Monthly leave",
  usage: "Leave taken",
  refund: "Given back",
  adjustment: "Adjusted by hand",
  lapse: "Lapsed at the end of the leave year",
};
