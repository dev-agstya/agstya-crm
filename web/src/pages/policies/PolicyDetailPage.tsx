import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { policiesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import {
  ExpiryChip, PolicyDetailBody,
} from "../../components/PolicyDetailBody";
import { StatusBadge } from "../../components/ui";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { refreshFinance } from "../../lib/live";
import { useAuth } from "../../store/auth";

/**
 * One policy, as a page (this was a dialog until 2026-08-03).
 *
 * Reached from the Policies list, from a customer's Policies tab, and from
 * Renewals — all three used to open their own copy of the same popup, so the
 * URL is now the single way in.
 */
export default function PolicyDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { has, user } = useAuth();
  const isPartner = user?.account_type === "channel_partner";

  const policy = useQuery({
    queryKey: ["policy", id],
    retry: false,
    queryFn: async () => (await policiesApi.get(id)).data,
  });
  const p = policy.data;

  // Deleting a policy reverses its finance, so it is owner-only and guarded
  // server-side as well.
  const canDelete = !isPartner && has("manage_policies");

  const del = useMutation({
    mutationFn: () => policiesApi.remove(id),
    onSuccess: () => {
      toast.success("Policy deleted.");
      qc.invalidateQueries({ queryKey: ["policies"] });
      refreshFinance(qc);
      navigate("/policies");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const missing = isAxiosError(policy.error)
    && policy.error.response?.status === 404;

  return (
    <RecordPage
      backTo="/policies"
      backLabel="Back to policies"
      title={p ? `Policy ${p.policy_number || p.code}` : "Policy"}
      documentTitle={p?.policy_number || p?.code || "Policy"}
      subtitle={p
        ? [p.customer_name, p.insurer_name].filter(Boolean).join(" · ")
        : undefined}
      meta={p && <span className="chip">{p.code}</span>}
      badges={p && (
        <>
          <StatusBadge value={p.status} />
          <ExpiryChip expiry={p.expiry_date} status={p.status} />
        </>
      )}
      loading={policy.isLoading}
      error={missing ? undefined : policy.error}
      onRetry={() => policy.refetch()}
      notFound={missing}
    >
      {p && (
        <div className="card card-body">
          <PolicyDetailBody
            policy={p}
            deleting={del.isPending}
            onDelete={canDelete ? async () => {
              if (await confirmDialog({
                title: "Delete policy?",
                message: `Delete policy ${p.policy_number || p.code}? This `
                  + "removes it and reverses its finance. This cannot be undone.",
                confirmLabel: "Delete policy",
                danger: true,
              })) del.mutate();
            } : undefined}
          />
        </div>
      )}
    </RecordPage>
  );
}
