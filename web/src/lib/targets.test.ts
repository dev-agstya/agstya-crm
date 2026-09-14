// The UI half of the house-profit rule (the server enforces the real one).
//
// Owner, 2026-07-26: an employee must not see the agency's margin on their own
// work — only the owner, and whoever assigns the targets, ever sees it.

import { describe, expect, it } from "vitest";
import { canSeeProfitTargets, isProfitMetric, visibleMetricRows } from "./targets";
import type { Me, TargetMetricRow } from "./types";

const user = (account_type: Me["account_type"], permissions: string[]) =>
  ({ account_type, permissions }) as Pick<Me, "account_type" | "permissions">;

const ROWS: TargetMetricRow[] = [
  { metric: "policies", label: "Policies", is_money: false,
    target_value: 10, actual_value: 5, attainment_pct: 50 },
  { metric: "house_profit", label: "House profit", is_money: true,
    target_value: 1_000_000, actual_value: 2_000_000, attainment_pct: 200 },
];

describe("canSeeProfitTargets", () => {
  it("lets the owner see it", () => {
    expect(canSeeProfitTargets(user("owner", []))).toBe(true);
  });

  it("lets someone who assigns targets see it", () => {
    expect(canSeeProfitTargets(user("employee", ["manage_targets"]))).toBe(true);
  });

  it("hides it from an employee who only reads targets", () => {
    expect(canSeeProfitTargets(user("employee", ["view_targets"]))).toBe(false);
  });

  it("hides it from the finance desk, permissions and all", () => {
    // The exact account from the owner's report: trusted with money screens,
    // still not shown a house-profit TARGET.
    expect(canSeeProfitTargets(
      user("employee", ["view_finance", "view_agency_profit", "view_targets"])
    )).toBe(false);
  });

  it("hides it from a channel partner and from nobody-signed-in", () => {
    expect(canSeeProfitTargets(user("channel_partner", []))).toBe(false);
    expect(canSeeProfitTargets(null)).toBe(false);
  });
});

describe("visibleMetricRows", () => {
  it("drops the profit row for an employee", () => {
    const rows = visibleMetricRows(ROWS, false);
    expect(rows.map((r) => r.metric)).toEqual(["policies"]);
  });

  it("keeps every row for the owner", () => {
    expect(visibleMetricRows(ROWS, true)).toHaveLength(2);
  });

  it("handles a missing list", () => {
    expect(visibleMetricRows(undefined, false)).toEqual([]);
  });

  it("knows which metric is the sensitive one", () => {
    expect(isProfitMetric("house_profit")).toBe(true);
    expect(isProfitMetric("premium")).toBe(false);
    expect(isProfitMetric("policies")).toBe(false);
    expect(isProfitMetric("renewals")).toBe(false);
  });
});
