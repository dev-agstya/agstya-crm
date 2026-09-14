// A unique field says whether it is free WHILE YOU TYPE.
//
// Owner, 2026-07-26, on the insurer short name: "if that is supposed to be
// unique then please show if it is available or not — why show error after I
// click save! ... just make same logic like broker code."
//
// The broker short code already worked this way. These sweep both forms so the
// insurer short name cannot quietly drift back to save-then-409, and so the two
// keep behaving the same way.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(path: string): string {
  const text = SOURCES[`/src/${path}`];
  if (text === undefined) throw new Error(`${path} not found — did it move?`);
  return text;
}

// [page, the api call it must make, the field's own state variable]
const LIVE_CHECKS = [
  ["pages/catalog/InsurerFormPage.tsx", "insurersApi.shortNameAvailable", "nameState"],
  ["pages/catalog/BrokerFormPage.tsx", "brokersApi.shortCodeAvailable", "codeState"],
] as const;

describe("both unique fields check themselves as you type", () => {
  it.each(LIVE_CHECKS)("%s asks the server", (file, call) => {
    expect(source(file)).toContain(call);
  });

  it.each(LIVE_CHECKS)("%s debounces instead of firing per keystroke",
    (file) => {
      const text = source(file);
      expect(text).toContain("setTimeout");
      // Without the cleanup, a stale reply can overwrite a newer one.
      expect(text).toContain("clearTimeout");
    });

  it.each(LIVE_CHECKS)("%s reports both outcomes in the field", (file, _c, st) => {
    const text = source(file);
    expect(text).toContain(`${st} === "checking"`);
    expect(text).toContain(`${st} === "ok"`);
    expect(text).toContain(`${st} === "taken"`);
    expect(text).toMatch(/is available/);
  });

  it.each(LIVE_CHECKS)("%s excludes the record being edited", (file, call) => {
    // Re-saving a record must not report its own value as taken, so the check
    // has to tell the server which record to ignore. The insurer form is a
    // route now and takes that id from the URL; the broker form still holds it
    // in state — either way, SOMETHING identifying the record is passed.
    const text = source(file);
    const args = text.slice(text.indexOf(call), text.indexOf(call) + 200);
    expect(args).toMatch(/editing\?\.id|, ?id\)/);
  });
});

describe("Save cannot be pressed into a known clash", () => {
  it("the insurer form gates on the short name", () => {
    const text = source("pages/catalog/InsurerFormPage.tsx");
    expect(text).toContain("!shortOk");          // submit + button both
    expect(text.match(/!shortOk/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("the broker form still gates on the short code", () => {
    const text = source("pages/catalog/BrokerFormPage.tsx");
    expect(text.match(/!codeOk/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the insurer short name stays optional", () => {
  const text = source("pages/catalog/InsurerFormPage.tsx");

  it("a blank box is allowed through", () => {
    // shortOk must be true when nothing was typed — most insurers have no
    // short name, and a required-looking field would block every one of them.
    expect(text).toMatch(/const shortOk\s*=\s*!shortName\s*\|\|/);
  });

  it("it is not marked required in the UI", () => {
    const field = text.slice(text.indexOf('<Field label="Short name"'),
      text.indexOf('<Field label="Contact person"'));
    expect(field).not.toContain("required");
  });

  it("an unchanged value is not re-checked", () => {
    expect(text).toContain("shortUnchanged");
    // Case-insensitively, because the server compares that way.
    expect(text).toContain("toLowerCase()");
  });
});

describe("the client calls the route the server registers", () => {
  it("uses /api/insurers/short-name-available", () => {
    expect(source("api/endpoints.ts"))
      .toContain("/api/insurers/short-name-available");
  });
});
