import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Upload } from "lucide-react";
import { leadsApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { ExportButton } from "../../components/ExportButton";
import { DataTable, Column } from "../../components/shared/DataTable";
import { FilterToolbar, FilterChip } from "../../components/shared/FilterToolbar";
import { titleCase } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { TIMING_TONE_CLASS, reminderTiming } from "../../lib/reminderTiming";
import { LEAD_TYPES, LEAD_TYPE_LABELS } from "../../lib/types";
import type { Lead, LeadStage, LeadType } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STAGES: LeadStage[] = ["new", "contacted", "quoted", "converted", "lost"];
const PAGE_SIZE = 15;

const STAGE_VARIANT: Record<
  LeadStage,
  "default" | "secondary" | "destructive" | "outline"
> = {
  new: "default",
  contacted: "secondary",
  quoted: "outline",
  converted: "default",
  lost: "destructive",
};

export default function LeadsListPage() {
  const navigate = useNavigate();
  const { has } = useAuth();

  const [page, setPage] = useState(1);
  const [stage, setStage] = useState("all");
  const [type, setType] = useState("all");
  const [sort, setSort] = useState("recent");
  const [q, setQ] = useState("");

  const list = useQuery({
    queryKey: ["leads", page, stage, type, sort, q],
    queryFn: async () =>
      (
        await leadsApi.list({
          page,
          page_size: PAGE_SIZE,
          stage: stage === "all" ? undefined : stage,
          type: type === "all" ? undefined : type,
          sort,
          q,
        })
      ).data,
  });

  const reset = () => {
    setPage(1);
    setQ("");
    setStage("all");
    setType("all");
  };

  const filtered = !!(q || stage !== "all" || type !== "all");
  const canManage = has("manage_leads");

  const chips: FilterChip[] = [];
  if (type !== "all") {
    chips.push({
      key: "type",
      label: `Type: ${LEAD_TYPE_LABELS[type as LeadType] ?? titleCase(type)}`,
      onRemove: () => { setPage(1); setType("all"); },
    });
  }
  if (stage !== "all") {
    chips.push({
      key: "stage",
      label: `Stage: ${titleCase(stage)}`,
      onRemove: () => { setPage(1); setStage("all"); },
    });
  }

  const addButton = canManage ? (
    <Button size="sm" className="h-8" onClick={() => navigate("/leads/new")}>
      <Plus className="mr-1 h-3.5 w-3.5" />
      Add lead
    </Button>
  ) : undefined;

  const columns: Column<Lead>[] = [
    {
      key: "name",
      header: "Lead",
      cell: (l) => (
        <div>
          <p className="font-medium text-foreground">{l.name}</p>
          <p className="text-xs text-muted-foreground">
            {l.mobile ? `${l.mobile_country_code} ${l.mobile}` : "No mobile"} ·{" "}
            {LEAD_TYPE_LABELS[l.type] ?? titleCase(l.type)}
          </p>
        </div>
      ),
    },
    {
      key: "interest",
      header: "Interested in",
      cell: (l) => (
        <span className="text-foreground">
          {l.interested_in || l.category_key || "—"}
        </span>
      ),
    },
    {
      key: "stage",
      header: "Stage",
      cell: (l) => (
        <Badge
          variant={STAGE_VARIANT[l.stage]}
          className={`h-5 px-1.5 text-[10px] ${
            l.stage === "converted"
              ? "bg-emerald-600 text-white hover:bg-emerald-600"
              : ""
          }`}
        >
          {titleCase(l.stage)}
        </Badge>
      ),
    },
    {
      key: "comment",
      header: "Last note",
      cell: (l) => (
        <span
          className="block max-w-[200px] truncate text-muted-foreground"
          title={l.last_comment || ""}
        >
          {l.last_comment || "—"}
        </span>
      ),
    },
    {
      key: "reminder",
      header: "Next follow-up",
      cell: (l) => {
        const next = l.next_reminder;
        const timing = reminderTiming(next?.due_at, {
          isOverdue: next?.is_overdue,
          isDueToday: next?.is_due_today,
        });
        const extra = (next?.open_count ?? 0) - 1;
        return (
          <div className="whitespace-nowrap">
            <span className={TIMING_TONE_CLASS[timing.tone]}>
              {timing.label}
            </span>
            {extra > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">
                +{extra}
              </span>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Leads" />

      <FilterToolbar
        search={{
          value: q,
          onChange: (v) => {
            setPage(1);
            setQ(v);
          },
          placeholder: "Search name, mobile, email...",
        }}
        chips={chips}
        onClearAll={reset}
        right={
          <>
            <ExportButton
              filename="leads"
              onExport={(fmt) =>
                leadsApi.export({
                  stage: stage === "all" ? undefined : stage,
                  type: type === "all" ? undefined : type,
                  q: q || undefined,
                  fmt,
                })
              }
            />
            {canManage && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => navigate("/leads/import")}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  Import
                </Button>
                {addButton}
              </>
            )}
          </>
        }
      >
        <Select
          value={type}
          onValueChange={(v) => {
            setPage(1);
            setType(v);
          }}
        >
          <SelectTrigger className="h-9 w-[140px] bg-card text-xs sm:h-8">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {LEAD_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={stage}
          onValueChange={(v) => {
            setPage(1);
            setStage(v);
          }}
        >
          <SelectTrigger className="h-9 w-[135px] bg-card text-xs sm:h-8">
            <SelectValue placeholder="Stage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stages</SelectItem>
            {STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                {titleCase(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={sort}
          onValueChange={(v) => {
            setPage(1);
            setSort(v);
          }}
        >
          <SelectTrigger className="h-9 w-[135px] bg-card text-xs sm:h-8">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="name_asc">Name A–Z</SelectItem>
            <SelectItem value="name_desc">Name Z–A</SelectItem>
          </SelectContent>
        </Select>
      </FilterToolbar>

      <DataTable
        data={list.data?.items ?? []}
        columns={columns}
        keyField={(l) => l.id}
        onRowClick={(l) => navigate(`/leads/${l.id}`)}
        loading={list.isLoading}
        error={list.isError ? "Could not load leads." : null}
        onRetry={() => list.refetch()}
        emptyTitle={
          filtered ? "No leads match your filters" : "No leads yet"
        }
        emptyDescription={
          filtered
            ? "Try a different search or clear your filters."
            : "Add your first lead or import a list from a spreadsheet."
        }
        emptyAction={
          filtered ? (
            <Button variant="outline" size="sm" onClick={reset}>
              Clear filters
            </Button>
          ) : (
            addButton
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
