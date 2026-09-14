import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { managersApi, remindersApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { CardSkeleton, Field, Modal, Segmented, StatCard, StatRow } from "./ui";
import { Icon } from "./Icon";
import { DateTimeInput } from "./DateInput";
import { toast } from "./Toast";
import { TargetCard, fmtMetric } from "./TargetProgress";
import { TargetGoalsForm } from "./TargetGoalsForm";
import { PartnerCard } from "./team/PartnerCard";
import { TeamPolicies } from "./team/TeamPolicies";
import {
  DateFilter, periodParams, type PeriodValue,
} from "./finance/DateFilter";
import { formatINR } from "../lib/format";
import { useAuth } from "../store/auth";
import { PartnerRoster } from "../pages/people/PartnerRoster";
import type {
  ManagerRoster, PartnerRosterRow, TargetAllocationRow,
} from "../lib/types";

/**
 * An employee's TEAM — their own number, the channel partners under them, and
 * the business those partners actually wrote.
 *
 * ONE component, two callers:
 *   - the Team tab on an employee's record (any employee, with view_partners)
 *   - the My Team view of /people/partners, for the signed-in employee
 *
 * Both hit the same serialiser server-side, so the owner's view of Rahul and
 * Rahul's own view of himself can never disagree — which is the whole reason
 * they are not two components (owner G6).
 *
 * REBUILT 2026-08-19. The owner's note was that there is nowhere to "see the
 * team of that employee… how is that team performing", which was startling,
 * because this panel existed. That is the finding: a tab nobody can find is a
 * feature nobody has. Two separate problems, both fixed:
 *
 *   FINDING IT — the employee directory now carries a partner count on the row
 *   (`partners_under`), and the Performance league table links straight in
 *   here. Nothing about the old page said a team was behind any given row, so
 *   opening one to check was a gamble you do not take twenty times.
 *
 *   WHAT IS IN IT — it was one screen doing three jobs at once: a target card,
 *   four tiles and a wide table carrying money, targets and attention flags in
 *   the same row. Now it is three VIEWS, because they answer different
 *   questions asked at different times:
 *
 *     Overview  who needs me?           cards, ranked, quiet first
 *     Policies  what did they write?    a ledger of the actual business
 *     Targets   what did I ask for?     the table, built for setting numbers
 *
 * `managerId` omitted means "me".
 */

type View = "overview" | "policies" | "targets";

export function ManagerRosterPanel({ managerId }: { managerId?: string }) {
  const { user } = useAuth();
  const [period, setPeriod] = useState<PeriodValue>({
    period: "current_month" });
  const [view, setView] = useState<View>("overview");
  // Which partner's target is being edited, if any.
  const [editing, setEditing] = useState<PartnerRosterRow | null>(null);
  // Which partner a follow-up is being logged against, if any.
  const [followUp, setFollowUp] = useState<PartnerRosterRow | null>(null);

  const roster = useQuery({
    queryKey: ["managers", "roster", managerId ?? "me", period],
    queryFn: async () => (managerId
      ? await managersApi.partners(managerId, periodParams(period))
      : await managersApi.myPartners(periodParams(period))).data,
  });
  const d = roster.data;
  const rows = d?.rows ?? [];
  // The biggest book on the roster, so each card's bar RANKS rather than
  // measures — a premium figure only means something next to the others.
  const peak = useMemo(
    () => Math.max(1, ...rows.map((r) => r.premium)), [rows]);

  const canSetTargets = !!d?.can_manage_targets;
  // Anyone in-house can create a reminder against a record they can open, so
  // the only gate on "log a follow-up" is being staff at all.
  const canFollowUp = user?.account_type !== "channel_partner";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented<View>
          value={view}
          onChange={setView}
          options={[
            { value: "overview", label: "Overview" },
            { value: "policies", label: "Policies" },
            { value: "targets", label: "Targets" },
          ]} />
        <DateFilter value={period} onChange={setPeriod} />
        {/* The windowed / current split is load-bearing and invisible unless
            it is written down: a partner cannot stop being "quiet" because you
            switched the filter to This month. */}
        <span className="text-xs text-slate-500">
          Policies, premium and targets follow the date filter.{" "}
          Balances and renewals are where things stand right now.
        </span>
      </div>

      {view === "policies" ? (
        <TeamPolicies managerId={managerId} period={period} />
      ) : (
        <>
          {/* The manager's OWN target, first — everything below it is the
              split. */}
          <TargetCard
            title={managerId ? "Their target" : "My target"}
            subtitle={d?.period_label}
            rows={d?.manager_metrics ?? []}
            attainmentPct={d?.manager_attainment_pct ?? 0}
            hasTarget={!!d?.manager_has_target}
            empty="No target has been set for this period."
            footer={d && d.partners > 0 ? (
              <div className="mt-3 border-t border-line/70 pt-3">
                <p className="text-xs text-slate-500">
                  {d.partners_with_target} of {d.partners} channel{" "}
                  {d.partners === 1 ? "partner has" : "partners have"} a target
                  for this period.
                </p>
                <Allocation rows={d.allocation} />
              </div>
            ) : undefined}
          />

          <StatRow>
            <StatCard label="Partners" value={String(d?.partners ?? 0)}
              icon="Users"
              hint={d ? `${d.active_partners} wrote business` : undefined} />
            <StatCard label="Quiet" value={String(d?.quiet_partners ?? 0)}
              icon="Clock" tone={d?.quiet_partners ? "due" : undefined}
              hint="60 days with no policy" />
            <StatCard label="Premium" value={formatINR(d?.premium)}
              icon="Money"
              hint={`${d?.policies ?? 0} ${
                d?.policies === 1 ? "policy" : "policies"}`} />
            <StatCard label="Renewals due" value={String(d?.renewals_due ?? 0)}
              icon="Refresh" tone={d?.renewals_due ? "due" : undefined}
              hint="next 30 days" />
          </StatRow>

          {view === "overview" ? (
            <OverviewGrid
              data={d}
              loading={roster.isLoading}
              error={roster.isError}
              onRetry={() => roster.refetch()}
              peak={peak}
              onSetTarget={canSetTargets ? setEditing : undefined}
              onLogFollowUp={canFollowUp ? setFollowUp : undefined} />
          ) : (
            /* The TABLE is the right rendering for setting numbers: one row
               per person, the ask and the progress side by side, and a Set
               button in a predictable place down a column. Cards are for
               scanning; a column is for working. */
            <PartnerRoster data={d} loading={roster.isLoading}
              error={roster.isError} onRetry={() => roster.refetch()}
              onSetTarget={canSetTargets ? setEditing : undefined} />
          )}
        </>
      )}

      {/* Setting a partner's target, inline. The form is the SAME one the
          Targets page uses (components/TargetGoalsForm) — a second form writing
          targets is a second place to get the paise conversion wrong.

          The MONTH PICKER stays visible rather than being locked to whatever
          the roster is filtered to. Targets are monthly and the filter is not:
          "Last 3 months" or a custom range has no single month a target could
          belong to, so pinning the form to the window's first day would quietly
          set a target for a month nobody chose. It defaults to the current
          month, which is what somebody pressing "Set" almost always wants, and
          the picker says so on screen either way. */}
      <Modal open={!!editing} onClose={() => setEditing(null)}
        title={editing ? `Target — ${editing.partner_name}` : "Target"}
        subtitle="Monthly goals for this channel partner.">
        {editing && (
          <TargetGoalsForm
            assigneeId={editing.partner_id}
            assigneeType="channel_partner"
            assigneeName={editing.partner_name}
            existingMetrics={editing.target_metrics}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)} />
        )}
      </Modal>

      <FollowUpModal partner={followUp} onClose={() => setFollowUp(null)} />
    </div>
  );
}

/* ----------------------------------------------------------- allocation --- */

/**
 * How much of the manager's goal has actually been handed out.
 *
 * The whole point of a team target is dividing your number across your roster —
 * "you have 100 policies, your ten partners get ten each". Both figures were
 * already on this screen and the GAP between them was not, so the one piece of
 * arithmetic that matters had to be done by eye, across ten rows, per metric.
 *
 * Over-allocation is reported, not warned about. A manager who wants headroom
 * deliberately hands out more than they were given; that is a strategy, not a
 * mistake, and flagging it in red would be this screen second-guessing them.
 */
function Allocation({ rows }: { rows?: TargetAllocationRow[] }) {
  if (!rows?.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {rows.map((r) => {
        const gap = r.target_value - r.allocated;
        return (
          <li key={r.metric} className="flex flex-wrap items-baseline gap-x-1.5
            text-xs text-slate-500">
            <span className="font-medium text-slate-700">{r.label}:</span>
            <span>
              {fmtMetric(r.is_money, r.allocated)} of{" "}
              {fmtMetric(r.is_money, r.target_value)} handed out
            </span>
            {gap > 0 ? (
              <span className="font-medium text-due">
                — {fmtMetric(r.is_money, gap)} unallocated
              </span>
            ) : gap < 0 ? (
              <span className="font-medium text-slate-600">
                — {fmtMetric(r.is_money, -gap)} over
              </span>
            ) : (
              <span className="font-medium text-money-in">— fully allocated</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------- overview --- */

function OverviewGrid({
  data, loading, error, onRetry, peak, onSetTarget, onLogFollowUp,
}: {
  data?: ManagerRoster;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  peak: number;
  onSetTarget?: (row: PartnerRosterRow) => void;
  onLogFollowUp?: (row: PartnerRosterRow) => void;
}) {
  // The error branch comes FIRST, before loading and before empty — both of
  // those are claims about data that was actually fetched, and this app is one
  // instance where a cold start after idle is routine.
  if (error) {
    return (
      <div className="card card-body">
        <p className="text-sm text-slate-600">
          This roster could not be loaded.</p>
        <button className="btn-secondary mt-3" onClick={onRetry}>
          <Icon.Refresh size={15} /> Try again
        </button>
      </div>
    );
  }
  if (loading) return <CardSkeleton count={6} />;

  const rows = data?.rows ?? [];
  if (!rows.length) {
    return (
      <div className="card card-body text-center">
        <p className="text-sm font-medium text-slate-700">
          No channel partners yet</p>
        <p className="mt-1 text-sm text-slate-500">
          {data?.can_manage
            ? "Partners are assigned a relationship manager when their account "
              + "is created. Add one from the Channel Partners page."
            : "Nobody has been assigned to this relationship manager."}
        </p>
      </div>
    );
  }

  // Already sorted server-side: quiet first, then biggest book. The page opens
  // on what needs attention, and re-sorting here would be a second opinion
  // about the same question.
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((r) => (
        <PartnerCard key={r.partner_id} row={r} peak={peak}
          onSetTarget={onSetTarget} onLogFollowUp={onLogFollowUp} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ follow-up --- */

/** Tomorrow at 10am, as a value the datetime-local input understands. */
function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Log a call against a partner who needs one.
 *
 * The quiet flag was a dead end: "quiet for 61 days" in amber, with nothing to
 * press. There was no way to record that you had rung them, so the same partner
 * was flagged again tomorrow and the day after, with no memory of any of it —
 * which is how a flag stops being read.
 *
 * A REMINDER, not a new kind of record. `models/reminder` was built generic
 * (lead / customer / policy) precisely so this would not need a new mechanism;
 * "channel_partner" joined that list on 2026-08-19. It rings the bell and it
 * appears in the 08:00 digest, like every other follow-up in the product.
 */
function FollowUpModal({ partner, onClose }: {
  partner: PartnerRosterRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(tomorrowMorning);
  const [saving, setSaving] = useState(false);

  const defaultTitle = partner
    ? (partner.renewals_due > 0
      ? `Chase ${partner.renewals_due} renewal${
        partner.renewals_due === 1 ? "" : "s"} with ${partner.partner_name}`
      : `Call ${partner.partner_name} — quiet${
        partner.days_quiet != null ? ` ${partner.days_quiet} days` : ""}`)
    : "";

  const save = async () => {
    if (!partner) return;
    setSaving(true);
    try {
      await remindersApi.create({
        entity_type: "channel_partner",
        entity_id: partner.partner_id,
        title: (title.trim() || defaultTitle),
        due_at: new Date(due).toISOString(),
      });
      qc.invalidateQueries({ queryKey: ["reminders"] });
      toast.success("Follow-up logged. You will get the reminder when it is due.");
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
    <Modal open={!!partner} onClose={onClose}
      title={partner ? `Follow up — ${partner.partner_name}` : "Follow up"}
      subtitle="Rings your bell and appears in the 08:00 digest.">
      {partner && (
        <div className="space-y-4">
          <Field label="What needs doing">
            <input className="input" value={title} placeholder={defaultTitle}
              onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {/* A due date must be in the FUTURE — the bell only looks forward
              from the moment it runs, so a past date is born overdue with no
              moment left to ring in. The server enforces it; defaulting to
              tomorrow morning means nobody meets that rule by accident. */}
          <Field label="When" hint="Must be in the future.">
            <DateTimeInput value={due} onChange={setDue} />
          </Field>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={saving} onClick={save}>
              <Icon.Clock size={15} /> Log follow-up
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
