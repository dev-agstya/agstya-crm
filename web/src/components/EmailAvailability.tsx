import { useEffect, useState } from "react";
import { usersApi } from "../api/endpoints";
import { Icon } from "./Icon";
import { Spinner } from "./ui";

export type EmailCheckState = "idle" | "checking" | "ok" | "taken";

// Debounced live check that an email isn't already an account — used by the
// Add Employee / Add Channel Partner wizards so a duplicate is caught while
// typing instead of after filling the whole form.
export function useEmailAvailable(email: string): EmailCheckState {
  const [state, setState] = useState<EmailCheckState>("idle");
  const formatOk = /^\S+@\S+\.\S+$/.test(email);
  useEffect(() => {
    if (!formatOk) { setState("idle"); return; }
    setState("checking");
    const t = setTimeout(async () => {
      try {
        const res = (await usersApi.emailAvailable(email.trim())).data;
        setState(res.available ? "ok" : "taken");
      } catch { setState("idle"); }  // network/permission issue: don't block
    }, 400);
    return () => clearTimeout(t);
  }, [email, formatOk]);
  return state;
}

export function EmailAvailabilityHint({ state }: { state: EmailCheckState }) {
  if (state === "checking")
    return (
      <span className="flex items-center gap-1 text-xs text-slate-500">
        <Spinner className="h-3 w-3" /> Checking…
      </span>
    );
  if (state === "ok")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium
        text-money-in">
        <Icon.Check size={13} /> Email is available
      </span>
    );
  if (state === "taken")
    return (
      <span className="text-xs font-medium text-money-out">
        ✗ An account with this email already exists
      </span>
    );
  return null;
}
