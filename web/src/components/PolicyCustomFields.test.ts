import { describe, expect, it } from "vitest";
import { splitCustomFields, validateDetailsClient } from "./PolicyCustomFields";
import type { CustomFieldSpec } from "../lib/types";

const spec = (p: Partial<CustomFieldSpec>): CustomFieldSpec => ({
  key: p.key ?? "k", label: p.label ?? "L", type: p.type ?? "text",
  required: p.required ?? false, options: p.options ?? [],
  hint: p.hint ?? null, min_value: p.min_value ?? null,
  max_value: p.max_value ?? null, is_reward_base: p.is_reward_base ?? false,
});

describe("splitCustomFields", () => {
  it("separates amount fields from the rest, preserving order", () => {
    const fields = [
      spec({ key: "note", type: "text" }),
      spec({ key: "od", type: "amount" }),
      spec({ key: "veh", type: "text" }),
      spec({ key: "tp", type: "amount" }),
    ];
    const { amount, other } = splitCustomFields(fields);
    expect(amount.map((f) => f.key)).toEqual(["od", "tp"]);
    expect(other.map((f) => f.key)).toEqual(["note", "veh"]);
  });
});

describe("validateDetailsClient", () => {
  it("flags a missing required field", () => {
    const fields = [spec({ key: "vehicle_no", label: "Vehicle No",
      type: "text", required: true })];
    expect(validateDetailsClient(fields, {})).toMatch(/Vehicle No.*required/);
  });
  it("passes when a required field is filled", () => {
    const fields = [spec({ key: "vehicle_no", label: "Vehicle No",
      type: "text", required: true })];
    expect(validateDetailsClient(fields, { vehicle_no: "MH12" })).toBeNull();
  });
  it("enforces amount bounds in rupees", () => {
    const fields = [spec({ key: "od", label: "OD", type: "amount",
      min_value: 100 })];
    // stored in paise: 5000 paise = ₹50 < ₹100 min
    expect(validateDetailsClient(fields, { od: 5000 })).toMatch(/at least 100/);
    expect(validateDetailsClient(fields, { od: 20000 })).toBeNull();
  });
});
