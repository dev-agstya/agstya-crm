import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit, Key, Plus, Trash2, Users } from "lucide-react";
import { rolesApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { ErrorState } from "../components/shared/ErrorState";
import { CardGridSkeleton } from "../components/shared/LoadingSkeleton";
import { toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export default function MyOrganizationPage() {
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

  return (
    <div>
      <PageHeader
        title="Roles & Permissions"
        subtitle="Reusable permission bundles for staff"
        actions={
          <Button
            size="sm"
            className="h-8"
            onClick={() => navigate("/organization/roles/new")}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            New role
          </Button>
        }
      />

      {roles.isError ? (
        <ErrorState onRetry={() => roles.refetch()} />
      ) : roles.isLoading ? (
        <CardGridSkeleton count={3} />
      ) : (roles.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Key className="h-6 w-6" />}
          title="No roles created yet"
          description="Create permission templates so you can assign access to employees in one click."
          action={
            <Button
              size="sm"
              onClick={() => navigate("/organization/roles/new")}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              New role
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {roles.data!.map((r) => (
            <Card
              key={r.id}
              className="transition-colors hover:border-primary/40"
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-foreground">
                      {r.name}
                    </h3>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {r.member_count}{" "}
                        {r.member_count === 1 ? "member" : "members"}
                      </span>
                      <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                        {r.permissions.length}{" "}
                        {r.permissions.length === 1 ? "perm" : "perms"}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title={`Edit ${r.name}`}
                      onClick={() =>
                        navigate(`/organization/roles/${r.id}/edit`)
                      }
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title={`Delete ${r.name}`}
                      onClick={async () => {
                        if (
                          await confirmDialog({
                            message: `Delete role "${r.name}"?`,
                            danger: true,
                          })
                        )
                          del.mutate(r.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {r.description && (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {r.description}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
