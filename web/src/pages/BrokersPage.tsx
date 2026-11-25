import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Edit, IndianRupee, Plus, Search } from "lucide-react";
import { brokersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { DataTable, Column } from "../components/shared/DataTable";
import { RateRulesPanel } from "../components/RateRulesPanel";
import { useAuth } from "../store/auth";
import type { Broker } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

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
        <Badge variant="outline" className="font-mono tracking-wider">
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
          className={
            b.active ? "bg-emerald-600 text-white hover:bg-emerald-600" : ""
          }
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
                className="flex justify-end gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setRatesFor(ratesFor?.id === b.id ? null : b)
                  }
                >
                  <IndianRupee className="mr-1 h-3.5 w-3.5" />
                  Rate card
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate(`/brokers/${b.id}/edit`)}
                >
                  <Edit className="mr-1 h-3.5 w-3.5" />
                  Edit
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Catalog"
        title="Brokers"
        subtitle="Brokerage codes and commission rate cards."
        actions={
          canManage && (
            <Button onClick={() => navigate("/brokers/new")}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add broker
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-4">
          <div className="relative max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search broker..."
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

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
            <Button onClick={() => navigate("/brokers/new")}>
              <Plus className="mr-1.5 h-4 w-4" />
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
