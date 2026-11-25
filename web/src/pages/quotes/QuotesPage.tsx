import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Clock } from "lucide-react";
import { quotesApi } from "../../api/endpoints";
import { ExportButton } from "../../components/ExportButton";
import { PageHeader } from "../../components/PageHeader";
import { DataTable, Column } from "../../components/shared/DataTable";
import { FilterToolbar } from "../../components/shared/FilterToolbar";
import { formatDate } from "../../lib/format";
import { QuoteStageBadge } from "../portal/shared";
import type { StaffQuote } from "../../lib/types";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const AMBER_HOURS = 24;
const RED_HOURS = 48;

type Scope = "open" | "mine" | "all";

function ageLabel(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function urgency(
  hours: number,
  answered: boolean,
  expired = false
): "calm" | "warn" | "late" {
  if (expired) return "warn";
  if (answered) return "calm";
  if (hours >= RED_HOURS) return "late";
  if (hours >= AMBER_HOURS) return "warn";
  return "calm";
}

export default function QuotesPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("open");

  const list = useQuery({
    queryKey: ["quotes", page, q, scope],
    queryFn: async () =>
      (
        await quotesApi.list({
          page,
          page_size: 20,
          q: q || undefined,
          mine: scope === "mine" || undefined,
          open_only: scope !== "all",
        })
      ).data,
  });

  const rows = list.data?.items ?? [];
  const waiting = rows.filter((r) => !r.answered).length;
  const late = rows.filter(
    (r) => urgency(r.age_hours, r.answered) === "late"
  ).length;
  const expired = rows.filter((r) => r.expired).length;

  const ageBadge =
    late > 0 ? (
      <Badge variant="destructive" className="h-6 gap-1 text-xs">
        <AlertCircle className="h-3 w-3" />
        {late} over {RED_HOURS}h
      </Badge>
    ) : waiting > 0 ? (
      <Badge variant="secondary" className="h-6 gap-1 bg-amber-100 text-xs text-amber-800">
        <Clock className="h-3 w-3" />
        {waiting} waiting
      </Badge>
    ) : expired > 0 ? (
      <Badge variant="secondary" className="h-6 gap-1 bg-amber-100 text-xs text-amber-800">
        <Clock className="h-3 w-3" />
        {expired} expired
      </Badge>
    ) : null;

  const columns: Column<StaffQuote>[] = [
    {
      key: "customer",
      header: "Customer & Type",
      cell: (r) => (
        <div>
          <p className="font-medium text-foreground">{r.customer_name}</p>
          <p className="text-xs text-muted-foreground">
            {r.category_label || r.category_key}
          </p>
        </div>
      ),
    },
    {
      key: "partner",
      header: "Requested by",
      cell: (r) => (
        <span className="text-foreground">{r.partner_name || "—"}</span>
      ),
    },
    {
      key: "stage",
      header: "Status",
      cell: (r) => <QuoteStageBadge stage={r.stage} />,
    },
    {
      key: "age",
      header: "Waiting",
      cell: (r) => {
        const u = urgency(r.age_hours, r.answered, r.expired);
        return (
          <Badge
            variant={
              u === "late" ? "destructive" : u === "warn" ? "secondary" : "outline"
            }
            className="h-5 px-1.5 text-[10px]"
          >
            {ageLabel(r.age_hours)}
          </Badge>
        );
      },
    },
    {
      key: "date",
      header: "Requested",
      align: "right",
      cell: (r) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatDate(r.created_at)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Quote Requests"
        subtitle="Partner requests for insurance quotes"
        actions={
          <>
            {ageBadge}
            <ExportButton
              filename="quotes"
              onExport={(fmt) =>
                quotesApi.export({
                  q: q || undefined,
                  mine: scope === "mine" || undefined,
                  open_only: scope !== "all",
                  fmt,
                })
              }
            />
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
          placeholder: "Search customer or partner...",
        }}
        onClearAll={() => {
          setPage(1);
          setQ("");
        }}
      >
        <Tabs
          value={scope}
          onValueChange={(v) => {
            setPage(1);
            setScope(v as Scope);
          }}
        >
          <TabsList className="h-8">
            <TabsTrigger value="open" className="h-6 px-2.5 text-xs">
              Open
            </TabsTrigger>
            <TabsTrigger value="mine" className="h-6 px-2.5 text-xs">
              Mine
            </TabsTrigger>
            <TabsTrigger value="all" className="h-6 px-2.5 text-xs">
              All
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </FilterToolbar>

      <DataTable
        data={rows}
        columns={columns}
        keyField={(r) => r.id}
        onRowClick={(r) => navigate(`/quotes/${r.id}`)}
        loading={list.isLoading}
        error={list.isError ? "Could not load quote requests." : null}
        onRetry={() => list.refetch()}
        emptyTitle="No quote requests"
        emptyDescription="When channel partners ask for a quote, their requests appear here."
        page={page}
        pageSize={20}
        total={list.data?.total}
        onPageChange={setPage}
      />
    </div>
  );
}
