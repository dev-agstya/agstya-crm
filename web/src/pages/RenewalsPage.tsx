import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, History, RefreshCw } from "lucide-react";
import { policiesApi, reportsApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/shared/StatCard";
import { DataTable, Column } from "../components/shared/DataTable";
import { FilterToolbar } from "../components/shared/FilterToolbar";
import { formatDate, formatINR } from "../lib/format";
import { useAuth } from "../store/auth";
import type { Policy } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const daysLeft = (iso?: string | null) => {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
};

export default function RenewalsPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const canManage = has("manage_renewals");
  const canReports = has("view_reports");
  const [windowDays, setWindowDays] = useState(30);

  const due = useQuery({
    queryKey: ["renewals-due", windowDays],
    queryFn: async () =>
      (await policiesApi.list({ expiring_in_days: windowDays, page_size: 100 }))
        .data,
  });
  const summary = useQuery({
    queryKey: ["renewal-summary"],
    queryFn: async () => (await reportsApi.renewalSummary(90)).data,
    enabled: canReports,
  });

  const columns: Column<Policy>[] = [
    {
      key: "policy",
      header: "Policy & Customer",
      cell: (p) => (
        <div>
          <p className="font-mono font-semibold text-foreground">
            {p.policy_number || p.code}
          </p>
          <p className="text-xs text-muted-foreground">
            {p.customer_name || "—"} · {p.insurer_name || "—"}
          </p>
        </div>
      ),
    },
    {
      key: "expiry",
      header: "Expiry Date",
      cell: (p) => {
        const dl = daysLeft(p.expiry_date);
        const urgent = dl !== null && dl <= 7;
        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="tabular-nums text-foreground">
              {p.expiry_date ? formatDate(p.expiry_date) : "—"}
            </span>
            {dl !== null && (
              <Badge
                variant={urgent ? "destructive" : "secondary"}
                className="h-4 px-1.5 text-[10px]"
              >
                {dl <= 0 ? "Due now" : `${dl}d`}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      key: "premium",
      header: "Last Premium",
      align: "right",
      cell: (p) => (
        <span className="font-semibold tabular-nums">
          {formatINR(p.premium_amount)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      mobileLabel: false,
      cell: (p) => (
        <div
          className="flex items-center justify-end gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => navigate(`/renewals/${p.id}/history`)}
          >
            <History className="mr-1 h-3 w-3" />
            History
          </Button>
          {canManage && (
            <Button
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => navigate(`/renewals/${p.id}`)}
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              Renew
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        title="Renewals"
        subtitle="Policies expiring soon"
        figure={
          canReports && summary.data
            ? {
                label: "Due (30d)",
                value: formatINR(summary.data.due_30d_premium),
                tone: "due",
              }
            : undefined
        }
      />

      {canReports && summary.data && (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Due in 30 days"
            value={String(summary.data.due_30d)}
            tone={summary.data.due_30d > 0 ? "warning" : "default"}
            icon={<RefreshCw className="h-4 w-4" />}
          />
          <StatCard
            label={`Renewed (${summary.data.window_days}d)`}
            value={String(summary.data.renewed_window)}
            tone="success"
            icon={<CheckCircle2 className="h-4 w-4" />}
          />
          <StatCard
            label="Renewal rate"
            value={
              summary.data.renewal_rate == null
                ? "—"
                : `${Math.round(summary.data.renewal_rate * 100)}%`
            }
          />
        </div>
      )}

      <FilterToolbar
        right={
          due.data && (
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {due.data.items.length} due
            </span>
          )
        }
      >
        <span className="text-xs font-medium text-muted-foreground">
          Expiring within
        </span>
        <Select
          value={String(windowDays)}
          onValueChange={(v) => setWindowDays(Number(v))}
        >
          <SelectTrigger className="h-9 w-[150px] bg-card text-xs sm:h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="30">Next 30 days</SelectItem>
            <SelectItem value="60">Next 60 days</SelectItem>
            <SelectItem value="90">Next 90 days</SelectItem>
          </SelectContent>
        </Select>
      </FilterToolbar>

      <DataTable
        data={due.data?.items ?? []}
        columns={columns}
        keyField={(p) => p.id}
        onRowClick={(p) =>
          navigate(canManage ? `/renewals/${p.id}` : `/policies/${p.id}`)
        }
        loading={due.isLoading}
        error={due.isError ? "Could not load upcoming renewals." : null}
        onRetry={() => due.refetch()}
        emptyTitle="No renewals due in this window"
        emptyDescription="All policies are up to date for the selected timeframe."
      />
    </div>
  );
}
