import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, Upload, Users } from "lucide-react";
import { customersApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { ExportButton } from "../../components/ExportButton";
import { DataTable, Column } from "../../components/shared/DataTable";
import { useAuth } from "../../store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
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

  const columns: Column<Customer>[] = [
    {
      key: "name",
      header: "Customer",
      cell: (c) => (
        <div>
          <div className="flex items-center gap-2 font-medium text-foreground">
            <span>{c.name}</span>
            {c.is_archived && <Badge variant="secondary">Archived</Badge>}
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
    <Button onClick={() => navigate("/customers/new")}>
      <Plus className="mr-1.5 h-4 w-4" />
      Add customer
    </Button>
  ) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        subtitle="View and manage all policyholders and their contact details."
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
                  onClick={() => navigate("/customers/import")}
                >
                  <Upload className="mr-1.5 h-4 w-4" />
                  Import
                </Button>
                {addBtn}
              </>
            )}
          </>
        }
      />

      {/* Filter Bar */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
              placeholder="Search by name, mobile, or email..."
              className="pl-9"
            />
          </div>

          <Select
            value={sort}
            onValueChange={(v) => {
              setPage(1);
              setSort(v);
            }}
          >
            <SelectTrigger className="w-[190px]">
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

          <Select
            value={renewalDue}
            onValueChange={(v) => {
              setPage(1);
              setRenewalDue(v);
            }}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Renewal window" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any renewal date</SelectItem>
              <SelectItem value="30">Due within 30 days</SelectItem>
              <SelectItem value="60">Due within 60 days</SelectItem>
              <SelectItem value="90">Due within 90 days</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 pl-1">
            <Switch
              id="cust-active"
              checked={hasActive}
              onCheckedChange={(c) => {
                setPage(1);
                setHasActive(c);
              }}
            />
            <Label htmlFor="cust-active" className="cursor-pointer text-sm">
              Has active policy
            </Label>
          </div>

          <div className="flex items-center gap-2 pl-1">
            <Switch
              id="cust-archived"
              checked={showArchived}
              onCheckedChange={(c) => {
                setPage(1);
                setShowArchived(c);
              }}
            />
            <Label htmlFor="cust-archived" className="cursor-pointer text-sm">
              Show archived
            </Label>
          </div>
        </CardContent>
      </Card>

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
