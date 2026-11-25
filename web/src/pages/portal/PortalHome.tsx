import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronRight,
  FileText,
  IndianRupee,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { portalApi } from "../../api/endpoints";
import { ErrorState } from "../../components/shared/ErrorState";
import { CardGridSkeleton } from "../../components/shared/LoadingSkeleton";
import { AttainmentPct, MetricBars } from "../../components/TargetProgress";
import {
  DateFilter,
  periodParams,
  type PeriodValue,
} from "../../components/finance/DateFilter";
import { formatDate, formatINR, formatMonthYear } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { NetPosition } from "./shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function monthOptions(): { value: string; label: string }[] {
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
  ];
}

function TargetCard() {
  const [win, setWin] = useState("current");
  const options = useMemo(monthOptions, []);
  const target = useQuery({
    queryKey: ["portal", "target", win],
    queryFn: async () => (await portalApi.target(win)).data,
  });
  const d = target.data;
  if (!d) return null;
  if (!d.has_target && win === "current") return null;

  return (
    <Card className="px-4 py-3.5 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {d.has_target && d.attainment_pct >= 100
              ? "Target achieved"
              : "Your target"}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-foreground">
            {d.label}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {d.has_target && <AttainmentPct pct={d.attainment_pct} size="lg" />}
          <Select value={win} onValueChange={setWin}>
            <SelectTrigger
              className="h-8 w-[132px] text-xs"
              aria-label="Show another month"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-3">
        {d.has_target && d.metrics.length > 0 ? (
          <MetricBars rows={d.metrics} />
        ) : (
          <p className="text-xs text-muted-foreground">
            No target was set for {d.label}.
          </p>
        )}
      </div>
    </Card>
  );
}

export default function PortalHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<PeriodValue>({
    period: "current_month",
  });

  const summary = useQuery({
    queryKey: ["portal", "summary", period],
    queryFn: async () => (await portalApi.summary(periodParams(period))).data,
  });
  const d = summary.data;
  const firstName = (user?.full_name ?? "").split(" ")[0];

  if (summary.isError) return <ErrorState onRetry={() => summary.refetch()} />;
  if (summary.isLoading) return <CardGridSkeleton count={4} />;

  const todo: { label: string; to: string; count: number }[] = [];
  if (d?.quotes_awaiting_me)
    todo.push({
      label:
        d.quotes_awaiting_me === 1
          ? "1 quote request is waiting on you"
          : `${d.quotes_awaiting_me} quote requests are waiting on you`,
      to: "/portal/quotes",
      count: d.quotes_awaiting_me,
    });
  if (d?.renewals_7d)
    todo.push({
      label:
        d.renewals_7d === 1
          ? "1 policy expires within a week"
          : `${d.renewals_7d} policies expire within a week`,
      to: "/portal/renewals",
      count: d.renewals_7d,
    });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {greeting()}
          {firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your business with Agastya, at a glance.
        </p>
      </header>

      <section className="overflow-hidden rounded-xl bg-slate-900 text-white shadow-sm">
        <div className="px-5 py-4 sm:px-6 sm:py-5">
          <NetPosition net={d?.money.net_balance ?? 0} dark />
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-white/10 pt-3.5">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-white/55">
                Reward earned
              </dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                {formatINR(d?.money.reward_earned_unpaid)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-white/55">
                Premium you hold
              </dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                {formatINR(d?.money.premium_owed)}
              </dd>
            </div>
          </dl>
        </div>
        <Link
          to="/portal/earnings"
          className="flex items-center justify-between gap-2 border-t border-white/10 px-5 py-3 text-xs font-medium text-white/80 transition-colors hover:bg-white/[0.06] hover:text-white sm:px-6"
        >
          See every transaction
          <ChevronRight className="h-4 w-4" />
        </Link>
      </section>

      <TargetCard />

      {todo.length > 0 && (
        <Card className="border-l-4 border-l-amber-500 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Needs you
          </p>
          <ul className="mt-1.5 space-y-1">
            {todo.map((t) => (
              <li key={t.to}>
                <Link
                  to={t.to}
                  className="flex items-center justify-between gap-3 text-[13px] font-medium text-foreground hover:text-primary"
                >
                  {t.label}
                  <ChevronRight className="h-4 w-4 shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <DateFilter value={period} onChange={setPeriod} />
        <span className="text-xs text-muted-foreground">{d?.period_label}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link
          to="/portal/policies"
          className="rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-primary/40"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Policies</span>
            <FileText className="h-3.5 w-3.5" />
          </div>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
            {d?.policies ?? 0}
          </p>
        </Link>
        <Link
          to="/portal/policies"
          className="rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-primary/40"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Premium</span>
            <IndianRupee className="h-3.5 w-3.5" />
          </div>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
            {formatINR(d?.premium)}
          </p>
        </Link>
        <Link
          to="/portal/earnings"
          className="rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-primary/40"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>You earned</span>
            <Wallet className="h-3.5 w-3.5 text-emerald-600" />
          </div>
          <p className="mt-1 text-lg font-semibold tabular-nums text-emerald-700">
            {formatINR(d?.my_earning)}
          </p>
        </Link>
        <Link
          to="/portal/renewals"
          className="rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-primary/40"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Renewals due</span>
            <RefreshCw className="h-3.5 w-3.5" />
          </div>
          <p
            className={`mt-1 text-lg font-semibold tabular-nums ${
              d?.renewals_30d ? "text-amber-700" : "text-foreground"
            }`}
          >
            {d?.renewals_30d ?? 0}
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
              next 30d
            </span>
          </p>
        </Link>
      </div>

      <Button
        size="lg"
        className="w-full"
        onClick={() => navigate("/portal/quotes/new")}
      >
        <Plus className="mr-1.5 h-4 w-4" /> Ask for a quotation
      </Button>

      {d?.latest_notice && (
        <Link
          to="/portal/notices"
          className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/30"
        >
          <Bell className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-foreground">
                {d.latest_notice.title}
              </span>
              {!d.latest_notice.read && (
                <Badge
                  variant="outline"
                  className="h-4 border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800"
                >
                  new
                </Badge>
              )}
            </span>
            <span className="block text-xs text-muted-foreground">
              From Agastya · {formatDate(d.latest_notice.created_at)}
            </span>
          </span>
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">
            Recent policies
          </h2>
          <Link
            to="/portal/policies"
            className="text-xs font-medium text-primary hover:underline"
          >
            See all
          </Link>
        </div>
        {(d?.recent_policies.length ?? 0) === 0 ? (
          <Card className="px-5 py-7 text-center">
            <p className="text-xs text-muted-foreground">
              Nothing here yet. When Agastya books a policy for you, it appears
              here with what you earned on it.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {d!.recent_policies.map((p) => (
              <Link
                key={p.id}
                to={`/portal/policies/${p.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2.5 transition-colors hover:bg-muted/30"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-foreground">
                    {p.policy_number || p.code}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.customer_name || "—"} · {p.category_label}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="block whitespace-nowrap text-sm font-semibold tabular-nums text-emerald-700">
                    {formatINR(p.my_earning)}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">
                    you earned
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
