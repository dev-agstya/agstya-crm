import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PERMISSION_GROUPS,
  PERMISSION_IMPLIES,
  expandPermissions,
  revokePermission,
} from "./types";

// The permission editor is only honest if the client applies the same
// implication rules as the server (core/permissions.py). If these drift, a user
// ticks one thing and a different set gets saved.

const allKeys = () =>
  PERMISSION_GROUPS.flatMap((g) =>
    g.sections.flatMap((s) => [s.view, s.manage].filter(Boolean) as string[]));

describe("permission catalogue", () => {
  it("gives every section a name, a view flag and help text", () => {
    for (const group of PERMISSION_GROUPS) {
      expect(group.group).toBeTruthy();
      expect(group.hint).toBeTruthy();
      expect(group.sections.length).toBeGreaterThan(0);
      for (const section of group.sections) {
        expect(section.name).toBeTruthy();
        expect(section.view).toBeTruthy();
        expect(section.help).toBeTruthy();
      }
    }
  });

  it("has no duplicate flags", () => {
    const keys = allKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("offers every navigable section on its own", () => {
    // THE 2026-08-07 ASK. `view_policies` used to be one flag covering leads,
    // customers, policies, renewals, quote requests, claims AND the catalog, so
    // hiring someone to chase renewals handed them the whole book of business.
    const keys = allKeys();
    for (const flag of [
      "view_leads", "manage_leads",
      "view_customers", "manage_customers",
      "view_policies", "manage_policies",
      "view_renewals", "manage_renewals",
      "view_quotes", "manage_quotes",
      "view_claims", "manage_claims",
      "view_transactions", "manage_transactions",
      "view_finance_overview", "view_balance_sheet",
      "view_tds", "manage_tds",
      "view_bank_accounts", "manage_bank_accounts",
      "view_agency_profit",
      "view_insurers", "manage_insurers",
      "view_brokers", "manage_brokers",
      "view_policy_types", "manage_policy_types",
      "view_rate_cards", "manage_rate_cards",
      "view_employees", "manage_employees",
      "view_partners", "manage_partners",
      "view_announcements", "manage_announcements",
      "view_targets", "manage_targets",
      "manage_roles_permissions",
      "view_reports", "export_data",
      "view_audit_logs", "view_sensitive_pii",
    ]) {
      expect(keys, flag).toContain(flag);
    }
  });

  it("no longer offers the merged umbrellas it replaced", () => {
    // A surviving `view_team` would mean two ways to grant the same access, and
    // the narrower one would quietly stop being enforced.
    const keys = allKeys();
    for (const flag of [
      "view_team", "manage_team", "view_finance", "manage_finance",
    ]) {
      expect(keys, flag).not.toContain(flag);
    }
  });

  it("splits by section, never by verb", () => {
    // The other failure mode, and the one this must not drift back into: before
    // 2026-07-26 there were 43 flags split by VERB (edit vs delete a customer,
    // three export flags) and the owner called it "very ugly".
    for (const key of allKeys()) {
      expect(key, key).toMatch(/^(view|manage|export)_/);
    }
    for (const flag of [
      "delete_customers", "delete_policies", "delete_ledger", "edit_ledger",
      "record_payments", "assign_leads", "reset_passwords", "cancel_policies",
      "export_reports", "manage_roles", "edit_permissions",
    ]) {
      expect(allKeys(), flag).not.toContain(flag);
    }
  });

  it("no longer offers the dead or partner-portal flags", () => {
    const keys = allKeys();
    for (const flag of [
      "approve_policies", "approve_withdrawals", "manage_withdrawals",
      "view_own_reward", "view_team_reward", "manage_reward", "view_all_audit",
    ]) {
      expect(keys, flag).not.toContain(flag);
    }
  });

  it("pairs each section's manage flag with its own view flag", () => {
    // The editor draws a section as ONE ROW with a View box and a Manage box,
    // so a mismatched pair would put "Manage transactions" beside "View leads".
    for (const group of PERMISSION_GROUPS) {
      for (const section of group.sections) {
        if (!section.manage) continue;
        expect(PERMISSION_IMPLIES[section.manage], section.name)
          .toEqual([section.view]);
      }
    }
  });

  it("only implies flags that actually exist", () => {
    const keys = new Set(allKeys());
    for (const [flag, implied] of Object.entries(PERMISSION_IMPLIES)) {
      expect(keys.has(flag), flag).toBe(true);
      implied.forEach((p) => expect(keys.has(p), p).toBe(true));
    }
  });
});

describe("expandPermissions", () => {
  it("adds the view flag whenever a manage flag is granted", () => {
    for (const [manage, implied] of Object.entries(PERMISSION_IMPLIES)) {
      const got = expandPermissions([manage]);
      implied.forEach((p) => expect(got, `${manage} -> ${p}`).toContain(p));
    }
  });

  it("does not duplicate a flag that is already held", () => {
    const got = expandPermissions(["manage_policies", "view_policies"]);
    expect(got.filter((p) => p === "view_policies")).toHaveLength(1);
  });

  it("leaves an empty set empty", () => {
    expect(expandPermissions([])).toEqual([]);
  });

  it("keeps agency profit independent of the rest of finance", () => {
    // Someone can run the whole finance desk without seeing the house margin.
    expect(expandPermissions([
      "manage_transactions", "view_balance_sheet", "manage_rate_cards",
    ])).not.toContain("view_agency_profit");
  });

  it("keeps renewals from widening into the whole book", () => {
    // The owner's worked example: "only renewals access". If manage_renewals
    // implied view_policies the split would buy nothing.
    const got = expandPermissions(["manage_renewals"]);
    expect(got).toContain("view_renewals");
    expect(got).not.toContain("view_policies");
    expect(got).not.toContain("view_customers");
  });

  it("keeps the two people populations separate", () => {
    const got = expandPermissions(["manage_employees"]);
    expect(got).toContain("view_employees");
    expect(got).not.toContain("view_partners");
    expect(got).not.toContain("manage_partners");
  });
});

describe("revokePermission", () => {
  it("removes the manage flag that depended on a revoked view flag", () => {
    // Otherwise unticking "View" appears to do nothing: the server re-adds it
    // because "Manage" is still ticked.
    const got = revokePermission(
      ["view_policies", "manage_policies", "view_reports"], "view_policies");
    expect(got).toEqual(["view_reports"]);
  });

  it("removing a manage flag leaves its view flag alone", () => {
    const got = revokePermission(
      ["view_policies", "manage_policies"], "manage_policies");
    expect(got).toEqual(["view_policies"]);
  });

  it("is a no-op for a flag that is not held", () => {
    expect(revokePermission(["view_reports"], "view_tds"))
      .toEqual(["view_reports"]);
  });

  it("round-trips: granting then revoking manage returns the original set", () => {
    const start = ["view_reports"];
    const granted = expandPermissions([...start, "manage_targets"]);
    const revoked = revokePermission(granted, "view_targets");
    expect(revoked).toEqual(start);
  });
});

describe("the split reaches the pages, not just the catalogue", () => {
  // A flag nothing enforces is decoration — the same failure mode as a model
  // field no schema declares. These read the source of the gates themselves.
  const read = (p: string) =>
    readFileSync(join(__dirname, "..", p), "utf8");

  it("gates each Work page on its own flag", () => {
    const nav = read("lib/access.ts");
    for (const [route, flag] of [
      ['to: "/leads"', "view_leads"],
      ['to: "/customers"', "view_customers"],
      ['to: "/policies"', "view_policies"],
      ['to: "/renewals"', "view_renewals"],
      ['to: "/quotes"', "view_quotes"],
      ['to: "/claims"', "view_claims"],
    ] as const) {
      const at = nav.indexOf(route);
      expect(at, route).toBeGreaterThan(-1);
      expect(nav.slice(at, at + 220), route).toContain(flag);
    }
  });

  it("gates each Finance page on its own flag", () => {
    const nav = read("lib/access.ts");
    for (const [route, flag] of [
      ['to: "/finance", label: "Overview"', "view_finance_overview"],
      ['to: "/finance/transactions"', "view_transactions"],
      ['to: "/finance/balance-sheet"', "view_balance_sheet"],
      ['to: "/finance/tds"', "view_tds"],
      ['to: "/finance/banks"', "view_bank_accounts"],
    ] as const) {
      const at = nav.indexOf(route);
      expect(at, route).toBeGreaterThan(-1);
      expect(nav.slice(at, at + 200), route).toContain(flag);
    }
  });

  it("gates each Catalog page on its own flag", () => {
    const nav = read("lib/access.ts");
    for (const [route, flag] of [
      ['{ to: "/insurers", label: "Insurers"', "view_insurers"],
      ['{ to: "/brokers", label: "Brokers"', "view_brokers"],
      ['to: "/insurance/policy-types"', "view_policy_types"],
    ] as const) {
      const at = nav.indexOf(route);
      expect(at, route).toBeGreaterThan(-1);
      expect(nav.slice(at, at + 160), route).toContain(flag);
    }
  });

  it("never mentions a retired umbrella flag anywhere in src", () => {
    // The umbrellas kept their NAMES out of the codebase for a reason: a
    // surviving `has("view_finance")` is permanently false, which fails silently
    // and always in the "not allowed" direction — the exact shape of the
    // 2026-08-05 portal-launch bug.
    // Filtered in JS rather than via the glob's `ignore`: on Windows the
    // returned paths are backslash-separated, so `**/*.test.*` matches nothing
    // below the top level and the sweep quietly includes the test files.
    const files = globSync("**/*.{ts,tsx}", { cwd: join(__dirname, "..") })
      .filter((f) => !f.includes(".test."));
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      for (const dead of ['"view_team"', '"manage_team"', '"view_finance"',
                          '"manage_finance"']) {
        if (src.includes(`has(${dead})`) || src.includes(`anyPerm: [${dead}]`)) {
          offenders.push(`${f}: ${dead}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("draws the person buttons from the right population's flag", () => {
    // Staff and partners are separate grants; PersonDetailBody must consult the
    // one matching the record on screen or it draws a button that 403s.
    const body = read("components/PersonDetailBody.tsx");
    expect(body).toContain('has(isEmp ? "manage_employees" : "manage_partners")');
  });
});
