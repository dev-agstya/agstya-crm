import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rolesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field } from "../../components/ui";
import { toast } from "../../components/Toast";
import { PermissionEditor } from "../../components/PermissionEditor";
import { expandPermissions } from "../../lib/types";
import type { RoleTemplate } from "../../lib/types";

/** Create (/organization/roles/new) and edit (/organization/roles/:id/edit). */
export default function RoleFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;

  const roles = useQuery({
    queryKey: ["roles"],
    enabled: editing,
    queryFn: async () => (await rolesApi.list()).data,
  });
  const role = roles.data?.find((r) => r.id === id) ?? null;
  const [loaded, setLoaded] = useState(!editing);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [perms, setPerms] = useState<string[]>([]);

  useEffect(() => {
    if (loaded || !role) return;
    setName(role.name);
    setDescription(role.description ?? "");
    setPerms(role.permissions);
    setLoaded(true);
  }, [loaded, role]);

  // Templates come from the backend so this screen can never drift from
  // permissions.py. The GRID itself is <PermissionEditor>, shared with the
  // per-person editor on the people pages: this file used to carry its own
  // copy, which meant two places to get the implication rule and the locked
  // "included" affordance right, and only one of them got the 2026-08-07
  // section layout.
  const catalog = useQuery({
    queryKey: ["permission-catalog"],
    queryFn: async () => (await rolesApi.catalog()).data,
    staleTime: 60 * 60 * 1000,
  });
  const templates: RoleTemplate[] = catalog.data?.templates ?? [];

  const applyTemplate = (t: RoleTemplate) => {
    setPerms(expandPermissions(t.permissions));
    if (!name.trim() && t.key !== "blank") setName(t.name);
    if (!description.trim() && t.key !== "blank") setDescription(t.description);
  };

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: description || null,
                     permissions: expandPermissions(perms) };
      return editing ? rolesApi.update(id!, body) : rolesApi.create(body);
    },
    onSuccess: () => {
      toast.success(editing ? "Role updated." : "Role created.");
      qc.invalidateQueries({ queryKey: ["roles"] });
      navigate("/organization?tab=roles");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <FormPage
      backTo="/organization?tab=roles"
      backLabel="Back to roles"
      title={editing ? `Edit ${role?.name ?? "role"}` : "New role"}
      subtitle="A role is a re-usable set of permissions. Assigning one copies its ticks onto a person; it is not stored on them."
      onSubmit={() => save.mutate()}
      submitLabel="Save role"
      submitting={save.isPending}
      disabled={!name.trim()}
      loading={editing && roles.isLoading}
      notFound={editing && !roles.isLoading && !role}
      wide
    >
      <div className="space-y-5">
        {/* Templates — a starting tick-set, not a saved role. */}
        {!editing && templates.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase text-slate-500">
              Start from
            </p>
            <div className="flex flex-wrap gap-2">
              {templates.map((t) => (
                <button key={t.key} type="button" title={t.description}
                  onClick={() => applyTemplate(t)}
                  className="rounded-control border border-line px-3 py-1.5
                    text-sm text-slate-600 transition-colors
                    hover:border-ink hover:bg-slate-50">
                  {t.name}
                  {t.permissions.length > 0 && (
                    <span className="ml-1.5 text-[10px] text-slate-500">
                      {t.permissions.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              Pre-ticks a suggested set you can edit. Nothing is saved until you
              press Save role.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Role name" required>
            <input className="input" value={name} required
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Finance manager" />
          </Field>
          <Field label="Description">
            <input className="input" value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for" />
          </Field>
        </div>

        {/* A role is a template, so there is no actor to limit it: the
            no-elevation rule is enforced server-side on save (roles.py
            _check_no_elevation), which is where it can actually be trusted. */}
        <PermissionEditor
          perms={perms}
          onPermsChange={setPerms}
          roles={[]}
          canGrant={() => true}
        />
      </div>
    </FormPage>
  );
}
