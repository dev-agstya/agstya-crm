import type { LedgerTxn, PartyType } from "../../lib/types";

/*
  How a ledger row is WORDED and COLOURED.

  Lifted out of TransactionsPage when the detail popup became a page, so the
  list and the record show the same thing. The rules are load-bearing: the
  ledger's stored sign is the party-receivable view, and cash direction comes
  from the transaction TYPE — reading direction off the sign is the mistake
  that silently corrupts a balance.
*/

// Plain-language, party-aware label for a transaction (owner 2026-07-18).
// Mirrors the backend ledger_label() in server/app/services/txn_display.py —
// keep the two in sync.
const PARTY_WORD: Record<string, string> = {
  channel_partner: "Channel Partner",
  customer: "Customer",
  broker: "Broker",
  expense: "House",
};
export function txnLabel(txnType: string, partyType?: string): string {
  const party = PARTY_WORD[partyType || ""] || "Party";
  switch (txnType) {
    case "premium_due": return "Premium Due";
    case "premium_to_insurer":
    case "premium_paid_by_agency": return "Policy Premium Paid";
    case "premium_collected": return `Received from ${party}`;
    case "reward_received": return "Broker Reward Received";
    case "reward_cancelled": return "Broker Reward Cancelled";
    case "tds_deducted": return "TDS Deducted";
    case "partner_payout":
    case "partner_advance": return "Paid to Channel Partner";
    case "refund": return `Paid to ${party}`;
    case "discount": return "Discount";
    case "adjustment": return "Adjustment";
    case "expense": return "Expense";
    default: return txnType;
  }
}
// Generic labels for the type filter dropdown (no single party there).
export const FILTER_LABEL: Record<string, string> = {
  premium_to_insurer: "Policy Premium Paid",
  premium_paid_by_agency: "Policy Premium Paid (Agency)",
  premium_collected: "Payment Received",
  reward_received: "Broker Reward Received",
  reward_cancelled: "Broker Reward Cancelled",
  partner_payout: "Paid to Channel Partner",
  partner_advance: "Advance to Channel Partner",
  refund: "Refund / Paid back",
  discount: "Discount",
  adjustment: "Adjustment",
  expense: "Expense",
};
// Premium-due rows are a balance POSITION, not a money movement — they still
// drive every net balance but stay off this page (owner Obs-1, 2026-07-15).
export const HIDDEN_TYPES = "premium_due";
export const FILTERABLE_TYPES = Object.entries(FILTER_LABEL);

// A single partner payout books TWO ledger rows — a wallet-driven reward payout
// plus any over-balance advance. Owner 2026-07-18: show them as ONE simple
// "Paid to Channel Partner" line. Merge is display-only; the two records stay
// intact so balances/statements are unaffected.
export type DisplayRow = LedgerTxn & {
  _merged?: boolean;
  _rewardPaise?: number;
  _advancePaise?: number;
};
export function mergeRows(items: LedgerTxn[]): DisplayRow[] {
  const isPart = (x: LedgerTxn) =>
    x.party_type === "channel_partner" &&
    (x.txn_type === "partner_payout" || x.txn_type === "partner_advance");
  const out: DisplayRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const b: LedgerTxn | undefined = items[i + 1];
    if (b && isPart(a) && isPart(b) && a.party_id === b.party_id
        && a.txn_type !== b.txn_type) {
      const payout = a.txn_type === "partner_payout" ? a : b;
      const advance = a.txn_type === "partner_advance" ? a : b;
      const total = Math.abs(payout.amount_paise)
        + Math.abs(advance.amount_paise);
      out.push({
        ...payout,
        _merged: true,
        _rewardPaise: Math.abs(payout.amount_paise),
        _advancePaise: Math.abs(advance.amount_paise),
        txn_type: "partner_payout",
        amount_paise: -total, // negative → outflow tone/sign
        reference: payout.reference || advance.reference,
        note: payout.note || advance.note,
      });
      i++; // consume the paired row
    } else {
      out.push(a);
    }
  }
  return out;
}
// Expense sub-category labels (mirror server EXPENSE_CATEGORY_LABELS).
export const EXPENSE_LABEL: Record<string, string> = {
  salary: "Salary", rent: "Rent", utilities: "Utilities", marketing: "Marketing",
  software: "Software / Tools", travel: "Travel",
  office_supplies: "Office Supplies", taxes_fees: "Taxes / Fees",
  reward_payout: "Reward / Incentive", other: "Other",
};
export const PARTY_LABEL: Record<PartyType, string> = {
  channel_partner: "Channel partner",
  customer: "Customer",
  broker: "Broker",
  expense: "House expense",
};
export const ENTITY_OF: Record<PartyType, string> = {
  channel_partner: "partner",
  customer: "customer",
  broker: "broker",
  expense: "",
};
// Rows the server refuses to edit/cancel/delete by hand: auto-managed from the
// policy.
export const LOCKED_TYPES = new Set([
  "premium_due", "premium_paid_by_agency", "reward_cancelled",
  // Reward payouts are driven by the partner's wallet, not the ledger — this
  // row is a read-only mirror. Reverse the payout from the wallet instead.
  "partner_payout",
]);

// Cash direction of a row (owner 1.2, 2026-07-16): incoming money is GREEN
// with a +, outgoing money is RED with a −. Derived from each type's stored
// sign convention, so a reversal (opposite sign) flips direction too.
// Non-cash rows (adjustment / discount / reward-cancelled info) return 0.
const CASH_IN_WHEN_NEGATIVE = new Set(["premium_collected", "reward_received"]);
const CASH_OUT_WHEN_NEGATIVE = new Set([
  "premium_paid_by_agency", "partner_payout", "expense",
]);
const CASH_OUT_WHEN_POSITIVE = new Set([
  "partner_advance", "refund", "premium_to_insurer",
]);
export function cashDirection(txnType: string, amountPaise: number): 1 | -1 | 0 {
  if (CASH_IN_WHEN_NEGATIVE.has(txnType))
    return amountPaise <= 0 ? 1 : -1;
  if (CASH_OUT_WHEN_NEGATIVE.has(txnType))
    return amountPaise <= 0 ? -1 : 1;
  if (CASH_OUT_WHEN_POSITIVE.has(txnType))
    return amountPaise >= 0 ? -1 : 1;
  return 0;
}
// Amount colour + sign for a ledger row, from its cash direction.
export function amountTone(txnType: string, amountPaise: number): {
  cls: string; sign: string;
} {
  if (txnType === "reward_cancelled")
    return { cls: "text-slate-500 line-through", sign: "" };
  const dir = cashDirection(txnType, amountPaise);
  if (dir > 0) return { cls: "text-money-in", sign: "+ " };
  if (dir < 0) return { cls: "text-money-out", sign: "− " };
  return { cls: "text-slate-500", sign: "" };
}

const TYPE_TONE: Record<string, string> = {
  premium_collected: "bg-money-in/10 text-money-in",
  reward_received: "bg-money-in/10 text-money-in",
  refund: "bg-slate-100 text-slate-900",
  partner_payout: "bg-slate-100 text-slate-900",
  premium_due: "bg-due/10 text-due",
  partner_advance: "bg-due/10 text-due",
  discount: "bg-due/10 text-due",
  adjustment: "bg-slate-100 text-slate-600",
  premium_to_insurer: "bg-slate-100 text-slate-600",
  premium_paid_by_agency: "bg-slate-100 text-slate-600",
  reward_cancelled: "bg-money-out/10 text-money-out",
  expense: "bg-money-out/10 text-money-out",
};
export function TypeTag({ t, party }: { t: string; party?: string }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium
      ${TYPE_TONE[t] || "bg-slate-100 text-slate-600"}`}>
      {txnLabel(t, party)}</span>
  );
}

