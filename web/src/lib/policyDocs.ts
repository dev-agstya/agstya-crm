import type { CustomerDocument, RequiredDocSpec } from "./types";

// The policy PDF is stored as a single document record with doc_key
// "policy_pdf" (see server/app/routers/policies.py:upload_policy_document).
export const POLICY_PDF_KEY = "policy_pdf";

/**
 * The policy's own PDF, out of everything attached to it.
 *
 * Older/edge records may carry no doc_key at all, so an UNTAGGED upload is
 * accepted as the fallback (the documents API returns newest-first). A document
 * tagged with some OTHER key is never the answer: those are the type's
 * supporting slots — an RC book is not the policy, and offering it behind a
 * "Download" button that says it is was the old fallback's real bug.
 */
export function pickPolicyPdf(
  docs: CustomerDocument[] | undefined | null,
): CustomerDocument | undefined {
  if (!docs || docs.length === 0) return undefined;
  return docs.find((d) => d.doc_key === POLICY_PDF_KEY)
    ?? docs.find((d) => !d.doc_key);
}

/** One line in the policy's Documents list. */
export type PolicyDocRow = {
  /** The slot this row fills. Null for a loose/legacy upload with no key. */
  key: string | null;
  label: string;
  /** Undefined on a configured slot that has nothing in it yet. */
  doc?: CustomerDocument;
  /**
   * `pdf`   — the policy document itself (replace-only, never deleted here)
   * `slot`  — a slot the policy TYPE asks for (may be empty)
   * `extra` — anything else attached to this policy
   */
  kind: "pdf" | "slot" | "extra";
  required: boolean;
};

/**
 * Every document a policy has, plus every slot its type asks for and hasn't got.
 *
 * The policy page used to show ONE file — `pickPolicyPdf` chose it and the rest
 * were loaded, ignored and invisible, so the supporting documents collected at
 * booking could not be read back (owner 2026-08-04). One list, in a fixed
 * order, is what replaced it:
 *
 *   1. the policy PDF, always, even when it is missing
 *   2. the type's configured slots in their configured order — INCLUDING the
 *      empty ones, because a missing required document is the thing you want to
 *      notice on this page (owner B3)
 *   3. everything else, newest first
 *
 * A document is matched to a slot by doc_key. Two documents sharing a key
 * cannot happen (the upload endpoint replaces a slot's previous file), but if
 * one ever did the extras below catch it rather than dropping it.
 */
export function buildPolicyDocRows(
  docs: CustomerDocument[] | undefined | null,
  slots: RequiredDocSpec[] | undefined | null,
): PolicyDocRow[] {
  const all = docs ?? [];
  const pdf = pickPolicyPdf(all);
  const used = new Set<string>();
  if (pdf) used.add(pdf.id);

  const rows: PolicyDocRow[] = [
    { key: POLICY_PDF_KEY, label: "Policy PDF", doc: pdf, kind: "pdf",
      required: true },
  ];

  for (const slot of slots ?? []) {
    if (slot.key === POLICY_PDF_KEY) continue;   // never two PDF rows
    const doc = all.find((d) => d.doc_key === slot.key && !used.has(d.id));
    if (doc) used.add(doc.id);
    rows.push({ key: slot.key, label: slot.label, doc, kind: "slot",
      required: !!slot.required });
  }

  for (const doc of all) {
    if (used.has(doc.id)) continue;
    rows.push({ key: doc.doc_key ?? null, label: doc.label || doc.filename,
      doc, kind: "extra", required: false });
  }
  return rows;
}

/** Slots the type asks for, marked required, that have nothing in them. */
export function missingRequiredDocs(rows: PolicyDocRow[]): PolicyDocRow[] {
  return rows.filter((r) => r.required && !r.doc);
}

/** A doc_key for a one-off document added from the policy page. Unique, so it
 *  can never replace an existing slot's file. */
export function customDocKey(): string {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
