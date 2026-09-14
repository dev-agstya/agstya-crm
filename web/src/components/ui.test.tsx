// The shared UI kit. These pin BEHAVIOUR, not appearance — a class name
// changing is a redesign, but a modal that no longer closes on Escape, or a tab
// bar that hides a count of zero, is a bug.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AvatarStack, Modal, StatusBadge, Tabs } from "./ui";

describe("Tabs", () => {
  const items = [
    { value: "", label: "All", count: 12 },
    { value: "customer", label: "Customer", count: 9 },
    { value: "business", label: "Business", count: 0 },
  ];

  it("marks the current tab selected", () => {
    render(<Tabs items={items} value="customer" onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /Customer/ })
      .getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /^All/ })
      .getAttribute("aria-selected")).toBe("false");
  });

  it("reports the value that was clicked", () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /Business/ }));
    expect(onChange).toHaveBeenCalledWith("business");
  });

  it("shows a count of zero rather than hiding the tab", () => {
    // A hidden count reads as "this category was removed"; a zero reads as
    // "nothing matches your filters", which is the truth.
    render(<Tabs items={items} value="" onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /Business 0/ })).toBeTruthy();
  });

  it("renders a tab with no count at all while the count is loading", () => {
    render(<Tabs items={[{ value: "a", label: "Alpha" }]} value="a"
      onChange={() => {}} />);
    const tab = screen.getByRole("tab", { name: /Alpha/ });
    expect(tab.textContent?.trim()).toBe("Alpha");
  });
});

describe("Modal", () => {
  const open = (extra: Record<string, unknown> = {}) => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Add a reminder" {...extra}>
        <p>body</p>
      </Modal>,
    );
    return onClose;
  };

  it("closes on Escape", () => {
    const onClose = open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the backdrop is pressed", () => {
    const onClose = open();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does NOT close when a press starts inside the panel", () => {
    // Dragging to select text in a form and releasing outside it used to shut
    // the dialog and lose everything typed.
    const onClose = open();
    fireEvent.mouseDown(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("locks the page behind it and restores the scroll on close", () => {
    const { unmount } = render(
      <Modal open onClose={() => {}} title="T"><p>body</p></Modal>);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("renders nothing at all when closed", () => {
    render(<Modal open={false} onClose={() => {}} title="T"><p>x</p></Modal>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the subtitle and the footer when given", () => {
    open({ subtitle: "Everyone named gets a notification.",
      footer: <button>Save</button> });
    expect(screen.getByText("Everyone named gets a notification.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("StatusBadge", () => {
  it("title-cases a raw value", () => {
    render(<StatusBadge value="renewal_due" />);
    expect(screen.getByText("Renewal Due")).toBeTruthy();
  });

  it("uses an explicit label when the raw value reads badly", () => {
    // "channel_partner" title-cases to "Channel Partner"; the app writes it
    // "Channel partner".
    render(<StatusBadge value="channel_partner" label="Channel partner" />);
    expect(screen.getByText("Channel partner")).toBeTruthy();
  });
});

describe("AvatarStack", () => {
  it("shows initials for each person", () => {
    render(<AvatarStack names={["Asha Rao", "Bilal Khan"]} />);
    expect(screen.getByText("AR")).toBeTruthy();
    expect(screen.getByText("BK")).toBeTruthy();
  });

  it("collapses past the limit instead of growing without end", () => {
    render(<AvatarStack names={["Asha Rao", "Bilal Khan", "Chetan Patel",
      "Deepa Iyer", "Esha Nair"]} max={3} />);
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("renders nothing for nobody", () => {
    const { container } = render(<AvatarStack names={[]} />);
    expect(container.textContent).toBe("");
  });

  it("handles a one-word name", () => {
    render(<AvatarStack names={["Prakash"]} />);
    expect(screen.getByText("PR")).toBeTruthy();
  });
});
