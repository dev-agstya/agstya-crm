// `has()` decides which in-page controls render — Add account, Transfer, the
// edit/delete icons, the manage-only empty-state copy. The nav gate
// (lib/access.canAccess) already treats an owner as holding everything; this
// pins that `has()` agrees, because when the two disagreed the result was a
// page the owner could open but not use.
//
// THE BUG (2026-08-02). `User.permissions` is a stored snapshot, written when
// an account is created. The owner is created once and never re-saved, so when
// view/manage_bank_accounts were added to the model the live owner's document
// still held the previous 16 flags. Bank & Cash appeared in their sidebar
// (account-type gate) with no way to add an account (flag-list gate), and the
// empty state told the owner to "ask an owner".
//
// Server-side is the real enforcement (it heals the stored set at
// authentication); this keeps the UI from lying in the meantime.

import { beforeEach, describe, expect, it } from "vitest";
import { useAuth } from "./auth";
import type { Me } from "../lib/types";

const me = (overrides: Partial<Me>): Me => ({
  id: "u1",
  code: "AG-USR-1",
  full_name: "Test",
  email: "test@example.com",
  account_type: "employee",
  permissions: [],
  status: "active",
  must_change_password: false,
  ...overrides,
} as Me);

beforeEach(() => {
  useAuth.setState({ user: null });
});

describe("an owner holds every permission by definition", () => {
  it("says yes to a flag their stored list is missing", () => {
    // Exactly the live shape: the 16 flags that existed before the bank pair.
    useAuth.setState({ user: me({
      account_type: "owner",
      permissions: ["view_policies", "manage_policies", "view_finance"],
    }) });
    const { has } = useAuth.getState();
    expect(has("manage_bank_accounts")).toBe(true);
    expect(has("view_bank_accounts")).toBe(true);
  });

  it("says yes even with an empty permission list", () => {
    useAuth.setState({ user: me({ account_type: "owner", permissions: [] }) });
    expect(useAuth.getState().has("manage_finance")).toBe(true);
  });

  it("says yes to any flag added in future", () => {
    useAuth.setState({ user: me({ account_type: "owner", permissions: [] }) });
    expect(useAuth.getState().has("some_flag_invented_next_year")).toBe(true);
  });
});

describe("everyone else is exactly their stored list", () => {
  it("does not inflate an employee", () => {
    useAuth.setState({ user: me({
      account_type: "employee",
      permissions: ["view_policies"],
    }) });
    const { has } = useAuth.getState();
    expect(has("view_policies")).toBe(true);
    expect(has("manage_bank_accounts")).toBe(false);
    expect(has("view_agency_profit")).toBe(false);
  });

  it("does not inflate a channel partner", () => {
    useAuth.setState({ user: me({
      account_type: "channel_partner",
      permissions: [],
    }) });
    expect(useAuth.getState().has("view_finance")).toBe(false);
  });

  it("says no when nobody is signed in", () => {
    expect(useAuth.getState().has("view_policies")).toBe(false);
  });
});
