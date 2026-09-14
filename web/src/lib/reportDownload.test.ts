// The Reports page's download section (owner 2026-08-04).
//
// "Download month pack" — a button in the page header opening a popup with its
// own month/FY/custom picker — became a section at the FOOT of the page with
// the app's shared date filter and two buttons.
//
// Two kinds of test here. The blob helpers are real behaviour and are exercised
// directly; the rest reads the source, like the other sweep tests, because what
// it protects is a set of decisions (the popup is gone, the filter is the shared
// one, the section does not inherit the chart filter) that a render test would
// have to stand up most of the page to observe.

import { describe, expect, it } from "vitest";
import { blobError, filenameFromResponse } from "./download";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such source file: ${rel}`);
  return text;
}

/** Source with comments stripped — this file's comments name the very things
 *  being asserted absent. */
function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const page = () => code("pages/FinanceReportsPage.tsx");

/* ------------------------------------------------------- the month pack is gone -- */

describe("the month pack is gone", () => {
  it("has no popup left on the reports page", () => {
    const text = page();
    expect(text).not.toContain("MonthPackModal");
    expect(text).not.toContain("<Modal");
    expect(text).not.toContain("packOpen");
  });

  it("no longer calls the month-pack endpoint", () => {
    expect(page()).not.toContain("monthPackApi");
    expect(code("api/endpoints.ts")).not.toContain("month-pack");
    expect(code("api/endpoints.ts")).not.toContain("monthPackApi");
  });

  it("drops the download button from the page header", () => {
    // Downloading is the last thing you do here, not the first.
    const text = page();
    const header = text.slice(text.indexOf("<PageHeader"),
      text.indexOf("Filters"));
    expect(header).not.toContain("Download");
  });
});

/* ----------------------------------------------------------- the new section -- */

describe("the download section", () => {
  it("sits at the foot of the page, after the breakdown table", () => {
    const text = page();
    expect(text).toContain("<ReportDownload />");
    expect(text.indexOf("<DetailTable"))
      .toBeLessThan(text.indexOf("<ReportDownload />"));
  });

  it("offers Excel and PDF as two buttons, not a question", () => {
    // One click instead of two, and both options are visible without opening
    // anything.
    const text = source("pages/FinanceReportsPage.tsx");
    expect(text).toContain("Download Excel");
    expect(text).toContain("Download PDF");
    expect(page()).toContain('download("excel")');
    expect(page()).toContain('download("pdf")');
  });

  it("uses the app's shared date filter", () => {
    // Not a bespoke month/FY/custom picker. A filter that looks like the one
    // above it and behaves differently is the drift this codebase keeps
    // getting bitten by.
    const text = page();
    const section = text.slice(text.indexOf("function ReportDownload"));
    expect(section).toContain("<DateFilter");
    expect(section).toContain("periodParams(period)");
  });

  it("keeps its own period, separate from the charts'", () => {
    // Silently inheriting a period somebody set to look at a graph is how you
    // email your CA the wrong month.
    const text = page();
    const section = text.slice(text.indexOf("function ReportDownload"));
    expect(section).toContain("useState<PeriodValue>");
    expect(section).toContain('period: "last_month"');
  });

  it("does not pass the page's entity filters to the report", () => {
    // The report is the WHOLE business for the period; narrowing it to one
    // insurer would quietly produce a file that does not add up to the month.
    const text = page();
    const section = text.slice(text.indexOf("function ReportDownload"));
    for (const f of ["insurerId", "categoryKey", "partnerId", "employeeId"])
      expect(section).not.toContain(f);
  });

  it("shows a spinner on the button rather than pretending it was instant", () => {
    const text = page();
    expect(text).toContain("busy === \"excel\"");
    expect(text).toContain("disabled={!!busy}");
  });

  it("says so instead of failing silently without the export permission", () => {
    expect(page()).toContain("canExport");
    expect(source("pages/FinanceReportsPage.tsx"))
      .toContain("You need the export permission");
  });
});

/* ---------------------------------------------------------- download plumbing -- */

describe("the server names the file", () => {
  it("reads the name out of Content-Disposition", () => {
    // The server knows whether the range is a whole calendar month; the browser
    // has no way to work that out.
    expect(filenameFromResponse({
      headers: {
        "content-disposition":
          'attachment; filename="Agastya-Report-Jul-2026.xlsx"',
      },
    })).toBe("Agastya-Report-Jul-2026.xlsx");
  });

  it("copes with an unquoted filename", () => {
    expect(filenameFromResponse({
      headers: { "content-disposition": "attachment; filename=report.pdf" },
    })).toBe("report.pdf");
  });

  it("falls back to undefined when the header is missing", () => {
    expect(filenameFromResponse({ headers: {} })).toBeUndefined();
    expect(filenameFromResponse({})).toBeUndefined();
  });

  it("is actually used by the download", () => {
    expect(page()).toContain("filenameFromResponse(res)");
  });
});

describe("a failed download reports what the server said", () => {
  it("reads the message out of a blob error body", async () => {
    // THE one. Axios hands the error body back as a Blob for a blob request,
    // so the ordinary apiError finds no `detail` and every failure reports the
    // same generic "Request failed (413)" — while the sentence the user needs
    // ("choose a shorter period") sits unread inside the blob.
    const detail = "This period holds 40,000 policies … choose a shorter period.";
    const err = {
      response: { data: new Blob([JSON.stringify({ detail })]) },
    };
    await expect(blobError(err)).resolves.toBe(detail);
  });

  it("falls back gracefully when the body is not JSON", async () => {
    const err = { response: { status: 500, data: new Blob(["<html>"]) } };
    await expect(blobError(err)).resolves.toContain("500");
  });

  it("reads a Blob that has no text() method", async () => {
    // Safari only got Blob.prototype.text() in 14, and jsdom still has none —
    // a bare `await blob.text()` throws "is not a function" on exactly the
    // browsers where the error message matters most.
    const detail = "Choose a shorter period.";
    const blob = new Blob([JSON.stringify({ detail })]);
    expect(typeof (blob as { text?: unknown }).text).not.toBe("function");
    await expect(blobError({ response: { data: blob } })).resolves.toBe(detail);
  });

  it("still handles an ordinary non-blob error", async () => {
    const err = { response: { status: 403, data: { detail: "Forbidden." } } };
    await expect(blobError(err)).resolves.toBe("Forbidden.");
  });

  it("is what the download section uses", () => {
    expect(page()).toContain("blobError(e)");
  });
});
