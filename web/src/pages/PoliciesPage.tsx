import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Shield } from "lucide-react";
import {
  brokersApi,
  categoriesApi,
  insurersApi,
  policiesApi,
  usersApi,
} from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { ExportButton } from "../components/ExportButton";
import { DataTable, Column } from "../components/shared/DataTable";
import { FilterToolbar, FilterChip } from "../components/shared/FilterToolbar";
import { ExpiryChip } from "../components/PolicyDetailBody";
import {
  DateFilter,
  periodLabel,
  periodParams,
  type PeriodValue,
} from "../components/finance/DateFilter";
import { formatDate, formatINRShort, titleCase } from "../lib/format";
import { describePath } from "../lib/rating";
import {
  PolicyAccessQueue,
  PolicyScopeNote,
  RestrictedMatches,
} from "../components/policies/PolicyAccess";
import { useAuth } from "../store/auth";
import {
  type Policy,
  type PolicyCategory,
  type PolicyStatus,
} from "../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUSES: PolicyStatus[] = [
  "draft",
  "active",
  "renewal_due",
  "renewed",
  "lapsed",
  "cancelled",
  "expired",
];

const rewardCompact = (basis: string, value: number): string =>
  basis === "percent" ? `${+(value / 100).toFixed(2)}%` : formatINRShort(value);

export default function PoliciesPage() {
  const navigate = useNavigate();
  const { has, user } = useAuth();
  const isPartner = user?.account_type === "channel_partner";
  const [sp, setSp] = useSearchParams();

  const accessView = sp.get("view") === "access-requests";
  const setAccessView = (on: boolean) => {
    const next = new URLSearchParams(sp);
    if (on) next.set("view", "access-requests");
    else next.delete("view");
    setSp(next, { replace: true });
  };

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>("all");
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [qDebounced, setQDebounced] = useState(sp.get("q") ?? "");
  const [categoryF, setCategoryF] = useState<string>("all");
  const [insurerF, setInsurerF] = useState<string>("all");
  const [brokerF, setBrokerF] = useState<string>("all");
  const [partnerF, setPartnerF] = useState<string>("all");
  const [period, setPeriod] = useState<PeriodValue>({ period: "till_date" });

  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      setQDebounced(q.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const urlQ = sp.get("q") ?? "";
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  if (urlQ !== lastUrlQ) {
    setLastUrlQ(urlQ);
    setQ(urlQ);
    setQDebounced(urlQ);
    setPage(1);
  }

  const filtered = !!(
    status !== "all" ||
    qDebounced ||
    categoryF !== "all" ||
    insurerF !== "all" ||
    brokerF !== "all" ||
    partnerF !== "all" ||
    period.period !== "till_date"
  );

  const clearFilters = () => {
    setPage(1);
    setStatus("all");
    setQ("");
    setQDebounced("");
    setCategoryF("all");
    setInsurerF("all");
    setBrokerF("all");
    setPartnerF("all");
    setPeriod({ period: "till_date" });
  };

  const list = useQuery({
    queryKey: [
      "policies",
      page,
      status,
      qDebounced,
      categoryF,
      insurerF,
      brokerF,
      partnerF,
      period,
    ],
    queryFn: async () =>
      (
        await policiesApi.list({
          page,
          page_size: 15,
          status: status === "all" ? undefined : status,
          q: qDebounced || undefined,
          category_key: categoryF === "all" ? undefined : categoryF,
          insurer_id: insurerF === "all" ? undefined : insurerF,
          broker_id: brokerF === "all" ? undefined : brokerF,
          partner_id: partnerF === "all" ? undefined : partnerF,
          ...periodParams(period),
        })
      ).data,
  });

  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await categoriesApi.list()).data,
  });
  const insurers = useQuery({
    queryKey: ["insurers-all"],
    queryFn: async () => (await insurersApi.list({ page_size: 200 })).data,
  });
  const brokersFilter = useQuery({
    queryKey: ["brokers-filter"],
    queryFn: async () => (await brokersApi.list({})).data,
    enabled: !isPartner,
  });
  const partnersFilter = useQuery({
    queryKey: ["partners-filter"],
    queryFn: async () => (await usersApi.attributablePartners()).data,
    enabled: !isPartner,
  });

  const catByKey = useMemo(() => {
    const m = new Map<string, PolicyCategory>();
    (cats.data ?? []).forEach((c) => m.set(c.key, c));
    return m;
  }, [cats.data]);

  const categoryTitle = (p: Policy): string => {
    const cat = catByKey.get(p.category_key);
    if (!cat) return p.category_key;
    const path = describePath(cat.children, p.subcategory_path || []);
    return path && path !== "Whole type" ? `${cat.label} › ${path}` : cat.label;
  };

  const seesFinance = has("view_balance_sheet");
  const canBook = has("manage_policies");

  if (accessView) {
    return (
      <div>
        <PageHeader
          title="Policy access requests"
          eyebrow="Policies"
          subtitle="Time-limited access to policies outside your desk."
          actions={
            <Button variant="outline" size="sm" onClick={() => setAccessView(false)}>
              Back to policies
            </Button>
          }
        />
        <PolicyAccessQueue />
      </div>
    );
  }

  const chips: FilterChip[] = [];
  if (status !== "all") {
    chips.push({
      key: "status",
      label: `Status: ${titleCase(status.replace(/_/g, " "))}`,
      onRemove: () => { setPage(1); setStatus("all"); },
    });
  }
  if (categoryF !== "all") {
    chips.push({
      key: "cat",
      label: `Type: ${catByKey.get(categoryF)?.label ?? categoryF}`,
      onRemove: () => { setPage(1); setCategoryF("all"); },
    });
  }
  if (insurerF !== "all") {
    const name = insurers.data?.items.find((i) => i.id === insurerF)?.name ?? "Insurer";
    chips.push({
      key: "insurer",
      label: `Insurer: ${name}`,
      onRemove: () => { setPage(1); setInsurerF("all"); },
    });
  }
  if (brokerF !== "all") {
    const name = (brokersFilter.data ?? []).find((b) => b.id === brokerF)?.name ?? "Broker";
    chips.push({
      key: "broker",
      label: `Broker: ${name}`,
      onRemove: () => { setPage(1); setBrokerF("all"); },
    });
  }
  if (partnerF !== "all") {
    const name = (partnersFilter.data ?? []).find((p) => p.id === partnerF)?.full_name ?? "Partner";
    chips.push({
      key: "partner",
      label: `Partner: ${name}`,
      onRemove: () => { setPage(1); setPartnerF("all"); },
    });
  }
  if (period.period !== "till_date") {
    chips.push({
      key: "period",
      label: `Period: ${periodLabel(period)}`,
      onRemove: () => { setPage(1); setPeriod({ period: "till_date" }); },
    });
  }

  const moreCount =
    (insurerF !== "all" ? 1 : 0) +
    (brokerF !== "all" ? 1 : 0) +
    (partnerF !== "all" ? 1 : 0) +
    (period.period !== "till_date" ? 1 : 0);

  const columns: Column<Policy>[] = [
    {
      key: "policy",
      header: "Policy & Customer",
      cell: (p) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono font-semibold text-foreground">
              {p.policy_number || p.code}
            </span>
            <Badge
              variant={
                p.status === "active"
                  ? "default"
                  : p.status === "renewal_due" || p.status === "lapsed"
                    ? "destructive"
                    : "secondary"
              }
              className="h-4 px-1.5 text-[10px]"
            >
              {titleCase(p.status.replace(/_/g, " "))}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {p.customer_name || "—"}
          </p>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type & Insurer",
      cell: (p) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">
            {categoryTitle(p)}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {p.insurer_name || "—"}
            {p.broker_name ? ` · ${p.broker_name}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "dates",
      header: "Expiry",
      cell: (p) => (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="tabular-nums text-foreground">
            {p.expiry_date ? formatDate(p.expiry_date) : "—"}
          </span>
          {p.expiry_date && <ExpiryChip expiry={p.expiry_date} status={p.status} />}
        </div>
      ),
    },
    ...(seesFinance
      ? [
          {
            key: "reward",
            header: "Reward (Ag / Pt)",
            align: "right" as const,
            cell: (p: Policy) => (
              <span className="text-xs font-medium tabular-nums text-muted-foreground">
                {rewardCompact(p.reward.agency_basis, p.reward.agency_value)} /{" "}
                {rewardCompact(p.reward.partner_basis, p.reward.partner_value)}
              </span>
            ),
          },
        ]
      : []),
    {
      key: "premium",
      header: "Premium",
      align: "right",
      cell: (p) => (
        <span className="font-semibold tabular-nums text-foreground">
          {formatINRShort(p.premium_amount)}
        </span>
      ),
    },
  ];

  const bookBtn = canBook ? (
    <Button size="sm" className="h-8" onClick={() => navigate("/policies/new")}>
      <Plus className="mr-1 h-3.5 w-3.5" />
      Book policy
    </Button>
  ) : undefined;

  return (
    <div>
      <PageHeader
        title="Policies"
        subtitle="Booked insurance policies & renewals"
        actions={
          <>
            {has("manage_policy_access") && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setAccessView(true)}
              >
                <Shield className="mr-1 h-3.5 w-3.5" />
                Access
              </Button>
            )}
            <ExportButton
              filename="policies"
              onExport={(fmt) =>
                policiesApi.export({
                  status: status === "all" ? undefined : status,
                  category_key: categoryF === "all" ? undefined : categoryF,
                  insurer_id: insurerF === "all" ? undefined : insurerF,
                  broker_id: brokerF === "all" ? undefined : brokerF,
                  partner_id: partnerF === "all" ? undefined : partnerF,
                  ...periodParams(period),
                  fmt,
                })
              }
            />
            {bookBtn}
          </>
        }
      />

      <PolicyScopeNote />

      <FilterToolbar
        search={{
          value: q,
          onChange: setQ,
          placeholder: "Search policy #, customer, vehicle...",
        }}
        moreCount={moreCount}
        chips={chips}
        onClearAll={clearFilters}
        moreFilters={
          <>
            <div className="space-y-1">
              <Label className="text-xs">Insurer</Label>
              <Select
                value={insurerF}
                onValueChange={(v) => {
                  setPage(1);
                  setInsurerF(v);
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="All insurers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All insurers</SelectItem>
                  {(insurers.data?.items ?? []).map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!isPartner && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Broker</Label>
                  <Select
                    value={brokerF}
                    onValueChange={(v) => {
                      setPage(1);
                      setBrokerF(v);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="All brokers" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All brokers</SelectItem>
                      {(brokersFilter.data ?? []).map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Channel Partner</Label>
                  <Select
                    value={partnerF}
                    onValueChange={(v) => {
                      setPage(1);
                      setPartnerF(v);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="All partners" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All partners</SelectItem>
                      {(partnersFilter.data ?? []).map((pt) => (
                        <SelectItem key={pt.id} value={pt.id}>
                          {pt.full_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Date Period</Label>
              <div>
                <DateFilter
                  value={period}
                  onChange={(p) => {
                    setPage(1);
                    setPeriod(p);
                  }}
                />
              </div>
            </div>
          </>
        }
      >
        <Select
          value={status}
          onValueChange={(v) => {
            setPage(1);
            setStatus(v);
          }}
        >
          <SelectTrigger className="h-9 w-[135px] bg-card text-xs sm:h-8">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {titleCase(s.replace(/_/g, " "))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={categoryF}
          onValueChange={(v) => {
            setPage(1);
            setCategoryF(v);
          }}
        >
          <SelectTrigger className="h-9 w-[140px] bg-card text-xs sm:h-8">
            <SelectValue placeholder="Policy type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {(cats.data ?? []).map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterToolbar>

      {qDebounced && <RestrictedMatches q={qDebounced} />}

      <DataTable
        data={list.data?.items ?? []}
        columns={columns}
        keyField={(p) => p.id}
        onRowClick={(p) => navigate(`/policies/${p.id}`)}
        loading={list.isLoading}
        error={list.isError ? "Could not load policies." : null}
        onRetry={() => list.refetch()}
        emptyTitle={
          filtered ? "No policies match your filters" : "No policies yet"
        }
        emptyDescription={
          filtered
            ? "Try adjusting your search or date range."
            : "Book your first policy to start tracking premiums and renewals."
        }
        emptyAction={
          filtered ? (
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : (
            bookBtn
          )
        }
        page={page}
        pageSize={15}
        total={list.data?.total}
        onPageChange={setPage}
      />
    </div>
  );
}
