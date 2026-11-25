import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  ChevronRight,
  Clock,
  FilePlus2,
  IndianRupee,
  RefreshCw,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import {
  managersApi,
  payslipsApi,
  remindersApi,
  reportsApi,
  targetsApi,
} from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/shared/StatCard";
import { ErrorState } from "../components/shared/ErrorState";
import { CardGridSkeleton } from "../components/shared/LoadingSkeleton";
import {
  AttainmentPct,
  TargetCard,
  toneFor,
} from "../components/TargetProgress";
import { PunchTile } from "../components/hr/PunchTile";
import { useAuth } from "../store/auth";
import PortalHome from "./portal/PortalHome";
import { formatINR, formatMonthYear, initials } from "../lib/format";
import { liveQueryOptions } from "../lib/live";
import type { DashboardStats, TargetWindow } from "../lib/types";
import {
  PAYSLIP_STATUS_LABELS,
  payslipMonthLabel,
} from "../lib/payroll";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";

function windowOptions(): { value: TargetWindow; label: string }[] {
  const monthName = (back: number) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - back);
    return formatMonthYear(d);
  };
  return [
    { value: "current", label: monthName(0) },
    { value: "prev1", label: monthName(1) },
    { value: "prev2", label: monthName(2) },
    { value: "last3", label: "Last 3 months" },
  ];
}

function TargetProgressCard() {
  const [win, setWin] = useState<TargetWindow>("current");
  const options = useMemo(windowOptions, []);

  const progress = useQuery({
    queryKey: ["target-progress", win],
    queryFn: async () => (await targetsApi.progress({ window: win })).data,
  });

  if (progress.isError) {
    return (
      <ErrorState
        message="Could not load target progress."
        onRetry={() => progress.refetch()}
      />
    );
  }
  const d = progress.data;
  if (!d) return null;

  const team = d.scope === "team";
  return (
    <TargetCard
      title={team ? "Team target progress" : "My target"}
      subtitle={
        <>
          {d.label}
          {team && (
            <span className="font-normal text-muted-foreground">
              {" · "}
              {d.people_with_target} of {d.people} with a target
            </span>
          )}
        </>
      }
      rows={d.metrics}
      attainmentPct={d.attainment_pct}
      hasTarget={d.has_target && d.metrics.length > 0}
      empty={
        team
          ? "Nobody has been given a target for this period yet."
          : `No target has been set for ${d.label} yet. Ask an owner.`
      }
      right={
        <Select
          value={win}
          onValueChange={(v) => setWin(v as TargetWindow)}
        >
          <SelectTrigger className="h-9 w-[150px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      footer={
        <div className="mt-3 border-t border-border pt-3">
          <Link
            to="/targets"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            {team ? "Open Targets" : "My targets and my roster"}
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      }
    />
  );
}

const TEAM_PREVIEW = 5;

function MyTeamBlock() {
  const roster = useQuery({
    queryKey: ["managers", "roster", "me", "dashboard"],
    queryFn: async () => (await managersApi.myPartners()).data,
  });
  const d = roster.data;
  if (!d || d.partners === 0) return null;

  const ranked = [...d.rows].sort((a, b) => {
    if (a.has_target !== b.has_target) return a.has_target ? 1 : -1;
    return a.attainment_pct - b.attainment_pct;
  });
  const shown = ranked.slice(0, TEAM_PREVIEW);
  const onTrack = d.rows.filter(
    (r) => r.has_target && r.attainment_pct >= 100
  ).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <CardTitle className="text-base font-semibold">My Partners</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {d.partners} channel {d.partners === 1 ? "partner" : "partners"} ·{" "}
            {d.partners_with_target} with target · {onTrack} on track
            {d.quiet_partners > 0 && (
              <span className="font-medium text-amber-600">
                {" "}
                · {d.quiet_partners} quiet
              </span>
            )}
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/people/partners?view=team">See all</Link>
        </Button>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0">
        {shown.map((r) => {
          const pct = Math.min(100, Math.max(0, r.attainment_pct));
          const tone = toneFor(r.attainment_pct);
          return (
            <Link
              key={r.partner_id}
              to={`/people/partners/${r.partner_id}`}
              className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted/40"
            >
              <Avatar className="h-9 w-9">
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {initials(r.partner_name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {r.partner_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.policies} {r.policies === 1 ? "policy" : "policies"} ·{" "}
                  {formatINR(r.premium)}
                  {r.is_quiet && (
                    <span className="font-medium text-amber-600"> · quiet</span>
                  )}
                </p>
              </div>
              <div className="w-28 shrink-0 text-right">
                {r.has_target ? (
                  <div className="space-y-1">
                    <AttainmentPct pct={r.attainment_pct} size="sm" />
                    <Progress
                      value={pct}
                      className={`h-1.5 ${
                        tone === "done"
                          ? "[&>div]:bg-emerald-600"
                          : tone === "close"
                            ? "[&>div]:bg-amber-500"
                            : ""
                      }`}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No target
                  </span>
                )}
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}

function GrowthCard({ s }: { s?: DashboardStats }) {
  const polPct = s?.growth_policies_pct;
  const earnPct = s?.growth_earning_pct;

  const renderMetric = (label: string, pct?: number | null) => {
    const known = pct !== null && pct !== undefined;
    const up = (pct ?? 0) >= 0;
    return (
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={`mt-0.5 inline-flex items-center gap-1 text-lg font-bold tabular-nums ${
            !known
              ? "text-muted-foreground"
              : up
                ? "text-emerald-600"
                : "text-red-600"
          }`}
        >
          {known ? (
            <>
              {up ? (
                <TrendingUp className="h-4 w-4" />
              ) : (
                <TrendingDown className="h-4 w-4" />
              )}
              {Math.abs(pct as number)}%
            </>
          ) : (
            "—"
          )}
        </p>
      </div>
    );
  };

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Monthly Growth
          </p>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <BarChart3 className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 flex items-center gap-6">
          {renderMetric("Policies", polPct)}
          {renderMetric("Earnings", earnPct)}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          This month vs last month
        </p>
      </CardContent>
    </Card>
  );
}

function QuickActions({ go }: { go: (to: string) => void }) {
  const actions = [
    {
      label: "Book Policy",
      desc: "Add a new policy",
      to: "/policies/new",
      icon: FilePlus2,
      primary: true,
    },
    {
      label: "Add Customer",
      desc: "Save client details",
      to: "/customers/new",
      icon: UserPlus,
    },
    {
      label: "Record Payment",
      desc: "Log money in or out",
      to: "/finance/transactions/new",
      icon: IndianRupee,
    },
    {
      label: "Check Renewals",
      desc: "Policies due soon",
      to: "/renewals",
      icon: RefreshCw,
    },
    {
      label: "Finance Reports",
      desc: "Monthly summaries",
      to: "/finance/reports",
      icon: BarChart3,
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Quick Actions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {actions.map((a) => {
            const IconComp = a.icon;
            return (
              <button
                key={a.to}
                type="button"
                onClick={() => go(a.to)}
                className={`flex flex-col items-start gap-2 rounded-lg border p-3.5 text-left transition-all hover:shadow-sm ${
                  a.primary
                    ? "border-primary/30 bg-primary/5 hover:border-primary/60 hover:bg-primary/10"
                    : "border-border bg-card hover:border-primary/30 hover:bg-muted/40"
                }`}
              >
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                    a.primary
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  <IconComp className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {a.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{a.desc}</p>
                </div>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function MyPayslipStrip({ go }: { go: (to: string) => void }) {
  const mine = useQuery({
    queryKey: ["payslips", "mine-strip"],
    queryFn: async () => (await payslipsApi.mine()).data,
    staleTime: 5 * 60_000,
  });
  const latest = mine.data?.latest;
  if (!latest) return null;

  const waiting = latest.status === "finalised";
  return (
    <Card
      onClick={() => go(`/hr/payslips?slip=${latest.id}`)}
      className="cursor-pointer transition-colors hover:border-primary/40 hover:bg-muted/30"
    >
      <CardContent className="flex flex-wrap items-center gap-4 p-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {payslipMonthLabel(latest.month)} Payslip
        </span>
        <span className="text-lg font-bold tabular-nums text-foreground">
          {formatINR(latest.net_payable_paise)}
        </span>
        <Badge variant={waiting ? "secondary" : "default"}>
          {PAYSLIP_STATUS_LABELS[latest.status]}
        </Badge>
        <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary">
          {waiting ? "Waiting to be paid" : "View breakdown"}
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </CardContent>
    </Card>
  );
}

function OwnerBoard({
  s,
  go,
}: {
  s?: DashboardStats;
  go: (to: string) => void;
}) {
  const { has } = useAuth();
  const canFinance = has("manage_transactions") || has("view_finance_overview");
  const canPolicies = has("view_policies");
  const canProfit = has("view_agency_profit");

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {canFinance && (
          <>
            <StatCard
              label="Money to collect"
              value={formatINR(s?.pending_to_collect)}
              hint="Owed to the agency by customers & insurers"
              icon={<ArrowDownLeft className="h-4 w-4 text-emerald-600" />}
              onClick={() => go("/finance")}
            />
            <StatCard
              label="Money to pay"
              value={formatINR(s?.pending_to_pay)}
              hint="Commissions & settlements owed"
              icon={<ArrowUpRight className="h-4 w-4 text-red-600" />}
              onClick={() => go("/finance")}
            />
          </>
        )}
        {canPolicies && (
          <>
            <StatCard
              label="Policies booked"
              value={String(s?.policies_mtd ?? 0)}
              hint="This month"
              icon={<ShieldCheck className="h-4 w-4" />}
              onClick={() => go("/policies")}
            />
            <StatCard
              label="Renewals due"
              value={String(s?.renewals_due_30d ?? 0)}
              hint="Next 30 days"
              tone={(s?.renewals_due_30d ?? 0) > 0 ? "danger" : "default"}
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() => go("/renewals")}
            />
          </>
        )}
        {canProfit && (
          <>
            <StatCard
              label="Net profit"
              value={formatINR(s?.net_profit_mtd)}
              hint="This month (agency minus partner reward)"
              tone={
                (s?.net_profit_mtd ?? 0) > 0
                  ? "success"
                  : (s?.net_profit_mtd ?? 0) < 0
                    ? "danger"
                    : "default"
              }
              icon={<IndianRupee className="h-4 w-4" />}
            />
            <GrowthCard s={s} />
          </>
        )}
      </div>

      <QuickActions go={go} />
    </div>
  );
}

function EmployeeBoard({
  s,
  go,
}: {
  s?: DashboardStats;
  go: (to: string) => void;
}) {
  const { has } = useAuth();
  const canFinance = has("manage_transactions") || has("view_finance_overview");
  const canPolicies = has("view_policies");
  const canProfit = has("view_agency_profit");

  const myReminders = useQuery({
    queryKey: ["reminders", "counts", "mine"],
    queryFn: async () => (await remindersApi.counts({ scope: "mine" })).data,
    ...liveQueryOptions,
  });
  const overdue = myReminders.data?.overdue ?? 0;

  return (
    <div className="space-y-6">
      <PunchTile />
      <MyPayslipStrip go={go} />
      <TargetProgressCard />
      <MyTeamBlock />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {canPolicies && (
          <>
            <StatCard
              label="My policies"
              value={String(s?.policies_mtd ?? 0)}
              hint="This month"
              icon={<ShieldCheck className="h-4 w-4" />}
              onClick={() => go("/policies")}
            />
            <StatCard
              label="Renewals due"
              value={String(s?.renewals_due_30d ?? 0)}
              hint="Next 30 days"
              tone={(s?.renewals_due_30d ?? 0) > 0 ? "danger" : "default"}
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() => go("/renewals")}
            />
            <StatCard
              label={overdue > 0 ? "Follow-ups overdue" : "Follow-ups today"}
              value={String(myReminders.data?.due_today ?? 0)}
              hint={overdue > 0 ? `${overdue} past due` : "Due today"}
              tone={overdue > 0 ? "danger" : "default"}
              icon={<Clock className="h-4 w-4" />}
              onClick={() => go("/leads")}
            />
          </>
        )}
        {canFinance && (
          <>
            <StatCard
              label="Money to collect"
              value={formatINR(s?.pending_to_collect)}
              icon={<ArrowDownLeft className="h-4 w-4 text-emerald-600" />}
              onClick={() => go("/finance")}
            />
            <StatCard
              label="Money to pay"
              value={formatINR(s?.pending_to_pay)}
              icon={<ArrowUpRight className="h-4 w-4 text-red-600" />}
              onClick={() => go("/finance")}
            />
          </>
        )}
        {canProfit && (
          <>
            <StatCard
              label="Net profit"
              value={formatINR(s?.net_profit_mtd)}
              hint="This month"
              tone={(s?.net_profit_mtd ?? 0) >= 0 ? "success" : "danger"}
              icon={<IndianRupee className="h-4 w-4" />}
            />
            <GrowthCard s={s} />
          </>
        )}
      </div>

      <QuickActions go={go} />
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  if (user?.account_type === "channel_partner") return <PortalHome />;
  return <StaffDashboard />;
}

function StaffDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const stats = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => (await reportsApi.dashboard()).data as DashboardStats,
    ...liveQueryOptions,
  });

  const today = useMemo(
    () =>
      new Date().toLocaleDateString("en-IN", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    []
  );

  const isOwner = user?.account_type === "owner";
  const go = (link: string) => navigate(link);

  return (
    <div>
      <PageHeader
        title={`Welcome, ${user?.full_name?.split(" ")[0] || "Team"}`}
        subtitle={today}
        actions={
          <Button onClick={() => go("/policies/new")}>
            <FilePlus2 className="mr-2 h-4 w-4" />
            Book Policy
          </Button>
        }
      />

      {stats.isError ? (
        <ErrorState onRetry={() => stats.refetch()} />
      ) : stats.isLoading ? (
        <CardGridSkeleton count={6} />
      ) : isOwner ? (
        <OwnerBoard s={stats.data} go={go} />
      ) : (
        <EmployeeBoard s={stats.data} go={go} />
      )}
    </div>
  );
}
