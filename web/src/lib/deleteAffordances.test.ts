// Delete is offered everywhere; the LINKS decide whether it goes through.
//
// The owner's rule (2026-07-26): keep the delete button on every page. An
// insurer, broker or policy type nothing points at is a typo someone should be
// able to clear up — one a policy names has to be deactivated instead. Same for
// a customer with a policy against them.
//
// The server is the enforcement (services/references.py). The UI's job is to
// never dead-end: a click either deletes, or explains why not and offers the
// action that will work. These sweep the source to pin that.

import { describe, expect, it } from "vitest";
import { blockedMessage, deleteAllowed, deleteMessage } from "./deleteGuard";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(path: string): string {
  const text = SOURCES[`/src/${path}`];
  if (text === undefined) throw new Error(`${path} not found — did it move?`);
  return text;
}

// Every page that can remove one of the relational records.
const DELETE_PAGES = [
  ["pages/catalog/InsurerFormPage.tsx", "insurer"],
  ["pages/catalog/BrokerFormPage.tsx", "broker"],
  ["pages/PolicyTypesPage.tsx", "policy type"],
  ["pages/customers/CustomerDetailPage.tsx", "customer"],
] as const;

describe("the delete button exists everywhere", () => {
  it.each(DELETE_PAGES)("%s offers a delete", (file) => {
    const text = source(file);
    expect(text).toMatch(/Icon\.Trash/);
    expect(text).toContain("askDelete({");
  });

  it("the People record offers one too", () => {
    expect(source("components/PersonDetailBody.tsx")).toContain("Icon.Trash");
  });

  it.each(DELETE_PAGES)("%s never hides it behind the account type", (file) => {
    const text = source(file);
    // An earlier pass gated these on being the owner. The rule is the links.
    expect(text).not.toContain('account_type === "owner"');
    expect(text).not.toContain("isOwner");
  });

  it("the People record is not owner-gated either", () => {
    expect(source("components/PersonDetailBody.tsx")).not.toContain("isOwner");
  });

  it.each(DELETE_PAGES)("%s never disables it on in_use", (file) => {
    // Disabling would leave someone clicking a dead control with no reason
    // given. It stays live and answers the question instead.
    const text = source(file);
    expect(text).not.toMatch(/disabled=\{[^}]*in_use/);
  });
});

describe("askDelete asks the right question", () => {
  it("allows a delete only when nothing points at the record", () => {
    expect(deleteAllowed(false)).toBe(true);
    expect(deleteAllowed(true)).toBe(false);
  });

  it("says the delete is safe when it is", () => {
    const msg = deleteMessage("insurer", "HDFC Life");
    expect(msg).toContain("HDFC Life");
    expect(msg).toContain("Nothing in the app uses this insurer yet");
    expect(msg).toContain("can't be undone");
  });

  it("names the way forward when it isn't", () => {
    const msg = blockedMessage("broker", "PolicyBazaar", "Deactivate",
                               "no new business goes through it.");
    expect(msg).toContain("PolicyBazaar");
    // Why, not just "no".
    expect(msg).toContain("point at it");
    expect(msg).toContain("Deactivate instead");
  });

  it("uses the entity's own word for the alternative", () => {
    // A customer is archived; sending someone to look for "Deactivate" on the
    // Customers page would be a wild goose chase.
    const msg = blockedMessage("customer", "Rajan", "Archive", "they're hidden.");
    expect(msg).toContain("Archive instead");
    expect(msg).not.toContain("Deactivate");
  });
});

describe("pages offer the correct fallback action", () => {
  it.each([
    ["pages/catalog/InsurerFormPage.tsx"],
    ["pages/catalog/BrokerFormPage.tsx"],
    ["pages/PolicyTypesPage.tsx"],
  ])("%s falls back to deactivating", (file) => {
    const text = source(file);
    expect(text).toContain('fallbackLabel: "Deactivate"');
    expect(text).toContain('choice === "fallback"');
  });

  it("customers fall back to archiving, not deactivating", () => {
    const text = source("pages/customers/CustomerDetailPage.tsx");
    expect(text).toContain('fallbackLabel: "Archive"');
    expect(text).toContain("archive.mutate(true)");
  });

  it("treats a missing in_use as in-use, the safe answer", () => {
    expect(source("pages/customers/CustomerDetailPage.tsx"))
      .toContain("c.in_use !== false");
    expect(source("components/PersonDetailBody.tsx"))
      .toContain("user.in_use !== false");
  });
});

describe("deactivate never travels as a delete", () => {
  it("policy types deactivate through the update endpoint", () => {
    const text = source("pages/PolicyTypesPage.tsx");
    // Was categoriesApi.remove(id), which hit DELETE and set active=false —
    // a verb that did something other than what it said. remove() is now a
    // real delete, called from the delete button.
    expect(text).toContain("categoriesApi.update(id, { active: false })");
    expect(text).toContain("categoriesApi.remove");
  });

  it("brokers gained the deactivate control they never had", () => {
    // The edit screen is a route now, so the record comes from the URL rather
    // than from state — the control itself is unchanged.
    const text = source("pages/catalog/BrokerFormPage.tsx");
    expect(text).toContain('record.active ? "Deactivate" : "Activate"');
  });

  it("the broker row status is read-only", () => {
    // Deactivating from a dense list row is one mis-click from switching off a
    // live broker; it lives in the edit popup with the delete, like Insurers.
    expect(source("pages/catalog/BrokerFormPage.tsx"))
      .not.toContain("canManage && toggleActive.mutate(b)");
  });
});

describe("the People pages say what they mean", () => {
  it.each([
    ["pages/EmployeesPage.tsx"],
    ["pages/ChannelPartnersPage.tsx"],
  ])("%s asks for switched-off accounts, not deleted ones", (file) => {
    const text = source(file);
    expect(text).toContain("inactive: 1");
    expect(text).toContain("Show deactivated");
    expect(text).not.toContain("deleted: 1");
    expect(text).not.toContain("Show deleted");
  });

  it("keeps a deactivated person openable so they can be switched back on", () => {
    const text = source("components/PeopleTable.tsx");
    expect(text).toContain("u.is_deleted ?");
    expect(text).toContain("View profile");
  });

  it("distinguishes deactivated from removed", () => {
    // Two different states: DEACTIVATED is switched off but intact and must
    // stay openable (reactivating happens on their own profile); REMOVED is
    // gone and read-only. Case-insensitive because the labels are badges and
    // every badge in the app is lower-case — what matters is that the two
    // states are still told apart, not how they are capitalised.
    const text = source("components/PeopleTable.tsx").toLowerCase();
    expect(text).toContain("deactivated");
    expect(text).toContain("removed");
  });
});

describe("in_use reaches the client", () => {
  it("is carried on every record that offers a delete", () => {
    const types = source("lib/types.ts");
    // Insurer / Broker / PolicyCategory get it as a required field: a response
    // that omits it should be a type error, not a wrongly-worded dialog.
    expect(types.match(/in_use: boolean;/g)?.length).toBeGreaterThanOrEqual(3);
    // Customer and UserRow are optional, with the safe default applied in code.
    expect(types.match(/in_use\?: boolean;/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
