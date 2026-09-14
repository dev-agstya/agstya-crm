import { describe, expect, it } from "vitest";
import {
  POLICY_PDF_KEY,
  buildPolicyDocRows,
  customDocKey,
  missingRequiredDocs,
  pickPolicyPdf,
} from "./policyDocs";
import type { CustomerDocument, RequiredDocSpec } from "./types";

function doc(overrides: Partial<CustomerDocument>): CustomerDocument {
  return {
    id: "d1",
    entity_type: "policy",
    entity_id: "p1",
    doc_key: null,
    label: "Policy PDF",
    filename: "policy.pdf",
    status: "uploaded",
    created_at: "2026-07-09T00:00:00Z",
    ...overrides,
  };
}

function slot(overrides: Partial<RequiredDocSpec>): RequiredDocSpec {
  return { key: "rc_book", label: "RC book", required: false, accepts: [],
    ...overrides };
}

describe("pickPolicyPdf", () => {
  it("returns undefined when there are no documents", () => {
    expect(pickPolicyPdf(undefined)).toBeUndefined();
    expect(pickPolicyPdf(null)).toBeUndefined();
    expect(pickPolicyPdf([])).toBeUndefined();
  });

  it("prefers the document tagged with doc_key 'policy_pdf'", () => {
    const other = doc({ id: "other", doc_key: "kyc", filename: "kyc.pdf" });
    const target = doc({ id: "target", doc_key: POLICY_PDF_KEY });
    expect(pickPolicyPdf([other, target])?.id).toBe("target");
  });

  it("falls back to the first (newest) UNTAGGED document when none is tagged",
    () => {
      const newest = doc({ id: "newest", filename: "new.pdf" });
      const older = doc({ id: "older", filename: "old.pdf" });
      expect(pickPolicyPdf([newest, older])?.id).toBe("newest");
    });

  it("never passes off a supporting document as the policy", () => {
    // The old fallback took docs[0] whatever it was, so a policy with an RC
    // book and no PDF offered the RC book behind a "Download" button labelled
    // as the policy document.
    const rc = doc({ id: "rc", doc_key: "rc_book", label: "RC book" });
    expect(pickPolicyPdf([rc])).toBeUndefined();
  });
});

describe("buildPolicyDocRows", () => {
  it("always leads with the policy PDF, even when it is missing", () => {
    const rows = buildPolicyDocRows([], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("pdf");
    expect(rows[0].doc).toBeUndefined();
    expect(rows[0].required).toBe(true);
  });

  it("shows the supporting documents that used to be invisible", () => {
    // The whole point: these were loaded by the page and then discarded.
    const pdf = doc({ id: "pdf", doc_key: POLICY_PDF_KEY });
    const rc = doc({ id: "rc", doc_key: "rc_book", label: "RC book",
      filename: "rc.jpg" });
    const rows = buildPolicyDocRows([pdf, rc], [slot({ key: "rc_book" })]);
    expect(rows.map((r) => r.doc?.id)).toEqual(["pdf", "rc"]);
  });

  it("keeps an empty configured slot on screen so a gap is visible", () => {
    const rows = buildPolicyDocRows(
      [doc({ id: "pdf", doc_key: POLICY_PDF_KEY })],
      [slot({ key: "rc_book", label: "RC book", required: true })]);
    const rc = rows.find((r) => r.key === "rc_book")!;
    expect(rc.doc).toBeUndefined();
    expect(rc.kind).toBe("slot");
    expect(missingRequiredDocs(rows).map((r) => r.label)).toEqual(["RC book"]);
  });

  it("follows the type's configured slot order, not upload order", () => {
    const rows = buildPolicyDocRows(
      [doc({ id: "prev", doc_key: "prev_policy" }),
        doc({ id: "rc", doc_key: "rc_book" })],
      [slot({ key: "rc_book", label: "RC book" }),
        slot({ key: "prev_policy", label: "Previous policy" })]);
    expect(rows.slice(1).map((r) => r.key))
      .toEqual(["rc_book", "prev_policy"]);
  });

  it("lists one-off and legacy uploads after the configured slots", () => {
    const pdf = doc({ id: "pdf", doc_key: POLICY_PDF_KEY });
    const custom = doc({ id: "custom", doc_key: "custom_123",
      label: "Survey report", filename: "survey.pdf" });
    const rows = buildPolicyDocRows([pdf, custom], [slot({ key: "rc_book" })]);
    expect(rows.map((r) => r.kind)).toEqual(["pdf", "slot", "extra"]);
    expect(rows[2].label).toBe("Survey report");
  });

  it("falls back to the filename when a loose upload has no label", () => {
    const rows = buildPolicyDocRows(
      [doc({ id: "pdf", doc_key: POLICY_PDF_KEY }),
        doc({ id: "loose", doc_key: "x", label: "", filename: "scan.png" })],
      []);
    expect(rows[1].label).toBe("scan.png");
  });

  it("counts an untagged document once — as the PDF, not also as an extra",
    () => {
      const legacy = doc({ id: "legacy", doc_key: null });
      const rows = buildPolicyDocRows([legacy], []);
      expect(rows).toHaveLength(1);
      expect(rows[0].doc?.id).toBe("legacy");
    });

  it("never draws two policy-PDF rows when a type declares that key", () => {
    const rows = buildPolicyDocRows(
      [doc({ id: "pdf", doc_key: POLICY_PDF_KEY })],
      [slot({ key: POLICY_PDF_KEY, label: "Policy PDF" })]);
    expect(rows.filter((r) => r.kind === "pdf")).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("survives no documents and no slots at all", () => {
    expect(buildPolicyDocRows(undefined, undefined)).toHaveLength(1);
    expect(buildPolicyDocRows(null, null)).toHaveLength(1);
  });
});

describe("customDocKey", () => {
  it("is unique, so a one-off upload can never replace a slot's file", () => {
    const keys = new Set(Array.from({ length: 50 }, () => customDocKey()));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k.startsWith("custom_")).toBe(true);
  });
});
