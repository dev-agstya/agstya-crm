import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Upload, Users } from "lucide-react";
import { customersApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { ExportButton } from "../../components/ExportButton";
import { DataTable, Column } from "../../components/shared/DataTable";
import { FilterToolbar, FilterChip } from "../../components/shared/FilterToolbar";
import { useAuth } from "../../store/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Customer } from "../../lib/types";

const CUST_SORTS = [
  { value: "recent", label: "Recently added" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "profit", label: "Top profit contributors" },
  { value: "policies", label: "Most policies" },
  { value: "active_policies", label: "Most active policies" },
  { value: "renewals", label: "Renewals due soonest" },
];

const PAGE_SIZE = 15;

export default function CustomersListPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const [sp] = useSearchParams();

  const [page, setPage] = useState(1);
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [sort, setSort] = useState("recent");
  const [renewalDue, setRenewalDue] = useState("all");
  const [hasActive, setHasActive] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const list = useQuery({
    queryKey: ["customers", page, q, sort, renewalDue, hasActive, showArchived],
    queryFn: async () =>
      (
        await customersApi.list({
          page,
          page_size: PAGE_SIZE,
          q,
          sort,
          include_archived: showArchived ? 1 : undefined,
          has_active_policy: hasActive ? 1 : undefined,
          renewal_due_days: renewalDue === "all" ? undefined : renewalDue,
        })
      ).data,
  });

  const canManage = has("manage_customers");

  const clearAll = () => {
    setPage(1);
    setQ("");
    setSort("recent");
    setRenewalDue("all");
    setHasActive(false);
    setShowArchived(false);
  };

  const chips: FilterChip[] = [];
  if (renewalDue !== "all") {
    chips.push({
      key: "renewal",
      label: `Renewal: within ${renewalDue}d`,
      onRemove: () => { setPage(1); setRenewalDue("all"); },
    });
  }
  if (hasActive) {
    chips.push({
      key: "active",
      label: "Has active policy",
      onRemove: () => { setPage(1); setHasActive(false); },
    });
  }
  if (showArchived) {
    chips.push({
      key: "archived",
      label: "Showing archived",
      onRemove: () => { setPage(1); setShowArchived(false); },
    });
  }

  const moreCount =
    (renewalDue !== "all" ? 1 : 0) +
    (hasActive ? 1 : 0) +
    (showArchived ? 1 : 0);

  const columns: Column<Customer>[] = [
    {
      key: "name",
      header: "Customer",
      cell: (c) => (
        <div>
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <span>{c.name}</span>
            {c.is_archived && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                Archived
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{c.email || "No email"}</p>
        </div>
      ),
    },
    {
      key: "mobile",
      header: "Mobile",
      cell: (c) => (
        <span className="tabular-nums text-foreground">
          {c.mobile || "—"}
        </span>
      ),
    },
    {
      key: "policies",
      header: "Active Policies",
      align: "right",
      cell: (c) => (
        <div className="text-right">
          <span className="font-semibold text-foreground tabular-nums">
            {c.active_policies ?? 0}
          </span>
          <span className="ml-1 text-xs text-muted-foreground">
            of {c.total_policies ?? 0}
          </span>
        </div>
      ),
    },
  ];

  const addBtn = canManage ? (
    <Button size="sm" className="h-8" onClick={() => navigate("/customers/new")}>
      <Plus className="mr-1 h-3.5 w-3.5" />
      Add customer
    </Button>
  ) : undefined;

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Policyholders & contact directory"
        actions={
          <>
            <ExportButton
              filename="customers"
              onExport={(fmt) =>
                customersApi.export({ q: q || undefined, fmt })
              }
            />
            {canManage && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => navigate("/customers/import")}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  Import
                </Button>
                {addBtn}
              </>
            )}
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
          placeholder: "Search name, mobile, email...",
        }}
        moreCount={moreCount}
        chips={chips}
        onClearAll={clearAll}
        moreFilters={
          <>
            <div className="space-y-1">
              <Label className="text-xs">Renewal Window</Label>
              <Select
                value={renewalDue}
                onValueChange={(v) => {
                  setPage(1);
                  setRenewalDue(v);
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any renewal date</SelectItem>
                  <SelectItem value="30">Due within 30 days</SelectItem>
                  <SelectItem value="60">Due within 60 days</SelectItem>
                  <SelectItem value="90">Due within 90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between pt-1">
              <Label htmlFor="cust-active" className="cursor-pointer text-xs">
                Has active policy
              </Label>
              <Switch
                id="cust-active"
                checked={hasActive}
                onCheckedChange={(c) => {
                  setPage(1);
                  setHasActive(c);
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="cust-archived" className="cursor-pointer text-xs">
                Show archived
              </Label>
              <Switch
                id="cust-archived"
                checked={showArchived}
                onCheckedChange={(c) => {
                  setPage(1);
                  setShowArchived(c);
                }}
              />
            </div>
          </>
        }
      >
        <Select
          value={sort}
          onValueChange={(v) => {
            setPage(1);
            setSort(v);
          }}
        >
          <SelectTrigger className="h-9 w-[175px] bg-card text-xs sm:h-8">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            {CUST_SORTS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterToolbar>

      <DataTable
        data={list.data?.items ?? []}
        columns={columns}
        keyField={(c) => c.id}
        onRowClick={(c) => navigate(`/customers/${c.id}`)}
        loading={list.isLoading}
        error={list.isError ? "Could not load customers." : null}
        onRetry={() => list.refetch()}
        emptyTitle="No customers found"
        emptyDescription="Add your first customer or import a list from Excel/CSV."
        emptyAction={
          addBtn ?? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>Ask an admin to add customers</span>
            </div>
          )
        }
        page={page}
        pageSize={PAGE_SIZE}
        total={list.data?.total}
        onPageChange={setPage}
      />
    </div>
  );
}
