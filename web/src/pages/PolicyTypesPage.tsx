import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit, Plus, Trash2 } from "lucide-react";
import { categoriesApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { DataTable, Column } from "../components/shared/DataTable";
import { toast } from "../components/Toast";
import { askDelete } from "../lib/deleteGuard";
import { useAuth } from "../store/auth";
import type { CategoryNode, PolicyCategory } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

function countNodes(nodes: CategoryNode[]): number {
  return nodes.reduce((n, c) => n + 1 + countNodes(c.children ?? []), 0);
}

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

  const deactivate = useMutation({
    mutationFn: (id: string) => categoriesApi.update(id, { active: false }),
    onSuccess: () => {
      toast.success("Policy type deactivated.");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const reactivate = useMutation({
    mutationFn: (id: string) => categoriesApi.update(id, { active: true }),
    onSuccess: () => {
      toast.success("Policy type activated.");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => categoriesApi.remove(id),
    onSuccess: () => {
      toast.success("Policy type deleted.");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const columns: Column<PolicyCategory>[] = [
    {
      key: "label",
      header: "Policy Type",
      cell: (c) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{c.label}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {c.key}
          </span>
        </div>
      ),
    },
    {
      key: "subtypes",
      header: "Sub-types",
      cell: (c) => {
        const cnt = countNodes(c.children);
        return cnt === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <Badge variant="secondary" className="h-5 px-2 text-[11px] font-medium">
            {cnt}
          </Badge>
        );
      },
    },
    {
      key: "fields",
      header: "Custom Fields",
      cell: (c) => {
        const n = c.custom_fields?.length ?? 0;
        return n === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="text-xs font-medium tabular-nums text-foreground">
            {n}
          </span>
        );
      },
    },
    ...(canManage
      ? [
          {
            key: "active",
            header: "Active",
            cell: (c: PolicyCategory) => (
              <div onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={c.active}
                  disabled={deactivate.isPending || reactivate.isPending}
                  onCheckedChange={() =>
                    c.active ? deactivate.mutate(c.id) : reactivate.mutate(c.id)
                  }
                  aria-label={`Toggle ${c.label} active status`}
                />
              </div>
            ),
          },
          {
            key: "actions",
            header: "Actions",
            align: "right" as const,
            mobileLabel: false as const,
            cell: (c: PolicyCategory) => (
              <div
                className="flex items-center justify-end gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/insurance/policy-types/${c.id}`)}
                >
                  <Edit className="mr-1.5 h-3.5 w-3.5" />
                  Manage
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive"
                  disabled={del.isPending}
                  onClick={async () => {
                    const choice = await askDelete({
                      noun: "policy type",
                      name: c.label,
                      inUse: c.in_use,
                      fallbackLabel: "Deactivate",
                      fallbackHint:
                        "no new policies can be booked under it, and existing ones stay intact.",
                    });
                    if (choice === "delete") del.mutate(c.id);
                    if (choice === "fallback" && c.active)
                      deactivate.mutate(c.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        title="Policy Types"
        subtitle="Insurance categories & booking fields"
        info="Manage insurance categories, sub-type trees, custom fields, and booking field order."
        actions={
          canManage && (
            <Button
              size="sm"
              className="h-8"
              onClick={() => navigate("/insurance/policy-types/new")}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add policy type
            </Button>
          )
        }
      />

      <DataTable
        data={list.data ?? []}
        columns={columns}
        keyField={(c) => c.id}
        onRowClick={
          canManage
            ? (c) => navigate(`/insurance/policy-types/${c.id}`)
            : undefined
        }
        loading={list.isLoading}
        error={list.isError ? "Could not load policy types." : null}
        onRetry={() => list.refetch()}
        emptyTitle="No policy types yet"
        emptyDescription="Add your first policy type (e.g. Motor, Health, Life) to get started."
        emptyAction={
          canManage ? (
            <Button onClick={() => navigate("/insurance/policy-types/new")}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add policy type
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
