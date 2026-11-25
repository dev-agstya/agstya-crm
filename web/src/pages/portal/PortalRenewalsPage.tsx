import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { portalApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, Column } from "../../components/shared/DataTable";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { formatDate, formatINR } from "../../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function urgency(days: number) {
  if (days <= 7) return { tone: "text-destructive", label: "this week" };
  if (days <= 30) return { tone: "text-amber-700", label: "this month" };
  return { tone: "text-muted-foreground", label: "" };
}

export default function PortalRenewalsPage() {
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["portal", "renewals"],
    queryFn: async () => (await portalApi.renewals()).data,
  });
  const rows = list.data ?? [];

  type RenewalRow = (typeof rows)[number];

  const columns: Column<RenewalRow>[] = [
    {
      key: "customer",
      header: "Customer",
      cell: (r) => (
        <div>
          <span className="font-medium text-foreground">
            {r.customer_name || "—"}
          </span>
          {r.customer_mobile && (
            <a
              href={`tel:${r.customer_mobile}`}
              onClick={(e) => e.stopPropagation()}
              className="ml-2 text-xs text-primary underline"
            >
              {r.customer_mobile}
            </a>
          )}
        </div>
      ),
    },
    {
      key: "policy",
      header: "Policy",
      cell: (r) => (
        <span className="font-mono text-xs text-foreground">
          {r.policy_number || r.code}
        </span>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (r) => (
        <span className="text-[13px] text-muted-foreground">
          {r.category_label}
        </span>
      ),
    },
    {
      key: "premium",
      header: "Premium",
      align: "right",
      cell: (r) => (
        <span className="font-medium tabular-nums text-foreground">
          {formatINR(r.premium_amount)}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      cell: (r) => {
        const u = urgency(r.days_left);
        return (
          <span className="whitespace-nowrap text-[13px]">
            {formatDate(r.expiry_date)}
            <span className={`ml-2 text-xs font-medium ${u.tone}`}>
              {r.days_left}d
            </span>
          </span>
        );
      },
    },
    {
      key: "action",
      header: "",
      align: "right",
      cell: (r) =>
        r.quote_requested ? (
          <Badge variant="secondary" className="h-5 px-2 text-[11px]">
            quote asked
          </Badge>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/portal/quotes/new?renewal=${r.policy_id}`);
            }}
          >
            <RefreshCw className="mr-1 h-3 w-3" /> Ask for a quote
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        title="Renewals"
        subtitle="Your policies coming up for renewal in the next 60 days."
      />

      {list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : !list.isLoading && rows.length === 0 ? (
        <EmptyState
          icon={<RefreshCw className="h-5 w-5" />}
          title="Nothing due"
          description="No policy of yours expires in the next 60 days."
        />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          keyField={(r) => r.policy_id}
          loading={list.isLoading}
          onRowClick={(r) => navigate(`/portal/policies/${r.policy_id}`)}
          renderMobileCard={(r) => {
            const u = urgency(r.days_left);
            return (
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {r.customer_name || r.policy_number || r.code}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.category_label} · {r.policy_number || r.code}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`block whitespace-nowrap text-xs font-semibold ${u.tone}`}
                    >
                      {r.days_left}d left
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {formatDate(r.expiry_date)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-1.5 text-xs">
                  <span>Premium {formatINR(r.premium_amount)}</span>
                  {r.quote_requested ? (
                    <Badge variant="secondary" className="h-5 px-2 text-[10px]">
                      quote asked
                    </Badge>
                  ) : (
                    <span className="font-medium text-primary">
                      Ask for a quote
                    </span>
                  )}
                </div>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}
