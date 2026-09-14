// The date field a user actually touches.
//
// dayFirstDates.test.ts pins the parsing rules; this pins the behaviour around
// them — what the box shows, what reaches the form, and what happens when
// someone types something that isn't a date.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateInput, DateTimeInput } from "./DateInput";

afterEach(cleanup);

// A parent that stores the value, like every real call site does — a controlled
// field is only correct if it survives the round trip back through props.
function Harness({ initial = "", onValue }: {
  initial?: string; onValue?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <DateInput value={value} onChange={(v) => { setValue(v); onValue?.(v); }} />
      <output data-testid="stored">{value}</output>
    </>
  );
}

const box = () => screen.getByPlaceholderText("dd/mm/yyyy") as HTMLInputElement;
const stored = () => screen.getByTestId("stored").textContent;

describe("what the field shows", () => {
  it("renders a stored date day-first", () => {
    render(<Harness initial="2026-07-26" />);
    expect(box().value).toBe("26/07/2026");
  });

  it("starts empty when there is no value", () => {
    render(<Harness />);
    expect(box().value).toBe("");
  });

  it("advertises the expected format so nobody has to guess", () => {
    render(<Harness />);
    expect(box().placeholder).toBe("dd/mm/yyyy");
  });

  it("is a text box, not a native date input — that is the whole point", () => {
    render(<Harness initial="2026-07-26" />);
    // A native date input would render in the browser's locale, which is what
    // produced mm/dd/yyyy in the first place.
    expect(box().type).toBe("text");
  });

  it("follows the parent when the value is replaced from outside", () => {
    const { rerender } = render(
      <DateInput value="2026-07-26" onChange={() => {}} />);
    expect(box().value).toBe("26/07/2026");
    rerender(<DateInput value="2026-01-05" onChange={() => {}} />);
    expect(box().value).toBe("05/01/2026");
  });

  it("clears when the parent clears it (form reset)", () => {
    const { rerender } = render(
      <DateInput value="2026-07-26" onChange={() => {}} />);
    rerender(<DateInput value="" onChange={() => {}} />);
    expect(box().value).toBe("");
  });
});

describe("typing", () => {
  it("adds the slashes as the digits arrive", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "26" } });
    expect(box().value).toBe("26");
    fireEvent.change(box(), { target: { value: "2607" } });
    expect(box().value).toBe("26/07");
    fireEvent.change(box(), { target: { value: "26072026" } });
    expect(box().value).toBe("26/07/2026");
  });

  it("saves the day-first reading, not the American one", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(box(), { target: { value: "07/06/2026" } });
    // 7 June — a native input on a US machine would have read this as 6 July.
    expect(stored()).toBe("2026-06-07");
    expect(onValue).toHaveBeenLastCalledWith("2026-06-07");
  });

  it("leaves the stored value alone while the date is half typed", () => {
    render(<Harness initial="2026-07-26" />);
    fireEvent.change(box(), { target: { value: "26/07/20" } });
    // Still the old date: a partial entry must not blank the form mid-keystroke.
    expect(stored()).toBe("2026-07-26");
  });

  it("clears the stored value when the box is emptied", () => {
    render(<Harness initial="2026-07-26" />);
    fireEvent.change(box(), { target: { value: "" } });
    expect(stored()).toBe("");
    expect(box().value).toBe("");
  });

  it("keeps the caret's text when the parent echoes the same day back", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "26072026" } });
    // The parent re-renders with "2026-07-26"; the box must not be rewritten
    // out from under the person typing.
    expect(box().value).toBe("26/07/2026");
    expect(stored()).toBe("2026-07-26");
  });
});

describe("recovering from a bad entry", () => {
  it("snaps a half-typed date back on blur", () => {
    render(<Harness initial="2026-07-26" />);
    fireEvent.change(box(), { target: { value: "26/07/20" } });
    fireEvent.blur(box());
    expect(box().value).toBe("26/07/2026");
  });

  it("snaps an impossible date back on blur", () => {
    render(<Harness initial="2026-07-26" />);
    fireEvent.change(box(), { target: { value: "31/02/2026" } });
    fireEvent.blur(box());
    // Not 03/03/2026 — the field never invents a date the user didn't mean.
    expect(box().value).toBe("26/07/2026");
    expect(stored()).toBe("2026-07-26");
  });

  it("leaves a genuinely empty field empty on blur", () => {
    render(<Harness initial="2026-07-26" />);
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.blur(box());
    expect(box().value).toBe("");
    expect(stored()).toBe("");
  });
});

describe("the calendar is still there", () => {
  it("opens the browser picker from the icon", () => {
    render(<Harness />);
    const native = screen.getByTestId("native-picker") as HTMLInputElement;
    const showPicker = vi.fn();
    (native as unknown as { showPicker: () => void }).showPicker = showPicker;
    fireEvent.click(screen.getByLabelText("Open calendar"));
    expect(showPicker).toHaveBeenCalled();
  });

  it("falls back to focusing the input where showPicker is unsupported", () => {
    render(<Harness />);
    const native = screen.getByTestId("native-picker") as HTMLInputElement;
    // jsdom has no showPicker, so this is the real path there.
    const click = vi.spyOn(native, "click");
    fireEvent.click(screen.getByLabelText("Open calendar"));
    expect(click).toHaveBeenCalled();
  });

  it("accepts a date chosen from the picker", () => {
    render(<Harness />);
    const native = screen.getByTestId("native-picker") as HTMLInputElement;
    fireEvent.change(native, { target: { value: "2026-07-26" } });
    expect(stored()).toBe("2026-07-26");
    expect(box().value).toBe("26/07/2026");
  });

  it("keeps the picker out of the tab order", () => {
    render(<Harness />);
    expect(screen.getByTestId("native-picker").getAttribute("tabindex"))
      .toBe("-1");
  });
});

describe("plumbing the call sites rely on", () => {
  it("passes `required` through to the visible control", () => {
    render(<DateInput value="" required onChange={() => {}} />);
    expect(box().required).toBe(true);
  });

  it("disables both halves together", () => {
    render(<DateInput value="" disabled onChange={() => {}} />);
    expect(box().disabled).toBe(true);
    expect((screen.getByLabelText("Open calendar") as HTMLButtonElement)
      .disabled).toBe(true);
  });

  it("does not open the picker while disabled", () => {
    render(<DateInput value="" disabled onChange={() => {}} />);
    const native = screen.getByTestId("native-picker") as HTMLInputElement;
    const click = vi.spyOn(native, "click");
    fireEvent.click(screen.getByLabelText("Open calendar"));
    expect(click).not.toHaveBeenCalled();
  });

  it("carries the caller's sizing classes", () => {
    const { container } = render(
      <DateInput value="" className="input h-10 w-40" onChange={() => {}} />);
    expect(container.querySelector(".h-10.w-40")).not.toBeNull();
  });
});

describe("DateTimeInput", () => {
  function TimeHarness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return (
      <>
        <DateTimeInput value={value} onChange={setValue} />
        <output data-testid="stored">{value}</output>
      </>
    );
  }

  beforeEach(() => cleanup());

  it("shows the date half day-first", () => {
    render(<TimeHarness initial="2026-07-26T17:36" />);
    expect(box().value).toBe("26/07/2026");
    expect((screen.getByLabelText("Time") as HTMLInputElement).value)
      .toBe("17:36");
  });

  it("keeps the time when the date changes", () => {
    render(<TimeHarness initial="2026-07-26T17:36" />);
    fireEvent.change(box(), { target: { value: "01/08/2026" } });
    expect(stored()).toBe("2026-08-01T17:36");
  });

  it("keeps the date when the time changes", () => {
    render(<TimeHarness initial="2026-07-26T17:36" />);
    fireEvent.change(screen.getByLabelText("Time"),
      { target: { value: "09:15" } });
    expect(stored()).toBe("2026-07-26T09:15");
  });

  it("empties the whole value when the date is cleared", () => {
    render(<TimeHarness initial="2026-07-26T17:36" />);
    fireEvent.change(box(), { target: { value: "" } });
    expect(stored()).toBe("");
  });
});
