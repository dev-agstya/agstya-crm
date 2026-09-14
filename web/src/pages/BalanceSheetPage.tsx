import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { financeApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { useAuth } from "../store/auth";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  ErrorState, EmptyState, Pagination, SearchInput, Segmented,
} from "../components/ui";
import { toast } from "../components/Toast";
import {
  type PaymentParty,
} from "../components/RecordPaymentForm";
import { catColor } from "../components/finance/charts";
import { NetAmount, netView, type NetParty } from "../components/finance/NetBalance";
import {
  DateFilter, periodLabel, periodParams, type PeriodValue,
} from "../components/finance/DateFilter";
import { formatINR, initials } from "../lib/format";
import { liveQueryOptions } from "../lib/live";
import type {
  BalanceSheetDetail, BalanceSheetItem, BalanceSheetSection,
} from "../lib/types";
import { moneyTone } from "../lib/tone";

const SECTIONS: {
  value: BalanceSheetSection; label: string; icon: keyof typeof Icon;
}[] = [
  { value: "broker", label: "Brokers", icon: "Insurer" },
  { value: "partner", label: "Channel Partners", icon: "Wallet" },
  { value: "customer", label: "Customers", icon: "Customers" },
];

const NET_PARTY: Record<BalanceSheetSection, NetParty> = {
  broker: "broker", partner: "partner", customer: "customer",
};

// The party kind the Record Payment modal expects.
const PAYMENT_KIND: Record<BalanceSheetSection, PaymentParty["kind"]> = {
  broker: "broker", partner: "channel_partner", customer: "customer",
};

// The sign/colour rule lives in lib/tone. It used to be re-declared here, on
// Finance Overview, on Reports, on the Dashboard and in NetBalance — five
// copies with three different greens between them.
const amountCls = moneyTone;

/* ------------------------------------------------------------- list rows -- */

// The figure shown on the right of a list row follows the ACTIVE sort:
//   net_balance -> current position (coloured by who-owes-whom, via NetAmount)
//   profit      -> the party's profit contribution for the selected period
function RowMetric({ r, sort, party }: {
  r: BalanceSheetItem; sort: SortKey; party: NetParty;
}) {
  if (sort === "profit")
    return (
      <>
        <span className={`block text-sm font-semibold tabular-nums ${
          amountCls(r.profit)}`}>{formatINR(r.profit)}</span>
        <span className="block text-[11px] text-slate-500">
          profit contribution</span>
      </>
    );
  return (
    <>
      <NetAmount receivable={r.net_balance} party={party}
        className="block text-sm font-semibold" />
      <span className="block text-[11px] text-slate-500">net balance</span>
    </>
  );
}

// The two list sorts the owner asked for. First click sorts HIGH -> LOW
// (most-useful-first); clicking the active sort flips it.
type SortKey = "net_balance" | "profit";
const SORTS: { value: SortKey; label: string }[] = [
  { value: "net_balance", label: "Net Balance" },
  { value: "profit", label: "Profit" },
];

/* -------------------------------------------------------------- fragments -- */

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const cls = size === "sm" ? "h-8 w-8 text-[11px]" : "h-11 w-11 text-sm";
  return (
    <span className={`flex ${cls} shrink-0 items-center justify-center
      rounded-full bg-slate-900 font-semibold text-white`}>
      {initials(name)}
    </span>
  );
}

// One metric tile in the detail panel.
function Stat({ label, value, sub, tone }: {
  label: string; value: React.ReactNode; sub?: string; tone?: string;
}) {
  return (
    <div className="rounded-card border border-line bg-white p-3">
      <p className="truncate text-xs font-medium uppercase tracking-wide
        text-slate-500">{label}</p>
      <p className={`mt-1 text-metric-sm tabular-nums ${
        tone ?? "text-slate-800"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

// Holds the panel's shape while a different party loads, instead of collapsing
// the whole right-hand column to a spinner on every click.
function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-16 rounded-card bg-slate-100" />
      <div className="h-24 rounded-card bg-slate-100" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[74px] rounded-card bg-slate-100" />
        ))}
      </div>
      <div className="h-40 rounded-card bg-slate-100" />
    </div>
  );
}

// The hero figure: who owes whom, right now.
function NetBalanceCard({ receivable, party }: {
  receivable: number; party: NetParty;
}) {
  const v = netView(receivable, party);
  const hint =
    receivable === 0 ? "Settled — nothing outstanding either way"
      : party === "broker"
        ? (receivable > 0 ? "Reward to receive from this broker"
          : "You owe this broker")
        : (receivable > 0 ? "They have to pay you" : "You have to pay them");
  // Borders, not tinted panels: the money colour on the FIGURE is what carries
  // the meaning, and washing the whole card in it says the same thing twice.
  const ring = receivable === 0 ? "border-line"
    : v.cls.includes("green") ? "border-money-in/30" : "border-money-out/30";
  return (
    <div className={`rounded-card border bg-white p-5 shadow-card ${ring}`}>
      <p className="text-caption uppercase text-slate-500">Net Balance</p>
      <p className={`mt-1.5 text-metric tabular-nums ${v.cls}`}>
        {receivable === 0 ? formatINR(0)
          : `${v.display > 0 ? "+" : "−"}${formatINR(Math.abs(v.display))}`}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {hint} · current position, not affected by the date filter</p>
    </div>
  );
}

function metricsFor(d: BalanceSheetDetail): {
  label: string; value: React.ReactNode; sub?: string; tone?: string;
}[] {
  const pct = d.avg_reward_pct == null ? "—" : `${d.avg_reward_pct}%`;
  const policiesTile = {
    label: "Total Policies",
    value: String(d.total_policies),
    sub: `${d.active_policies ?? 0} active in this period`,
  };
  if (d.section === "broker") return [
    policiesTile,
    { label: "Rewards Earned", value: formatINR(d.reward_earned) },
    { label: "Rewards Received", value: formatINR(d.reward_received),
      tone: "text-money-in" },
    // TDS tile leads with the broker's rate; the amount withheld sits under it.
    { label: "TDS", value: d.tds_percent != null
        ? `${(d.tds_percent / 100).toFixed(d.tds_percent % 100 ? 2 : 0)}%` : "—",
      sub: `${formatINR(d.tds_deducted)} deducted`,
      tone: "text-due" },
    // What we actually pocketed: rewards RECEIVED net of TDS. `?? 0` here
    // turned "the request failed" into a confident "Total Earnings ₹0" in the
    // largest type on the tile — formatINR(null) already renders an em-dash,
    // which is the honest answer.
    { label: "Total Earnings", value: formatINR(d.total_earnings),
      sub: "Rewards received − TDS", tone: "text-money-in" },
    { label: "Avg Reward %", value: pct },
  ];
  if (d.section === "partner") return [
    policiesTile,
    { label: "Business Generated", value: formatINR(d.premium) },
    { label: "Rewards Earned", value: formatINR(d.reward_earned) },
    { label: "Profit Contribution", value: formatINR(d.house_profit),
      tone: "text-money-in" },
  ];
  return [   // customer
    policiesTile,
    { label: "Discount Given", value: formatINR(d.discount) },
    { label: "Profit Contribution", value: formatINR(d.house_profit),
      tone: "text-money-in" },
  ];
}

/* --------------------------------------------------------- detail panel -- */

function DetailPanel({ section, id, period }: {
  section: BalanceSheetSection; id: string; period: PeriodValue;
}) {
  const nav = useNavigate();
  const { has, user } = useAuth();
  const [pdfBusy, setPdfBusy] = useState(false);
  const detail = useQuery({
    queryKey: ["finance", "balance-sheet-detail", section, id, period],
    queryFn: async () =>
      (await financeApi.balanceSheetDetail(section, id, periodParams(period)))
        .data,
    ...liveQueryOptions,
  });
  const d = detail.data;
  // Keep the previous party's shape on screen only until the first load lands.
  if (!d) return <DetailSkeleton />;

  const catMax = Math.max(1, ...d.by_category.map((c) => c.premium));
  const catTotal = Math.max(1, d.by_category.reduce((a, c) => a + c.premium, 0));
  const isPartner = section === "partner";
  const canPay = user?.account_type === "owner" || has("manage_transactions");

  // Net balance from the AGENCY-receivable view for the colour rule.
  const receivable = section === "partner"
    ? -(d.net_balance)          // partner detail net is partner-perspective
    : d.net_balance;

  const genPdf = async () => {
    setPdfBusy(true);
    try {
      const res = await financeApi.statementPdf(section, id,
        periodParams(period));
      // The server names the file (PREFIX_statement_Name_Code.pdf); read it
      // back off the Content-Disposition so both ends can never disagree.
      const disposition = String(
        (res.headers as Record<string, string>)["content-disposition"] ?? "");
      const named = /filename="?([^";]+)"?/.exec(disposition)?.[1];
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = named || `statement_${section}_${d.code || id}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Identity + actions */}
      <div className="card card-body">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={d.label} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-section text-slate-900">
                {d.label}</h2>
              {d.code && <span className="rounded-md bg-slate-100 px-2 py-0.5
                text-xs font-medium text-slate-500">{d.code}</span>}
              {isPartner && (
                <button onClick={() => nav(`/people/partners/${id}`)}
                  title="View profile"
                  className="rounded-md border border-line p-1
                    text-slate-500 hover:bg-slate-50 hover:text-slate-700">
                  <Icon.User size={14} /></button>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              {d.total_policies} {d.total_policies === 1 ? "policy" : "policies"}
              {" · "}{periodLabel(period)}
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t
          border-line/70 pt-3">
          {canPay && (
            <button onClick={() => nav(`/finance/transactions/new?${
            new URLSearchParams({ party_kind: PAYMENT_KIND[section],
              party_id: id,
              party_label: d.code ? `${d.label} (${d.code})` : d.label,
            })}`)}
              className="btn-secondary">
              <Icon.Plus size={15} /> Record Payment</button>
          )}
          <button onClick={genPdf} disabled={pdfBusy}
            className="btn-primary ml-auto flex items-center gap-1.5 text-sm">
            <Icon.Download size={15} />
            {pdfBusy ? "Generating…" : "Download Statement"}</button>
        </div>
      </div>

      <NetBalanceCard receivable={receivable} party={NET_PARTY[section]} />

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3">
        {metricsFor(d).map((m) => (
          <Stat key={m.label} label={m.label} value={m.value} sub={m.sub}
            tone={m.tone} />
        ))}
      </div>


      {/* Policies by category */}
      <div className="card card-body">
        <p className="mb-3 text-sm font-medium text-slate-600">
          Policies by type</p>
        {d.by_category.length === 0 ? (
          <p className="text-sm text-slate-500">No policies in this period.</p>
        ) : (
          <div className="space-y-2.5">
            {d.by_category.map((c, i) => (
              <div key={c.key} className="flex items-center gap-3 text-sm">
                <span className="w-36 shrink-0 truncate text-slate-600"
                  title={c.label}>{c.label}</span>
                <div className="relative h-5 flex-1 rounded bg-slate-100">
                  {/* One hue per policy type, in rank order — the same ramp the
                      "Premium by category" donut on Reports uses, so the two
                      screens colour Motor the same way. It was one flat black
                      bar per row until 2026-08-19. */}
                  <div className="absolute inset-y-0 left-0 rounded"
                    style={{ width: `${Math.max(3, c.premium / catMax * 100)}%`,
                      background: catColor(i) }} />
                </div>
                <span className="w-10 shrink-0 text-right text-xs text-slate-500">
                  {Math.round(c.premium / catTotal * 100)}%</span>
                <span className="w-12 shrink-0 text-right text-xs text-slate-500">
                  {c.policies}p</span>
                <span className="w-24 shrink-0 text-right font-medium
                  tabular-nums text-slate-700">
                  {formatINR(c.premium)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Broker: insurer-company-wise breakdown of business placed */}
      {d.section === "broker" && d.profiles.length > 0 && (
        <div className="card">
          <p className="border-b border-line/70 px-5 py-3 text-sm font-medium
            text-slate-600">By insurer company</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm table-sticky">
              <thead>
                <tr>
                  <th className="px-5 py-3">Insurer</th>
                  <th className="px-5 py-3 text-right">Policies</th>
                  <th className="px-5 py-3 text-right">Premium</th>
                  <th className="px-5 py-3 text-right">
                    Rewards Earned</th>
                  <th className="px-5 py-3 text-right">Earnings</th>
                </tr>
              </thead>
              <tbody>
                {d.profiles.map((p) => (
                  <tr key={p.id} className="border-t border-line-soft">
                    <td className="px-5 py-3 font-medium text-slate-700">
                      {p.label}</td>
                    <td className="px-5 py-3 text-right text-slate-600">
                      {p.policies}</td>
                    <td className="px-5 py-3 text-right text-slate-600">
                      {formatINR(p.premium)}</td>
                    <td className="px-5 py-3 text-right text-slate-600">
                      {formatINR(p.reward_earned)}</td>
                    <td className="px-5 py-3 text-right font-medium
                      text-slate-700">{formatINR(p.house_profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-slate-500">
        Volume figures follow the selected period; Net Balance is the live
        position. The downloadable statement carries the full policy list and
        the money ledger behind these numbers.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ page -- */

const PAGE_SIZE = 25;

export default function BalanceSheetPage() {
  const [section, setSection] = useState<BalanceSheetSection>("broker");
  const [period, setPeriod] = useState<PeriodValue>({ period: "this_year" });
  const [sort, setSort] = useState<SortKey>("net_balance");
  const [asc, setAsc] = useState(false);        // click the active sort to flip
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  // Search, sort and paging all happen on the SERVER now (owner 2026-09-12) —
  // a broker/partner/customer roster is no longer fetched whole and sliced in
  // the browser. Every one of those four inputs has to be in the query key,
  // or a change to any of them would silently reuse a stale page.
  const list = useQuery({
    queryKey: ["finance", "balance-sheet", section, period, sort, asc, search,
      page],
    queryFn: async () => (await financeApi.balanceSheetList(section, {
      ...periodParams(period),
      sort, order: asc ? "asc" : "desc",
      q: search.trim() || undefined,
      page, page_size: PAGE_SIZE,
    })).data,
    ...liveQueryOptions,
  });

  const rows = useMemo(() => list.data?.items ?? [], [list.data]);

  // Keep a valid selection as the page of results changes.
  useEffect(() => {
    if (rows.length === 0) { setSelected(null); return; }
    if (!selected || !rows.some((r) => r.id === selected))
      setSelected(rows[0].id);
  }, [rows, selected]);

  const changeSection = (s: BalanceSheetSection) => {
    setSection(s); setSelected(null); setSearch(""); setPage(1);
    setSort("net_balance"); setAsc(false);
  };

  const changeSearch = (v: string) => { setSearch(v); setPage(1); };

  const clickSort = (s: SortKey) => {
    setPage(1);
    if (sort === s) setAsc((v) => !v);
    else { setSort(s); setAsc(false); }
  };

  return (
    <div>
      <PageHeader title="Balance Sheet"
        actions={<DateFilter value={period} onChange={setPeriod} />} />

      {/* Section selector — full width, so the three books read as top-level
          tabs rather than a control buried in the list card. */}
      {/* The SHARED segmented control. This hand-rolled its own — same job,
          different height, different radius, `bg-slate-900` where the token is
          `ink`, and `font-semibold` where `.seg-item` is `font-medium` — so the
          most important navigational control on the page was the one place the
          pattern was not used. `fill` spreads it to the full width, which is
          what the hand-rolled version wanted `flex-1` for. */}
      <div className="mb-4">
        <Segmented<BalanceSheetSection>
          fill
          value={section}
          onChange={changeSection}
          options={SECTIONS.map((s) => ({
            value: s.value, label: s.label, icon: s.icon }))}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---- Left: the list ---- */}
        <div className="card flex max-h-[78vh] flex-col lg:col-span-1">
          {/* Search + sort toggles */}
          <div className="shrink-0 border-b border-line/70 p-3">
            <SearchInput value={search} onChange={changeSearch}
              placeholder={`Search ${SECTIONS.find(
                (s) => s.value === section)?.label.toLowerCase()}…`} />
            <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
              <span className="text-slate-500">Sort:</span>
              {SORTS.map((s) => {
                const active = sort === s.value;
                return (
                  <button key={s.value}
                    className={`flex items-center gap-0.5 rounded-md px-2 py-0.5
                      font-medium ${active
                        ? "bg-slate-900 text-white"
                        : "text-slate-500 hover:bg-slate-100"}`}
                    title={active
                      ? `Sorted ${asc ? "low → high" : "high → low"} — click to flip`
                      : `Sort by ${s.label}`}
                    onClick={() => clickSort(s.value)}>
                    {s.label}
                    {active && <span>{asc ? "↑" : "↓"}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
            <div className="space-y-px p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-control
                  bg-slate-100" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing here"
              hint={search
                ? "No records match this search."
                : "No records for this section / period."} />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {rows.map((r: BalanceSheetItem) => (
                <button key={r.id} onClick={() => setSelected(r.id)}
                  className={`flex w-full items-center gap-2.5 border-b
                    border-line-soft px-3 py-2.5 text-left last:border-0 ${
                      selected === r.id
                        ? "bg-slate-900/[0.04] ring-1 ring-inset ring-slate-900/10"
                        : "hover:bg-slate-50"}`}>
                  <Avatar name={r.label} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium
                      text-slate-700">{r.label}</span>
                    <span className="block text-xs text-slate-500">
                      {r.policies} {r.policies === 1 ? "policy" : "policies"}
                      {r.code ? ` · ${r.code}` : ""}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <RowMetric r={r} sort={sort} party={NET_PARTY[section]} />
                  </span>
                </button>
              ))}
            </div>
          )}
          {list.data && list.data.total > PAGE_SIZE && (
            <div className="shrink-0 px-3">
              <Pagination page={page} pageSize={PAGE_SIZE}
                total={list.data.total} onChange={setPage} />
            </div>
          )}
        </div>

        {/* ---- Right: the detail panel ---- */}
        <div className="lg:col-span-2">
          {selected ? (
            <DetailPanel section={section} id={selected} period={period} />
          ) : (
            <div className="card flex h-full items-center justify-center p-10">
              <p className="text-sm text-slate-500">
                Select a record to view its balance sheet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
