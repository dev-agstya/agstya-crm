// Lead types and the removal of "convert to customer" (owner 2026-08-03),
// from the client's side.
//
// The server is the authority on both; these pin the pieces the browser owns —
// the labels, the tab list, and the fact that nothing can still call the
// endpoint that used to delete a lead.

import { describe, expect, it } from "vitest";
import { LEAD_TYPES, LEAD_TYPE_LABELS } from "./types";
import type { LeadType } from "./types";
import { leadsApi } from "../api/endpoints";

const EXPECTED: LeadType[] = ["customer", "channel_partner", "business"];

describe("the three lead types", () => {
  it("are the ones the owner asked for, in that order", () => {
    expect(LEAD_TYPES.map((t) => t.value)).toEqual(EXPECTED);
  });

  it("has a human label for every one", () => {
    for (const t of EXPECTED) {
      expect(LEAD_TYPE_LABELS[t]).toBeTruthy();
      // Sentence case, not Title Case: the app writes "Channel partner".
      expect(LEAD_TYPE_LABELS[t]).not.toMatch(/ [A-Z]/);
    }
  });

  it("keeps the dropdown and the label map in step", () => {
    // Two lists of the same thing is how a filter ends up showing a raw
    // "channel_partner" in one place and "Channel partner" in another.
    for (const t of LEAD_TYPES) {
      expect(t.label).toBe(LEAD_TYPE_LABELS[t.value]);
    }
  });

  it("does not carry the old individual/business flag", () => {
    expect(LEAD_TYPES.map((t) => t.value)).not.toContain("individual");
  });
});

describe("the leads API surface", () => {
  it("no longer exposes convert", () => {
    // It created a customer and then DELETED the lead. Leaving the client
    // method in place is how a stray call still destroys a record.
    expect("convert" in leadsApi).toBe(false);
  });

  it("exposes the counts endpoint the tabs need", () => {
    expect(typeof leadsApi.counts).toBe("function");
  });

  it("can still move a lead to the converted stage", () => {
    // Removing the button must not remove the ability to mark a lead won.
    expect(typeof leadsApi.setStage).toBe("function");
  });
});
