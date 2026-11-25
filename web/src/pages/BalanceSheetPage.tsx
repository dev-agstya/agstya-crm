import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  Download,
  Plus,
  Search,
  User,
  Users,
  Wallet,
} from "lucide-react";
import { financeApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { useAuth } from "../store/auth";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { ErrorState } from "../components/shared/ErrorState";
import { Pagination } from "../components/ui";
import { toast } from "../components/Toast";
import { type PaymentParty } from "../components/RecordPaymentForm";
import { catColor } from "../components/finance/charts";
import {
  NetAmount,
  netView,
  type NetParty,
} from "../components/finance/NetBalance";
import {
  DateFilter,
  periodLabel,
  periodParams,
  type PeriodValue,
} from "../components/finance/DateFilter";
import { formatINR, initials } from "../lib/format";
import { liveQueryOptions } from "../lib/live";
import type {
  BalanceSheetDetail,
  BalanceSheetItem,
  BalanceSheetSection,
} from "../lib/types";
import { moneyTone } from "../lib/tone";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SECTIONS: {
  value: BalanceSheetSection;
  label: string;
  IconComp: typeof Building2;
}[] = [
  { value: "broker", label: "Brokers", IconComp: Building2 },
  { value: "partner", label: "Channel Partners", IconComp: Wallet },
  { value: "customer", label: "Customers", IconComp: Users },
  { value: "custom", label: "Khata (Parties)", IconComp: User },
];

const NET_PARTY: Record<BalanceSheetSection, NetParty> = {
  broker: "broker",
  partner: "partner",
  customer: "customer",
  custom: "custom",
};

const PAYMENT_KIND: Record<BalanceSheetSection, PaymentParty["kind"]> = {
  broker: "broker",
  partner: "channel_partner",
  customer: "customer",
  custom: "custom",
};

const amountCls = moneyTone;

function RowMetric({
  r,
  sort,
  party,
}: {
  r: BalanceSheetItem;
  sort: SortKey;
  party: NetParty;
}) {
  if (sort === "profit")
    return (
      <>
        <span
          className={`block text-[13px] font-semibold tabular-nums ${amountCls(
            r.profit
          )}`}
        >
          {formatINR(r.profit)}
        </span>
        <span className="block text-[10px] text-muted-foreground">
          profit contribution
        </span>
      </>
    );
  return (
    <>
      <NetAmount
        receivable={r.net_balance}
        party={party}
        className="block text-[13px] font-semibold"
      />
      <span className="block text-[10px] text-muted-foreground">
        net balance
      </span>
    </>
  );
}

type SortKey = "net_balance" | "profit";
const SORTS: { value: SortKey; label: string }[] = [
  { value: "net_balance", label: "Net Balance" },
  { value: "profit", label: "Profit" },
];

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: string;
}) {
  return (
    <Card className="p-3">
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-0.5 text-base font-semibold tabular-nums ${
          tone ?? "text-foreground"
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-16 rounded-lg bg-muted" />
      <div className="h-24 rounded-lg bg-muted" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[72px] rounded-lg bg-muted" />
        ))}
      </div>
      <div className="h-40 rounded-lg bg-muted" />
    </div>
  );
}

function NetBalanceCard({
  receivable,
  party,
}: {
  receivable: number;
  party: NetParty;
}) {
  const v = netView(receivable, party);
  const hint =
    receivable === 0
      ? "Settled — nothing outstanding either way"
      : party === "broker"
        ? receivable > 0
          ? "Reward to receive from this broker"
          : "You owe this broker"
        : receivable > 0
          ? "They have to pay you"
          : "You have to pay them";
  const ring =
    receivable === 0
      ? "border-border"
      : v.cls.includes("green") || v.cls.includes("emerald")
        ? "border-emerald-200"
        : "border-destructive/30";

  return (
    <Card className={`p-4 ${ring}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Net Balance
      </p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${v.cls}`}>
        {receivable === 0
          ? formatINR(0)
          : `${v.display > 0 ? "+" : "−"}${formatINR(Math.abs(v.display))}`}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {hint} · current position, not affected by the date filter
      </p>
    </Card>
  );
}

function metricsFor(d: BalanceSheetDetail): {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: string;
}[] {
  const pct = d.avg_reward_pct == null ? "—" : `${d.avg_reward_pct}%`;
  const policiesTile = {
    label: "Total Policies",
    value: String(d.total_policies),
    sub: `${d.active_policies ?? 0} active in this period`,
  };
  if (d.section === "broker")
    return [
      policiesTile,
      { label: "Rewards Earned", value: formatINR(d.reward_earned) },
      {
        label: "Rewards Received",
        value: formatINR(d.reward_received),
        tone: "text-emerald-700",
      },
      {
        label: "TDS",
        value:
          d.tds_percent != null
            ? `${(d.tds_percent / 100).toFixed(
                d.tds_percent % 100 ? 2 : 0
              )}%`
            : "—",
        sub: `${formatINR(d.tds_deducted)} deducted`,
        tone: "text-amber-700",
      },
      {
        label: "Total Earnings",
        value: formatINR(d.total_earnings),
        sub: "Rewards received − TDS",
        tone: "text-emerald-700",
      },
      { label: "Avg Reward %", value: pct },
    ];
  if (d.section === "partner")
    return [
      policiesTile,
      { label: "Business Generated", value: formatINR(d.premium) },
      { label: "Rewards Earned", value: formatINR(d.reward_earned) },
      {
        label: "Profit Contribution",
        value: formatINR(d.house_profit),
        tone: "text-emerald-700",
      },
    ];
  if (d.section === "custom")
    return [
      {
        label: "Total Paid Out (Gave)",
        value: formatINR(d.reward_earned),
        tone: "text-destructive",
        sub: "Money given to party",
      },
      {
        label: "Total Received (Got)",
        value: formatINR(d.reward_received),
        tone: "text-emerald-700",
        sub: "Money received from party",
      },
      {
        label: "Net Position",
        value: formatINR(Math.abs(d.net_balance)),
        tone: d.net_balance >= 0 ? "text-emerald-700" : "text-destructive",
        sub: d.net_balance >= 0 ? "Party owes agency" : "Agency owes party",
      },
    ];
  return [
    policiesTile,
    { label: "Discount Given", value: formatINR(d.discount) },
    {
      label: "Profit Contribution",
      value: formatINR(d.house_profit),
      tone: "text-emerald-700",
    },
  ];
}

function DetailPanel({
  section,
  id,
  period,
}: {
  section: BalanceSheetSection;
  id: string;
  period: PeriodValue;
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
  if (!d) return <DetailSkeleton />;

  const catMax = Math.max(1, ...d.by_category.map((c) => c.premium));
  const catTotal = Math.max(
    1,
    d.by_category.reduce((a, c) => a + c.premium, 0)
  );
  const isPartner = section === "partner";
  const canPay =
    user?.account_type === "owner" || has("manage_transactions");

  const receivable = section === "partner" ? -d.net_balance : d.net_balance;

  const genPdf = async () => {
    setPdfBusy(true);
    try {
      const res = await financeApi.statementPdf(
        section,
        id,
        periodParams(period)
      );
      const disposition = String(
        (res.headers as Record<string, string>)["content-disposition"] ?? ""
      );
      const named = /filename="?([^";]+)"?/.exec(disposition)?.[1];
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = named || `statement_${section}_${d.code || id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar className="h-10 w-10 shrink-0">
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
              {initials(d.label)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">
                {d.label}
              </h2>
              {d.code && (
                <Badge
                  variant="secondary"
                  className="h-5 px-1.5 font-mono text-[11px]"
                >
                  {d.code}
                </Badge>
              )}
              {isPartner && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => nav(`/people/partners/${id}`)}
                  title="View profile"
                >
                  <User className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {section === "custom"
                ? `Khata Ledger · ${periodLabel(period)}`
                : `${d.total_policies} ${
                    d.total_policies === 1 ? "policy" : "policies"
                  } · ${periodLabel(period)}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {canPay && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  if (section === "custom") {
                    nav(`/finance/custom-parties?id=${id}&action=pay`);
                  } else {
                    nav(
                      `/finance/transactions/new?${new URLSearchParams({
                        party_kind: PAYMENT_KIND[section],
                        party_id: id,
                        party_label: d.code
                          ? `${d.label} (${d.code})`
                          : d.label,
                      })}`
                    );
                  }
                }}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Record Payment
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              onClick={genPdf}
              disabled={pdfBusy}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {pdfBusy ? "Generating…" : "Download Statement"}
            </Button>
          </div>
        </div>
      </Card>

      <NetBalanceCard receivable={receivable} party={NET_PARTY[section]} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {metricsFor(d).map((m) => (
          <Stat
            key={m.label}
            label={m.label}
            value={m.value}
            sub={m.sub}
            tone={m.tone}
          />
        ))}
      </div>

      {section !== "custom" && (
        <Card className="p-4">
          <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Policies by type
          </p>
          {d.by_category.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No policies in this period.
            </p>
          ) : (
            <div className="space-y-2">
              {d.by_category.map((c, i) => (
                <div key={c.key} className="flex items-center gap-3 text-xs">
                  <span
                    className="w-32 shrink-0 truncate text-foreground"
                    title={c.label}
                  >
                    {c.label}
                  </span>
                  <div className="relative h-4 flex-1 rounded bg-muted">
                    <div
                      className="absolute inset-y-0 left-0 rounded"
                      style={{
                        width: `${Math.max(3, (c.premium / catMax) * 100)}%`,
                        background: catColor(i),
                      }}
                    />
                  </div>
                  <span className="w-9 shrink-0 text-right text-muted-foreground">
                    {Math.round((c.premium / catTotal) * 100)}%
                  </span>
                  <span className="w-10 shrink-0 text-right text-muted-foreground">
                    {c.policies}p
                  </span>
                  <span className="w-24 shrink-0 text-right font-medium tabular-nums text-foreground">
                    {formatINR(c.premium)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {d.section === "broker" && d.profiles.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              By insurer company
            </p>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="h-8 text-xs">Insurer</TableHead>
                  <TableHead className="h-8 text-right text-xs">
                    Policies
                  </TableHead>
                  <TableHead className="h-8 text-right text-xs">
                    Premium
                  </TableHead>
                  <TableHead className="h-8 text-right text-xs">
                    Rewards Earned
                  </TableHead>
                  <TableHead className="h-8 text-right text-xs">
                    Earnings
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.profiles.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="py-2 text-[13px] font-medium text-foreground">
                      {p.label}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] tabular-nums text-muted-foreground">
                      {p.policies}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] tabular-nums text-muted-foreground">
                      {formatINR(p.premium)}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] tabular-nums text-muted-foreground">
                      {formatINR(p.reward_earned)}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] font-medium tabular-nums text-foreground">
                      {formatINR(p.house_profit)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Volume figures follow the selected period; Net Balance is the live
        position. The downloadable statement carries the full policy list and
        the money ledger behind these numbers.
      </p>
    </div>
  );
}

const PAGE_SIZE = 25;

export default function BalanceSheetPage() {
  const [section, setSection] = useState<BalanceSheetSection>("broker");
  const [period, setPeriod] = useState<PeriodValue>({ period: "this_year" });
  const [sort, setSort] = useState<SortKey>("net_balance");
  const [asc, setAsc] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  const list = useQuery({
    queryKey: [
      "finance",
      "balance-sheet",
      section,
      period,
      sort,
      asc,
      search,
      page,
    ],
    queryFn: async () =>
      (
        await financeApi.balanceSheetList(section, {
          ...periodParams(period),
          sort,
          order: asc ? "asc" : "desc",
          q: search.trim() || undefined,
          page,
          page_size: PAGE_SIZE,
        })
      ).data,
    ...liveQueryOptions,
  });

  const rows = useMemo(() => list.data?.items ?? [], [list.data]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !rows.some((r) => r.id === selected))
      setSelected(rows[0].id);
  }, [rows, selected]);

  const changeSection = (s: BalanceSheetSection) => {
    setSection(s);
    setSelected(null);
    setSearch("");
    setPage(1);
    setSort("net_balance");
    setAsc(false);
  };

  const changeSearch = (v: string) => {
    setSearch(v);
    setPage(1);
  };

  const clickSort = (s: SortKey) => {
    setPage(1);
    if (sort === s) setAsc((v) => !v);
    else {
      setSort(s);
      setAsc(false);
    }
  };

  return (
    <div className="space-y-3">
      <PageHeader
        title="Balance Sheet"
        subtitle="Live receivable and payable positions by party."
        actions={<DateFilter value={period} onChange={setPeriod} />}
      />

      <Tabs
        value={section}
        onValueChange={(v) => changeSection(v as BalanceSheetSection)}
      >
        <TabsList className="h-9 w-full justify-start flex-wrap sm:w-auto">
          {SECTIONS.map((s) => {
            const IconComp = s.IconComp;
            return (
              <TabsTrigger
                key={s.value}
                value={s.value}
                className="gap-1.5 text-xs"
              >
                <IconComp className="h-3.5 w-3.5" />
                {s.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex max-h-[78vh] flex-col overflow-hidden lg:col-span-1">
          <div className="shrink-0 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => changeSearch(e.target.value)}
                placeholder={`Search ${SECTIONS.find(
                  (s) => s.value === section
                )?.label.toLowerCase()}…`}
                className="pl-8"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
              <span className="text-muted-foreground">Sort:</span>
              {SORTS.map((s) => {
                const active = sort === s.value;
                return (
                  <Button
                    key={s.value}
                    type="button"
                    variant={active ? "default" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    title={
                      active
                        ? `Sorted ${
                            asc ? "low → high" : "high → low"
                          } — click to flip`
                        : `Sort by ${s.label}`
                    }
                    onClick={() => clickSort(s.value)}
                  >
                    {s.label}
                    {active && <span className="ml-0.5">{asc ? "↑" : "↓"}</span>}
                  </Button>
                );
              })}
            </div>
          </div>

          {list.isError ? (
            <ErrorState onRetry={() => list.refetch()} />
          ) : list.isLoading ? (
            <div className="space-y-1.5 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-12 animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="Nothing here"
              description={
                search
                  ? "No records match this search."
                  : "No records for this section / period."
              }
            />
          ) : (
            <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
              {rows.map((r: BalanceSheetItem) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelected(r.id)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                    selected === r.id
                      ? "bg-primary/5 ring-1 ring-inset ring-primary/20"
                      : "hover:bg-muted/40"
                  }`}
                >
                  <Avatar className="h-7 w-7 shrink-0">
                    <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                      {initials(r.label)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {r.label}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {r.policies} {r.policies === 1 ? "policy" : "policies"}
                      {r.code ? ` · ${r.code}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <RowMetric
                      r={r}
                      sort={sort}
                      party={NET_PARTY[section]}
                    />
                  </span>
                </button>
              ))}
            </div>
          )}

          {list.data && list.data.total > PAGE_SIZE && (
            <div className="shrink-0 border-t border-border px-3">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={list.data.total}
                onChange={setPage}
              />
            </div>
          )}
        </Card>

        <div className="lg:col-span-2">
          {selected ? (
            <DetailPanel section={section} id={selected} period={period} />
          ) : (
            <Card className="flex h-full items-center justify-center p-10">
              <p className="text-xs text-muted-foreground">
                Select a record to view its balance sheet.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
