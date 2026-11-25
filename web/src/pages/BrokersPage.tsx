import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Edit, IndianRupee, Plus } from "lucide-react";
import { brokersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { DataTable, Column } from "../components/shared/DataTable";
import { FilterToolbar } from "../components/shared/FilterToolbar";
import { RateRulesPanel } from "../components/RateRulesPanel";
import { useAuth } from "../store/auth";
import type { Broker } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function BrokersPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const canManage = has("manage_brokers");
  const [ratesFor, setRatesFor] = useState<Broker | null>(null);
  const [q, setQ] = useState("");

  const list = useQuery({
    queryKey: ["brokers", q],
    queryFn: async () => (await brokersApi.list({ q: q || undefined })).data,
  });

  const columns: Column<Broker>[] = [
    {
      key: "name",
      header: "Broker",
      cell: (b) => (
        <div>
          <p className="font-medium text-foreground">{b.name}</p>
          <p className="text-xs text-muted-foreground">{b.code}</p>
        </div>
      ),
    },
    {
      key: "code",
      header: "Short code",
      cell: (b) => (
        <Badge variant="outline" className="font-mono text-xs tracking-wider">
          {b.short_code}
        </Badge>
      ),
    },
    {
      key: "tds",
      header: "TDS %",
      align: "right",
      cell: (b) => (
        <span className="font-semibold tabular-nums">
          {(b.tds_percent / 100).toFixed(2)}%
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (b) => (
        <Badge
          variant={b.active ? "default" : "secondary"}
          className={`h-5 px-1.5 text-[10px] ${
            b.active ? "bg-emerald-600 text-white hover:bg-emerald-600" : ""
          }`}
        >
          {b.active ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "Actions",
            align: "right" as const,
            mobileLabel: false as const,
            cell: (b: Broker) => (
              <div
                className="flex justify-end gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    setRatesFor(ratesFor?.id === b.id ? null : b)
                  }
                >
                  <IndianRupee className="mr-1 h-3 w-3" />
                  Rate card
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => navigate(`/brokers/${b.id}/edit`)}
                >
                  <Edit className="mr-1 h-3 w-3" />
                  Edit
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Brokers"
        subtitle="Brokerages & commission rate cards"
        actions={
          canManage && (
            <Button
              size="sm"
              className="h-8"
              onClick={() => navigate("/brokers/new")}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add broker
            </Button>
          )
        }
      />

      <FilterToolbar
        search={{
          value: q,
          onChange: setQ,
          placeholder: "Search broker...",
        }}
        onClearAll={() => setQ("")}
      />

      <DataTable
        data={list.data ?? []}
        columns={columns}
        keyField={(b) => b.id}
        onRowClick={
          canManage ? (b) => navigate(`/brokers/${b.id}/edit`) : undefined
        }
        loading={list.isLoading}
        error={list.isError ? "Could not load brokers." : null}
        onRetry={() => list.refetch()}
        emptyTitle="No brokers yet"
        emptyDescription="Add the brokerages you place policies through."
        emptyAction={
          canManage ? (
            <Button size="sm" onClick={() => navigate("/brokers/new")}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add broker
            </Button>
          ) : undefined
        }
      />

      {ratesFor && (
        <RateRulesPanel
          broker={ratesFor}
          canManage={has("manage_rate_cards")}
          onClose={() => setRatesFor(null)}
        />
      )}
    </div>
  );
}
