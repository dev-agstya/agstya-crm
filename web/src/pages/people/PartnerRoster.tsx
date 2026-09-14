import { Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/Icon";
import {
  ErrorState, EmptyState, GroupHeader, Meter, PersonCell, TableSkeleton,
} from "../../components/ui";
import { AttainmentPct, toneFor } from "../../components/TargetProgress";
import { formatDate, formatINR } from "../../lib/format";
import type { ManagerRoster, PartnerRosterRow } from "../../lib/types";

/*
  One relationship manager's channel partners.

  Shared by BOTH the employee's own "My Team" view and the owner opening an
  employee's Team tab, because they are the same question asked by two people —
  and a roster that reads differently depending on who is looking is a roster
  somebody will argue with.

  Nothing here is a visibility boundary. Every in-house user can still open every
  policy and customer in the app; this list is filtered because it is a roster,
  not because the rest is forbidden.

  REBUILT 2026-08-05. It was eight columns wide, with a count and a money figure
  crammed into single cells joined by a "·", and every row weighted the same —
  so the one partner you needed to ring looked exactly like the eleven you
  didn't. Now:

    * rows are GROUPED, and the group that needs a phone call is first;
    * each row has ONE hero figure (their premium) with a share bar, not six
      equal numbers;
    * the partner is a person — initials, name, code — not a string of grey text.

  EXTENDED 2026-08-06 with the TARGET the partner was given. It is a column, not
  a footnote: the manager divided their own goal to produce these numbers, and a
  roster that cannot show whether anybody is keeping to them is a roster that
  cannot answer the question it was opened for.
*/

/** Which bucket a partner falls into. Order here is the order on screen. */
type Bucket = "attention" | "active" | "dormant";

function bucketOf(r: PartnerRosterRow): Bucket {
  if (!r.active_account) return "dormant";
  // Renewals are somebody else's money walking out of the door, a partner who
  // has gone quiet stops being a partner unless someone notices, and one who is
  // badly behind on a number they were given is the third way this list earns a
  // phone call.
  if (r.renewals_due > 0 || r.is_quiet) return "attention";
  if (r.has_target && r.attainment_pct < 50) return "attention";
  return "active";
}

const BUCKET_LABEL: Record<Bucket, string> = {
  attention: "Needs a call",
  active: "Active",
  dormant: "Inactive accounts",
};

const BAR_TONE: Record<ReturnType<typeof toneFor>, string> = {
  done: "bg-money-in",
  close: "bg-due",
  behind: "bg-slate-400",
};

/** The target cell: the ask, the progress, and a way to change it. */
function TargetCell({ r, onSetTarget }: {
  r: PartnerRosterRow;
  onSetTarget?: (row: PartnerRosterRow) => void;
}) {
  if (!r.has_target) {
    return (
      <div className="ml-auto w-32 text-right">
        <p className="text-sm text-slate-500">No target</p>
        {onSetTarget && (
          <button className="btn-secondary btn-sm mt-1.5"
            onClick={(e) => { e.stopPropagation(); onSetTarget(r); }}>
            <Icon.Target size={13} /> Set
          </button>
        )}
      </div>
    );
  }
  const tone = toneFor(r.attainment_pct);
  return (
    <div className="ml-auto w-32 text-right">
      <AttainmentPct pct={r.attainment_pct} />
      <span className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full
        bg-slate-100">
        <span className={`block h-full rounded-full ${BAR_TONE[tone]}
          transition-[width] duration-700`}
          style={{ width: `${Math.min(
            100, Math.max(2, r.attainment_pct))}%` }} />
      </span>
      {/* The goals themselves, smallest possible: "10 policies · ₹5,00,000".
          Two lines maximum — this is a column, not a report. */}
      <p className="mt-1 truncate text-xs text-slate-500"
        title={r.target_metrics.map((m) => `${m.label}: ${
          m.is_money ? formatINR(m.target_value) : m.target_value}`).join(" · ")}>
        {r.target_metrics.slice(0, 2).map((m) => (
          m.is_money ? formatINR(m.target_value) : `${m.target_value} ${
            m.label.toLowerCase()}`
        )).join(" · ")}
      </p>
      {onSetTarget && (
        <button className="mt-1 text-xs font-medium text-slate-500
          underline-offset-2 hover:text-slate-900 hover:underline"
          onClick={(e) => { e.stopPropagation(); onSetTarget(r); }}>
          Change
        </button>
      )}
    </div>
  );
}

export function PartnerRoster({
  data, loading, error = false, onRetry, onSetTarget,
}: {
  data?: ManagerRoster;
  loading: boolean;
  /** The request failed — never let that render as "no partners yet". */
  error?: boolean;
  onRetry?: () => void;
  /** Omitted when the viewer may not assign targets on this roster. */
  onSetTarget?: (row: PartnerRosterRow) => void;
}) {
  const navigate = useNavigate();
  const rows = data?.rows ?? [];

  if (error) {
    return <div className="card"><ErrorState onRetry={onRetry} /></div>;
  }
  if (loading) {
    return <div className="card overflow-hidden"><TableSkeleton cols={6} /></div>;
  }

  if (!rows.length) {
    return (
      <div className="card">
        <EmptyState
          icon={<Icon.UserPlus size={20} />}
          title="No channel partners yet"
          hint={data?.can_manage
            ? "Partners are assigned a relationship manager when their account "
              + "is created. Add one from the Channel Partners page."
            : "Nobody has been assigned to this relationship manager."}
        />
      </div>
    );
  }

  // The biggest book on the page, so each row's bar is drawn relative to the
  // best performer rather than to an absolute scale that means nothing.
  const peak = Math.max(...rows.map((r) => r.premium), 1);

  const groups = (["attention", "active", "dormant"] as Bucket[])
    .map((b) => ({ bucket: b, items: rows.filter((r) => bucketOf(r) === b) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-sticky">
          <thead>
            <tr>
              <th>Channel partner</th>
              <th className="num">Target</th>
              <th className="num">Their book</th>
              <th className="num">Balance</th>
              <th>Attention</th>
              <th />
            </tr>
          </thead>
          {groups.map((g) => (
            <Fragment key={g.bucket}>
              <tbody>
                <tr>
                  <td colSpan={6} className="!border-b-0 !p-0">
                    <GroupHeader label={BUCKET_LABEL[g.bucket]}
                      count={g.items.length}
                      tone={g.bucket === "attention" ? "due"
                        : g.bucket === "dormant" ? "muted" : undefined} />
                  </td>
                </tr>
              </tbody>
              <tbody>
                {g.items.map((r) => (
                  // The whole row opens the partner's own record — the detailed
                  // view of everything this summary abbreviates (owner G5).
                  <tr key={r.partner_id} className="row-link"
                    title={`Open ${r.partner_name}`}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") navigate(`/people/partners/${r.partner_id}`);
                    }}
                    onClick={() =>
                      navigate(`/people/partners/${r.partner_id}`)}>
                    <td className={g.bucket === "attention" ? "rail-due" : ""}>
                      <PersonCell
                        name={r.partner_name}
                        sub={`${r.partner_code}${r.mobile ? ` · ${r.mobile}` : ""}`}
                        badges={
                          <>
                            {r.is_quiet && (
                              <span className="badge bg-due/10 text-due">
                                quiet</span>
                            )}
                            {!r.active_account && (
                              <span className="badge bg-slate-100
                                text-slate-600">inactive</span>
                            )}
                          </>
                        }
                      />
                    </td>

                    {/* What they were asked for, and how far along. */}
                    <td className="num">
                      <TargetCell r={r} onSetTarget={onSetTarget} />
                    </td>

                    {/* ONE hero figure per row. The bar ranks it against the
                        best book on the page — a premium figure only means
                        something next to the other rows. */}
                    <td className="num">
                      <div className="ml-auto w-32">
                        <p className="font-semibold text-slate-900">
                          {formatINR(r.premium)}</p>
                        <Meter value={r.premium} total={peak}
                          className="mt-1.5"
                          title="Premium relative to the largest book on this roster" />
                        <p className="mt-1 text-xs text-slate-500">
                          {r.policies} {r.policies === 1 ? "policy" : "policies"}
                          {" · "}{formatINR(r.their_reward)} earned
                        </p>
                      </div>
                    </td>

                    {/* Net position, NOT windowed — the same figure the Balance
                        Sheet and the partner's own statement show. Positive =
                        the agency owes them, so it is money out: red. */}
                    <td className="num">
                      {r.net_balance === 0 ? (
                        <span className="text-slate-500">settled</span>
                      ) : (
                        <>
                          <span className={`font-semibold ${
                            r.net_balance > 0
                              ? "text-money-out" : "text-money-in"}`}>
                            {formatINR(Math.abs(r.net_balance))}
                          </span>
                          <span className="block text-xs text-slate-500">
                            {r.net_balance > 0 ? "to pay" : "to collect"}
                          </span>
                        </>
                      )}
                    </td>

                    <td>
                      <div className="flex flex-col gap-1">
                        {r.renewals_due > 0 && (
                          <span className="badge w-fit bg-due/10 text-due">
                            <Icon.Refresh size={12} />
                            {r.renewals_due} renewal
                            {r.renewals_due === 1 ? "" : "s"} due
                          </span>
                        )}
                        <span className="text-xs text-slate-500">
                          {r.last_policy_at
                            ? `Last policy ${formatDate(r.last_policy_at)}`
                            : "No policy yet"}
                          {r.days_quiet != null && r.days_quiet > 0
                            && ` · ${r.days_quiet}d ago`}
                        </span>
                      </div>
                    </td>

                    <td className="num">
                      <div className="flex items-center justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}>
                        {data?.can_manage && (
                          <button className="btn-secondary btn-sm"
                            title={`Book a policy for ${r.partner_name}`}
                            onClick={() =>
                              navigate(`/policies/new?partner=${r.partner_id}`)}>
                            <Icon.Plus size={14} /> Policy
                          </button>
                        )}
                        {/* Reassigning lives on the partner's own page, which
                            already owns that picker. A second one here would be
                            a second way to change the same field. */}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Fragment>
          ))}
        </table>
      </div>
    </div>
  );
}
