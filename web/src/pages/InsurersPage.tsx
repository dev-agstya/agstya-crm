import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Edit, Plus, Search } from "lucide-react";
import { insurersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { DataTable, Column } from "../components/shared/DataTable";
import { useAuth } from "../store/auth";
import type { Insurer } from "../lib/types";
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

export default function InsurersPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const [q, setQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);

  const list = useQuery({
    queryKey: ["insurers", q, activeOnly],
    queryFn: async () =>
      (
        await insurersApi.list({
          page_size: 200,
          q: q || undefined,
          active_only: activeOnly ? 1 : 0,
        })
      ).data,
  });

  const canManage = has("manage_insurers");

  const columns: Column<Insurer>[] = [
    {
      key: "name",
      header: "Insurer",
      cell: (i) => (
        <div>
          <p className="font-medium text-foreground">{i.name}</p>
          <p className="text-xs text-muted-foreground">{i.code}</p>
        </div>
      ),
    },
    {
      key: "contact",
      header: "Contact",
      cell: (i) => (
        <span className="text-sm text-muted-foreground">
          {i.phone || i.email || "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (i) => (
        <Badge
          variant={i.active ? "default" : "secondary"}
          className={
            i.active ? "bg-emerald-600 text-white hover:bg-emerald-600" : ""
          }
        >
          {i.active ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "",
            align: "right" as const,
            mobileLabel: false as const,
            cell: (i: Insurer) => (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/insurers/${i.id}/edit`);
                }}
              >
                <Edit className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Catalog"
        title="Insurers"
        subtitle="Insurance companies whose policies you sell."
        actions={
          canManage && (
            <Button onClick={() => navigate("/insurers/new")}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add insurer
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search insurer name..."
              className="pl-9"
            />
          </div>
          <Select
            value={activeOnly ? "active" : "all"}
            onValueChange={(v) => setActiveOnly(v === "active")}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active only</SelectItem>
              <SelectItem value="all">All insurers</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <DataTable
        data={list.data?.items ?? []}
        columns={columns}
        keyField={(i) => i.id}
        onRowClick={
          canManage ? (i) => navigate(`/insurers/${i.id}/edit`) : undefined
        }
        loading={list.isLoading}
        error={list.isError ? "Could not load insurers." : null}
        onRetry={() => list.refetch()}
        emptyTitle="No insurers found"
        emptyDescription="Add insurance companies so you can attach policies to them."
        emptyAction={
          canManage ? (
            <Button onClick={() => navigate("/insurers/new")}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add insurer
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
