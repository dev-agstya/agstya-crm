// "Make sure you go in depth and find every date field and correct it, not a
// single date field should be in other format." (owner, 2026-07-26)
//
// Auditing that by eye works once and then rots the next time someone adds a
// form. So it is a test: sweep the source tree and fail if a raw browser date
// control — which renders in the viewer's locale and cannot be told not to —
// reappears anywhere outside the one component that wraps it.

import { describe, expect, it } from "vitest";

// Vite's own glob rather than node:fs, so the sweep needs no extra types and
// runs the same way the app is bundled.
// Rooted at the project, not at this file: a file-relative glob collapses
// same-directory keys to "./format.ts", which makes the paths depend on where
// the test happens to live.
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

// The single place a native date control is allowed to exist: DateInput hides
// one to borrow the browser's calendar popup, and never shows its text.
const WRAPPER = "components/DateInput.tsx";

// Comment lines are skipped — several of these files explain the rule in prose
// and would otherwise report themselves.
const isComment = (line: string) => /^(\/\/|\/\*|\*)/.test(line.trim());

function appFiles(): [string, string][] {
  return Object.entries(SOURCES)
    .map(([p, text]) => [p.replace(/\\/g, "/").replace(/^\/src\//, ""), text] as
      [string, string])
    .filter(([p]) => !/\.test\.tsx?$/.test(p) && !/\.d\.ts$/.test(p));
}

function offenders(pattern: RegExp, allow: string[] = []): string[] {
  const hits: string[] = [];
  for (const [file, text] of appFiles()) {
    if (allow.some((a) => file.endsWith(a))) continue;
    text.split("\n").forEach((line, i) => {
      if (!isComment(line) && pattern.test(line))
        hits.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
  return hits;
}

describe("no raw browser date controls survive", () => {
  it("finds the source tree it is meant to be auditing", () => {
    const files = appFiles().map(([f]) => f);
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain(WRAPPER);
    expect(files).toContain("pages/PoliciesPage.tsx");
  });

  it('has no <input type="date"> outside DateInput', () => {
    // Every one of these rendered mm/dd/yyyy on a US-configured browser.
    expect(offenders(/type=["']date["']/, [WRAPPER])).toEqual([]);
  });

  it('has no <input type="datetime-local"> outside DateInput', () => {
    expect(offenders(/type=["']datetime-local["']/, [WRAPPER])).toEqual([]);
  });

  it("has no bare toLocaleDateString()/toLocaleString() anywhere", () => {
    // With no locale argument the browser picks, and en-US answers month-first
    // even when the options spell out day/month/year. format.ts pins en-IN;
    // everything else must go through formatDate / formatDateTime.
    expect(offenders(/toLocale(Date)?String\(\s*\)/)).toEqual([]);
    expect(offenders(/toLocale(Date)?String\(\s*undefined\s*,/)).toEqual([]);
  });

  it("keeps the locale pinned in format.ts itself", () => {
    const format = appFiles().find(([f]) => f === "lib/format.ts")![1];
    expect(format).toContain('const DATE_LOCALE = "en-IN"');
  });

  it("routes every date form field through the shared component", () => {
    // A page that still imports nothing but renders a date is the shape of the
    // next regression; this at least proves the component is actually adopted.
    const users = appFiles()
      .filter(([, text]) => /from ["'][^"']*DateInput["']/.test(text))
      .map(([f]) => f);
    expect(users.length).toBeGreaterThanOrEqual(8);
    expect(users).toContain("pages/OnboardingPage.tsx");
    expect(users).toContain("components/PolicyCustomFields.tsx");
  });
});

describe("the sweep would actually catch a regression", () => {
  // Guard the guard: a pattern that matches nothing is a test that always
  // passes. Prove each one fires on the code it is meant to reject.
  it("matches the markup it is looking for", () => {
    const rawDate = /type=["']date["']/;
    const rawDateTime = /type=["']datetime-local["']/;
    const bareLocale = /toLocale(Date)?String\(\s*\)/;

    expect(rawDate.test('<input type="date" className="input" />')).toBe(true);
    expect(rawDate.test("<input type='date' />")).toBe(true);
    expect(rawDateTime.test('<input type="datetime-local" />')).toBe(true);
    expect(bareLocale.test("new Date(x).toLocaleDateString()")).toBe(true);
    expect(bareLocale.test("d.toLocaleString()")).toBe(true);

    // …and does not fire on the replacement.
    expect(rawDate.test("<DateInput value={v} onChange={set} />")).toBe(false);
    expect(bareLocale.test('d.toLocaleDateString("en-IN", opts)')).toBe(false);
  });

  it("does not quietly skip every file", () => {
    // If the glob ever stops resolving, `offenders` returns [] and all the
    // assertions above pass for the wrong reason.
    expect(offenders(/import /).length).toBeGreaterThan(100);
  });
});
