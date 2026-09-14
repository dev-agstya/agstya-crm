import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { categoriesApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  ErrorState, EmptyState, TableSkeleton, Toggle as UiToggle,
} from "../components/ui";
import { toast } from "../components/Toast";
import { askDelete } from "../lib/deleteGuard";
import { useAuth } from "../store/auth";
import type { CategoryNode } from "../lib/types";

/* ---------------------------------------------------------------- helpers -- */

function countNodes(nodes: CategoryNode[]): number {
  return nodes.reduce((n, c) => n + 1 + countNodes(c.children ?? []), 0);
}

function Toggle({ on, disabled, onClick }: {
  on: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <UiToggle checked={on} disabled={disabled} onChange={onClick}
      label={on ? "Active — click to deactivate"
        : "Inactive — click to activate"} />
  );
}

/* ---------------------------------------------------------- add-type modal -- */

/* ----------------------------------------------------------------- page --- */

export default function PolicyTypesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { has } = useAuth();
  const canManage = has("manage_policy_types");

  const list = useQuery({
    queryKey: ["categories", "all"],
    queryFn: async () => (await categoriesApi.list(true)).data,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
  };

  // Deactivating is a plain update. It used to POST to the DELETE route, which
  // deactivated behind the scenes — a delete that did something else (owner
  // 2026-07-26). DELETE now means delete, and is owner-only + reference-guarded.
  const deactivate = useMutation({
    mutationFn: (id: string) => categoriesApi.update(id, { active: false }),
    onSuccess: () => { toast.success("Policy type deactivated."); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const reactivate = useMutation({
    mutationFn: (id: string) => categoriesApi.update(id, { active: true }),
    onSuccess: () => { toast.success("Policy type activated."); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  // Permanent removal. The server refuses while any policy or rate-card rule
  // still names this type, and says which — so the toast is worth reading.
  const del = useMutation({
    mutationFn: (id: string) => categoriesApi.remove(id),
    onSuccess: () => { toast.success("Policy type deleted."); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div>
      <PageHeader title="Policy Types"
        subtitle="Your policy templates and their nested sub-types. Reward % is set per broker code."
        actions={canManage && (
          <button className="btn-primary" onClick={() => navigate("/insurance/policy-types/new")}>
            <Icon.Plus size={18} /> Add Policy Type
          </button>
        )} />

      <div className="card">
        {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
          <TableSkeleton cols={4} />
        ) : (list.data?.length ?? 0) === 0 ? (
          <EmptyState title="No policy types yet"
            hint="Add your first policy type (e.g. Life, Motor) to get started." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm table-sticky">
              <thead>
                <tr>
                  <th className="px-5 py-3">Policy type</th>
                  <th className="px-5 py-3">Sub-types</th>
                  {canManage && <th className="px-5 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {list.data!.map((c) => (
                  <tr key={c.id} className="border-t border-line-soft hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-800">{c.label}</p>
                      <p className="text-xs text-slate-500">{c.key}</p>
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {countNodes(c.children) === 0
                        ? <span className="text-slate-500">None</span>
                        : `${countNodes(c.children)} sub-type(s)`}
                    </td>
                    {canManage && (
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-3">
                          <Toggle on={c.active}
                            disabled={deactivate.isPending || reactivate.isPending}
                            onClick={() => (c.active
                              ? deactivate.mutate(c.id)
                              : reactivate.mutate(c.id))} />
                          <button className="btn-secondary
                            text-xs" onClick={() => navigate(`/insurance/policy-types/${c.id}`)}>
                            <Icon.Edit size={14} /> Edit
                          </button>
                          {/* Always offered; the links decide. A type nothing
                              has been booked under is a mistake someone should
                              be able to clear up — one with policies against it
                              gets deactivated instead. */}
                          <button className="icon-btn text-money-out" title="Delete"
                            disabled={del.isPending}
                            onClick={async () => {
                              const choice = await askDelete({
                                noun: "policy type", name: c.label,
                                inUse: c.in_use, fallbackLabel: "Deactivate",
                                fallbackHint: "no new policies can be booked "
                                  + "under it, and every existing one carries "
                                  + "on unchanged.",
                              });
                              if (choice === "delete") del.mutate(c.id);
                              if (choice === "fallback" && c.active)
                                deactivate.mutate(c.id);
                            }}>
                            <Icon.Trash size={15} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
