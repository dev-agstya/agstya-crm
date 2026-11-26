import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PartyPicker, type Party } from "../pickers";
import { formatDate, formatINR } from "../../lib/format";

export interface RowDecision {
  action: "party" | "expense" | "pending" | "skip";
  party?: Party | null;
  category?: string;
  note?: string;
  key: string;
}

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
  facts,
  decision,
  onChange,
  onRemove,
  removeLabel,
  extra,
  showPending = true,
}: {
  facts: StatementFacts;
  decision: RowDecision;
  onChange: (patch: Partial<RowDecision>) => void;
  onRemove?: () => void;
  removeLabel?: string;
  extra?: React.ReactNode;
  showPending?: boolean;
}) {
  const inbound = facts.direction === "in";
  const decided =
    (decision.action === "party" && !!decision.party) ||
    (decision.action === "expense" && !!decision.category);

  return (
    <div
      className={`rounded-lg border border-border bg-card px-3 py-2 transition-colors ${
        decided ? "border-l-4 border-l-primary bg-primary/[0.02]" : ""
      }`}
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
        {/* Date & Direction */}
        <div className="flex shrink-0 items-center gap-2">
          <span className="w-[82px] whitespace-nowrap text-xs font-medium tabular-nums text-foreground">
            {formatDate(facts.occurred_on)}
          </span>
          <Badge
            variant={inbound ? "default" : "destructive"}
            className={`h-5 px-1.5 text-[10px] font-medium ${
              inbound
                ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"
                : "bg-red-100 text-red-800 hover:bg-red-100"
            }`}
          >
            {inbound ? "In" : "Out"}
          </Badge>
          {facts.duplicate_of && (
            <span
              title={facts.duplicate_note ?? "Possible duplicate"}
              className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
            >
              <AlertTriangle className="h-3 w-3" />
              Dup?
            </span>
          )}
        </div>

        {/* Description & Reference (single line truncated) */}
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-xs text-foreground"
            title={`${facts.description || "(no description)"}${
              facts.reference ? ` · ${facts.reference}` : ""
            }`}
          >
            <span className="font-medium">
              {facts.description || "(no description)"}
            </span>
            {facts.reference && (
              <span className="ml-1.5 text-muted-foreground">
                · {facts.reference}
              </span>
            )}
          </p>
        </div>

        {/* Amount */}
        <div className="shrink-0 lg:w-28 lg:text-right">
          <span
            className={`text-sm font-semibold tabular-nums whitespace-nowrap ${
              inbound ? "text-emerald-700" : "text-red-600"
            }`}
          >
            {inbound ? "+" : "−"}
            {formatINR(facts.amount_paise)}
          </span>
        </div>

        {/* Mode selector + Search box / Category at the end */}
        <div className="flex flex-wrap items-center gap-1.5 lg:flex-nowrap lg:shrink-0">
          <div className="inline-flex h-8 items-center rounded-md border border-border bg-muted/50 p-0.5 text-xs">
            {showPending && (
              <button
                type="button"
                onClick={() => onChange({ action: "pending" })}
                className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  decision.action === "pending"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Pending
              </button>
            )}
            <button
              type="button"
              onClick={() => onChange({ action: "party" })}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                decision.action === "party"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {inbound ? "From" : "To Party"}
            </button>
            {!inbound && (
              <button
                type="button"
                onClick={() => onChange({ action: "expense" })}
                className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  decision.action === "expense"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Expense
              </button>
            )}
          </div>

          {decision.action === "party" && (
            <div className="w-full min-w-[230px] sm:w-64">
              <PartyPicker
                value={decision.party ?? null}
                onChange={(p) => onChange({ action: "party", party: p })}
              />
            </div>
          )}

          {decision.action === "expense" && (
            <Select
              value={decision.category ?? ""}
              onValueChange={(v) => onChange({ category: v })}
            >
              <SelectTrigger className="h-8 w-full min-w-[200px] sm:w-56 text-xs">
                <SelectValue placeholder="Choose category…" />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {decision.action === "pending" && (
            <Input
              className="h-8 w-full min-w-[200px] sm:w-56 text-xs"
              value={decision.note ?? ""}
              placeholder="Note for later (optional)…"
              onChange={(e) => onChange({ note: e.target.value })}
            />
          )}

          {onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={removeLabel ?? "Remove this transaction"}
              title={removeLabel ?? "Remove this transaction"}
              onClick={onRemove}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {extra && <div className="mt-1.5">{extra}</div>}
    </div>
  );
}

export function UnreadableRow({
  line,
  problem,
  description,
}: {
  line: number;
  problem: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-border border-l-4 border-l-destructive bg-card px-3.5 py-2.5">
      <p className="text-xs font-semibold text-foreground">
        Line {line} — cannot be imported
      </p>
      <p className="mt-0.5 text-xs text-destructive">{problem}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {description || "(no description)"}
      </p>
    </div>
  );
}
