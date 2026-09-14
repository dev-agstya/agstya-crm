// Stop the browser silently editing money while you scroll.
//
// THE BUG THIS FIXES (owner, 2026-07-26): a policy typed as ₹999 was saved as
// ₹998.99, and the same "off by one step" turned up all over the app. Nothing
// was wrong with the maths — Chrome (and Firefox) treat the mouse wheel as a
// stepper on a FOCUSED <input type="number">. You type 999, roll the wheel to
// bring the Save button into view, and the field quietly counts down by its
// step (0.01 on money fields) with no visual cue that anything happened.
//
// The fix is to blur the field the moment a wheel event reaches it. Blurring
// (rather than preventDefault) is deliberate:
//   * the page still scrolls, which is what the user was asking for;
//   * an unfocused number input ignores the wheel entirely, so the value is
//     safe for the rest of the gesture;
//   * it needs no cooperation from the ~40 number inputs across the app, so a
//     field added tomorrow is protected too.
//
// Arrow keys are left alone on purpose: those are a deliberate keystroke on a
// field you are already in, and blocking them would break keyboard use.

export function isSteppableNumberInput(el: EventTarget | null): boolean {
  return el instanceof HTMLInputElement && el.type === "number"
    && !el.disabled && !el.readOnly;
}

// Exported for tests: the decision, without any DOM plumbing.
export function shouldBlurOnWheel(target: EventTarget | null,
                                  active: Element | null): boolean {
  return isSteppableNumberInput(target) && target === active;
}

export function installNumberInputWheelGuard(
  doc: Document = document
): () => void {
  const onWheel = (e: Event) => {
    const target = e.target;
    if (shouldBlurOnWheel(target, doc.activeElement)) {
      (target as HTMLInputElement).blur();
    }
  };
  // Capture phase: reach the input before its own default handling, and before
  // any component-level wheel handler can stop propagation.
  doc.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => doc.removeEventListener("wheel", onWheel, { capture: true });
}
