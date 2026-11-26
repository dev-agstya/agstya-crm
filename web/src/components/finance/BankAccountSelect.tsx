import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { banksApi } from "../../api/endpoints";
import { FormField } from "../shared/FormSection";
import { formatINR } from "../../lib/format";
import { useAuth } from "../../store/auth";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function BankAccountSelect({
  value,
  onChange,
  label = "Paid from / into",
  hint,
  autoSelect = true,
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  hint?: string;
  autoSelect?: boolean;
}) {
  const { has, user } = useAuth();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  if (!canSee || items.length === 0) return null;

  return (
    <FormField
      label={label}
      required
      tooltip={hint ?? "Keeps each account's live balance correct."}
    >
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 text-sm">
          <SelectValue placeholder="Choose an account…" />
        </SelectTrigger>
        <SelectContent>
          {items.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name} · {formatINR(a.balance_paise)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
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
