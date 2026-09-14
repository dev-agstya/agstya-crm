import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { portalApi } from "../../api/endpoints";
import { Icon } from "../../components/Icon";
import { ErrorState, PageLoader } from "../../components/ui";
import {
  AttainmentPct, MetricBars,
} from "../../components/TargetProgress";
import {
  DateFilter, periodParams, type PeriodValue,
} from "../../components/finance/DateFilter";
import { formatDate, formatINR, formatMonthYear } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { NetPosition, MobileCard, StatTile } from "./shared";

/*
  The Channel Partner's home screen.

  It answers, in this order, the four questions a partner actually opens the app
  for: how much have I earned and when do I get it; what is happening with the
  case I sent you; what is coming up for renewal; is there anything new.

  ONE request draws the whole thing (`GET /api/portal/summary`). A partner is on
  a phone on mobile data — four round trips to paint one screen is the
  difference between a portal they use and one they give up on.
*/

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/*
  Their target (owner E1-E3, 2026-08-06).

  A partner carries a target because their relationship manager splits their own
  goal across the roster — so this is the partner's half of a conversation the
  two of them are already having on the phone. Showing them the number is the
  point: a target nobody can see is a spreadsheet, not a target.

  It sits directly under the money and above the tiles (owner E1): money is
  still why they opened the app, and a goal above the earnings would read like
  the agency's priorities in the wrong order.

  The percentage here is the ONE a partner ever sees. "Rupees only, never a
  percentage" (owner E1) is about RATES — what the agency keeps — and progress
  against a goal they were handed on purpose is the opposite of that. There is
  no house-profit row: the server strips it before serialising.
*/

// Owner E3: this month and the two before it. The names are worked out from
// today so they read "August 2026", not "prev1".
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
  // Nothing has ever been set for this partner and nothing is loading — stay
  // quiet rather than parking an empty promise on their home screen. A month
  // they simply had no target in still says so (below), because a switcher that
  // makes a card vanish looks broken.
  if (!d) return null;
  if (!d.has_target && win === "current") return null;

  return (
    <section className="card px-5 py-4 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption uppercase text-slate-500">
            {d.has_target && d.attainment_pct >= 100
              ? "Target achieved" : "Your target"}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-slate-800">
            {d.label}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {d.has_target && <AttainmentPct pct={d.attainment_pct} size="lg" />}
          <select className="select h-9 w-[132px] text-xs" value={win}
            aria-label="Show another month"
            onChange={(e) => setWin(e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3">
        {d.has_target && d.metrics.length > 0 ? (
          <MetricBars rows={d.metrics} />
        ) : (
          <p className="text-sm text-slate-500">
            No target was set for {d.label}.
          </p>
        )}
      </div>
    </section>
  );
}

export default function PortalHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<PeriodValue>({
    period: "current_month" });

  const summary = useQuery({
    queryKey: ["portal", "summary", period],
    queryFn: async () => (await portalApi.summary(periodParams(period))).data,
  });
  const d = summary.data;
  const firstName = (user?.full_name ?? "").split(" ")[0];

  if (summary.isError) return <ErrorState onRetry={() => summary.refetch()} />;
  if (summary.isLoading) return <PageLoader />;

  // "Needs you" — the things where the ball is in the partner's court. Shown
  // ONLY when there is something, because an empty to-do list on a home screen
  // trains people to stop looking at it.
  const todo: { label: string; to: string; count: number }[] = [];
  if (d?.quotes_awaiting_me)
    todo.push({ label: d.quotes_awaiting_me === 1
      ? "1 quote request is waiting on you"
      : `${d.quotes_awaiting_me} quote requests are waiting on you`,
      to: "/portal/quotes", count: d.quotes_awaiting_me });
  if (d?.renewals_7d)
    todo.push({ label: d.renewals_7d === 1
      ? "1 policy expires within a week"
      : `${d.renewals_7d} policies expire within a week`,
      to: "/portal/renewals", count: d.renewals_7d });

  return (
    <div className="space-y-4 sm:space-y-5">
      <header>
        <h1 className="text-page-title text-slate-900">
          {greeting()}{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Your business with Agastya, at a glance.
        </p>
      </header>

      {/*
        The money, first and biggest — it is why they opened the app.

        This is the one dark surface in the portal, deliberately: a partner
        checks this figure and nothing else on most visits, and giving it the
        weight of the sidebar makes it findable in a glance on a phone held at
        arm's length. Both sides are always shown (owner E2) — hiding what they
        owe makes what they are owed wrong by subtraction.
      */}
      <section className="overflow-hidden rounded-card bg-ink text-white
        shadow-card">
        <div className="px-5 py-5 sm:px-6 sm:py-6">
          <NetPosition net={d?.money.net_balance ?? 0} dark />
          <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10
            pt-4">
            <div>
              <dt className="text-caption uppercase text-white/45">
                Reward earned</dt>
              <dd className="mt-1 text-[15px] font-semibold tabular-nums
                text-white">
                {formatINR(d?.money.reward_earned_unpaid)}
              </dd>
            </div>
            <div>
              <dt className="text-caption uppercase text-white/45">
                Premium you hold</dt>
              <dd className="mt-1 text-[15px] font-semibold tabular-nums
                text-white">
                {formatINR(d?.money.premium_owed)}
              </dd>
            </div>
          </dl>
        </div>
        <Link to="/portal/earnings"
          className="flex items-center justify-between gap-2 border-t
            border-white/10 px-5 py-3.5 text-sm font-medium text-white/80
            transition-colors hover:bg-white/[0.06] hover:text-white sm:px-6">
          See every transaction
          <Icon.ChevronRight size={16} />
        </Link>
      </section>

      {/* Their target, directly under the money (owner E1). */}
      <TargetCard />

      {todo.length > 0 && (
        <section className="card border-l-4 border-l-due px-4 py-3 sm:px-5">
          <p className="text-caption font-semibold uppercase text-slate-500">
            Needs you</p>
          <ul className="mt-1.5 space-y-1.5">
            {todo.map((t) => (
              <li key={t.to}>
                <Link to={t.to} className="flex items-center justify-between
                  gap-3 text-sm font-medium text-slate-800 hover:text-slate-900">
                  {t.label}
                  <Icon.ChevronRight size={16} className="shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <DateFilter value={period} onChange={setPeriod} />
        <span className="text-xs text-slate-500">{d?.period_label}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Policies" value={String(d?.policies ?? 0)}
          icon="Policy" to="/portal/policies" />
        <StatTile label="Premium" value={formatINR(d?.premium)}
          icon="Money" to="/portal/policies" />
        <StatTile label="You earned" value={formatINR(d?.my_earning)}
          tone="in" icon="Wallet" to="/portal/earnings" />
        <StatTile label="Renewals due" value={String(d?.renewals_30d ?? 0)}
          hint="next 30 days" tone={d?.renewals_30d ? "due" : undefined}
          icon="Refresh" to="/portal/renewals" />
      </div>

      {/* The partner's action, big enough to hit with a thumb. "Report a
          claim" sat beside it until 2026-08-19, when claims were paused — a
          button whose route no longer exists is a dead end, not a feature. */}
      <div className="grid grid-cols-1 gap-3">
        <button className="btn-primary btn-lg w-full"
          onClick={() => navigate("/portal/quotes/new")}>
          <Icon.Plus size={17} /> Ask for a quotation
        </button>
      </div>

      {d?.latest_notice && (
        <Link to="/portal/notices"
          className="card flex items-start gap-3 px-4 py-3 transition-colors
            hover:bg-slate-50 sm:px-5">
          <span className="mt-0.5 text-slate-400"><Icon.Bell size={18} /></span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">
                {d.latest_notice.title}</span>
              {!d.latest_notice.read && (
                <span className="badge bg-due/10 text-due">new</span>
              )}
            </span>
            <span className="block text-xs text-slate-500">
              From Agastya · {formatDate(d.latest_notice.created_at)}
            </span>
          </span>
          <Icon.ChevronRight size={16} className="mt-1 shrink-0 text-slate-400" />
        </Link>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-card-title text-slate-900">Recent policies</h2>
          <Link to="/portal/policies"
            className="text-sm font-medium text-slate-600 hover:text-slate-900">
            See all
          </Link>
        </div>
        {(d?.recent_policies.length ?? 0) === 0 ? (
          <div className="card px-5 py-8 text-center">
            <p className="text-sm text-slate-500">
              Nothing here yet. When Agastya books a policy for you, it appears
              here with what you earned on it.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {d!.recent_policies.map((p) => (
              <MobileCard key={p.id} to={`/portal/policies/${p.id}`}
                title={p.policy_number || p.code}
                meta={<>{p.customer_name || "—"} · {p.category_label}</>}
                right={
                  <>
                    <span className="block whitespace-nowrap text-sm
                      font-semibold tabular-nums text-money-in">
                      {formatINR(p.my_earning)}
                    </span>
                    <span className="block text-xs text-slate-500">
                      you earned</span>
                  </>
                } />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
