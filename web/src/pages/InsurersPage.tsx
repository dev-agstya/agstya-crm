import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Edit, Plus } from "lucide-react";
import { insurersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { DataTable, Column } from "../components/shared/DataTable";
import { FilterToolbar } from "../components/shared/FilterToolbar";
import { useAuth } from "../store/auth";
import type { Insurer } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
        <span className="text-muted-foreground">
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
          className={`h-5 px-1.5 text-[10px] ${
            i.active ? "bg-emerald-600 text-white hover:bg-emerald-600" : ""
          }`}
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
                className="h-7 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/insurers/${i.id}/edit`);
                }}
              >
                <Edit className="mr-1 h-3 w-3" />
                Edit
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader title="Insurers" />

      <FilterToolbar
        right={
          canManage && (
            <Button
              size="sm"
              className="h-8"
              onClick={() => navigate("/insurers/new")}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add insurer
            </Button>
          )
        }
        search={{
          value: q,
          onChange: setQ,
          placeholder: "Search insurer name...",
        }}
        onClearAll={() => {
          setQ("");
          setActiveOnly(true);
        }}
      >
        <Select
          value={activeOnly ? "active" : "all"}
          onValueChange={(v) => setActiveOnly(v === "active")}
        >
          <SelectTrigger className="h-9 w-[145px] bg-card text-xs sm:h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active only</SelectItem>
            <SelectItem value="all">All insurers</SelectItem>
          </SelectContent>
        </Select>
      </FilterToolbar>

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
            <Button size="sm" onClick={() => navigate("/insurers/new")}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add insurer
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
