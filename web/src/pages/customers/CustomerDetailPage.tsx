import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { customersApi, documentsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage, RecordTabs } from "../../components/RecordPage";
import { CustomerDocuments } from "./CustomerDocuments";
import { Icon } from "../../components/Icon";
import { ErrorState, DetailItem, StatusBadge } from "../../components/ui";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatINR, maskTail, pctText } from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import { askDelete } from "../../lib/deleteGuard";
import { useAuth } from "../../store/auth";
import type { Policy } from "../../lib/types";

const TABS = [
  { value: "details", label: "Details" },
  { value: "analytics", label: "Analytics" },
  { value: "policies", label: "Policies" },
  { value: "documents", label: "Documents" },
];

/** One customer, as a page. The tab lives in the URL so it survives a refresh
 *  and can be linked to. */
export default function CustomerDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { has } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "details";

  const customer = useQuery({
    queryKey: ["customer", id],
    retry: false,
    queryFn: async () => (await customersApi.get(id)).data,
  });
  const c = customer.data;

  const policies = useQuery({
    queryKey: ["customer-policies", id],
    enabled: !!c,
    queryFn: async () => (await customersApi.policies(id)).data,
  });
  const stats = useQuery({
    queryKey: ["customer-stats", id],
    enabled: !!c,
    queryFn: async () => (await customersApi.stats(id)).data,
  });
  const docs = useQuery({
    queryKey: ["customer-docs", id],
    enabled: !!c,
    queryFn: async () => (await documentsApi.listFor("customer", id)).data,
  });

  const afterChange = () => {
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["customer", id] });
    refreshFinance(qc);
  };

  const archive = useMutation({
    mutationFn: (v: boolean) => customersApi.setArchive(id, v),
    onSuccess: (_r, v) => {
      toast.success(v ? "Customer archived." : "Customer unarchived.");
      afterChange();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Permanent removal. The server refuses while a policy or ledger row names
  // them, and its message says which — worth surfacing verbatim.
  const remove = useMutation({
    mutationFn: () => customersApi.remove(id),
    onSuccess: () => {
      toast.success("Customer deleted.");
      qc.invalidateQueries({ queryKey: ["customers"] });
      refreshFinance(qc);
      navigate("/customers");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canEdit = !!c?.can_edit && has("manage_customers");
  const missing = isAxiosError(customer.error)
    && customer.error.response?.status === 404;

  // Active policies first, then the rest (owner 2026-07-17).
  const sortedPolicies = [...(policies.data ?? [])].sort((a, b) => {
    const rank = (p: Policy) => (p.status === "active" ? 0
      : p.status === "renewal_due" ? 1 : 2);
    return rank(a) - rank(b);
  });

  return (
    <RecordPage
      backTo="/customers"
      backLabel="Back to customers"
      title={c?.name ?? "Customer"}
      subtitle={c ? `Added by ${c.created_by_name || "—"}` : undefined}
      meta={c && <span className="chip">{c.code}</span>}
      badges={c?.is_archived && (
        <span className="badge bg-due/10 text-due ring-1 ring-inset
          ring-due/20">Archived</span>
      )}
      loading={customer.isLoading}
      error={missing ? undefined : customer.error}
      onRetry={() => customer.refetch()}
      notFound={missing}
      actions={canEdit && c && (
        <>
          <button className="btn-secondary"
            onClick={() => navigate(`/customers/${id}/edit`)}>
            <Icon.Edit size={15} /> Edit
          </button>
          <button className="btn-secondary" disabled={archive.isPending}
            onClick={async () => {
              const next = !c.is_archived;
              if (next && !(await confirmDialog({
                title: "Archive customer?",
                message: `Archive "${c.name}"? They'll be hidden from lists but `
                  + "all policies and finance history are kept.",
                confirmLabel: "Archive", danger: true }))) return;
              archive.mutate(next);
            }}>
            <Icon.Archive size={15} />
            {c.is_archived ? "Unarchive" : "Archive"}
          </button>
          {/* Delete is always offered — the LINKS decide (owner 2026-07-26).
              A customer with a policy or any money against them is
              load-bearing for finance and gets archived instead; anyone else
              was added by mistake and can go, documents included. */}
          <button className="btn-danger-soft" disabled={remove.isPending}
            onClick={async () => {
              const choice = await askDelete({
                noun: "customer", name: c.name,
                inUse: c.in_use !== false,
                fallbackLabel: "Archive",
                fallbackHint: "they're hidden from lists while every policy, "
                  + "payment and statement stays exactly as it is — and "
                  + "re-adding the same mobile number brings them back.",
              });
              if (choice === "delete") remove.mutate();
              if (choice === "fallback" && !c.is_archived) archive.mutate(true);
            }}>
            <Icon.Trash size={15} /> Delete
          </button>
        </>
      )}
    >
      {c && (
        <div className="card">
          <RecordTabs
            tabs={TABS.map((t) => t.value === "policies"
              ? { ...t, count: sortedPolicies.length } : t)}
            value={tab}
            onChange={(v) => setSp(v === "details" ? {} : { tab: v },
              { replace: true })}
          />

          <div className="px-5 py-5">
            {tab === "details" && (
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2
                lg:grid-cols-3">
                <DetailItem label="Mobile" value={c.mobile || "—"} />
                <DetailItem label="Email" value={c.email || "—"} />
                <DetailItem label="Added by"
                  value={c.created_by_name || "—"} />
                <DetailItem className="sm:col-span-2 lg:col-span-3"
                  label="Notes" value={c.notes || "—"} />
              </div>
            )}

            {tab === "analytics" && (
              <dl className="divide-y divide-line/70 rounded-control border
                border-line">
                <AnalyticsRow label="Policies"
                  value={`${stats.data?.active_policies ?? 0} active / ${
                    stats.data?.total_policies ?? 0} total`} />
                <AnalyticsRow label="Source" value={stats.data?.source ?? "—"} />
                <AnalyticsRow label="Renewal rate"
                  value={pctText(stats.data?.renewal_rate)} />
                {/* No `?? 0`: an unfetched figure is an em-dash, not ₹0. */}
                <AnalyticsRow label="Total premium"
                  value={formatINR(stats.data?.total_premium)} />
                {stats.data?.can_view_profit && (
                  <AnalyticsRow label="Profit contribution" accent
                    value={formatINR(stats.data?.profit_contribution)} />
                )}
              </dl>
            )}

            {tab === "policies" && (
              policies.isError ? <ErrorState onRetry={() => policies.refetch()} /> : policies.isLoading ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : sortedPolicies.length === 0 ? (
                <p className="rounded-control border border-dashed border-line
                  px-4 py-5 text-center text-sm text-slate-500">
                  No policies for this customer yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {sortedPolicies.map((p) => (
                    <button key={p.id}
                      className="flex w-full items-center gap-3 rounded-control
                        border border-line p-3 text-left transition-colors
                        hover:border-slate-300 hover:bg-slate-50"
                      onClick={() => navigate(`/policies/${p.id}`)}>
                      <span className="flex h-9 w-9 shrink-0 items-center
                        justify-center rounded-control bg-slate-100
                        text-slate-500">
                        <Icon.Policy size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-sm font-semibold
                          text-slate-900">
                          {maskTail(p.policy_number || p.code)}</p>
                        <p className="truncate text-xs text-slate-500">
                          {p.insurer_name || "—"}
                          <span className="mx-1 text-slate-300">·</span>
                          <span className="capitalize">{p.category_key}</span>
                        </p>
                      </div>
                      <StatusBadge value={p.status} />
                      <Icon.ChevronRight size={16} className="text-slate-300" />
                    </button>
                  ))}
                </div>
              )
            )}

            {tab === "documents" && (
              <CustomerDocuments
                customerId={id}
                docs={docs.data ?? []}
                canEdit={canEdit}
                loading={docs.isLoading}
                onChanged={() =>
                  qc.invalidateQueries({ queryKey: ["customer-docs", id] })}
              />
            )}
          </div>
        </div>
      )}
    </RecordPage>
  );
}

function AnalyticsRow({ label, value, accent }: {
  label: string; value: string; accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className={`text-sm font-semibold tabular-nums ${
        accent ? "text-money-in" : "text-slate-900"}`}>{value}</dd>
    </div>
  );
}
