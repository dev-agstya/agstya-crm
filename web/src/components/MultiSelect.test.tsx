// The picker behind "assign this reminder to several people" (owner Q3.2).
//
// The behaviours worth pinning are the ones that make picking four names
// bearable: the panel stays open, chips keep the order you chose, and the cap
// refuses politely instead of silently ignoring a click.

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MultiSelect } from "./MultiSelect";

const PEOPLE = [
  { value: "u1", label: "Asha Rao", sub: "asha@example.com" },
  { value: "u2", label: "Bilal Khan", sub: "bilal@example.com" },
  { value: "u3", label: "Chetan Patel", sub: "chetan@example.com" },
];

function Harness({ initial = [], max }: { initial?: string[]; max?: number }) {
  const [values, setValues] = useState<string[]>(initial);
  return (
    <MultiSelect options={PEOPLE} values={values} onChange={setValues}
      max={max} placeholder="Choose who this is for" />
  );
}

const openPanel = () => fireEvent.click(screen.getByRole("combobox"));
const optionNamed = (name: string) =>
  screen.getByRole("option", { name: new RegExp(name) });

describe("picking people", () => {
  it("shows the placeholder until something is picked", () => {
    render(<Harness />);
    expect(screen.getByText("Choose who this is for")).toBeTruthy();
  });

  it("stays open so several names can be picked in a row", () => {
    render(<Harness />);
    openPanel();
    fireEvent.click(optionNamed("Asha Rao"));
    // The listbox is still there — this is the whole reason it is not a
    // SearchSelect, which closes on pick.
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.click(optionNamed("Bilal Khan"));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("keeps chips in the order they were chosen", () => {
    render(<Harness />);
    openPanel();
    fireEvent.click(optionNamed("Chetan Patel"));
    fireEvent.click(optionNamed("Asha Rao"));
    const trigger = screen.getByRole("combobox");
    const text = trigger.textContent ?? "";
    expect(text.indexOf("Chetan")).toBeLessThan(text.indexOf("Asha"));
  });

  it("marks a picked option as selected", () => {
    render(<Harness initial={["u1"]} />);
    openPanel();
    expect(optionNamed("Asha Rao").getAttribute("aria-selected")).toBe("true");
    expect(optionNamed("Bilal Khan").getAttribute("aria-selected")).toBe("false");
  });

  it("clicking a picked option removes it", () => {
    render(<Harness initial={["u1"]} />);
    openPanel();
    fireEvent.click(optionNamed("Asha Rao"));
    expect(optionNamed("Asha Rao").getAttribute("aria-selected")).toBe("false");
  });
});

describe("removing people", () => {
  it("removes one from its chip without opening the panel", () => {
    render(<Harness initial={["u1", "u2"]} />);
    fireEvent.click(screen.getByLabelText("Remove Asha Rao"));
    expect(screen.queryByLabelText("Remove Asha Rao")).toBeNull();
    expect(screen.getByLabelText("Remove Bilal Khan")).toBeTruthy();
  });

  it("does not open the panel when a chip's remove is clicked", () => {
    render(<Harness initial={["u1"]} />);
    fireEvent.click(screen.getByLabelText("Remove Asha Rao"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("searching", () => {
  it("filters on name and on the secondary line", () => {
    render(<Harness />);
    openPanel();
    const box = screen.getByPlaceholderText("Type to search…");
    fireEvent.change(box, { target: { value: "bilal@" } });
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(within(list).getByText("Bilal Khan")).toBeTruthy();
  });

  it("says so when nothing matches", () => {
    render(<Harness />);
    openPanel();
    fireEvent.change(screen.getByPlaceholderText("Type to search…"),
      { target: { value: "zzz" } });
    expect(screen.getByText(/No matches for/)).toBeTruthy();
  });
});

describe("the cap", () => {
  it("blocks further picks and explains why", () => {
    render(<Harness initial={["u1"]} max={1} />);
    openPanel();
    // Visibly inert rather than a click that appears to do nothing.
    expect(optionNamed("Bilal Khan").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/maximum of 1/)).toBeTruthy();
  });

  it("still allows removing someone once full", () => {
    render(<Harness initial={["u1"]} max={1} />);
    openPanel();
    fireEvent.click(optionNamed("Asha Rao"));
    expect(optionNamed("Bilal Khan").hasAttribute("disabled")).toBe(false);
  });
});
