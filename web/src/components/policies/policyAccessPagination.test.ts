// The policy-access "IT EXISTS, AND IT IS NOT YOURS" queue (a VIEW on the
// Policies page, ?view=access-requests) is a real, growing queue — every
// request ever made or decided, across the whole agency's history — so it
// gets the same server-side pagination as the Balance Sheet roster (owner
// 2026-09-12).

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob(
  "/src/components/policies/PolicyAccess.tsx",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const page = Object.values(SOURCES)[0];

describe("Policy access queue pagination", () => {
  it("sends page and page_size to the server", () => {
    expect(page).toContain(
      "mine: tab === \"mine\", status: \"all\", page, page_size: PAGE_SIZE");
  });

  it("renders the shared Pagination control", () => {
    expect(page).toContain("<Pagination");
  });

  it("resets to page 1 when the tab changes", () => {
    expect(page).toMatch(/changeTab[\s\S]{0,80}setPage\(1\)/);
  });

  it("reads .items off a Page response, not a bare array", () => {
    expect(page).toContain("rows.data?.items");
  });

  it("counts the 'to decide' badge from the server's own total, not just "
    + "the rows on the current page", () => {
    expect(page).toContain("pending-total");
    expect(page).toContain("pendingTotal.data");
  });
});
