import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { targetsApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { Edit, Plus, Target as TargetIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState, EmptyState, PageLoader } from "./ui";
import { MetricBars, TargetRing, toneFor } from "./TargetProgress";
import { TargetGoalsForm } from "./TargetGoalsForm";
import { toast } from "./Toast";
import { confirmDialog } from "./Confirm";
import { refreshFinance } from "../lib/live";
import { useAuth } from "../store/auth";
import type { Target, UserRow } from "../lib/types";

// Manage one person's performance targets. Opened from the People lists.
//
// A target carries SEVERAL metrics at once (owner, 2026-07-26): "15 policies
// and ₹2,500 house profit for July" is one target set in one go, not two
// separate ones. Leave a field blank for no goal on that metric.
//
// The period is picked as a MONTH, not a free start date — that is what stopped
// a "July" target from silently covering only 26-31 July.
/**
 * The targets for one person — set, edit and delete the periods.
 *
 * Rendered inside a RecordPage (pages/people/PersonTargetsPage), which owns the
 * heading and the link back to the person. It was a dialog until 2026-08-03.
 *
 * The FORM is components/TargetGoalsForm, shared with the Targets page roster
 * and the inline editor on an employee's Team tab (2026-08-06) — the paise
 * conversion, the "blank is not zero" rule and the house-profit carry-through
 * live in one place, not three.
 */
export function TargetsBody({ user }: { user: UserRow }) {
  const qc = useQueryClient();
  const { has, user: me } = useAuth();
  // A relationship manager may set their OWN partners' targets without
  // manage_targets (owner F1). The server is the enforcement
  // (routers/targets._may_assign); this decides whether to draw the button.
  const canManage = has("manage_targets")
    || (user.account_type === "channel_partner"
      && !!me?.id && user.relationship_manager_id === me.id);
  const [editing, setEditing] = useState<Target | "new" | null>(null);

  const targets = useQuery({
    queryKey: ["targets", user.id],
    queryFn: async () => (await targetsApi.list(user.id)).data,
  });

  const del = useMutation({
    mutationFn: (id: string) => targetsApi.remove(id),
    onSuccess: () => {
      toast.success("Target deleted.");
      qc.invalidateQueries({ queryKey: ["targets"] });
      qc.invalidateQueries({ queryKey: ["managers"] });
      refreshFinance(qc); // targets drive the dashboard/overview graphs
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const rows = targets.data ?? [];

  const remove = async (t: Target) => {
    if (await confirmDialog({
      message: `Delete the ${t.period_label} target?`, danger: true,
    })) del.mutate(t.id);
  };

  if (editing) {
    return (
      <TargetGoalsForm
        assigneeId={user.id}
        assigneeType={user.account_type}
        assigneeName={user.full_name}
        assigneeCode={user.code}
        target={editing === "new" ? null : editing}
        onDone={() => setEditing(null)}
        onCancel={() => setEditing(null)}
        onDelete={editing !== "new"
          ? () => { const t = editing; setEditing(null); remove(t); }
          : undefined} />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {rows.length} {rows.length === 1 ? "month" : "months"} set
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Set target
          </Button>
        )}
      </div>

      {targets.isError ? <ErrorState onRetry={() => targets.refetch()} />
        : targets.isLoading ? <PageLoader />
          : rows.length === 0 ? (
            <EmptyState title="No targets yet"
              icon={<TargetIcon className="h-5 w-5" />}
              hint={canManage
                ? "Set a target to start tracking performance. You can give several numbers — policies, premium, profit — in one go."
                : "No targets have been set for this person."}
              action={canManage ? (
                <Button size="sm" onClick={() => setEditing("new")}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Set the first target
                </Button>
              ) : undefined} />
          ) : (
            <div className="space-y-2.5">
              {rows.map((t) => (
                <TargetRow key={t.id} t={t} canManage={canManage}
                  onEdit={() => setEditing(t)}
                  onDelete={() => remove(t)} />
              ))}
            </div>
          )}
    </div>
  );
}

function TargetRow({ t, canManage, onEdit, onDelete }: {
  t: Target; canManage: boolean; onEdit: () => void; onDelete: () => void;
}) {
  const done = toneFor(t.attainment_pct) === "done";
  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <TargetRing pct={t.attainment_pct} size={56} stroke={5} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-800">{t.period_label}</p>
              <p className="text-xs text-slate-500">
                {done ? "Target achieved" : `${t.metrics.length} `
                  + `${t.metrics.length === 1 ? "goal" : "goals"} set`}
              </p>
            </div>
            {canManage && (
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit" onClick={onEdit}>
                  <Edit className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600 hover:bg-red-50 hover:text-red-700" title="Delete"
                  onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            )}
          </div>

          <div className="mt-3">
            <MetricBars rows={t.metrics} compact />
          </div>
        </div>
      </div>
    </Card>
  );
}
