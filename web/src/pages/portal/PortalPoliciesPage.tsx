import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { FileText, RefreshCw, Search } from "lucide-react";
import { portalApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { RecordPage } from "../../components/RecordPage";
import { DataTable, Column } from "../../components/shared/DataTable";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { StatusBadge } from "../../components/ui";
import { toast } from "../../components/Toast";
import {
  DateFilter,
  periodParams,
  type PeriodValue,
} from "../../components/finance/DateFilter";
import { formatDate, formatINR } from "../../lib/format";
import { DetailRow, DocumentList, SectionCard } from "./shared";
import type { PortalPolicy } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function PortalPoliciesPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [period, setPeriod] = useState<PeriodValue>({ period: "" });

  const list = useQuery({
    queryKey: ["portal", "policies", page, q, period],
    queryFn: async () =>
      (
        await portalApi.policies({
          page,
          page_size: 20,
          q: q || undefined,
          ...(period.period ? periodParams(period) : {}),
        })
      ).data,
  });
  const rows = list.data?.items ?? [];

  const columns: Column<PortalPolicy>[] = [
    {
      key: "policy",
      header: "Policy",
      cell: (p) => (
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground">
            {p.policy_number || p.code}
          </span>
          {p.is_renewal && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              renewal
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (p) => (
        <span className="text-[13px] text-foreground">
          {p.customer_name || "—"}
        </span>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (p) => (
        <span className="text-[13px] text-muted-foreground">
          {p.category_label}
        </span>
      ),
    },
    {
      key: "premium",
      header: "Premium",
      align: "right",
      cell: (p) => (
        <span className="tabular-nums text-[13px] text-foreground">
          {formatINR(p.premium_amount)}
        </span>
      ),
    },
    {
      key: "earned",
      header: "You earned",
      align: "right",
      cell: (p) => (
        <span className="font-semibold tabular-nums text-emerald-700">
          {formatINR(p.my_earning)}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      cell: (p) => (
        <span className="whitespace-nowrap text-[13px] text-muted-foreground">
          {formatDate(p.expiry_date)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (p) => <StatusBadge value={p.status} />,
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        title="My Policies"
        subtitle="Every policy credited to you, and what you earned on it."
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Policy number…"
            className="pl-8"
          />
        </div>
        <DateFilter
          value={period}
          onChange={(v) => {
            setPeriod(v);
            setPage(1);
          }}
        />
      </div>

      {list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : !list.isLoading && rows.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title="No policies yet"
          description="When Agastya books a policy credited to you, it shows up here with your earning on it."
        />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          keyField={(p) => p.id}
          loading={list.isLoading}
          page={page}
          pageSize={20}
          total={list.data?.total ?? 0}
          onPageChange={setPage}
          onRowClick={(p) => navigate(`/portal/policies/${p.id}`)}
          renderMobileCard={(p) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {p.policy_number || p.code}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.customer_name || "—"} · {p.category_label}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[10px] uppercase text-muted-foreground">
                    you earned
                  </p>
                  <p className="text-sm font-semibold tabular-nums text-emerald-700">
                    {formatINR(p.my_earning)}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-1.5 text-xs">
                <span>Premium {formatINR(p.premium_amount)}</span>
                <StatusBadge value={p.status} />
              </div>
            </div>
          )}
        />
      )}
    </div>
  );
}

export function PortalPolicyDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();

  const policy = useQuery({
    queryKey: ["portal", "policy", id],
    retry: false,
    queryFn: async () => (await portalApi.policy(id)).data,
  });
  const p = policy.data;
  const missing =
    isAxiosError(policy.error) && policy.error.response?.status === 404;

  const openDoc = async (docId: string) => {
    try {
      const { data } = await portalApi.policyDocumentUrl(id, docId);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  const details = Object.entries(p?.details ?? {}).filter(
    ([, v]) => v !== null && v !== "" && v !== undefined
  );

  return (
    <RecordPage
      backTo="/portal/policies"
      backLabel="Back to my policies"
      title={p ? p.policy_number || p.code : "Policy"}
      documentTitle={p?.policy_number || p?.code || "Policy"}
      subtitle={
        p
          ? [p.customer_name, p.insurer_name].filter(Boolean).join(" · ")
          : undefined
      }
      badges={p && <StatusBadge value={p.status} />}
      loading={policy.isLoading}
      error={missing ? undefined : policy.error}
      onRetry={() => policy.refetch()}
      notFound={missing}
    >
      {p && (
        <div className="space-y-4">
          <Card className="px-4 py-3.5 sm:px-5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              You earned on this policy
            </p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums text-emerald-700 sm:text-3xl">
              {formatINR(p.my_earning)}
            </p>
          </Card>

          <SectionCard title="Policy">
            <DetailRow label="Policy number">
              {p.policy_number || "—"}
            </DetailRow>
            <DetailRow label="Customer">
              {p.customer_name || "—"}
              {p.customer_mobile && (
                <a
                  href={`tel:${p.customer_mobile}`}
                  className="ml-2 text-primary underline"
                >
                  {p.customer_mobile}
                </a>
              )}
            </DetailRow>
            <DetailRow label="Insurer">{p.insurer_name || "—"}</DetailRow>
            <DetailRow label="Type">
              {p.category_label}
              {p.subcategory_label ? ` · ${p.subcategory_label}` : ""}
            </DetailRow>
            <DetailRow label="Premium">
              {formatINR(p.premium_amount)}
            </DetailRow>
            <DetailRow label="Sum insured">
              {p.sum_insured ? formatINR(p.sum_insured) : "—"}
            </DetailRow>
            <DetailRow label="Cover">
              {formatDate(p.start_date)} — {formatDate(p.expiry_date)}
            </DetailRow>
            {p.days_to_expiry != null &&
              p.days_to_expiry >= 0 &&
              p.days_to_expiry <= 60 && (
                <DetailRow label="Renewal">
                  <span className="text-amber-700">
                    {p.days_to_expiry} days left
                  </span>
                </DetailRow>
              )}
          </SectionCard>

          {details.length > 0 && (
            <SectionCard title={`${p.category_label ?? "Policy"} details`}>
              {details.map(([key, value]) => (
                <DetailRow key={key} label={p.field_labels[key] ?? key}>
                  {String(value)}
                </DetailRow>
              ))}
            </SectionCard>
          )}

          <SectionCard title="Documents">
            <DocumentList
              documents={p.documents}
              onOpen={openDoc}
              emptyLabel="No documents have been attached to this policy yet."
            />
          </SectionCard>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => navigate(`/portal/quotes/new?renewal=${p.id}`)}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" /> Ask for a renewal quote
          </Button>
        </div>
      )}
    </RecordPage>
  );
}
