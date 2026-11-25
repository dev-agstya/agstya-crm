import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { auditApi, type AuditFilters } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { DataTable, Column } from "../components/shared/DataTable";
import { FilterToolbar, FilterChip } from "../components/shared/FilterToolbar";
import { DateInput } from "../components/DateInput";
import { toast } from "../components/Toast";
import { downloadBlob } from "../lib/download";
import { formatDateTime, titleCase } from "../lib/format";
import type { AuditEntry } from "../lib/types";
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

const ACTIONS = [
  "login_success", "login_failed", "logout", "password_changed",
  "account_created", "account_updated", "account_deactivated", "account_deleted",
  "permissions_changed", "profile_updated", "email_changed",
  "customer_created", "customer_updated", "customer_deleted",
  "lead_created", "lead_updated", "lead_deleted",
  "policy_created", "policy_updated", "policy_approved", "policy_rejected",
  "policy_cancelled", "reward_status_changed",
  "payment_recorded", "ledger_adjusted",
  "document_uploaded", "document_downloaded", "document_deleted",
  "email_sent", "report_exported",
];

const ENTITY_TYPES = [
  "user", "customer", "lead", "policy", "reward",
  "ledger_txn", "settlement", "document", "role", "insurer", "target",
];

export default function AuditPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const [entityType, setEntityType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const filters: AuditFilters = {
    q: q || undefined,
    action: action === "all" ? undefined : action,
    entity_type: entityType === "all" ? undefined : entityType,
    date_from: dateFrom || undefined,
    date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
  };

  const list = useQuery({
    queryKey: ["audit", page, filters],
    queryFn: async () =>
      (await auditApi.list({ ...filters, page, page_size: 25 })).data,
  });

  const doExport = async (fmt: "excel" | "csv") => {
    setExporting(true);
    try {
      const res = await auditApi.export({ ...filters, fmt });
      downloadBlob(
        res.data as Blob,
        `audit-logs.${fmt === "excel" ? "xlsx" : "csv"}`
      );
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setExporting(false);
    }
  };

  const reset = () => {
    setQ("");
    setAction("all");
    setEntityType("all");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const chips: FilterChip[] = [];
  if (action !== "all") {
    chips.push({
      key: "action",
      label: `Action: ${titleCase(action.replace(/_/g, " "))}`,
      onRemove: () => { setPage(1); setAction("all"); },
    });
  }
  if (entityType !== "all") {
    chips.push({
      key: "entity",
      label: `Record: ${titleCase(entityType.replace(/_/g, " "))}`,
      onRemove: () => { setPage(1); setEntityType("all"); },
    });
  }
  if (dateFrom) {
    chips.push({
      key: "from",
      label: `From: ${dateFrom}`,
      onRemove: () => { setPage(1); setDateFrom(""); },
    });
  }
  if (dateTo) {
    chips.push({
      key: "to",
      label: `To: ${dateTo}`,
      onRemove: () => { setPage(1); setDateTo(""); },
    });
  }

  const moreCount = (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);

  const columns: Column<AuditEntry>[] = [
    {
      key: "actor",
      header: "User & Time",
      cell: (a) => (
        <div>
          <p className="font-medium text-foreground">
            {a.actor_name || "System"}
          </p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {formatDateTime(a.created_at)}
          </p>
        </div>
      ),
    },
    {
      key: "action",
      header: "Action",
      cell: (a) => (
        <Badge variant="outline" className="text-[11px]">
          {titleCase(a.action.replace(/_/g, " "))}
        </Badge>
      ),
    },
    {
      key: "summary",
      header: "Details",
      cell: (a) => (
        <span className="block max-w-md truncate text-foreground">
          {a.summary || "—"}
        </span>
      ),
    },
    {
      key: "entity",
      header: "Record Type",
      cell: (a) => (
        <span className="text-xs capitalize text-muted-foreground">
          {a.entity_type ? a.entity_type.replace(/_/g, " ") : "—"}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="Activity history across the agency"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={exporting}
              onClick={() => doExport("excel")}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={exporting}
              onClick={() => doExport("csv")}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              CSV
            </Button>
          </>
        }
      />

      <FilterToolbar
        search={{
          value: q,
          onChange: (v) => {
            setPage(1);
            setQ(v);
          },
          placeholder: "Search name, code, summary...",
        }}
        moreCount={moreCount}
        chips={chips}
        onClearAll={reset}
        moreFilters={
          <>
            <div className="space-y-1">
              <Label className="text-xs">From date</Label>
              <DateInput
                value={dateFrom}
                placeholder="From"
                onChange={(v) => {
                  setPage(1);
                  setDateFrom(v);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To date</Label>
              <DateInput
                value={dateTo}
                placeholder="To"
                onChange={(v) => {
                  setPage(1);
                  setDateTo(v);
                }}
              />
            </div>
          </>
        }
      >
        <Select
          value={action}
          onValueChange={(v) => {
            setPage(1);
            setAction(v);
          }}
        >
          <SelectTrigger className="h-9 w-[165px] bg-card text-xs sm:h-8">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {titleCase(a.replace(/_/g, " "))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={entityType}
          onValueChange={(v) => {
            setPage(1);
            setEntityType(v);
          }}
        >
          <SelectTrigger className="h-9 w-[145px] bg-card text-xs sm:h-8">
            <SelectValue placeholder="Record type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {ENTITY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {titleCase(t.replace(/_/g, " "))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterToolbar>

      <DataTable
        data={list.data?.items ?? []}
        columns={columns}
        keyField={(a) => a.id}
        onRowClick={(a) => navigate(`/audit/${a.id}`)}
        loading={list.isLoading}
        error={list.isError ? "Could not load audit logs." : null}
        onRetry={() => list.refetch()}
        emptyTitle="No activity recorded"
        emptyDescription="Actions taken across the CRM will appear here."
        page={page}
        pageSize={25}
        total={list.data?.total}
        onPageChange={setPage}
      />
    </div>
  );
}
