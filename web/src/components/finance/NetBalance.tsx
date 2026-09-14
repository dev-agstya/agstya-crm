import { formatINR } from "../../lib/format";
import { moneyTone } from "../../lib/tone";

// Owner's portal-wide sign & colour convention for NET BALANCES (2026-07):
// the party owes the agency -> amount shows NEGATIVE in RED
// the agency owes the party -> amount shows POSITIVE in GREEN
// exactly zero -> BLUE
// Exception (owner Q5): a BROKER owing us rewards is income we expect —
// it shows POSITIVE in GREEN; the agency owing a broker shows negative red.
//
// All helpers take the AGENCY-RECEIVABLE value the API returns
// (>0 = the party owes us, <0 = we owe them).

export type NetParty = "customer" | "partner" | "broker";

export function netView(receivablePaise: number, party: NetParty): {
  display: number; // signed paise to render
  cls: string; // tailwind text colour
  label: string; // short human meaning
} {
  const v = receivablePaise;
  if (v === 0) {
    return { display: 0, cls: moneyTone(0),
      label: "Settled" };
  }
  if (party === "broker") {
    // Broker owes us -> green positive (income); we owe broker -> red negative.
    return v > 0
      ? { display: v, cls: "text-money-in", label: "To receive" }
      : { display: v, cls: "text-money-out", label: "You owe" };
  }
  // Customers / channel partners: owes-us shows negative red.
  return v > 0
    ? { display: -v, cls: "text-money-out", label: "They owe you" }
    : { display: -v, cls: "text-money-in", label: "You owe them" };
}

function signed(paise: number): string {
  const abs = formatINR(Math.abs(paise));
  if (paise === 0) return abs;
  return `${paise > 0 ? "+" : "−"}${abs}`;
}

// Inline coloured amount following the convention. Always full Indian-format
// numbers (owner's rule — no abbreviations).
export function NetAmount({ receivable, party, className = "" }: {
  receivable: number; party: NetParty; short?: boolean; className?: string;
}) {
  const v = netView(receivable, party);
  return (
    <span className={`tabular-nums ${v.cls} ${className}`}>
      {signed(v.display)}
    </span>
  );
}
