import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rolesApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState, PageLoader } from "../components/ui";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";

// Roles & Permissions: reusable permission bundles.
//
// NOTHING is seeded — the owner asked for roles to be created by hand only, so
// a fresh install starts empty. The create dialog offers editable TEMPLATES
// instead: picking one pre-ticks a sensible set that you adjust before saving,
// and nothing is written until you press Save.
//
// Roles are applied to employees as a bulk-select in the People → Employees
// permission editor; they are not stored on the employee (see PermissionEditor).
export default function MyOrganizationPage() {
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader title="Roles & Permissions" actions={
        <button className="btn-primary" onClick={() => navigate("/organization/roles/new")}>
          <Icon.Plus size={18} /> New Role
        </button>
      } />
      <RolesTab />
    </div>
  );
}

/* ------------------------------------------------------------------ Roles -- */

function RolesTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: async () => (await rolesApi.list()).data,
  });

  const del = useMutation({
    mutationFn: (id: string) => rolesApi.remove(id),
    onSuccess: () => {
      toast.success("Role deleted.");
      qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (roles.isError) return <ErrorState onRetry={() => roles.refetch()} />;
  if (roles.isLoading) return <PageLoader />;

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {roles.data!.map((r) => (
          <div key={r.id} className="card card-body">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-slate-800">{r.name}</h3>
                <p className="text-xs text-slate-500">
                  {r.member_count} {r.member_count === 1 ? "member" : "members"}
                </p>
              </div>
              <div className="flex gap-1">
                <button className="text-slate-500 hover:text-brand-600"
                  title={`Edit ${r.name}`} aria-label={`Edit ${r.name}`}
                  onClick={() => navigate(`/organization/roles/${r.id}/edit`)}><Icon.Edit size={16} /></button>
                <button className="text-slate-300 hover:text-money-out"
                  title={`Delete ${r.name}`} aria-label={`Delete ${r.name}`}
                  onClick={async () => {
                    if (await confirmDialog({ message: `Delete role "${r.name}"?`,
                      danger: true })) del.mutate(r.id);
                  }}><Icon.Trash size={16} /></button>
              </div>
            </div>
            {r.description && (
              <p className="mt-2 text-sm text-slate-500">{r.description}</p>
            )}
            <p className="mt-3 text-xs text-slate-500">
              {r.permissions.length} {r.permissions.length === 1 ? "permission" : "permissions"}
            </p>
          </div>
        ))}
        {roles.data!.length === 0 && (
          <div className="md:col-span-2 xl:col-span-3">
            <EmptyState title="No roles yet"
              hint="Create your first role to grant employees specific access. Start from a template and adjust it — nothing is created until you save." />
          </div>
        )}
      </div>

    </div>
  );
}
