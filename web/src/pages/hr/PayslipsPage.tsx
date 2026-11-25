import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  RefreshCw,
  User,
  Users,
  Wallet,
} from "lucide-react";
import { payslipsApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, Column } from "../../components/shared/DataTable";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { FormField } from "../../components/shared/FormSection";
import { PayslipDetail } from "../../components/hr/PayslipDetail";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { blobError, downloadBlob } from "../../lib/download";
import { formatDate, formatINR, rupeesToPaise } from "../../lib/format";
import { isCurrentMonth, monthKey, monthLabel, shiftMonth } from "../../lib/hr";
import {
  PAYSLIP_STATUS_LABELS,
  deductionSummary,
  payDays,
  payslipBadge,
  payslipMonthLabel,
  windowSentence,
} from "../../lib/payroll";
import { useAuth } from "../../store/auth";
import type { PayRunBlocker, Payslip } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/*
  Payslips UX pattern: Gusto/Linear style — compact 1-line PageHeader with info tooltip,
  inline month stepper + action buttons, slim 4-metric pay run strip, actionable blockers
  panel, and dense DataTable rows linking to ?slip=<id> for instant drill-down.
*/

type View = "mine" | "run";

const PAGE_SIZE = 25;

function slipLink(p: Payslip): string {
  return `?slip=${p.id}`;
}

export default function PayslipsPage() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const canSeeAll = has("view_payslips");
  const canManage = has("manage_payslips");
  const canExport = has("export_data") && canSeeAll;

  const requested = params.get("view") as View | null;
  const [view, setView] = useState<View>(
    requested === "run" && canSeeAll ? "run" : canSeeAll ? "run" : "mine"
  );
  const [month, setMonth] = useState(
    () => params.get("month") || shiftMonth(monthKey(new Date()), -1)
  );
  const [minePage, setMinePage] = useState(1);

  const openId = params.get("slip") || "";
  const setOpenId = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("slip", id);
    else next.delete("slip");
    setParams(next, { replace: !id });
  };

  const switchView = (v: View) => {
    setView(v);
    const next = new URLSearchParams(params);
    if (v === "mine") next.delete("view");
    else next.set("view", v);
    setParams(next, { replace: true });
  };

  const mine = useQuery({
    queryKey: ["payslips", "mine", minePage],
    queryFn: async () =>
      (await payslipsApi.list({ page: minePage, page_size: PAGE_SIZE })).data,
    enabled: view === "mine",
  });

  const run = useQuery({
    queryKey: ["payslips", "run", month],
    queryFn: async () => (await payslipsApi.run(month)).data,
    enabled: view === "run" && canSeeAll,
  });

  const openSlip = useQuery({
    queryKey: ["payslips", "one", openId],
    queryFn: async () => (await payslipsApi.get(openId)).data,
    enabled: !!openId,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["payslips"] });

  const generate = useMutation({
    mutationFn: (regenerate: boolean) =>
      payslipsApi.generate({ month, regenerate }),
    onSuccess: (res) => {
      const missing = res.data.totals.missing_salary.length;
      toast.success(
        `${res.data.totals.payslips} payslip${
          res.data.totals.payslips === 1 ? "" : "s"
        } for ${payslipMonthLabel(month)}.` +
          (missing ? ` ${missing} still have no salary on record.` : "")
      );
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const finalise = useMutation({
    mutationFn: () => payslipsApi.finalise(month),
    onSuccess: (res) => {
      toast.success(
        `${res.data.totals.finalised} payslip${
          res.data.totals.finalised === 1 ? "" : "s"
        } finalised. Everybody has been told what they are getting.`
      );
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const exportRun = useMutation({
    mutationFn: async () => {
      const res = await payslipsApi.exportRun(month);
      downloadBlob(res.data as Blob, `payroll-${month}.xlsx`);
    },
    onError: async (e) => toast.error(await blobError(e)),
  });

  const totals = run.data?.totals;

  return (
    <div className="space-y-3">
      <PageHeader
        title="Payslips"
        subtitle="Monthly pay runs and employee payslips."
        info="Worked out from the attendance register and each employee's salary. Generated automatically on the 1st for the month that just ended, then locked once the correction window closes."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => navigate("/hr/attendance")}
          >
            <Clock className="mr-1.5 h-3.5 w-3.5" /> Attendance
          </Button>
        }
      />

      {canSeeAll && (
        <Tabs value={view} onValueChange={(v) => switchView(v as View)}>
          <TabsList className="h-9 flex-wrap">
            <TabsTrigger value="run" className="gap-1.5 text-xs">
              <Users className="h-3.5 w-3.5" /> Pay run
            </TabsTrigger>
            <TabsTrigger value="mine" className="gap-1.5 text-xs">
              <User className="h-3.5 w-3.5" /> My payslips
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {view === "mine" && (
        <div>
          {mine.isError ? (
            <ErrorState onRetry={() => mine.refetch()} />
          ) : !mine.isLoading && (mine.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No payslips yet"
              description="Your first one is generated on the 1st of next month, from this month's attendance. You are told as soon as it is final."
            />
          ) : (
            <MyPayslips
              rows={mine.data?.items ?? []}
              loading={mine.isLoading}
              page={minePage}
              total={mine.data?.total ?? 0}
              onPageChange={setMinePage}
            />
          )}
        </div>
      )}

      {view === "run" && canSeeAll && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Previous month"
                onClick={() => setMonth(shiftMonth(month, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[8.5rem] text-center text-sm font-medium text-foreground">
                {monthLabel(month)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Next month"
                disabled={isCurrentMonth(month)}
                onClick={() => setMonth(shiftMonth(month, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              {isCurrentMonth(month) && (
                <Badge
                  variant="outline"
                  className="ml-1 border-amber-200 bg-amber-50 text-amber-800"
                >
                  <AlertTriangle className="mr-1 h-3 w-3" /> Still running
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {canExport && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={exportRun.isPending}
                  onClick={() => exportRun.mutate()}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {exportRun.isPending ? "Preparing…" : "Pay sheet"}
                </Button>
              )}
              {canManage && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={generate.isPending}
                  onClick={() => generate.mutate(false)}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Generate
                </Button>
              )}
              {canManage && (totals?.draft ?? 0) > 0 && (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={finalise.isPending}
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: `Finalise ${totals!.draft} payslip${
                          totals!.draft === 1 ? "" : "s"
                        }?`,
                        message:
                          "Everybody gets told what they are being paid, and the figures lock. A payslip can be reopened afterwards if a correction lands.",
                        confirmLabel: "Finalise them",
                      })
                    )
                      finalise.mutate();
                  }}
                >
                  <Check className="mr-1.5 h-3.5 w-3.5" /> Finalise all
                </Button>
              )}
            </div>
          </div>

          {run.isError ? (
            <ErrorState onRetry={() => run.refetch()} />
          ) : !run.isLoading && (!totals || totals.payslips === 0) ? (
            <EmptyState
              title={`No payslips for ${monthLabel(month)}`}
              description={
                canManage
                  ? "They are generated automatically on the 1st. Press Generate to build them now."
                  : "They are generated automatically on the 1st of the month."
              }
              action={
                canManage ? (
                  <Button
                    size="sm"
                    disabled={generate.isPending}
                    onClick={() => generate.mutate(false)}
                  >
                    Generate them now
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {totals && (
                <div className="grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                  <div className="px-3.5 py-2.5">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      Net payable
                    </p>
                    <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                      {formatINR(totals.net_paise)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {totals.payslips} of {totals.employees} employees
                    </p>
                  </div>
                  <div className="px-3.5 py-2.5">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      Deducted
                    </p>
                    <p
                      className={`mt-0.5 text-lg font-semibold tabular-nums ${
                        totals.deduction_paise > 0
                          ? "text-destructive"
                          : "text-foreground"
                      }`}
                    >
                      {formatINR(totals.deduction_paise)}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      Absences, unpaid &amp; late
                    </p>
                  </div>
                  <div className="px-3.5 py-2.5">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      Still to pay
                    </p>
                    <p
                      className={`mt-0.5 text-lg font-semibold tabular-nums ${
                        totals.outstanding_paise > 0
                          ? "text-amber-700"
                          : "text-foreground"
                      }`}
                    >
                      {formatINR(totals.outstanding_paise)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {totals.finalised} finalised, {totals.draft} draft
                    </p>
                  </div>
                  <div className="px-3.5 py-2.5">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      Paid
                    </p>
                    <p
                      className={`mt-0.5 text-lg font-semibold tabular-nums ${
                        totals.paid > 0 ? "text-emerald-700" : "text-foreground"
                      }`}
                    >
                      {totals.paid}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        of {totals.payslips}
                      </span>
                    </p>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-emerald-600 transition-all"
                        style={{
                          width: `${
                            totals.payslips
                              ? Math.round((totals.paid / totals.payslips) * 100)
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {totals && (
                <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {windowSentence(totals)}
                </p>
              )}

              {totals && totals.blocked.length > 0 && (
                <BlockedList
                  rows={totals.blocked}
                  month={month}
                  canManage={canManage}
                  onFixed={refresh}
                />
              )}

              <PayRunTable rows={run.data?.rows ?? []} loading={run.isLoading} />
            </>
          )}
        </div>
      )}

      {openId && openSlip.data && (
        <PayslipDetail
          payslip={openSlip.data}
          canManage={canManage}
          onClose={() => setOpenId("")}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function BlockedList({
  rows,
  month,
  canManage,
  onFixed,
}: {
  rows: PayRunBlocker[];
  month: string;
  canManage: boolean;
  onFixed: () => void;
}) {
  const { has } = useAuth();
  const canSetSalary = has("manage_employees") && has("view_salary");
  const [salaryFor, setSalaryFor] = useState<PayRunBlocker | null>(null);

  return (
    <Card className="p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          Waiting on {rows.length === 1 ? "one person" : `${rows.length} people`}
        </h3>
        <span className="text-xs text-muted-foreground">
          Drafts stay unlocked until resolved
        </span>
      </div>
      <ul className="mt-2 divide-y divide-border/60">
        {rows.map((b) => {
          const noSalary = b.reasons.some((r) => r.includes("no salary"));
          const disputed = b.reasons.some((r) => r.includes("correction"));
          return (
            <li
              key={b.payslip_id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">
                  {b.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {b.reasons.join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {noSalary && canSetSalary && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setSalaryFor(b)}
                  >
                    <Wallet className="mr-1 h-3.5 w-3.5" /> Set salary
                  </Button>
                )}
                {noSalary && !canSetSalary && (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                  >
                    <Link to={`/people/employees/${b.user_id}?tab=hr`}>
                      Open profile
                    </Link>
                  </Button>
                )}
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                >
                  <Link
                    to={
                      disputed
                        ? "/hr/attendance?view=corrections"
                        : `/hr/attendance?view=month&month=${month}`
                    }
                  >
                    <Clock className="mr-1 h-3.5 w-3.5" />
                    {disputed ? "Corrections" : "Register"}
                  </Link>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {salaryFor && (
        <SetSalaryDialog
          blocker={salaryFor}
          month={month}
          canManage={canManage}
          onClose={() => setSalaryFor(null)}
          onSaved={() => {
            setSalaryFor(null);
            onFixed();
          }}
        />
      )}
    </Card>
  );
}

function SetSalaryDialog({
  blocker,
  month,
  canManage,
  onClose,
  onSaved,
}: {
  blocker: PayRunBlocker;
  month: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rupees, setRupees] = useState("");

  const person = useQuery({
    queryKey: ["user", blocker.user_id],
    queryFn: async () => (await usersApi.get(blocker.user_id)).data,
  });

  const save = useMutation({
    mutationFn: async () => {
      const profile = person.data?.employee_profile ?? {};
      await usersApi.update(blocker.user_id, {
        employee_profile: {
          ...profile,
          monthly_salary_paise: rupeesToPaise(Number(rupees || 0)),
        },
      });
      if (canManage) {
        await payslipsApi
          .generate({ month, user_id: blocker.user_id, regenerate: true })
          .catch(() => undefined);
      }
    },
    onSuccess: () => {
      toast.success(`Saved. ${blocker.name}'s payslip has been rebuilt.`);
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Monthly salary for {blocker.name}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            This is the figure the whole payslip is worked out from — a day
            costs this divided by 30. It is saved on their employee record.
          </p>
          <FormField
            label="Monthly salary"
            required
            hint="What they are paid for a full month, before any deduction."
          >
            <div className="flex">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 text-xs text-muted-foreground">
                Rs
              </span>
              <Input
                className="rounded-l-none"
                inputMode="decimal"
                autoFocus
                value={rupees}
                placeholder="15000"
                onChange={(e) =>
                  setRupees(e.target.value.replace(/[^\d.]/g, ""))
                }
              />
            </div>
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={save.isPending || person.isLoading || !rupees}
            >
              {save.isPending ? "Saving…" : "Save salary"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MyPayslips({
  rows,
  loading,
  page,
  total,
  onPageChange,
}: {
  rows: Payslip[];
  loading: boolean;
  page: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
  const columns: Column<Payslip>[] = [
    {
      key: "month",
      header: "Month",
      cell: (p) => (
        <Link to={slipLink(p)} className="block group">
          <p className="font-medium text-foreground group-hover:text-primary">
            {payslipMonthLabel(p.month)}
          </p>
          <p className="text-xs text-muted-foreground">
            {p.status === "paid" && p.paid_at
              ? `Paid ${formatDate(p.paid_at)}`
              : p.code}
          </p>
        </Link>
      ),
    },
    {
      key: "days",
      header: "Days",
      cell: (p) => (
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {payDays(p.payable_days)} / {p.calendar_days}
        </span>
      ),
    },
    {
      key: "deductions",
      header: "Deductions",
      cell: (p) => (
        <span className="text-[13px] text-muted-foreground">
          {deductionSummary(p) || "—"}
        </span>
      ),
    },
    {
      key: "net",
      header: "Net payable",
      align: "right",
      cell: (p) => (
        <span className="font-semibold tabular-nums text-foreground">
          {formatINR(p.net_payable_paise)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (p) => (
        <span className={`badge ${payslipBadge(p.status)}`}>
          {PAYSLIP_STATUS_LABELS[p.status]}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      keyField={(p) => p.id}
      loading={loading}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={onPageChange}
      renderMobileCard={(p) => (
        <Link to={slipLink(p)} className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground">
              {payslipMonthLabel(p.month)}
            </p>
            <p className="text-xs text-muted-foreground">
              {payDays(p.payable_days)} payable days
              {p.status === "paid" && p.paid_at
                ? ` · paid ${formatDate(p.paid_at)}`
                : ""}
            </p>
          </div>
          <div className="text-right">
            <span className="block text-sm font-semibold tabular-nums text-foreground">
              {formatINR(p.net_payable_paise)}
            </span>
            <span className={`badge mt-0.5 ${payslipBadge(p.status)}`}>
              {PAYSLIP_STATUS_LABELS[p.status]}
            </span>
          </div>
        </Link>
      )}
    />
  );
}

function PayRunTable({ rows, loading }: { rows: Payslip[]; loading: boolean }) {
  const columns: Column<Payslip>[] = [
    {
      key: "employee",
      header: "Employee",
      cell: (p) => (
        <Link to={slipLink(p)} className="block group">
          <p className="font-medium text-foreground group-hover:text-primary">
            {p.user_name}
          </p>
          <p className="text-xs text-muted-foreground">
            {p.designation || p.user_code}
          </p>
        </Link>
      ),
    },
    {
      key: "salary",
      header: "Salary",
      align: "right",
      cell: (p) => (
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {p.monthly_salary_paise > 0 ? (
            formatINR(p.monthly_salary_paise)
          ) : (
            <span className="font-medium text-destructive">Not set</span>
          )}
        </span>
      ),
    },
    {
      key: "days",
      header: "Days",
      cell: (p) => (
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {payDays(p.payable_days)} / {p.calendar_days}
        </span>
      ),
    },
    {
      key: "deductions",
      header: "Deductions",
      cell: (p) => (
        <span className="text-[13px] text-muted-foreground">
          {deductionSummary(p) || "—"}
        </span>
      ),
    },
    {
      key: "net",
      header: "Net payable",
      align: "right",
      cell: (p) => (
        <span className="font-semibold tabular-nums text-foreground">
          {formatINR(p.net_payable_paise)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (p) => (
        <div className="flex items-center gap-1.5">
          <span className={`badge ${payslipBadge(p.status)}`}>
            {PAYSLIP_STATUS_LABELS[p.status]}
          </span>
          {p.unresolved_days > 0 && (
            <span
              className="inline-flex items-center text-amber-600"
              title={`${p.unresolved_days} days in the register are unresolved`}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      keyField={(p) => p.id}
      loading={loading}
      renderMobileCard={(p) => (
        <Link to={slipLink(p)} className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground">
              {p.user_name}
            </p>
            <p className="text-xs text-muted-foreground">
              {payDays(p.payable_days)} days ·{" "}
              {deductionSummary(p) || "full month"}
            </p>
          </div>
          <div className="text-right">
            <span className="block text-sm font-semibold tabular-nums text-foreground">
              {formatINR(p.net_payable_paise)}
            </span>
            <span className={`badge mt-0.5 ${payslipBadge(p.status)}`}>
              {PAYSLIP_STATUS_LABELS[p.status]}
            </span>
          </div>
        </Link>
      )}
    />
  );
}
