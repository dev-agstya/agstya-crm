import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { portalApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { RecordPage } from "../../components/RecordPage";
import { Icon } from "../../components/Icon";
import {
  ErrorState, EmptyState, Pagination, SearchInput, StatusBadge, TableSkeleton,
} from "../../components/ui";
import { toast } from "../../components/Toast";
import {
  DateFilter, periodParams, type PeriodValue,
} from "../../components/finance/DateFilter";
import { formatDate, formatINR } from "../../lib/format";
import {
  CardMoney, DetailRow, DocumentList, ListShell, MobileCard, SectionCard,
} from "./shared";

/*
  A partner's own policies — READ ONLY, always.

  A partner cannot create, edit or delete a policy and never could usefully:
  the policy number, the insurer and the rate are all outputs of work the
  agency does. What they need is to see what they have sold and what it earned
  them, and to hand the document to the customer.
*/

export function PortalPoliciesPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [period, setPeriod] = useState<PeriodValue>({ period: "" });

  const list = useQuery({
    queryKey: ["portal", "policies", page, q, period],
    queryFn: async () => (await portalApi.policies({
      page, page_size: 20, q: q || undefined,
      ...(period.period ? periodParams(period) : {}),
    })).data,
  });
  const rows = list.data?.items ?? [];

  return (
    <div>
      <PageHeader title="My Policies"
        subtitle="Every policy credited to you, and what you earned on it." />

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput value={q}
          onChange={(v) => { setQ(v); setPage(1); }}
          placeholder="Policy number…" />
        <DateFilter value={period}
          onChange={(v) => { setPeriod(v); setPage(1); }} />
      </div>

      {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
        <div className="card card-body"><TableSkeleton cols={5} /></div>
      ) : (
        <ListShell
          empty={rows.length === 0 ? (
            <EmptyState
              icon={<Icon.Policy size={20} />}
              title="No policies yet"
              hint="When Agastya books a policy credited to you, it shows up
                here with your earning on it." />
          ) : undefined}
          cards={rows.map((p) => (
            <MobileCard key={p.id} to={`/portal/policies/${p.id}`}
              title={p.policy_number || p.code}
              meta={<>{p.customer_name || "—"} · {p.category_label}</>}
              right={<CardMoney label="you earned" value={p.my_earning}
                tone="in" />}
              footer={
                <span className="flex items-center justify-between gap-2">
                  <span>Premium {formatINR(p.premium_amount)}</span>
                  <StatusBadge value={p.status} />
                </span>
              } />
          ))}
          table={
            <table>
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Customer</th>
                  <th>Type</th>
                  <th className="num">Premium</th>
                  <th className="num">You earned</th>
                  <th>Expires</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <PolicyRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          } />
      )}

      <Pagination page={page} pageSize={20} total={list.data?.total ?? 0}
        onChange={setPage} />
    </div>
  );
}

function PolicyRow({ p }: { p: import("../../lib/types").PortalPolicy }) {
  const navigate = useNavigate();
  return (
    <tr className="row-link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(`/portal/policies/${p.id}`);
      }}
      onClick={() => navigate(`/portal/policies/${p.id}`)}>
      <td className="font-medium text-slate-900">
        {p.policy_number || p.code}
        {p.is_renewal && (
          <span className="ml-2 chip">renewal</span>
        )}
      </td>
      <td>{p.customer_name || "—"}</td>
      <td>{p.category_label}</td>
      <td className="num">{formatINR(p.premium_amount)}</td>
      <td className="num font-semibold text-money-in">
        {formatINR(p.my_earning)}</td>
      <td className="whitespace-nowrap">{formatDate(p.expiry_date)}</td>
      <td><StatusBadge value={p.status} /></td>
    </tr>
  );
}

/* ------------------------------------------------------------------ detail -- */

export function PortalPolicyDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();

  const policy = useQuery({
    queryKey: ["portal", "policy", id],
    retry: false,
    queryFn: async () => (await portalApi.policy(id)).data,
  });
  const p = policy.data;
  const missing = isAxiosError(policy.error)
    && policy.error.response?.status === 404;

  const openDoc = async (docId: string) => {
    try {
      const { data } = await portalApi.policyDocumentUrl(id, docId);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  // Only the fields the type actually collected, labelled as the agency
  // labelled them.
  const details = Object.entries(p?.details ?? {})
    .filter(([, v]) => v !== null && v !== "" && v !== undefined);

  return (
    <RecordPage
      backTo="/portal/policies"
      backLabel="Back to my policies"
      title={p ? (p.policy_number || p.code) : "Policy"}
      documentTitle={p?.policy_number || p?.code || "Policy"}
      subtitle={p ? [p.customer_name, p.insurer_name].filter(Boolean).join(" · ")
        : undefined}
      badges={p && <StatusBadge value={p.status} />}
      loading={policy.isLoading}
      error={missing ? undefined : policy.error}
      onRetry={() => policy.refetch()}
      notFound={missing}
    >
      {p && (
        <div className="space-y-4">
          {/* What they earned, first — everything else is context for it. */}
          <div className="card px-4 py-4 sm:px-5">
            <p className="text-caption font-semibold uppercase text-slate-500">
              You earned on this policy</p>
            <p className="mt-1 text-metric-sm tabular-nums text-money-in
              sm:text-3xl">{formatINR(p.my_earning)}</p>
          </div>

          <SectionCard title="Policy">
            <DetailRow label="Policy number">
              {p.policy_number || "—"}</DetailRow>
            <DetailRow label="Customer">
              {p.customer_name || "—"}
              {p.customer_mobile && (
                <a href={`tel:${p.customer_mobile}`}
                  className="ml-2 text-slate-500 underline">
                  {p.customer_mobile}</a>
              )}
            </DetailRow>
            <DetailRow label="Insurer">{p.insurer_name || "—"}</DetailRow>
            <DetailRow label="Type">
              {p.category_label}
              {p.subcategory_label ? ` · ${p.subcategory_label}` : ""}
            </DetailRow>
            <DetailRow label="Premium">
              {formatINR(p.premium_amount)}</DetailRow>
            <DetailRow label="Sum insured">
              {p.sum_insured ? formatINR(p.sum_insured) : "—"}</DetailRow>
            <DetailRow label="Cover">
              {formatDate(p.start_date)} — {formatDate(p.expiry_date)}
            </DetailRow>
            {p.days_to_expiry != null && p.days_to_expiry >= 0
              && p.days_to_expiry <= 60 && (
              <DetailRow label="Renewal">
                <span className="text-due">
                  {p.days_to_expiry} days left</span>
              </DetailRow>
            )}
          </SectionCard>

          {details.length > 0 && (
            <SectionCard title={`${p.category_label ?? "Policy"} details`}>
              {details.map(([key, value]) => (
                <DetailRow key={key} label={p.field_labels[key] ?? key}>
                  {String(value)}
                </DetailRow>
              ))}
            </SectionCard>
          )}

          <SectionCard title="Documents">
            <DocumentList documents={p.documents} onOpen={openDoc}
              emptyLabel="No documents have been attached to this policy yet." />
          </SectionCard>

          {/* "Report a claim" was the first button here until claims were
              paused on 2026-08-19. `open_claims` still comes down on the
              serialiser and is deliberately not rendered — the number is true,
              but there is now no screen it can lead to. */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button className="btn-secondary flex-1"
              onClick={() => navigate(
                `/portal/quotes/new?renewal=${p.id}`)}>
              <Icon.Refresh size={16} /> Ask for a renewal quote
            </button>
          </div>
        </div>
      )}
    </RecordPage>
  );
}
