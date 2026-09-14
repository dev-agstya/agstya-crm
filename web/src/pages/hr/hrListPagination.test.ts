// Pagination added to the Workplace HR lists that kept handing the browser a
// whole collection (owner 2026-09-12: "on entire website, where the data rows
// are to be exceeding 25, just add pagination, better").
//
// Same house style as `balanceSheetPagination.test.ts`: source-inspection
// against the real page files, because there is no live-DB / live-API test
// harness in this repo for React Query pages.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob(
  ["/src/pages/hr/LeavePage.tsx", "/src/pages/hr/AttendancePage.tsx",
   "/src/pages/hr/PayslipsPage.tsx"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const leavePage = SOURCES["/src/pages/hr/LeavePage.tsx"];
const attendancePage = SOURCES["/src/pages/hr/AttendancePage.tsx"];
const payslipsPage = SOURCES["/src/pages/hr/PayslipsPage.tsx"];

describe("Leave page pagination", () => {
  it("sends page and page_size to my leave, the ledger and the queue", () => {
    expect(leavePage).toMatch(/mine: true,\s*page: minePage, page_size: PAGE_SIZE/);
    expect(leavePage).toMatch(/page: ledgerPage, page_size: PAGE_SIZE/);
    expect(leavePage).toMatch(
      /mine: false, status: statusFilter \|\| undefined,[\s\S]{0,20}page: queuePage, page_size: PAGE_SIZE/);
  });

  it("renders the shared Pagination control for all three lists", () => {
    expect(leavePage.match(/<Pagination/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("resets the queue to page 1 when the status filter changes", () => {
    expect(leavePage).toMatch(/changeStatusFilter[\s\S]{0,80}setQueuePage\(1\)/);
  });

  it("reads .items and .total off a Page response, not a bare array", () => {
    expect(leavePage).toContain("mine.data?.items");
    expect(leavePage).toContain("ledger.data?.items");
    expect(leavePage).toContain("queue.data?.items");
  });

  it("counts the Requests tab badge from the server's own total, not the "
    + "current page", () => {
    expect(leavePage).toContain("leave-pending-total");
    expect(leavePage).toContain("pendingTotal.data ?? 0");
  });
});

describe("Attendance corrections pagination", () => {
  it("sends page and page_size to the corrections queue", () => {
    expect(attendancePage).toContain(
      "mine: !canSeeTeam, page: correctionsPage, page_size: PAGE_SIZE");
  });

  it("renders the shared Pagination control", () => {
    expect(attendancePage).toContain("<Pagination");
  });

  it("reads .items off a Page response, not a bare array", () => {
    expect(attendancePage).toContain("corrections.data?.items");
    expect(attendancePage).toContain("myPending.data?.items");
  });

  it("counts the Corrections tab badge from the server's own total", () => {
    expect(attendancePage).toContain("corrections-pending-total");
    expect(attendancePage).toContain("pendingTotal.data ?? 0");
  });
});

describe("Payslips (mine) pagination", () => {
  it("sends page and page_size to my own payslip history", () => {
    expect(payslipsPage).toContain(
      "payslipsApi.list({ page: minePage, page_size: PAGE_SIZE })");
  });

  it("renders the shared Pagination control", () => {
    expect(payslipsPage).toContain("<Pagination");
  });

  it("reads .items off a Page response, not a bare array", () => {
    expect(payslipsPage).toContain("mine.data?.items");
    expect(payslipsPage).toContain("mine.data!.items");
  });

  // The Pay Run view is bounded by headcount for one month — it stays on its
  // own dedicated /run/{month} endpoint and is deliberately NOT paginated.
  it("leaves the bounded, headcount-sized Pay Run view alone", () => {
    expect(payslipsPage).toContain("payslipsApi.run(month)");
  });
});
