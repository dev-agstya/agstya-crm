// The lead screens are PAGES now, not dialogs (owner 2026-08-03).
//
// These pin the two things that break silently when popups become routes:
// route ORDER (a dynamic /:id happily swallows /new and /import), and the Back
// link being a real destination rather than history.back() — someone opening a
// pasted link has no history, and a Back button that does nothing is worse than
// none at all.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RecordPage } from "../../components/RecordPage";
import { gateForPath } from "../../lib/access";

/** The lead route table as declared in App.tsx, in the same order. */
const LEAD_ROUTES = [
  "/leads",
  "/leads/new",
  "/leads/import",
  "/leads/:id",
  "/leads/:id/edit",
  "/leads/:id/reminders/new",
  "/leads/:id/reminders/:reminderId",
];

/** Which of the declared routes React Router picks for `url`. Unmounts before
 *  returning so a test may ask about several URLs in a row. */
function whichMatches(url: string): string {
  const view = render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        {LEAD_ROUTES.map((path) => (
          <Route key={path} path={path}
            element={<span data-testid="hit">{path}</span>} />
        ))}
      </Routes>
    </MemoryRouter>,
  );
  const matched = view.getByTestId("hit").textContent ?? "";
  view.unmount();
  return matched;
}

describe("lead route matching", () => {
  it("keeps /leads/new off the detail route", () => {
    // The classic failure: /leads/:id matches "new" as an id and the add form
    // becomes a 404 for a lead called "new".
    expect(whichMatches("/leads/new")).toBe("/leads/new");
  });

  it("keeps /leads/import off the detail route", () => {
    expect(whichMatches("/leads/import")).toBe("/leads/import");
  });

  it("still routes a real id to the detail page", () => {
    expect(whichMatches("/leads/64f0c0ffee")).toBe("/leads/:id");
  });

  it("routes edit, and does not treat 'edit' as an id", () => {
    expect(whichMatches("/leads/64f0c0ffee/edit")).toBe("/leads/:id/edit");
  });

  it("separates a new reminder from editing an existing one", () => {
    expect(whichMatches("/leads/abc/reminders/new"))
      .toBe("/leads/:id/reminders/new");
    expect(whichMatches("/leads/abc/reminders/r123"))
      .toBe("/leads/:id/reminders/:reminderId");
  });
});

describe("lead routes are permission-gated", () => {
  it("gates the list and the non-nav screens on view_leads", () => {
    for (const path of ["/leads", "/leads/new", "/leads/import"]) {
      const gate = gateForPath(path);
      expect(gate, `${path} has no gate`).toBeDefined();
      expect(gate!.anyPerm).toContain("view_leads");
    }
  });
});

describe("RecordPage back link", () => {
  const renderPage = (extra = {}) =>
    render(
      <MemoryRouter>
        <RecordPage backTo="/leads" backLabel="Back to leads" title="Vivek Pra"
          {...extra}>
          <p>body</p>
        </RecordPage>
      </MemoryRouter>,
    );

  it("is an anchor to the parent list, not a history button", () => {
    // With history.back() a pasted link dead-ends. An href always works.
    renderPage();
    const back = screen.getByRole("link", { name: /Back to leads/ });
    expect(back.getAttribute("href")).toBe("/leads");
  });

  it("shows the back link while the record is still loading", () => {
    // A slow record must not trap someone on a blank page.
    renderPage({ loading: true });
    expect(screen.getByRole("link", { name: /Back to leads/ })).toBeTruthy();
    expect(screen.queryByText("body")).toBeNull();
  });

  it("offers a way out when the record does not exist", () => {
    renderPage({ notFound: true });
    expect(screen.getByText("Not found")).toBeTruthy();
    // Two ways back: the header link and one in the empty state.
    expect(screen.getAllByRole("link", { name: /Back to leads/ }).length)
      .toBeGreaterThan(1);
  });

  it("renders the body, title and badges when loaded", () => {
    renderPage({ badges: <span>Customer</span> });
    expect(screen.getByRole("heading", { name: "Vivek Pra" })).toBeTruthy();
    expect(screen.getByText("Customer")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("shows a retry when the load failed", () => {
    renderPage({ error: new Error("boom"), onRetry: () => {} });
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });
});
