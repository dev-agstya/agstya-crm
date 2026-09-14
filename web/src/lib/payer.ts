import type { PayerType } from "./types";

// "Policy Premium Paid By" — who actually paid the premium to the insurer. Three
// explicit options so premium dues and reports stay accurate (owner Q1):
//   agency          -> the agency fronted it (the buyer then owes us).
//   customer        -> the customer paid the insurer directly.
//   channel_partner -> the channel partner paid the insurer directly.
export const PAID_BY_OPTIONS: { value: PayerType; label: string }[] = [
  { value: "agency", label: "Agastya Agency" },
  { value: "customer", label: "Customer" },
  { value: "channel_partner", label: "Channel Partner" },
];

export function paidByLabel(payer: PayerType | string): string {
  return PAID_BY_OPTIONS.find((o) => o.value === payer)?.label ?? String(payer);
}
