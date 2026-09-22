// The channel-partner surface on the STAFF side (owner G1-G3, H1, I1).
//
// Three changes on 2026-08-06, each of which is easy to half-undo:
//
//   * the Channel Partners page opened up to every employee, scoped by the
//     server to their own roster — but ADDING a partner did not
//   * "Portal settings" left the top of that page for Settings, where an
//     owner-level master switch belongs
//   * a new partner can finish onboarding without a PAN and an Aadhaar, which
//     is what stood between "invited" and "signed in"
//
// Source-level assertions, like the other sweep tests: what is protected is an
// omission (no button, no required flag) and a render test would have to mount
// the app plus a fake server to see one absent.

import { describe, expect, it } from "vitest";
import { canAccess, gateForPath } from "./access";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such source file: ${rel}`);
  return text;
}

function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/* ---------------------------------------------- the Channel Partners page --- */

describe("the Channel Partners page", () => {
  const page = () => code("pages/ChannelPartnersPage.tsx");

  it("has no Portal settings button any more (owner 2026-08-06)", () => {
    expect(page()).not.toContain("Portal settings");
    expect(page()).not.toContain("/people/partners/portal");
  });

  it("hides Add Channel Partner from someone who may not add one", () => {
    // Owner G3: an employee works their roster; the agency decides who joins
    // it. The server refuses either way (manage_partners on POST /users/partners),
    // so this is about not showing a button that 403s.
    expect(page()).toContain('const canAdd = has("manage_partners")');
    expect(page()).toMatch(/actions=\{canAdd &&/);
  });

  it("says whose partners it is showing", () => {
    // A list that silently hides most of its rows is worse than one that says
    // what it is showing.
    expect(page()).toContain('const everyone = has("view_partners")');
    expect(page()).toContain("you are the relationship manager for");
  });

  it("carries the team view rather than a second page", () => {
    expect(page()).toContain("<ManagerRosterPanel />");
    expect(page()).toContain('params.get("view") === "team"');
  });

  it("never filters the list client-side", () => {
    // The scope is applied in the QUERY server-side (routers/users.list_users).
    // A client-side filter would be both a lie and bypassable.
    expect(page()).not.toMatch(/rows\.filter|\.filter\(\(u\)/);
    expect(page()).not.toContain("relationship_manager_id ===");
  });
});

/* ---------------------------------------- opening a record vs changing it --- */

describe("a manager reads their partner's record without owning it", () => {
  const body = () => code("components/PersonDetailBody.tsx");

  it("shows no Edit button without the partner manage right (owner G4)", () => {
    // Reading the record is the job; changing it is not. PATCH /users/{id}
    // still demands it, so the button must not be there to press.
    // Split 2026-08-07: the right consulted is the one for THIS person's
    // population, matching routers/users._can_manage.
    expect(body()).toContain(
      'has(isEmp ? "manage_employees" : "manage_partners")');
    expect(body()).toMatch(/\{canEdit && \(\s*<button key="edit"/);
  });

  it("shows the account status but not the switch", () => {
    expect(body()).toMatch(/\{canEdit \? \(\s*<button/);
  });

  it("offers no delete at all without the manage right", () => {
    expect(body()).toContain("{!canEdit ? null : linked");
  });
});

/* -------------------------------------------------------- portal settings --- */

describe("the portal's settings moved to Settings (owner H1)", () => {
  it("is reachable from the Settings page, owner only", () => {
    const settings = code("pages/SettingsPage.tsx");
    // expect(settings).toContain("/settings/partner-portal"); // Removed in v1.1
    expect(settings).toContain('user.account_type === "owner"');
    expect(canAccess(gateForPath("/settings/partner-portal")!, "owner",
                     () => false)).toBe(true);
    expect(canAccess(gateForPath("/settings/partner-portal")!, "employee",
                     () => true)).toBe(false);
  });

  it("was moved, not deleted — the master switch still exists", () => {
    // Deleting the button alone would have frozen the portal on/off switch,
    // six capability flags and the quote validity at whatever they happened to
    // be, with no way back short of a deploy.
    const settings = code("pages/people/PartnerPortalSettingsPage.tsx");
    expect(settings).toContain("Portal is");
    expect(settings).toContain("quote_validity_days");
    // ...and it points BACK to where it now lives.
    expect(settings).toContain('backTo="/settings"');
  });

  it("redirects the old URL rather than 404ing it", () => {
    expect(code("App.tsx")).toMatch(
      /path="\/people\/partners\/portal"[\s\S]{0,120}\/settings\/partner-portal/);
  });
});

/* ------------------------------------------------- a partner's first login --- */

describe("a new channel partner can actually get in (owner I1)", () => {
  const onboarding = () => code("pages/OnboardingPage.tsx");

  it("lets a partner past the KYC step with nothing typed", () => {
    const src = onboarding();
    expect(src).toContain('const isPartner = user?.account_type === "channel_partner"');
    expect(src).toContain("const panOk = !pan.trim() ? isPartner");
    expect(src).toContain("const aadhaarOk = !aadhaar.trim()");
    expect(src).toContain("const docsOk = isPartner");
  });

  it("still validates anything a partner DOES type", () => {
    // A malformed PAN is worse than a missing one: it looks collected.
    expect(onboarding()).toContain("PAN_RE.test(pan.toUpperCase())");
    expect(onboarding()).toContain("AADHAAR_RE.test(aadhaar.replace");
  });

  it("keeps KYC mandatory for staff", () => {
    // `required` follows the account type, in both directions.
    const src = onboarding();
    expect(src).toContain('label="PAN number" required={!isPartner}');
    expect(src).toContain('label="Aadhaar number" required={!isPartner}');
  });

  it("sends nothing rather than an empty string", () => {
    const src = onboarding();
    expect(src).toContain("pan.trim() ? pan.toUpperCase() : null");
    expect(src).toContain('aadhaar.trim() ? aadhaar.replace(/\\s+/g, "") : null');
  });

  it("never lets anyone skip setting their own password", () => {
    // Onboarding is also where the emailed temporary password is replaced.
    // Making KYC optional must not have made the wizard skippable.
    expect(onboarding()).toContain("passwordOk");
    expect(onboarding()).toContain("pw.length >= 8");
  });
});
