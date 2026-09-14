import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../Icon";
import { Avatar, Meter } from "../ui";
import { TargetRing } from "../TargetProgress";
import { formatDate, formatINR } from "../../lib/format";
import type { PartnerRosterRow } from "../../lib/types";

/*
  ONE channel partner, as a card.

  The roster has been a TABLE since it was built, and the table is good — six
  columns, grouped, one hero figure per row. What a table cannot do is let you
  read thirty people at a glance, because every row is the same shape and the
  eye has to walk them. A ring is a shape you recognise across a grid; "62%" is
  a number you have to read. That is the whole argument for this rendering, and
  it is the same argument `TargetRing` was built on.

  So both exist and each has a job: cards are the OVERVIEW ("who needs me"), the
  table is the TARGETS tab ("set these numbers, one row at a time"). Neither is
  a second implementation — the rounding, the three tones and the metric
  formatting all come from components/TargetProgress, exactly as the table's do.
*/

/** Why this partner is on the "needs a call" pile, in as few words as possible. */
function attentionReason(r: PartnerRosterRow): string | null {
  if (!r.active_account) return null;
  if (r.renewals_due > 0)
    return `${r.renewals_due} renewal${r.renewals_due === 1 ? "" : "s"} due`;
  if (r.days_quiet == null) return "Never written a policy";
  if (r.is_quiet) return `Quiet for ${r.days_quiet} days`;
  if (r.has_target && r.attainment_pct < 50) return "Behind on their target";
  return null;
}

export function PartnerCard({ row, peak, onSetTarget, onLogFollowUp }: {
  row: PartnerRosterRow;
  /** The biggest book on the roster, so the bar ranks rather than measures. */
  peak: number;
  onSetTarget?: (row: PartnerRosterRow) => void;
  /** Omitted when the viewer cannot create reminders. */
  onLogFollowUp?: (row: PartnerRosterRow) => void;
}) {
  const navigate = useNavigate();
  const reason = attentionReason(row);
  const to = `/people/partners/${row.partner_id}`;

  return (
    <div
      className={`card group relative flex flex-col gap-3 px-4 py-4
        transition-shadow hover:shadow-raise
        ${reason ? "border-l-4 border-l-due" : ""}`}
    >
      {/* The whole card opens the partner. A real <Link> laid over it rather
          than onClick on the container: a keyboard user must be able to reach
          it, and middle-click must open a second tab — the same rule
          `LedgerCell` follows on every list in the app. The buttons below sit
          above it in the stacking order and stop propagation. */}
      <Link to={to} className="absolute inset-0 rounded-card focus-visible:ring"
        aria-label={`Open ${row.partner_name}`} />

      <div className="relative flex items-start gap-3">
        <Avatar name={row.partner_name} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            {row.partner_name}</p>
          <p className="truncate text-xs text-slate-500">
            {row.partner_code}
            {row.mobile ? ` · ${row.mobile}` : ""}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {!row.active_account && (
              <span className="badge-neutral">inactive</span>
            )}
            {row.is_quiet && row.active_account && (
              <span className="badge-due">quiet</span>
            )}
          </div>
        </div>
        {/* The ring is the headline. No target is a real and different state
            from 0% — an empty ring claiming "0%" would read as failure when
            nobody has asked them for anything. */}
        {row.has_target ? (
          <TargetRing pct={row.attainment_pct} size={52} stroke={5} />
        ) : (
          <span className="shrink-0 rounded-full border border-dashed
            border-line px-2 py-1 text-[10px] font-medium text-slate-400">
            no target
          </span>
        )}
      </div>

      {/* Their book, ranked against the biggest on the roster. A premium figure
          on its own means nothing; next to the others it means everything. */}
      <div className="relative">
        <p className="text-metric-sm tabular-nums text-slate-900">
          {formatINR(row.premium)}</p>
        <Meter value={row.premium} total={peak} className="mt-1.5"
          title="Premium relative to the largest book on this roster" />
        <p className="mt-1 text-xs text-slate-500">
          {row.policies} {row.policies === 1 ? "policy" : "policies"}
          {" · "}{formatINR(row.their_reward)} earned
        </p>
      </div>

      <div className="relative flex items-center justify-between gap-2
        border-t border-line-soft pt-2.5 text-xs">
        {/* Net position, NOT windowed — the same figure the Balance Sheet and
            the partner's own statement show. Positive = the agency owes them. */}
        {row.net_balance === 0 ? (
          <span className="text-slate-500">Settled</span>
        ) : (
          <span className={row.net_balance > 0
            ? "font-medium text-money-out" : "font-medium text-money-in"}>
            {formatINR(Math.abs(row.net_balance))}
            <span className="ml-1 font-normal text-slate-500">
              {row.net_balance > 0 ? "to pay" : "to collect"}
            </span>
          </span>
        )}
        <span className="truncate text-slate-500">
          {row.last_policy_at
            ? formatDate(row.last_policy_at) : "No policy yet"}
        </span>
      </div>

      {reason && (
        <p className="relative flex items-center gap-1.5 text-xs font-medium
          text-due">
          <Icon.Alert size={12} /> {reason}
        </p>
      )}

      {/* Actions sit ABOVE the overlay link, so a click on one of them does not
          also navigate. */}
      {(onSetTarget || onLogFollowUp) && (
        <div className="relative flex flex-wrap gap-1.5">
          {onSetTarget && (
            <button type="button" className="btn-secondary btn-sm"
              onClick={() => onSetTarget(row)}>
              <Icon.Target size={13} />
              {row.has_target ? "Change target" : "Set target"}
            </button>
          )}
          {/*
            F15 — a flag you can ACT on.

            "Quiet for 61 days" was drawn in amber and led nowhere: no way to
            record that you had rung them, so the same partner was flagged again
            tomorrow with no memory of yesterday. Reminders already work against
            any entity; this just points one at the partner.
          */}
          {onLogFollowUp && reason && (
            <button type="button" className="btn-secondary btn-sm"
              onClick={() => onLogFollowUp(row)}>
              <Icon.Clock size={13} /> Log a follow-up
            </button>
          )}
          <button type="button" className="btn-secondary btn-sm"
            title={`Book a policy for ${row.partner_name}`}
            onClick={() => navigate(`/policies/new?partner=${row.partner_id}`)}>
            <Icon.Plus size={13} /> Policy
          </button>
        </div>
      )}
    </div>
  );
}
