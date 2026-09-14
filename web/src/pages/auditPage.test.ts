// Audit page (2026-09-12): no horizontal scroll, no raw ObjectId anywhere.
//
// The table used to carry Action/Who/When/IP/(3-dot menu) inside a
// minWidth-720 ledger, which didn't fit next to the sidebar and scrolled
// sideways with the one column worth reading (the summary) cut off on the
// left. IP and the row menu moved to the detail page; the raw Mongo
// ObjectId ("Record ID") was dropped from the detail page too — only the
// human-facing code (CP-264JL2, EMP-0042, ...) is ever shown.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/pages/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function src(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such file: ${rel}`);
  return text;
}

describe("audit list — no horizontal-scroll columns", () => {
  const page = src("pages/AuditPage.tsx");

  it("does not render an IP column in the table", () => {
    expect(page).not.toMatch(/<LTh>IP<\/LTh>/);
    expect(page).not.toContain("ip_address");
  });

  it("does not render a row menu / 3-dot button", () => {
    expect(page).not.toContain("RowMenu");
  });

  it("does not force a minWidth wider than the three remaining columns need",
    () => {
      expect(page).not.toMatch(/minWidth=\{?\d/);
    });
});

describe("audit detail — names over ids, and no raw ObjectId", () => {
  const detail = src("pages/audit/AuditDetailPage.tsx");

  it("never renders the raw entity_id (the Mongo ObjectId)", () => {
    expect(detail).not.toContain("entity_id}");
    expect(detail).not.toMatch(/label="Record ID"/);
  });

  it("still shows the human-facing entity code", () => {
    expect(detail).toContain("entity_code");
  });
});
