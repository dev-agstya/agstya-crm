// Target helpers shared by the dashboard tile, the Targets page and the
// per-person popup.
//
// House profit is the agency's own margin. The owner's rule (2026-07-26): an
// employee must never see how much the house made on their work — someone who
// learns they cleared ₹20,000 against a ₹10,000 goal starts negotiating rather
// than selling. Only the owner and the people who ASSIGN targets
// (manage_targets) see it.
//
// The server already strips these rows (services/targets.can_see_profit_targets),
// so this is belt-and-braces for the UI: it decides whether to render a column
// or an input at all, and never has to depend on a field being absent.

import type { Me, TargetMetric, TargetMetricRow } from "./types";

export const PROFIT_METRICS: TargetMetric[] = ["house_profit"];

export function canSeeProfitTargets(
  user: Pick<Me, "account_type" | "permissions"> | null | undefined
): boolean {
  if (!user) return false;
  if (user.account_type === "owner") return true;
  return (user.permissions ?? []).includes("manage_targets");
}

export function isProfitMetric(metric: TargetMetric): boolean {
  return PROFIT_METRICS.includes(metric);
}

// Drop the rows this viewer may not see. Used on data that arrives from the
// server already filtered — harmless there, and correct for anything built
// client-side (drafts in the assign grid, for instance).
export function visibleMetricRows(
  rows: TargetMetricRow[] | undefined,
  canSeeProfit: boolean
): TargetMetricRow[] {
  const list = rows ?? [];
  return canSeeProfit ? list : list.filter((r) => !isProfitMetric(r.metric));
}
