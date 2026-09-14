// One way of asking "delete this?" across every relational record.
//
// The owner's rule (2026-07-26): the delete button stays on every page. What
// decides whether it goes through is the LINKS — an insurer, broker or policy
// type that nothing points at is a typo someone should be able to clear up,
// while one a policy names has to be deactivated instead, because policies store
// the ID and resolve the name at read time.
//
// So the button is never hidden and never disabled. Clicking it either confirms
// a delete that will work, or explains why it can't and offers the action that
// will — a dead-end "nope" leaves someone hunting for a control they can't find.
//
// The server decides for real (services/references.py); `inUse` is its answer,
// carried on the record, and is used here only to pick which question to ask.

import { confirmDialog } from "../components/Confirm";

export type DeleteChoice = "delete" | "fallback" | "cancel";

export interface DeleteAsk {
  /** What this thing is, lower case: "insurer", "broker", "customer". */
  noun: string;
  /** Its name, for the dialog: "HDFC Life". */
  name: string;
  /** Server's answer: does anything point at this record? */
  inUse: boolean;
  /** The action to offer instead when it IS in use: "Deactivate" / "Archive". */
  fallbackLabel: string;
  /** What that action does, one clause: "it stays on existing policies". */
  fallbackHint: string;
}

/** What the person is currently able to do to this record. */
export function deleteAllowed(inUse: boolean): boolean {
  return !inUse;
}

/** The sentence shown when a delete is possible. */
export function deleteMessage(noun: string, name: string): string {
  return `Permanently delete ${name}? Nothing in the app uses this ${noun} yet, `
    + `so removing it is safe — but it can't be undone.`;
}

/** The sentence shown when it isn't, naming the way forward. */
export function blockedMessage(noun: string, name: string,
                               fallbackLabel: string,
                               fallbackHint: string): string {
  return `${name} can't be deleted because other records point at it — `
    + `removing this ${noun} would leave them referring to nothing. `
    + `${fallbackLabel} instead: ${fallbackHint}`;
}

/**
 * Ask about deleting `name`, and say what happened:
 *   "delete"   — confirmed, and the record is free of links
 *   "fallback" — in use; the person chose the deactivate/archive alternative
 *   "cancel"   — backed out
 */
export async function askDelete(ask: DeleteAsk): Promise<DeleteChoice> {
  if (deleteAllowed(ask.inUse)) {
    const ok = await confirmDialog({
      title: "Delete permanently?",
      message: deleteMessage(ask.noun, ask.name),
      confirmLabel: "Delete permanently",
      danger: true,
    });
    return ok ? "delete" : "cancel";
  }
  const useFallback = await confirmDialog({
    title: `Can't delete — it's in use`,
    message: blockedMessage(ask.noun, ask.name, ask.fallbackLabel,
                            ask.fallbackHint),
    confirmLabel: ask.fallbackLabel,
    cancelLabel: "Leave it",
  });
  return useFallback ? "fallback" : "cancel";
}
