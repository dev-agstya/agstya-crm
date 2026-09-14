import { create } from "zustand";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

// A single styled confirmation dialog for the whole app — replaces native
// window.confirm() so destructive actions get an on-brand modal (with a red
// primary for dangerous actions), keyboard support and a focus trap.
//
// Usage (from any handler):
//   if (await confirmDialog({ message: "Delete this?", danger: true })) { ... }

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /*
    ASK FOR A REASON, not just for a second click (2026-08-24).

    Some destructive actions are only defensible if somebody wrote down WHY —
    dismissing a bank-statement line is the one that brought this in ("we don't
    want to delete any of the transactions actually"), and a bank
    reconciliation is the same shape. Two clicks stop an accident; a reason is
    what makes the row explainable three months later.

    A field on the confirmation rather than a separate dialog component,
    because it IS the confirmation: splitting them would mean two mechanisms
    for "are you sure", and the one without the reason is the one people would
    keep reaching for.
  */
  prompt?: {
    label: string;
    placeholder?: string;
    /** Below this the confirm button stays disabled. 3 by default, so one
     *  keystroke does not satisfy a question that wanted a sentence. */
    minLength?: number;
  };
}

/** What a prompting dialog settles to: the text, or null if cancelled. */
export interface PromptOptions extends Omit<ConfirmOptions, "prompt"> {
  label: string;
  placeholder?: string;
  minLength?: number;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (value: boolean | string) => void;
}

interface ConfirmState {
  current: ConfirmRequest | null;
  open: (opts: ConfirmOptions,
         resolve: (v: boolean | string) => void) => void;
  settle: (value: boolean | string) => void;
}

let counter = 0;

const useConfirm = create<ConfirmState>((set, get) => ({
  current: null,
  open: (opts, resolve) =>
    set({ current: { ...opts, id: ++counter, resolve } }),
  settle: (value) => {
    const cur = get().current;
    if (cur) cur.resolve(value);
    set({ current: null });
  },
}));

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) =>
    useConfirm.getState().open(opts, (v) => resolve(v === true)));
}

/**
 * Confirm, AND collect the reason. Resolves to the text, or null on cancel.
 *
 * The caller treats a null exactly as a "no" — which is the point of returning
 * one rather than an empty string: `if (reason)` is the same shape as
 * `if (await confirmDialog(...))`, so the two are used the same way and neither
 * can be mistaken for the other.
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  const { label, placeholder, minLength, ...rest } = opts;
  return new Promise((resolve) =>
    useConfirm.getState().open(
      { ...rest, prompt: { label, placeholder, minLength } },
      (v) => resolve(typeof v === "string" ? v : null)));
}

export function ConfirmHost() {
  const { current, settle } = useConfirm();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");

  const prompt = current?.prompt;
  const min = prompt?.minLength ?? 3;
  const ready = !prompt || text.trim().length >= min;

  useEffect(() => {
    if (!current) return;
    setText("");
    // Focus the FIELD when there is one — the person has to type before they
    // can confirm, so putting the caret on the button would make Enter do
    // nothing and read as a broken dialog.
    if (current.prompt) inputRef.current?.focus();
    else confirmRef.current?.focus();
  }, [current]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
      // Enter confirms — but never past an unfinished reason, or the guard the
      // field exists to be would be one keystroke wide.
      if (e.key === "Enter" && ready) {
        settle(current.prompt ? text.trim() : true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, settle, ready, text]);

  if (!current) return null;
  const danger = !!current.danger;

  /*
    PORTALLED, for the same reason `Modal` is — see the long note in
    components/ui.tsx. A confirmation can be raised from ANYWHERE, including
    from inside a Modal (which is itself portalled) and from handlers that run
    in the top bar, so it must not inherit a stacking context from whatever
    happened to call `confirmDialog()`. It sits one rung above `dialog` so
    "are you sure?" always covers the form that asked the question.
  */
  return createPortal(
    <div
      className="fixed inset-0 z-confirm flex items-center justify-center
        bg-slate-900/50 p-4 backdrop-blur-[1px] animate-fade-in"
      onMouseDown={() => settle(false)}
      role="alertdialog"
      aria-modal="true"
    >
      <div
        className="card w-full max-w-md shadow-pop animate-modal-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3.5 px-6 pt-6">
          <div
            className={`mt-0.5 shrink-0 rounded-full p-2.5 ${
              danger ? "bg-money-out/10 text-money-out"
                : "bg-slate-100 text-slate-900"
            }`}
          >
            {danger ? <Icon.Alert size={20} /> : <Icon.Shield size={20} />}
          </div>
          <div className="min-w-0">
            <h2 className="text-section text-slate-900">
              {current.title || (danger ? "Are you sure?" : "Please confirm")}
            </h2>
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed
              text-slate-500">
              {current.message}</p>
            {prompt && (
              <label className="mt-3 block">
                <span className="text-caption uppercase text-slate-500">
                  {prompt.label}
                </span>
                <input ref={inputRef} className="input mt-1 w-full"
                  value={text} placeholder={prompt.placeholder}
                  maxLength={300}
                  onChange={(e) => setText(e.target.value)} />
              </label>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-line
          bg-slate-50/60 px-6 py-3.5">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => settle(false)}
          >
            {current.cancelLabel || "Cancel"}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={!ready}
            onClick={() => settle(prompt ? text.trim() : true)}
            className={danger ? "btn-danger" : "btn-primary"}
          >
            {current.confirmLabel || (danger ? "Delete" : "Confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
