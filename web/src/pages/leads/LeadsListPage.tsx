import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, Upload, X } from "lucide-react";
import { leadsApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { ExportButton } from "../../components/ExportButton";
import { DataTable, Column } from "../../components/shared/DataTable";
import { titleCase } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { TIMING_TONE_CLASS, reminderTiming } from "../../lib/reminderTiming";
import { LEAD_TYPES, LEAD_TYPE_LABELS } from "../../lib/types";
import type { Lead, LeadStage } from "../../lib/types";
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

  const addButton = canManage ? (
    <Button onClick={() => navigate("/leads/new")}>
      <Plus className="mr-1.5 h-4 w-4" />
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
          className={
            l.stage === "converted"
              ? "bg-emerald-600 text-white hover:bg-emerald-600"
              : ""
          }
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
          className="block max-w-[220px] truncate text-muted-foreground"
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
              <span className="ml-1.5 text-xs text-muted-foreground">
                +{extra} more
              </span>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        subtitle="Track prospective customers and follow-up reminders."
        actions={
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
                  onClick={() => navigate("/leads/import")}
                >
                  <Upload className="mr-1.5 h-4 w-4" />
                  Import
                </Button>
                {addButton}
              </>
            )}
          </>
        }
      />

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
            value={type}
            onValueChange={(v) => {
              setPage(1);
              setType(v);
            }}
          >
            <SelectTrigger className="w-[170px]">
              <SelectValue placeholder="Lead type" />
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
            <SelectTrigger className="w-[160px]">
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
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="name_asc">Name A–Z</SelectItem>
              <SelectItem value="name_desc">Name Z–A</SelectItem>
            </SelectContent>
          </Select>

          {filtered && (
            <Button variant="ghost" size="sm" onClick={reset}>
              <X className="mr-1 h-4 w-4" />
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

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
            <Button variant="outline" onClick={reset}>
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
