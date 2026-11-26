import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, RefreshCw } from "lucide-react";
import { managersApi, remindersApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { CardGridSkeleton } from "./shared/LoadingSkeleton";
import { FormField } from "./shared/FormSection";
import { DateTimeInput } from "./DateInput";
import { toast } from "./Toast";
import { TargetCard, fmtMetric } from "./TargetProgress";
import { TargetGoalsForm } from "./TargetGoalsForm";
import { PartnerCard } from "./team/PartnerCard";
import { TeamPolicies } from "./team/TeamPolicies";
import {
  DateFilter,
  periodParams,
  type PeriodValue,
} from "./finance/DateFilter";
import { formatINR } from "../lib/format";
import { useAuth } from "../store/auth";
import { PartnerRoster } from "../pages/people/PartnerRoster";
import type {
  ManagerRoster,
  PartnerRosterRow,
  TargetAllocationRow,
} from "../lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "overview" | "policies" | "targets";

export function ManagerRosterPanel({ managerId }: { managerId?: string }) {
  const { user } = useAuth();
  const [period, setPeriod] = useState<PeriodValue>({
    period: "current_month",
  });
  const [view, setView] = useState<View>("overview");
  const [editing, setEditing] = useState<PartnerRosterRow | null>(null);
  const [followUp, setFollowUp] = useState<PartnerRosterRow | null>(null);

  const roster = useQuery({
    queryKey: ["managers", "roster", managerId ?? "me", period],
    queryFn: async () =>
      (managerId
        ? await managersApi.partners(managerId, periodParams(period))
        : await managersApi.myPartners(periodParams(period))
      ).data,
  });
  const d = roster.data;
  const rows = d?.rows ?? [];
  const peak = useMemo(() => Math.max(1, ...rows.map((r) => r.premium)), [rows]);

  const canSetTargets = !!d?.can_manage_targets;
  const canFollowUp = user?.account_type !== "channel_partner";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList className="h-8">
            <TabsTrigger value="overview" className="text-xs">
              Overview
            </TabsTrigger>
            <TabsTrigger value="policies" className="text-xs">
              Policies
            </TabsTrigger>
            <TabsTrigger value="targets" className="text-xs">
              Targets
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <DateFilter value={period} onChange={setPeriod} />
        <span className="text-xs text-muted-foreground">
          Policies, premium and targets follow the date filter. Balances and
          renewals are where things stand right now.
        </span>
      </div>

      {view === "policies" ? (
        <TeamPolicies managerId={managerId} period={period} />
      ) : (
        <>
          <TargetCard
            title={managerId ? "Their target" : "My target"}
            subtitle={d?.period_label}
            rows={d?.manager_metrics ?? []}
            attainmentPct={d?.manager_attainment_pct ?? 0}
            hasTarget={!!d?.manager_has_target}
            empty="No target has been set for this period."
            footer={
              d && d.partners > 0 ? (
                <div className="mt-3 border-t border-border/70 pt-3">
                  <p className="text-xs text-muted-foreground">
                    {d.partners_with_target} of {d.partners} channel{" "}
                    {d.partners === 1 ? "partner has" : "partners have"} a
                    target for this period.
                  </p>
                  <Allocation rows={d.allocation} />
                </div>
              ) : undefined
            }
          />

          <div className="grid grid-cols-2 divide-y divide-border rounded-lg border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-y-0">
            <div className="px-3.5 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Partners
              </p>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="text-lg font-semibold tabular-nums text-foreground">
                  {d?.partners ?? 0}
                </span>
                {d && (
                  <span className="text-[11px] font-normal text-muted-foreground">
                    {d.active_partners} wrote business
                  </span>
                )}
              </div>
            </div>
            <div className="px-3.5 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Quiet
              </p>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span
                  className={`text-lg font-semibold tabular-nums ${
                    d?.quiet_partners ? "text-amber-700" : "text-foreground"
                  }`}
                >
                  {d?.quiet_partners ?? 0}
                </span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  60d no policy
                </span>
              </div>
            </div>
            <div className="px-3.5 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Premium
              </p>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="text-lg font-semibold tabular-nums text-foreground">
                  {formatINR(d?.premium)}
                </span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  {d?.policies ?? 0}{" "}
                  {d?.policies === 1 ? "policy" : "policies"}
                </span>
              </div>
            </div>
            <div className="px-3.5 py-2.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Renewals due
              </p>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span
                  className={`text-lg font-semibold tabular-nums ${
                    d?.renewals_due ? "text-amber-700" : "text-foreground"
                  }`}
                >
                  {d?.renewals_due ?? 0}
                </span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  next 30 days
                </span>
              </div>
            </div>
          </div>

          {view === "overview" ? (
            <OverviewGrid
              data={d}
              loading={roster.isLoading}
              error={roster.isError}
              onRetry={() => roster.refetch()}
              peak={peak}
              onSetTarget={canSetTargets ? setEditing : undefined}
              onLogFollowUp={canFollowUp ? setFollowUp : undefined}
            />
          ) : (
            <PartnerRoster
              data={d}
              loading={roster.isLoading}
              error={roster.isError}
              onRetry={() => roster.refetch()}
              onSetTarget={canSetTargets ? setEditing : undefined}
            />
          )}
        </>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Target — ${editing.partner_name}` : "Target"}
            </DialogTitle>
            <DialogDescription>
              Monthly goals for this channel partner.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <TargetGoalsForm
              assigneeId={editing.partner_id}
              assigneeType="channel_partner"
              assigneeName={editing.partner_name}
              existingMetrics={editing.target_metrics}
              onDone={() => setEditing(null)}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <FollowUpModal partner={followUp} onClose={() => setFollowUp(null)} />
    </div>
  );
}

function Allocation({ rows }: { rows?: TargetAllocationRow[] }) {
  if (!rows?.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {rows.map((r) => {
        const gap = r.target_value - r.allocated;
        return (
          <li
            key={r.metric}
            className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground"
          >
            <span className="font-medium text-foreground">{r.label}:</span>
            <span>
              {fmtMetric(r.is_money, r.allocated)} of{" "}
              {fmtMetric(r.is_money, r.target_value)} handed out
            </span>
            {gap > 0 ? (
              <span className="font-medium text-amber-700">
                — {fmtMetric(r.is_money, gap)} unallocated
              </span>
            ) : gap < 0 ? (
              <span className="font-medium text-foreground">
                — {fmtMetric(r.is_money, -gap)} over
              </span>
            ) : (
              <span className="font-medium text-emerald-700">
                — fully allocated
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function OverviewGrid({
  data,
  loading,
  error,
  onRetry,
  peak,
  onSetTarget,
  onLogFollowUp,
}: {
  data?: ManagerRoster;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  peak: number;
  onSetTarget?: (row: PartnerRosterRow) => void;
  onLogFollowUp?: (row: PartnerRosterRow) => void;
}) {
  if (error) {
    return (
      <Card className="p-4">
        <p className="text-xs text-muted-foreground">
          This roster could not be loaded.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2.5"
          onClick={onRetry}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
        </Button>
      </Card>
    );
  }
  if (loading) return <CardGridSkeleton count={6} />;

  const rows = data?.rows ?? [];
  if (!rows.length) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm font-medium text-foreground">
          No channel partners yet
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {data?.can_manage
            ? "Partners are assigned a relationship manager when their account is created. Add one from the Channel Partners page."
            : "Nobody has been assigned to this relationship manager."}
        </p>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((r) => (
        <PartnerCard
          key={r.partner_id}
          row={r}
          peak={peak}
          onSetTarget={onSetTarget}
          onLogFollowUp={onLogFollowUp}
        />
      ))}
    </div>
  );
}

function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function FollowUpModal({
  partner,
  onClose,
}: {
  partner: PartnerRosterRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(tomorrowMorning);
  const [saving, setSaving] = useState(false);

  const defaultTitle = partner
    ? partner.renewals_due > 0
      ? `Chase ${partner.renewals_due} renewal${
          partner.renewals_due === 1 ? "" : "s"
        } with ${partner.partner_name}`
      : `Call ${partner.partner_name} — quiet${
          partner.days_quiet != null ? ` ${partner.days_quiet} days` : ""
        }`
    : "";

  const save = async () => {
    if (!partner) return;
    setSaving(true);
    try {
      await remindersApi.create({
        entity_type: "channel_partner",
        entity_id: partner.partner_id,
        title: title.trim() || defaultTitle,
        due_at: new Date(due).toISOString(),
      });
      qc.invalidateQueries({ queryKey: ["reminders"] });
      toast.success(
        "Follow-up logged. You will get the reminder when it is due."
      );
      setTitle("");
      setDue(tomorrowMorning());
      onClose();
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!partner} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {partner ? `Follow up — ${partner.partner_name}` : "Follow up"}
          </DialogTitle>
          <DialogDescription>
            Rings your bell and appears in the 08:00 digest.
          </DialogDescription>
        </DialogHeader>
        {partner && (
          <div className="space-y-3 py-1">
            <FormField label="What needs doing">
              <Input
                value={title}
                placeholder={defaultTitle}
                onChange={(e) => setTitle(e.target.value)}
              />
            </FormField>
            <FormField label="When" hint="Must be in the future.">
              <DateTimeInput value={due} onChange={setDue} />
            </FormField>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving}
            onClick={save}
          >
            <Clock className="mr-1.5 h-3.5 w-3.5" /> Log follow-up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
