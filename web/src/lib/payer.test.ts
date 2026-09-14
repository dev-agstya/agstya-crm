import { describe, expect, it } from "vitest";
import { PAID_BY_OPTIONS, paidByLabel } from "./payer";

describe("PAID_BY_OPTIONS", () => {
  it("offers the three explicit payers", () => {
    expect(PAID_BY_OPTIONS.map((o) => o.value)).toEqual([
      "agency", "customer", "channel_partner"]);
  });
});

describe("paidByLabel", () => {
  it("labels each payer", () => {
    expect(paidByLabel("agency")).toBe("Agastya Agency");
    expect(paidByLabel("customer")).toBe("Customer");
    expect(paidByLabel("channel_partner")).toBe("Channel Partner");
  });
});
