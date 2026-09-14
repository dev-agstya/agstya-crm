import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { banksApi } from "../../api/endpoints";
import { Field } from "../ui";
import { formatINR } from "../../lib/format";
import { useAuth } from "../../store/auth";

/**
 * "Which of our accounts did this money move through?"
 *
 * Required once the agency has set up any account (the server enforces it too —
 * see routers/finance._require_bank_account). Before that, it renders nothing
 * at all, so an agency that has not got round to adding accounts keeps working
 * exactly as it did.
 *
 * Auto-selects the default account, because a mandatory field the user has to
 * fill on every single payment is a field they will start resenting.
 */
export function BankAccountSelect({ value, onChange, label = "Paid from / into",
  hint, autoSelect = true }: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  hint?: string;
  /**
   * Pre-pick the default account when nothing is chosen. Right on a NEW
   * payment — a mandatory field the user fills every single time is a field
   * they start resenting. Wrong on an EDIT: a legacy row genuinely has no
   * account, and quietly attaching one would move a balance the person opened
   * the form to correct, not to change.
   */
  autoSelect?: boolean;
}) {
  const { has, user } = useAuth();
  // The picker needs the account list, which sits behind view_bank_accounts.
  // Someone who records payments but may not see balances still has to choose
  // an account, so the list endpoint is the gate — if they cannot read it, the
  // server will not demand one from them either.
  const canSee = user?.account_type === "owner" || has("view_bank_accounts");

  const accounts = useQuery({
    queryKey: ["banks", "active"],
    enabled: canSee,
    queryFn: async () => (await banksApi.list()).data.items,
    staleTime: 60_000,
  });
  const items = (accounts.data ?? []).filter((a) => a.active);

  useEffect(() => {
    if (!autoSelect || value || items.length === 0) return;
    const preferred = items.find((a) => a.is_default) ?? items[0];
    onChange(preferred.id);
    // Only when the list first arrives; re-running on every render would fight
    // the user's own choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  if (!canSee || items.length === 0) return null;

  return (
    <Field label={label} required
      hint={hint ?? "Keeps each account's live balance correct."}>
      <select className="select" value={value}
        onChange={(e) => onChange(e.target.value)}>
        <option value="">— Choose an account —</option>
        {items.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {formatINR(a.balance_paise)}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** True when an account must be chosen before the form can be submitted. */
export function useBankAccountRequired(): boolean {
  const { has, user } = useAuth();
  const canSee = user?.account_type === "owner" || has("view_bank_accounts");
  const accounts = useQuery({
    queryKey: ["banks", "active"],
    enabled: canSee,
    queryFn: async () => (await banksApi.list()).data.items,
    staleTime: 60_000,
  });
  return canSee && (accounts.data ?? []).some((a) => a.active);
}
