// Balance Sheet roster: real server-side pagination (owner 2026-09-12).
//
// The left-hand broker/partner/customer list used to fetch the WHOLE section
// and filter/sort/slice it in the browser. The owner explicitly asked for
// server-side paging (not just "show fewer rows"), which means the page must
// send page/page_size/q/sort/order to the server and never re-slice the
// response itself.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/pages/BalanceSheetPage.tsx", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

const page = Object.values(SOURCES)[0];

describe("Balance Sheet roster pagination", () => {
  it("sends page, page_size, q, sort and order to the server", () => {
    expect(page).toContain("page, page_size: PAGE_SIZE");
    expect(page).toContain('order: asc ? "asc" : "desc"');
    expect(page).toContain("q: search.trim()");
  });

  it("renders the shared Pagination control, not a client-side slice", () => {
    expect(page).toContain("<Pagination");
    // No client-side re-sort of the fetched rows — that was the whole bug:
    // paging a response that's already been re-sorted in the browser makes
    // "page 2" mean something different than what the server just counted.
    expect(page).not.toContain("rows.sort(");
    expect(page).not.toContain("base.sort(");
  });

  it("resets to page 1 whenever the search, sort or section changes", () => {
    expect(page).toMatch(/changeSearch[\s\S]{0,80}setPage\(1\)/);
    expect(page).toMatch(/clickSort[\s\S]{0,120}setPage\(1\)/);
    expect(page).toMatch(/changeSection[\s\S]{0,150}setPage\(1\)/);
  });
});
