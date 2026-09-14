import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { leadsApi } from "../../api/endpoints";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import { ExportButton } from "../../components/ExportButton";
import {
  EmptyState,
  ErrorState,
  Ledger,
  LedgerCell,
  LedgerRow,
  ListShell,
  LTh,
  MobileCard,
  Pagination,
  SearchInput,
  StatusBadge,
  TableSkeleton,
} from "../../components/ui";
import { titleCase } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { TIMING_TONE_CLASS, reminderTiming } from "../../lib/reminderTiming";
import { LEAD_TYPES, LEAD_TYPE_LABELS } from "../../lib/types";
import type { Lead, LeadStage } from "../../lib/types";
import { FilterPill } from "../../components/FilterPill";

const STAGES: LeadStage[] = ["new", "contacted", "quoted", "converted", "lost"];

const PAGE_SIZE = 15;

/**
 * The lead pipeline.
 *
 * Type is a THIRD DROPDOWN beside Stage and Sort (owner Q2.1), not the tab
 * strip it briefly was: the tabs floated above the card looking detached from
 * the table they filtered, and three controls doing the same job belong in the
 * same row.
 *
 * Clicking a row opens /leads/:id — a real page, not a dialog (owner 2026-08-03).
 */
export default function LeadsListPage() {
  const navigate = useNavigate();
  const { has } = useAuth();

  const [page, setPage] = useState(1);
  const [stage, setStage] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState("recent");
  const [q, setQ] = useState("");

  const list = useQuery({
    queryKey: ["leads", page, stage, type, sort, q],
    queryFn: async () =>
      (await leadsApi.list({
        page, page_size: PAGE_SIZE, stage: stage || undefined,
        type: type || undefined, sort, q,
      })).data,
  });

  const reset = () => { setPage(1); setQ(""); setStage(""); setType(""); };
  const filtered = !!(q || stage || type);

  const addButton = has("manage_leads") ? (
    <button className="btn-primary" onClick={() => navigate("/leads/new")}>
      <Icon.Plus size={16} /> Add lead
    </button>
  ) : undefined;

  return (
    <div>
      <PageHeader
        title="Leads"
        actions={
          <>
            <ExportButton filename="leads"
              onExport={(fmt) => leadsApi.export({
                stage: stage || undefined, type: type || undefined,
                q: q || undefined, fmt })} />
            {has("manage_leads") && (
              <>
                <button className="btn-secondary"
                  onClick={() => navigate("/leads/import")}>
                  <Icon.Upload size={16} /> Import
                </button>
                {addButton}
              </>
            )}
          </>
        }
      />

      <div>
        <div className="ledger-bar">
          <SearchInput placeholder="Search name, mobile, email…"
            value={q} onChange={(v) => { setPage(1); setQ(v); }}
            className="min-w-[220px] max-w-sm flex-1" />
          {/* Pills, not selects: each states its own value when set and clears
              in a click, so the bar says what is being looked at instead of
              being three dropdowns all reading "All …". */}
          <FilterPill label="Type" value={type}
            onChange={(v) => { setPage(1); setType(v); }}
            options={LEAD_TYPES.map((t) => ({
              value: t.value, label: t.label }))} />
          <FilterPill label="Stage" value={stage}
            onChange={(v) => { setPage(1); setStage(v); }}
            options={STAGES.map((s) => ({ value: s, label: titleCase(s) }))} />
          {/* Sort has no empty state — "Newest first" IS its resting position,
              so `defaultValue` keeps it quiet until it is actually changed. */}
          <FilterPill label="Sort" value={sort} defaultValue="recent"
            onChange={(v) => { setPage(1); setSort(v); }}
            options={[
              { value: "recent", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
              { value: "name_asc", label: "Name A–Z" },
              { value: "name_desc", label: "Name Z–A" },
            ]} />
          {filtered && (
            <button className="btn-ghost btn-sm" onClick={reset}>
              Clear filters
            </button>
          )}
        </div>

        {list.isError ? (
          <ErrorState onRetry={() => list.refetch()} />
        ) : list.isLoading ? (
          <TableSkeleton cols={6} />
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            title={filtered ? "No leads match these filters" : "No leads yet"}
            icon={<Icon.Lead size={24} />}
            hint={filtered
              ? "Try a different search, or clear the filters."
              : "Add your first lead, or import a list from a spreadsheet."}
            action={filtered
              ? <button className="btn-secondary" onClick={reset}>
                Clear filters</button>
              : addButton}
          />
        ) : (
          <ListShell
            bare
            cards={list.data!.items.map((l) => (
              <LeadCard key={l.id} lead={l} />
            ))}
            table={
              <Ledger
                head={
                  <>
                    <LTh>Lead</LTh>
                    <LTh>Interested in</LTh>
                    <LTh>Stage</LTh>
                    <LTh>Last comment</LTh>
                    <LTh>Next reminder</LTh>
                  </>
                }
              >
                {list.data!.items.map((l) => (
                  <LeadRow key={l.id} lead={l}
                    onOpen={() => navigate(`/leads/${l.id}`)} />
                ))}
              </Ledger>
            }
          />
        )}
        {list.data && (
          <Pagination page={page} pageSize={PAGE_SIZE}
            total={list.data.total} onChange={setPage} />
        )}
      </div>
    </div>
  );
}

/** The reminder clock, shared by both renderings. */
function useLeadTiming(lead: Lead) {
  const next = lead.next_reminder;
  return {
    timing: reminderTiming(next?.due_at, {
      isOverdue: next?.is_overdue,
      isDueToday: next?.is_due_today,
    }),
    extra: (next?.open_count ?? 0) - 1,
    // A lead with an overdue reminder is the one to ring. That is the queue's
    // whole purpose, so it gets the rail rather than a colour buried in the
    // seventh column where nobody was looking.
    rail: next?.is_overdue ? ("out" as const)
      : next?.is_due_today ? ("due" as const) : undefined,
  };
}

function LeadRow({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const { timing, extra, rail } = useLeadTiming(lead);

  return (
    <LedgerRow onClick={onOpen}>
      {/*
        Name over contact. Type, mobile and email were three columns; they are
        all "who this is", and the phone number is what you came for.
        Type stays plain text, not a pill (owner) — a pill made a category look
        like a status, which is what Stage actually is.
      */}
      <LedgerCell
        rail={rail}
        to={`/leads/${lead.id}`}
        title={lead.name}
        sub={
          <>
            {lead.mobile
              ? `${lead.mobile_country_code} ${lead.mobile}`
              : "No mobile"}
            {" · "}{LEAD_TYPE_LABELS[lead.type] ?? titleCase(lead.type)}
          </>
        }
      />
      <td className="text-[13px] text-slate-700">
        {lead.interested_in || lead.category_key || "—"}
      </td>
      <td><StatusBadge value={lead.stage} /></td>
      <td className="max-w-[220px] truncate text-[13px] text-slate-500">
        <span title={lead.last_comment || ""}>{lead.last_comment || "—"}</span>
      </td>
      <td>
        <span className={`whitespace-nowrap text-secondary ${
          TIMING_TONE_CLASS[timing.tone]}`}>
          {timing.label}
        </span>
        {extra > 0 && (
          <span className="ml-1.5 text-xs text-slate-500">+{extra} more</span>
        )}
      </td>
    </LedgerRow>
  );
}

/** The phone rendering. Same facts, stacked. */
function LeadCard({ lead }: { lead: Lead }) {
  const { timing, rail } = useLeadTiming(lead);
  return (
    <MobileCard
      to={`/leads/${lead.id}`}
      rail={rail}
      title={lead.name}
      meta={
        <>
          {lead.mobile
            ? `${lead.mobile_country_code} ${lead.mobile}`
            : "No mobile"}
          {" · "}{LEAD_TYPE_LABELS[lead.type] ?? titleCase(lead.type)}
        </>
      }
      right={<StatusBadge value={lead.stage} />}
      footer={
        <span className={TIMING_TONE_CLASS[timing.tone]}>{timing.label}</span>
      }
    />
  );
}
