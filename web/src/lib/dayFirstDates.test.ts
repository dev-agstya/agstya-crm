// Dates read day-first everywhere (owner 2026-07-26).
//
// The report: "on entire UI you are collecting the date in mm/dd/yyyy format …
// we are from India and these date must be in dd/mm/yyyy". Two separate causes
// sat behind that, and each gets its own section here:
//
//   1. every input was a native <input type="date">, which renders in the
//      BROWSER's locale — so the parsing rules that replace it must be exact;
//   2. formatDate passed `undefined` as the locale, and en-US answers that with
//      "Jul 26, 2026" — month first — even with day/month/year spelled out.

import { describe, expect, it } from "vitest";
import {
  formatDate, formatDateNumeric, formatDateTime, fromDmy, joinLocalDateTime,
  maskDmy, splitLocalDateTime, toDmy,
} from "./format";

describe("maskDmy — slashes appear as you type", () => {
  it("inserts separators at the right places", () => {
    expect(maskDmy("2")).toBe("2");
    expect(maskDmy("26")).toBe("26");
    expect(maskDmy("260")).toBe("26/0");
    expect(maskDmy("2607")).toBe("26/07");
    expect(maskDmy("260720")).toBe("26/07/20");
    expect(maskDmy("26072026")).toBe("26/07/2026");
  });

  it("is idempotent, so re-typing over a formatted value is stable", () => {
    expect(maskDmy("26/07/2026")).toBe("26/07/2026");
    expect(maskDmy(maskDmy("26072026"))).toBe("26/07/2026");
  });

  it("accepts a paste in any separator style", () => {
    expect(maskDmy("26-07-2026")).toBe("26/07/2026");
    expect(maskDmy("26.07.2026")).toBe("26/07/2026");
  });

  it("refuses to grow past a full date", () => {
    expect(maskDmy("260720261234")).toBe("26/07/2026");
  });

  it("drops letters rather than showing them", () => {
    expect(maskDmy("26aa07")).toBe("26/07");
    expect(maskDmy("")).toBe("");
  });
});

describe("toDmy — what the person reads", () => {
  it("flips the stored value round", () => {
    expect(toDmy("2026-07-26")).toBe("26/07/2026");
    expect(toDmy("2026-01-05")).toBe("05/01/2026");
  });

  it("tolerates a full ISO timestamp", () => {
    expect(toDmy("2026-07-26T00:00:00Z")).toBe("26/07/2026");
  });

  it("gives an empty box, never NaN, for nothing", () => {
    expect(toDmy("")).toBe("");
    expect(toDmy(null)).toBe("");
    expect(toDmy(undefined)).toBe("");
    expect(toDmy("garbage")).toBe("");
  });
});

describe("fromDmy — what gets saved", () => {
  it("reads a day-first date the way an Indian user means it", () => {
    // The whole point: 07/06 is the 7th of June, not the 6th of July.
    expect(fromDmy("07/06/2026")).toBe("2026-06-07");
    expect(fromDmy("26/07/2026")).toBe("2026-07-26");
  });

  it("round-trips with toDmy", () => {
    for (const iso of ["2026-07-26", "2024-02-29", "1999-12-31", "2026-01-01"])
      expect(fromDmy(toDmy(iso))).toBe(iso);
  });

  it("holds its peace while the date is half typed", () => {
    expect(fromDmy("26")).toBe("");
    expect(fromDmy("26/07")).toBe("");
    expect(fromDmy("26/07/20")).toBe("");
  });

  it("rejects impossible days instead of rolling them forward", () => {
    // new Date(2026, 1, 31) silently becomes 3 March — a wrong-but-plausible
    // date is worse than an empty field, so these must come back blank.
    expect(fromDmy("31/02/2026")).toBe("");
    expect(fromDmy("31/04/2026")).toBe("");
    expect(fromDmy("29/02/2025")).toBe(""); // 2025 is not a leap year
    expect(fromDmy("29/02/2024")).toBe("2024-02-29"); // 2024 is
  });

  it("rejects out-of-range parts", () => {
    expect(fromDmy("00/07/2026")).toBe("");
    expect(fromDmy("26/00/2026")).toBe("");
    expect(fromDmy("26/13/2026")).toBe("");
    expect(fromDmy("26/07/0026")).toBe("");
  });

  it("accepts a pasted date with any separator", () => {
    expect(fromDmy("26-07-2026")).toBe("2026-07-26");
    expect(fromDmy("26072026")).toBe("2026-07-26");
  });
});

describe("formatDateNumeric", () => {
  it("shows a stored timestamp day-first", () => {
    expect(formatDateNumeric("2026-07-26T00:00:00Z")).toBe("26/07/2026");
  });
  it("dashes out a missing date", () => {
    expect(formatDateNumeric(null)).toBe("—");
    expect(formatDateNumeric("")).toBe("—");
  });
});

describe("formatDate / formatDateTime are pinned, not locale-guessed", () => {
  // The regression that made every readable date month-first on a US machine.
  it("never puts the month before the day", () => {
    const shown = formatDate("2026-07-26T00:00:00Z");
    expect(shown).toContain("26");
    expect(shown).toContain("Jul");
    // "26 Jul 2026", not "Jul 26, 2026".
    expect(shown.indexOf("26")).toBeLessThan(shown.indexOf("Jul"));
  });

  it("holds for a day that could be read either way", () => {
    // 06/07 is the classic ambiguity: 6 July, never 7 June.
    const shown = formatDate("2026-07-06T00:00:00Z");
    expect(shown.trim().startsWith("06")).toBe(true);
    expect(shown).toContain("Jul");
  });

  it("puts the day first in date-times too", () => {
    const shown = formatDateTime("2026-07-06T05:30:00Z");
    expect(shown.trim().startsWith("06")).toBe(true);
  });

  it("still dashes out blanks", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });
});

describe("datetime split/join", () => {
  it("splits a datetime-local value into its two controls", () => {
    expect(splitLocalDateTime("2026-07-26T17:36")).toEqual({
      date: "2026-07-26", time: "17:36",
    });
  });

  it("copes with seconds and with a bare date", () => {
    expect(splitLocalDateTime("2026-07-26T17:36:20").time).toBe("17:36");
    expect(splitLocalDateTime("2026-07-26")).toEqual({
      date: "2026-07-26", time: "",
    });
    expect(splitLocalDateTime("")).toEqual({ date: "", time: "" });
  });

  it("treats a missing time as midnight so the date alone still works", () => {
    expect(joinLocalDateTime("2026-07-26", "")).toBe("2026-07-26T00:00");
    expect(joinLocalDateTime("2026-07-26", "17:36")).toBe("2026-07-26T17:36");
  });

  it("has no value at all without a date", () => {
    expect(joinLocalDateTime("", "17:36")).toBe("");
  });

  it("round-trips", () => {
    const v = "2026-07-26T17:36";
    const { date, time } = splitLocalDateTime(v);
    expect(joinLocalDateTime(date, time)).toBe(v);
  });
});
