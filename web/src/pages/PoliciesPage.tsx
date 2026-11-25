import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, Shield, X } from "lucide-react";
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
import { ExpiryChip } from "../components/PolicyDetailBody";
import {
  DateFilter,
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
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
      <div className="space-y-6">
        <PageHeader
          title="Policy access requests"
          eyebrow="Policies"
          subtitle="Time-limited read access for policies outside an employee's desk."
          actions={
            <Button variant="outline" onClick={() => setAccessView(false)}>
              Back to policies
            </Button>
          }
        />
        <PolicyAccessQueue />
      </div>
    );
  }

  const columns: Column<Policy>[] = [
    {
      key: "policy",
      header: "Policy & Customer",
      cell: (p) => (
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-foreground">
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
              className="text-[11px]"
            >
              {titleCase(p.status.replace(/_/g, " "))}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {p.customer_name || "—"}
          </p>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type & Insurer",
      cell: (p) => (
        <div>
          <p className="text-sm font-medium text-foreground">
            {categoryTitle(p)}
          </p>
          <p className="text-xs text-muted-foreground">
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
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-sm tabular-nums text-foreground">
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
    <Button onClick={() => navigate("/policies/new")}>
      <Plus className="mr-1.5 h-4 w-4" />
      Book policy
    </Button>
  ) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Policies"
        subtitle="View booked insurance policies, premiums, and renewal dates."
        actions={
          <>
            {has("manage_policy_access") && (
              <Button variant="outline" onClick={() => setAccessView(true)}>
                <Shield className="mr-1.5 h-4 w-4" />
                Access requests
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

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search policy #, customer, vehicle..."
              className="pl-9"
            />
          </div>

          <Select
            value={status}
            onValueChange={(v) => {
              setPage(1);
              setStatus(v);
            }}
          >
            <SelectTrigger className="w-[150px]">
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
            <SelectTrigger className="w-[160px]">
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

          <Select
            value={insurerF}
            onValueChange={(v) => {
              setPage(1);
              setInsurerF(v);
            }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Insurer" />
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

          {!isPartner && (
            <>
              <Select
                value={brokerF}
                onValueChange={(v) => {
                  setPage(1);
                  setBrokerF(v);
                }}
              >
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Broker" />
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

              <Select
                value={partnerF}
                onValueChange={(v) => {
                  setPage(1);
                  setPartnerF(v);
                }}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Partner" />
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
            </>
          )}

          <DateFilter
            value={period}
            onChange={(p) => {
              setPage(1);
              setPeriod(p);
            }}
          />

          {filtered && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="mr-1 h-4 w-4" />
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

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
            <Button variant="outline" onClick={clearFilters}>
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
