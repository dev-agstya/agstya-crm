import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rolesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { toast } from "../../components/Toast";
import { PermissionEditor } from "../../components/PermissionEditor";
import { expandPermissions } from "../../lib/types";
import type { RoleTemplate } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      const body = {
        name,
        description: description || null,
        permissions: expandPermissions(perms),
      };
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
      subtitle="A role is a re-usable set of permissions. Assigning one copies its ticks onto a person."
      onSubmit={() => save.mutate()}
      submitLabel="Save role"
      submitting={save.isPending}
      disabled={!name.trim()}
      loading={editing && roles.isLoading}
      notFound={editing && !roles.isLoading && !role}
      wide
    >
      <div className="space-y-4">
        {!editing && templates.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Start from
            </p>
            <div className="flex flex-wrap gap-1.5">
              {templates.map((t) => (
                <Button
                  key={t.key}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  title={t.description}
                  onClick={() => applyTemplate(t)}
                >
                  {t.name}
                  {t.permissions.length > 0 && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                      {t.permissions.length}
                    </span>
                  )}
                </Button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Pre-ticks a suggested set you can edit. Nothing is saved until you
              press Save role.
            </p>
          </div>
        )}

        <div className="grid gap-3.5 sm:grid-cols-2">
          <FormField label="Role name" required>
            <Input
              value={name}
              required
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Finance manager"
            />
          </FormField>
          <FormField label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for"
            />
          </FormField>
        </div>

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
