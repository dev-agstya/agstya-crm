import { Icon } from "../Icon";
import { Segmented } from "../ui";
import { PartyPicker, type Party } from "../pickers";
import { formatDate, formatINR } from "../../lib/format";

/*
  ONE STATEMENT ROW, AND THE DECISION ATTACHED TO IT.

  Shared by the bank-statement importer (pages/finance/StatementImportPage) and
  the pending queue (pages/finance/PendingTransactionsPage), which is the whole
  point of it existing.

  Those two screens ask the SAME question about the SAME kind of line — who was
  this with — and the server books both through the same function
  (`statement_import._commit_row`). Two renderings of one question is how the
  two screens end up offering different options for the same row: this repo has
  that scar in `lib/tone.ts` (five implementations of the money sign rule) and
  in `TargetProgress` (two roundings of the same percentage).

  THE DIRECTION IS NEVER EDITABLE, on either screen. If the statement says the
  money left, it left. What a person chooses is who it concerned.
*/

/** What somebody decided about one line. Mirrors the server's `CommitRow`. */
export interface RowDecision {
  /* "pending" means PARK IT — nothing posts and it joins the queue. It is the
     DEFAULT (owner 2026-08-24): the safe answer for an undecided statement line
     is "somebody looks at this", not "it never existed". */
  action: "party" | "expense" | "pending" | "skip";
  party?: Party | null;
  category?: string;
  /** A note to whoever picks this up later. Only meaningful when parking. */
  note?: string;
  /** One per row, so a retried commit re-posts nothing. */
  key: string;
}

/** Mirrors the server's EXPENSE_CATEGORIES — the same list the Add-transaction
 *  form offers, so a category chosen here is one that page recognises. */
export const EXPENSE_CATEGORIES: { value: string; label: string }[] = [
  { value: "salary", label: "Salary" },
  { value: "rent", label: "Rent" },
  { value: "utilities", label: "Utilities" },
  { value: "marketing", label: "Marketing" },
  { value: "software", label: "Software / Tools" },
  { value: "travel", label: "Travel" },
  { value: "office_supplies", label: "Office Supplies" },
  { value: "taxes_fees", label: "Taxes / Fees" },
  { value: "reward_payout", label: "Reward / Incentive" },
  { value: "other", label: "Other" },
];

/** The bank's own facts about one line. Neither screen lets these be edited. */
export interface StatementFacts {
  occurred_on?: string | null;
  description: string;
  reference: string;
  amount_paise: number;
  direction: "in" | "out" | "";
  duplicate_of?: string | null;
  duplicate_note?: string | null;
  suggested_terms: string[];
}

export function StatementRowCard({
  facts, decision, onChange, onRemove, removeLabel, extra, showPending = true,
}: {
  facts: StatementFacts;
  decision: RowDecision;
  onChange: (patch: Partial<RowDecision>) => void;
  /**
   * The CROSS in the corner (owner 2026-08-24). Its confirmation dialog is the
   * caller's, because what "remove" means differs: on the import screen the row
   * has never existed anywhere, and in the queue it is a stored row being
   * dismissed with a reason.
   */
  onRemove?: () => void;
  removeLabel?: string;
  /** Anything the calling screen wants under the controls — the pending
   *  queue puts the note field and the provenance line here. */
  extra?: React.ReactNode;
  /** The import screen offers "Pending"; the queue does not (a row that is
   *  already pending cannot be made more pending). */
  showPending?: boolean;
}) {
  const inbound = facts.direction === "in";
  const decided = decision.action === "party" || decision.action === "expense";

  return (
    <div className={`card relative px-4 py-3 ${
      decided ? "border-l-4 border-l-ink" : ""}`}>
      {/*
        THE CROSS, top right (the owner's own placement). It removes the row
        from this list and nothing else — the confirmation behind it exists
        because "we don't want to delete any of the transactions actually".
      */}
      {onRemove && (
        <button type="button"
          className="icon-btn absolute right-2 top-2"
          aria-label={removeLabel ?? "Remove this transaction"}
          title={removeLabel ?? "Remove this transaction"}
          onClick={onRemove}>
          <Icon.X size={14} />
        </button>
      )}

      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 pr-8">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-slate-900">
              {formatDate(facts.occurred_on)}
            </span>
            {/* The bank's direction, drawn as a badge and not as a control. */}
            <span className={`badge ${inbound ? "badge-in" : "badge-out"}`}>
              {inbound ? "Received" : "Paid"}
            </span>
            {facts.duplicate_of && (
              <span className="badge-due" title={facts.duplicate_note ?? ""}>
                <Icon.Alert size={11} /> already recorded?
              </span>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500"
            title={facts.description}>
            {facts.description || "(no description)"}
            {facts.reference ? ` · ${facts.reference}` : ""}
          </p>
        </div>

        <span className={`text-metric-sm tabular-nums ${
          inbound ? "text-money-in" : "text-money-out"}`}>
          {inbound ? "+" : "−"}{formatINR(facts.amount_paise)}
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Segmented<RowDecision["action"]>
          value={decision.action}
          onChange={(v) => onChange({ action: v })}
          options={[
            ...(showPending
              ? [{ value: "pending" as const, label: "Pending" }] : []),
            { value: "party", label: inbound ? "Received from" : "Paid to" },
            // Money coming IN is never a house expense, so the option is not
            // offered rather than being offered and refused.
            ...(inbound ? [] : [{ value: "expense" as const,
              label: "House expense" }]),
          ]} />

        {decision.action === "party" && (
          <div className="min-w-[16rem] flex-1">
            <PartyPicker value={decision.party ?? null}
              onChange={(p) => onChange({ party: p })} />
            {/* Suggested search terms, pulled out of the narration. A HINT and
                nothing more — a wrong guess that assigned itself would post
                real money against the wrong person. */}
            {!decision.party && facts.suggested_terms.length > 0 && (
              <p className="mt-1 text-xs text-slate-500">
                From the description: {facts.suggested_terms.join(", ")}
              </p>
            )}
          </div>
        )}

        {decision.action === "expense" && (
          <select className="select w-56" value={decision.category ?? ""}
            onChange={(e) => onChange({ category: e.target.value })}>
            <option value="">— Choose a category —</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        )}

        {decision.action === "pending" && (
          <input className="input min-w-[16rem] flex-1"
            value={decision.note ?? ""}
            placeholder="What do you need to find out? (optional)"
            onChange={(e) => onChange({ note: e.target.value })} />
        )}
      </div>

      {extra}
    </div>
  );
}

/**
 * The row that could not be read at all.
 *
 * Shown and skipped, never dropped silently: a statement that imports 38 of 40
 * lines without saying which two is worse than one that refuses outright.
 */
export function UnreadableRow({ line, problem, description }: {
  line: number; problem: string; description: string;
}) {
  return (
    <div className="card border-l-4 border-l-money-out px-4 py-3">
      <p className="text-sm font-medium text-slate-700">
        Line {line} — cannot be imported
      </p>
      <p className="mt-0.5 text-xs text-money-out">{problem}</p>
      <p className="mt-1 truncate text-xs text-slate-500">
        {description || "(no description)"}
      </p>
    </div>
  );
}
