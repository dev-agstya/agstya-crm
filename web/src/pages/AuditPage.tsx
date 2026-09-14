import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { auditApi, type AuditFilters } from "../api/endpoints";
import { apiError } from "../api/client";
import { ListPage } from "../components/ListPage";
import { FilterPill } from "../components/FilterPill";
import {
  LedgerCell, LedgerRow, LTh, MobileCard, PersonCell,
} from "../components/ui";
import { Icon } from "../components/Icon";
import { DateInput } from "../components/DateInput";
import { toast } from "../components/Toast";
import { downloadBlob } from "../lib/download";
import { formatDateTime, titleCase } from "../lib/format";
import type { AuditEntry } from "../lib/types";

const ACTIONS = [
  "login_success", "login_failed", "logout", "password_changed",
  "account_created", "account_updated", "account_deactivated", "account_deleted",
  "permissions_changed", "profile_updated", "email_changed",
  "customer_created", "customer_updated", "customer_deleted",
  "lead_created", "lead_updated", "lead_deleted",
  "policy_created", "policy_updated", "policy_approved", "policy_rejected",
  "policy_cancelled", "reward_status_changed",
  "payment_recorded", "ledger_adjusted",
  "document_uploaded", "document_downloaded", "document_deleted",
  "email_sent", "report_exported",
];
const ENTITY_TYPES = ["user", "customer", "lead", "policy", "reward",
  "ledger_txn", "settlement", "document", "role", "insurer", "target"];

export default function AuditPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const filters: AuditFilters = {
    q: q || undefined, action: action || undefined,
    entity_type: entityType || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo ? `${dateTo}T23:59:59` : undefined,
  };

  const list = useQuery({
    queryKey: ["audit", page, filters],
    queryFn: async () =>
      (await auditApi.list({ ...filters, page, page_size: 25 })).data,
  });

  const doExport = async (fmt: "excel" | "csv") => {
    setExporting(true);
    try {
      const res = await auditApi.export({ ...filters, fmt });
      downloadBlob(res.data as Blob,
        `audit-logs.${fmt === "excel" ? "xlsx" : "csv"}`);
    } catch (e) { toast.error(apiError(e)); }
    finally { setExporting(false); }
  };

  const reset = () => {
    setQ(""); setAction(""); setEntityType(""); setDateFrom(""); setDateTo("");
    setPage(1);
  };
  const hasFilter = q || action || entityType || dateFrom || dateTo;

  return (
    <ListPage<AuditEntry>
      title="Audit log"
      eyebrow="Compliance"
      actions={
        <>
          <button className="btn-secondary" disabled={exporting}
            onClick={() => doExport("excel")}>
            <Icon.Download size={16} /> Excel</button>
          <button className="btn-secondary" disabled={exporting}
            onClick={() => doExport("csv")}>
            <Icon.Download size={16} /> CSV</button>
        </>
      }
      search={{
        value: q,
        onChange: (v) => { setPage(1); setQ(v); },
        placeholder: "Search name, code, summary…",
      }}
      filters={
        <>
          <FilterPill label="Action" value={action}
            onChange={(v) => { setPage(1); setAction(v); }}
            options={ACTIONS.map((a) => ({ value: a, label: titleCase(a) }))} />
          <FilterPill label="Entity" value={entityType}
            onChange={(v) => { setPage(1); setEntityType(v); }}
            options={ENTITY_TYPES.map((t) => ({
              value: t, label: titleCase(t) }))} />
          {/* Dates stay real date fields — a range is two values, and a pill
              popover would hide the one you are comparing against. */}
          <DateInput className="input w-[150px]"
            value={dateFrom} title="From" placeholder="From dd/mm/yyyy"
            onChange={(v) => { setPage(1); setDateFrom(v); }} />
          <DateInput className="input w-[150px]"
            value={dateTo} title="To" placeholder="To dd/mm/yyyy"
            onChange={(v) => { setPage(1); setDateTo(v); }} />
        </>
      }
      filtered={!!hasFilter}
      onClearFilters={reset}
      query={list}
      items={list.data?.items ?? []}
      loadingCols={3}
      empty={{
        title: "No activity yet",
        hint: "Every state-changing action lands here as it happens.",
      }}
      filteredEmpty={{ title: "No entries match these filters" }}
      pagination={list.data
        ? { page, pageSize: 25, total: list.data.total, onChange: setPage }
        : undefined}
      head={
        <>
          <LTh>Action</LTh>
          <LTh>Who</LTh>
          <LTh>When</LTh>
        </>
      }
      card={(a) => (
        <MobileCard key={a.id} to={`/audit/${a.id}`}
          title={a.summary}
          meta={<>{titleCase(a.action)} · {a.actor_name || "System"}</>}
          footer={formatDateTime(a.created_at)} />
      )}
      row={(a) => (
        <LedgerRow key={a.id} onClick={() => navigate(`/audit/${a.id}`)}>
          {/* The SUMMARY is what the row is about — "Reconciled HDFC Current:
              was short by Rs 1,200" — and it was buried in a "Details" column
              four across, behind Time, Actor and Action. The action name is
              context, so it goes underneath, which is the shape every other
              ledger in the app already uses.

              No IP column and no 3-dot menu here (2026-09-12) — a table row
              that doesn't fit the viewport scrolls sideways, which is exactly
              what happened with Action/Who/When/IP/menu all fighting for the
              same width. Both move to the detail page, which has the room and
              is where a staff member actually wants the technical detail. */}
          <LedgerCell
            to={`/audit/${a.id}`}
            title={a.summary}
            sub={titleCase(a.action)}
          />
          <td>
            <PersonCell
              name={a.actor_name || "System"}
              sub={a.actor_role ? titleCase(a.actor_role) : "Automated"}
            />
          </td>
          <td className="whitespace-nowrap text-[13px] text-slate-600">
            {formatDateTime(a.created_at)}
          </td>
        </LedgerRow>
      )}
    />
  );
}
