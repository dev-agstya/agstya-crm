import { describe, expect, it } from "vitest";
import {
  formatINRShort, maskTail, paiseToRupeeStr, pctText, toDateInput, todayInput,
} from "./format";

describe("maskTail", () => {
  it("masks all but the last 4 characters", () => {
    expect(maskTail("12345678")).toBe("****5678");
    expect(maskTail("POL-26K352")).toBe("****K352");
  });
  it("shows short values whole", () => {
    expect(maskTail("123")).toBe("123");
    expect(maskTail("8745")).toBe("8745");
  });
  it("returns a dash for blank/nullish", () => {
    expect(maskTail("")).toBe("—");
    expect(maskTail(null)).toBe("—");
    expect(maskTail(undefined)).toBe("—");
  });
  it("respects a custom keep length", () => {
    expect(maskTail("998877", 2)).toBe("****77");
  });
});

describe("formatINRShort", () => {
  it("drops the paise decimals to save space", () => {
    // paise -> rupees, Indian grouping, no .00
    expect(formatINRShort(118000)).toBe("₹1,180");
    expect(formatINRShort(760000)).toBe("₹7,600");
  });
  it("renders a dash for nullish", () => {
    expect(formatINRShort(null)).toBe("—");
    expect(formatINRShort(undefined)).toBe("—");
  });
});

describe("pctText", () => {
  it("appends a percent sign", () => {
    expect(pctText(33)).toBe("33%");
    expect(pctText(0)).toBe("0%");
  });
  it("returns a dash for nullish", () => {
    expect(pctText(null)).toBe("—");
    expect(pctText(undefined)).toBe("—");
  });
});

describe("paiseToRupeeStr", () => {
  it("renders plain rupees with two decimals", () => {
    expect(paiseToRupeeStr(118000)).toBe("1180.00");
    expect(paiseToRupeeStr(12345)).toBe("123.45");
    expect(paiseToRupeeStr(0)).toBe("0.00");
  });
  it("returns an empty string for nullish", () => {
    expect(paiseToRupeeStr(null)).toBe("");
    expect(paiseToRupeeStr(undefined)).toBe("");
  });
});

describe("todayInput / toDateInput", () => {
  it("todayInput is a local yyyy-mm-dd matching the current date", () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${
      String(now.getMonth() + 1).padStart(2, "0")}-${
      String(now.getDate()).padStart(2, "0")}`;
    expect(todayInput()).toBe(expected);
  });
  it("toDateInput uses the LOCAL calendar day (no UTC midnight flip)", () => {
    // A specific instant -> the local date components, not the UTC slice.
    const iso = "2026-07-25T18:30:00Z";
    const d = new Date(iso);
    const expected = `${d.getFullYear()}-${
      String(d.getMonth() + 1).padStart(2, "0")}-${
      String(d.getDate()).padStart(2, "0")}`;
    expect(toDateInput(iso)).toBe(expected);
  });
  it("toDateInput returns '' for blank/invalid input", () => {
    expect(toDateInput(null)).toBe("");
    expect(toDateInput(undefined)).toBe("");
    expect(toDateInput("not-a-date")).toBe("");
  });
});
