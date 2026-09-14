// The ₹999 -> ₹998.99 bug.
//
// The owner booked a policy at 999, scrolled down to reach Save, and the record
// stored 99899 paise. Nothing was wrong with the maths — the browser had
// stepped the focused number input down by 0.01 on the wheel. These tests pin
// the guard that stops it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installNumberInputWheelGuard,
  isSteppableNumberInput,
  shouldBlurOnWheel,
} from "./numberInputGuard";

function makeInput(type = "number"): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  document.body.appendChild(el);
  return el;
}

// The guard attaches to the shared jsdom document, so every install has to be
// undone or a later test inherits listeners it never asked for.
let installed: (() => void)[] = [];
const install = () => {
  const off = installNumberInputWheelGuard();
  installed.push(off);
  return off;
};

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { installed.forEach((off) => off()); installed = []; });

describe("which fields are at risk", () => {
  it("flags a number input", () => {
    expect(isSteppableNumberInput(makeInput())).toBe(true);
  });

  it("leaves text, date and select fields alone", () => {
    expect(isSteppableNumberInput(makeInput("text"))).toBe(false);
    expect(isSteppableNumberInput(makeInput("date"))).toBe(false);
    expect(isSteppableNumberInput(document.createElement("select"))).toBe(false);
  });

  it("ignores disabled and read-only fields, which cannot step anyway", () => {
    const disabled = makeInput();
    disabled.disabled = true;
    const readonly = makeInput();
    readonly.readOnly = true;
    expect(isSteppableNumberInput(disabled)).toBe(false);
    expect(isSteppableNumberInput(readonly)).toBe(false);
  });

  it("ignores a null target", () => {
    expect(isSteppableNumberInput(null)).toBe(false);
  });
});

describe("when to intervene", () => {
  it("acts only on the field that actually has focus", () => {
    const el = makeInput();
    expect(shouldBlurOnWheel(el, el)).toBe(true);
    // Same field, not focused: the browser will not step it, so leave it be.
    expect(shouldBlurOnWheel(el, document.body)).toBe(false);
  });
});

describe("the installed guard", () => {
  it("blurs a focused money field on wheel, so the value cannot change", () => {
    const el = makeInput();
    el.step = "0.01";
    el.value = "999";
    install();
    el.focus();
    expect(document.activeElement).toBe(el);

    el.dispatchEvent(new Event("wheel", { bubbles: true }));

    expect(document.activeElement).not.toBe(el);
    expect(el.value).toBe("999");     // the premium the user actually typed
  });

  it("does not disturb a text field being scrolled over", () => {
    const text = makeInput("text");
    install();
    text.focus();
    text.dispatchEvent(new Event("wheel", { bubbles: true }));
    expect(document.activeElement).toBe(text);
  });

  it("leaves an unfocused number field focused elsewhere alone", () => {
    const number = makeInput();
    const text = makeInput("text");
    install();
    text.focus();
    number.dispatchEvent(new Event("wheel", { bubbles: true }));
    expect(document.activeElement).toBe(text);
  });

  it("can be uninstalled", () => {
    const el = makeInput();
    const uninstall = install();
    uninstall();
    el.focus();
    el.dispatchEvent(new Event("wheel", { bubbles: true }));
    expect(document.activeElement).toBe(el);
  });
});
