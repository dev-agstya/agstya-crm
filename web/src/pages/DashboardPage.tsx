import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  managersApi, payslipsApi, remindersApi, reportsApi, targetsApi,
} from "../api/endpoints";
import { Avatar, ErrorState, PageLoader } from "../components/ui";
import { Icon } from "../components/Icon";
import {
  AttainmentPct, TargetCard, toneFor,
} from "../components/TargetProgress";
import { PunchTile } from "../components/hr/PunchTile";
import { useAuth } from "../store/auth";
import PortalHome from "./portal/PortalHome";
import { formatINR, formatMonthYear } from "../lib/format";
import { liveQueryOptions } from "../lib/live";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import type { DashboardStats, TargetWindow } from "../lib/types";
import { moneyTone } from "../lib/tone";
import {
  PAYSLIP_STATUS_LABELS, payslipBadge, payslipMonthLabel,
} from "../lib/payroll";

/*
  THREE HOME PAGES, not one with things hidden (owner 2026-08-06).

  The owner runs a business: cash in, cash out, what was written, what is about
  to lapse, and whether the month is going anywhere. The employee runs a patch:
  their own number and the channel partners they were given, in that order,
  because that is the order they can do something about. The channel partner
  gets their own screen entirely (pages/portal/PortalHome) — they are on a
  phone, and their first question is money.

  What decides what appears is never the layout: every figure is omitted by the
  SERVER when the caller may not see it (routers/reports.dashboard computes
  nothing it is not allowed to send), so a tile missing here means the number
  never left the building.
*/

// --- Target progress ---------------------------------------------------------

// Labels for the window picker, worked out from today so they read
// "July 2026 / June 2026 / May 2026" rather than "prev1".
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

// The target card.
//
// An EMPLOYEE sees their own numbers — and since 2026-08-06 those include the
// business their channel partners wrote, because that is what "here is your
// hundred, split it across your ten partners" has to mean (services/targets).
// The OWNER carries no target of their own (they set everyone else's), so they
// get the team's combined position instead.
//
// House profit never reaches an employee here. The server strips that row
// (services/targets.can_see_profit_targets), so this renders whatever it is
// handed and makes no visibility decision of its own.
function TargetProgressCard() {
  const [win, setWin] = useState<TargetWindow>("current");
  const options = useMemo(windowOptions, []);

  const progress = useQuery({
    queryKey: ["target-progress", win],
    queryFn: async () => (await targetsApi.progress({ window: win })).data,
  });

  /*
    THE ERROR BRANCH COMES FIRST (the 2026-08-06 rule, applied here 2026-08-21).

    This card used to be `if (!d) return null`, which collapsed three different
    situations into one blank space: still loading, request failed, and no data.
    On the screen everybody lands on, a failed fetch simply removed the card —
    so an employee whose target had been set read the dashboard as "nobody has
    given me a number", which is a claim about DATA, made out of a network
    error. This app is one Render instance and a cold start after idle is
    routine, so that is not a rare path.
  */
  if (progress.isError) {
    return <ErrorState onRetry={() => progress.refetch()} />;
  }
  const d = progress.data;
  if (!d) return null;   // first load only — the error case is handled above

  const team = d.scope === "team";
  return (
    <TargetCard
      title={team ? "Team target progress" : "My target"}
      subtitle={
        <>
          {d.label}
          {team && (
            <span className="font-normal text-slate-500">
              {" · "}{d.people_with_target} of {d.people} with a target
            </span>
          )}
        </>
      }
      rows={d.metrics}
      attainmentPct={d.attainment_pct}
      hasTarget={d.has_target && d.metrics.length > 0}
      empty={team
        ? "Nobody has been given a target for this period yet."
        // Owner D4: say so rather than hiding the card. An employee who has not
        // been set a number should know that, not wonder where the card went.
        : `No target has been set for ${d.label} yet. Ask an owner.`}
      right={
        <select className="select h-9 w-[150px] text-xs" value={win}
          title="Show another month"
          onChange={(e) => setWin(e.target.value as TargetWindow)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      }
      /*
        A WAY OUT OF THE CARD (owner C2, 2026-08-21). This was the only place an
        employee could see their own target and it led nowhere — no history, no
        previous month, and no sight of the partners the number is split across.
        Worse, when they had no target of their own it said "ask an owner" and
        stopped, which is a dead end on the one screen they open every day.

        The Targets page is `employeeAny` now, so this link resolves for
        everybody who can see this card.
      */
      footer={
        <div className="mt-3 border-t border-line/70 pt-3">
          <Link to="/targets"
            className="inline-flex items-center gap-1.5 text-sm font-medium
              text-slate-700 hover:text-slate-900">
            {team ? "Open Targets" : "My targets and my roster"}
            <Icon.ChevronRight size={15} />
          </Link>
        </div>
      }
    />
  );
}

// --- My team (employee) ------------------------------------------------------

// How many partners the dashboard lists before handing over to the full page
// (owner D2). Five, worst first — the point of the block is the one you need to
// ring, not a directory.
const TEAM_PREVIEW = 5;

/**
 * The channel partners this employee manages, against the targets they were
 * given.
 *
 * Hidden entirely when they manage nobody (owner D3): an empty card on a home
 * page teaches people to stop looking at the home page.
 *
 * Sorted worst-attainment first, with "has no target at all" sorting to the
 * very top — a partner nobody has given a number to is a more urgent gap than
 * one who is behind on theirs.
 */
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
    (r) => r.has_target && r.attainment_pct >= 100).length;

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3
        border-b border-line px-5 py-3.5">
        <div>
          <p className="text-caption uppercase text-slate-500">My team</p>
          <p className="mt-0.5 text-sm font-semibold text-slate-800">
            {d.partners} channel {d.partners === 1 ? "partner" : "partners"}
            <span className="font-normal text-slate-500">
              {" · "}{d.partners_with_target} with a target
              {" · "}{onTrack} on track
              {d.quiet_partners > 0 && (
                <span className="text-due"> · {d.quiet_partners} quiet</span>
              )}
            </span>
          </p>
        </div>
        <Link to="/people/partners?view=team"
          className="text-sm font-medium text-slate-600 hover:text-slate-900">
          See all
        </Link>
      </div>

      <ul className="divide-y divide-line/70">
        {shown.map((r) => (
          <li key={r.partner_id}>
            <Link to={`/people/partners/${r.partner_id}`}
              className="flex items-center gap-3 px-5 py-3 transition-colors
                hover:bg-slate-50">
              <Avatar name={r.partner_name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium
                  text-slate-800">{r.partner_name}</span>
                <span className="block text-xs text-slate-500">
                  {r.policies} {r.policies === 1 ? "policy" : "policies"}
                  {" · "}{formatINR(r.premium)}
                  {r.is_quiet && (
                    <span className="text-due"> · quiet</span>
                  )}
                </span>
              </span>
              <span className="w-28 shrink-0 text-right">
                {r.has_target ? (
                  <>
                    <AttainmentPct pct={r.attainment_pct} size="sm" />
                    <span className="mt-1 block h-1.5 w-full overflow-hidden
                      rounded-full bg-slate-100">
                      <span className={`block h-full rounded-full ${
                        toneFor(r.attainment_pct) === "done" ? "bg-money-in"
                          : toneFor(r.attainment_pct) === "close"
                            ? "bg-due" : "bg-slate-400"}`}
                        style={{ width: `${Math.min(
                          100, Math.max(2, r.attainment_pct))}%` }} />
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-slate-500">no target</span>
                )}
              </span>
              <Icon.ChevronRight size={16} className="shrink-0 text-slate-300" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- Tiles -------------------------------------------------------------------

/**
 * ONE tile. Every figure on the board is this shape: caption label, icon in the
 * corner, figure, optional sub-line.
 *
 * There used to be three shapes — this, plus a bespoke Net Profit card and a
 * bespoke Growth card, each with its own label casing (`text-sm` sentence case
 * vs `text-caption` uppercase), its own value size and its own padding. On the
 * owner's board that meant rows 1-2 and row 3 visibly did not belong to the
 * same set, which reads as "unfinished" long before anyone can say why.
 */
function MetricCard({ label, value, icon, onClick, sub, tone, title }: {
  label: string; value: string; icon: keyof typeof Icon;
  onClick?: () => void;
  /** One quiet line under the figure — a comparison, a horizon, a count. */
  sub?: React.ReactNode;
  /** `danger` for a number that means something is late; `money` for a signed
   *  figure that has already been through moneyTone. */
  tone?: "danger" | string;
  /** A short explanation for a figure that is not self-evident from the label. */
  title?: string;
}) {
  const IconCmp = Icon[icon];
  const valueTone = tone === "danger" ? "text-money-out"
    : tone ? tone : "text-slate-900";
  /*
    A tile that does not navigate is a DIV, not a disabled button (2026-08-07).

    Every tile on this board used to be `<button disabled={!onClick}>`, so a
    screen reader announced the headline figure of the business as "dimmed
    button" and it was dropped from the tab order — for a number that was never
    interactive in the first place. `disabled` also suppresses the title
    attribute in some browsers.

    `StatCard` in components/ui.tsx already solved this by switching element on
    whether it has a destination; this now does the same.
  */
  const Wrap = onClick ? "button" : "div";
  return (
    <Wrap
      {...(onClick ? { type: "button" as const, onClick } : {})}
      title={title}
      className={`card flex flex-col justify-between gap-3 p-4 text-left
        transition-all duration-150 ${onClick
          ? "hover:-translate-y-px hover:border-slate-300 hover:shadow-raise"
          : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-caption uppercase text-slate-500">{label}</p>
        <IconCmp size={16} className="shrink-0 text-slate-300" />
      </div>
      <div className="min-w-0">
        <p className={`truncate text-metric tabular-nums ${valueTone}`}>
          {value}</p>
        {sub && (
          <p className="mt-1 truncate text-xs text-slate-500">{sub}</p>
        )}
      </div>
    </Wrap>
  );
}

function GrowthBadge({ label, pct }: { label: string; pct?: number | null }) {
  const known = pct !== null && pct !== undefined;
  const up = (pct ?? 0) >= 0;
  return (
    <div>
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`mt-0.5 inline-flex items-center gap-1 text-metric-sm
        tabular-nums ${!known ? "text-slate-500"
          : up ? "text-money-in" : "text-money-out"}`}>
        {known ? (
          <>
            <Icon.Trend size={16}
              className={up ? "" : "-scale-y-100"} />
            {Math.abs(pct as number)}%
          </>
        ) : "—"}
      </p>
    </div>
  );
}

function MoneyTiles({ s, onOpen }: {
  s?: DashboardStats; onOpen: (to: string) => void;
}) {
  return (
    <>
      <MetricCard label="Pending to collect"
        value={formatINR(s?.pending_to_collect)} icon="Money"
        onClick={() => onOpen("/finance")} />
      <MetricCard label="Pending to pay"
        value={formatINR(s?.pending_to_pay)} icon="Money"
        onClick={() => onOpen("/finance")} />
    </>
  );
}

function ProfitTiles({ s }: { s?: DashboardStats }) {
  return (
    <>
      {/* Sign/colour rule: negative RED, positive GREEN, zero BLUE — owned by
          lib/tone, so this figure and the Balance Sheet's cannot end up in two
          different greens. */}
      <MetricCard label="Net profit" icon="Shield"
        value={formatINR(s?.net_profit_mtd)}
        tone={moneyTone(s?.net_profit_mtd)}
        sub="this month"
        title="House profit — agency reward minus partner reward, booked this month" />
      {/* Growth is TWO figures, so it is the one tile that cannot be a single
          number. It keeps the tile's frame — label, icon, sub-line — and swaps
          only the value row, rather than being a differently-shaped card. */}
      <div className="card flex flex-col justify-between gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-caption uppercase text-slate-500">Growth</p>
          <Icon.Trend size={16} className="shrink-0 text-slate-300" />
        </div>
        <div>
          <div className="flex items-center gap-6">
            <GrowthBadge label="Policies" pct={s?.growth_policies_pct} />
            <GrowthBadge label="Earnings" pct={s?.growth_earning_pct} />
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">
            this month vs last</p>
        </div>
      </div>
    </>
  );
}

// --- The two staff boards ----------------------------------------------------

/**
 * The owner's board. Money first, then what was written, then whether it is
 * growing — the order they confirmed (owner C1), unchanged from what shipped.
 * Below the tiles: the team's combined target, then who is carrying it.
 */
function OwnerBoard({ s, go }: { s?: DashboardStats; go: (to: string) => void }) {
  const { has } = useAuth();
  const canFinance = has("manage_transactions") || has("view_finance_overview");
  const canPolicies = has("view_policies");
  const canProfit = has("view_agency_profit");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {canFinance && <MoneyTiles s={s} onOpen={go} />}
        {canPolicies && (
          <>
            <MetricCard label="Policies done"
              value={String(s?.policies_mtd ?? 0)} icon="Policy"
              sub="this month"
              onClick={() => go("/policies")} />
            <MetricCard label="Renewals due"
              value={String(s?.renewals_due_30d ?? 0)} icon="Refresh"
              sub="next 30 days"
              tone={(s?.renewals_due_30d ?? 0) > 0 ? "danger" : undefined}
              onClick={() => go("/renewals")} />
          </>
        )}
        {canProfit && <ProfitTiles s={s} />}
      </div>
      {/*
        The team-target card and the top-performers list were here and are gone
        (owner 2026-08-07).

        Both are league tables, and a league table is a thing you go and study,
        not a thing you glance at forty times a day. They pushed the tiles — the
        actual answer to "how are we doing right now" — up against the top of
        the screen and filled the rest of it with names.

        Neither is lost: the team's target lives on Targets, and the ranking is
        the Performance view of Employees (`/people/employees?view=performance`),
        which is where somebody comparing people is already headed.
      */}
    </div>
  );
}

/**
 * The employee's board (owner D1). Their own number first, then the partners
 * they were given, then their queue — the order they can act on it in. Money
 * comes last and only with the permission for it: an executive who cannot open
 * the finance pages has no use for the agency's receivables at the top of their
 * home screen.
 */
function EmployeeBoard({ s, go }: {
  s?: DashboardStats; go: (to: string) => void;
}) {
  const { has } = useAuth();
  const canFinance = has("manage_transactions") || has("view_finance_overview");
  const canPolicies = has("view_policies");
  const canProfit = has("view_agency_profit");

  // My own follow-ups: three indexed counts, so the tile costs nothing. This is
  // an EMPLOYEE tile — the owner runs the desk rather than working the
  // pipeline, so the query is never issued for them at all.
  const myReminders = useQuery({
    queryKey: ["reminders", "counts", "mine"],
    queryFn: async () => (await remindersApi.counts({ scope: "mine" })).data,
    ...liveQueryOptions,
  });
  const overdue = myReminders.data?.overdue ?? 0;

  return (
    <div className="space-y-4">
      {/* FIRST, above the target. The one thing an employee does every single
          day, on the screen they land on — if clocking in needs a navigation
          people forget, and somebody then spends their morning approving
          correction requests (owner H3). It renders NOTHING on a week off, a
          holiday, or for an account that does not clock in. */}
      <PunchTile />
      {/* What you were last paid, and whether anything is waiting. One row,
          under the clock — a payslip is checked once a month, so it earns a
          line rather than a tile, and it disappears entirely until the first
          one exists. */}
      <MyPayslipStrip go={go} />
      <TargetProgressCard />
      <MyTeamBlock />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {canPolicies && (
          <>
            <MetricCard label="My policies"
              value={String(s?.policies_mtd ?? 0)} icon="Policy"
              sub="this month"
              onClick={() => go("/policies")} />
            <MetricCard label="Renewals due"
              value={String(s?.renewals_due_30d ?? 0)} icon="Refresh"
              sub="next 30 days"
              tone={(s?.renewals_due_30d ?? 0) > 0 ? "danger" : undefined}
              onClick={() => go("/renewals")} />
            {/* What THIS person owes a follow-up on today. Overdue is counted
                against the Indian day boundary server-side. */}
            <MetricCard
              label={overdue > 0 ? "Follow-ups overdue" : "Follow-ups today"}
              value={String(myReminders.data?.due_today ?? 0)}
              icon="Clock"
              sub={overdue > 0 ? `${overdue} past due` : "due today"}
              tone={overdue > 0 ? "danger" : undefined}
              onClick={() => go("/leads")} />
          </>
        )}
        {canFinance && <MoneyTiles s={s} onOpen={go} />}
        {canProfit && <ProfitTiles s={s} />}
      </div>
    </div>
  );
}

/**
 * My last payslip, on my own dashboard.
 *
 * The owner asked for the employee to be able to "go to the payslip section and
 * see the salary slip in detail" — the nav entry does that. This is the
 * SIGNPOST, and this repo has learned twice over that a feature nobody can find
 * is a feature nobody has (the employee Team tab on 2026-08-19, /targets on
 * 2026-08-21).
 *
 * Renders NOTHING until a payslip exists, so a new joiner's dashboard is not
 * carrying an empty box about pay they have not earned yet. No permission: it
 * is their own.
 */
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
    <button
      className="card-link flex w-full flex-wrap items-center gap-x-4 gap-y-1
        px-5 py-3.5 text-left"
      onClick={() => go(`/hr/payslips?slip=${latest.id}`)}>
      <span className="text-caption uppercase text-slate-500">
        {payslipMonthLabel(latest.month)}
      </span>
      <span className="text-metric-sm tabular-nums text-slate-900">
        {formatINR(latest.net_payable_paise)}
      </span>
      <span className={`badge ${payslipBadge(latest.status)}`}>
        {PAYSLIP_STATUS_LABELS[latest.status]}
      </span>
      <span className="ml-auto text-xs text-slate-500">
        {waiting ? "Waiting to be paid" : "See the breakdown"}
        <Icon.ChevronRight size={13} className="ml-1 inline align-[-2px]" />
      </span>
    </button>
  );
}

// --- The page ----------------------------------------------------------------

export default function DashboardPage() {
  const { user } = useAuth();
  // Set before the partner/staff branch so both halves get the same tab name.
  useDocumentTitle("Dashboard");
  // A channel partner's home is their own portal summary: /api/reports is
  // staff-only, so the staff dashboard below would only 403 for them.
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
  // The date, spelled out — a dashboard is a "where are we today" screen and
  // it never said which day it was.
  const today = useMemo(() => new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric" }), []);

  if (stats.isError) return <ErrorState onRetry={() => stats.refetch()} />;
  if (stats.isLoading) return <PageLoader />;
  const s = stats.data;
  const isOwner = user?.account_type === "owner";

  const go = (link: string) => navigate(link);

  return (
    <div className="mx-auto w-full max-w-6xl">
      {/*
        THE HEADER, REBUILT 2026-08-06.

        What was here: a randomly-chosen slogan — "Guarding What Matters
        Most." — set in the largest type on the page, above a centred search
        box, the pair of them claiming the full height of the viewport with
        `flex-1`. Every actual number was below the fold. Screenshotting the app
        made it obvious in a way that reading the file never did: the owner's
        home screen led with an insurance platitude that changed on every
        reload, and you had to scroll to find out how the business was doing.

        Now it is one row: who you are and what day it is on the left, search on
        the right. The greeting is the heading, because a greeting addressed to
        you is at least ABOUT you; the slogan was about nobody. Everything below
        starts within the first screen.
      */}
      {/*
        ONE LINE. No search box, no "as of" qualifier.

        The search box was here because there was no top bar to put one in.
        There is now, on every page — so a second field on this page alone was
        the same control twice, and the one that only works on one screen is the
        one people learn.

        "figures as of now" went with it: every figure in this product is as of
        now unless it says otherwise, so the line was reassuring nobody and
        taking a row to do it. The date stays because "which day am I looking
        at" is a real question on a screen full of month-to-date numbers.
      */}
      <header className="mb-6">
        <h1 className="text-page-title text-slate-900">Dashboard</h1>
        <p className="mt-0.5 text-sm text-slate-500">{today}</p>
      </header>

      {isOwner ? <OwnerBoard s={s} go={go} />
        : <EmployeeBoard s={s} go={go} />}
    </div>
  );
}
