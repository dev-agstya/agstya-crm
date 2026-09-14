import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  brokersApi, customersApi, policiesApi, usersApi,
} from "../api/endpoints";
import { SearchSelect, type SearchSelectOption } from "./SearchSelect";

/**
 * Data-bound pickers built on the ONE `SearchSelect`.
 *
 * These exist so a screen never hand-rolls "search a record and pick it" again:
 * every such field in the app is the same component with the same dropdown,
 * keyboard behaviour and empty state, differing only in what it queries.
 */

/* ------------------------------------------------------------- customers -- */

export function CustomerPicker({
  value, displayName, onSelect, onAddNew, disabled = false,
  allowClear = false,
}: {
  value: string;
  /** Name of the picked customer — they may not be in the current results. */
  displayName?: string;
  onSelect: (id: string, name: string) => void;
  onAddNew?: () => void;
  disabled?: boolean;
  /** Off by default: the customer is a required field almost everywhere, and
   *  offering a "— None —" row on a required field is a trap. */
  allowClear?: boolean;
}) {
  const [query, setQuery] = useState("");
  const results = useQuery({
    queryKey: ["customer-search", query],
    queryFn: async () => (await customersApi.list({
      q: query || undefined, page_size: 20 })).data.items,
  });

  const options: SearchSelectOption[] = (results.data ?? []).map((c) => ({
    value: c.id,
    label: c.name,
    sub: [c.code, c.mobile].filter(Boolean).join(" · "),
  }));

  return (
    <SearchSelect
      options={options}
      value={value}
      selectedLabel={displayName}
      onSearch={setQuery}
      loading={results.isLoading}
      disabled={disabled}
      allowClear={allowClear}
      placeholder="Select customer…"
      searchPlaceholder="Search by name, code or mobile…"
      emptyHint="Type to search customers."
      onChange={(id, option) => onSelect(id, option?.label ?? "")}
      onAddNew={onAddNew}
      addNewLabel={onAddNew ? "Add Customer" : undefined}
    />
  );
}

/* --------------------------------------------------------------- policies -- */

export function PolicyPicker({
  value, displayLabel, onSelect, disabled = false,
}: {
  value: string;
  displayLabel?: string;
  onSelect: (id: string, label: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim();
  const results = useQuery({
    queryKey: ["policy-pick", term],
    enabled: term.length >= 2,
    queryFn: async () => (await policiesApi.list({ q: term, page_size: 10 }))
      .data.items,
  });

  const options: SearchSelectOption[] = (results.data ?? []).map((p) => ({
    value: p.id,
    label: p.policy_number || p.code,
    sub: p.customer_name ?? undefined,
  }));

  return (
    <SearchSelect
      options={options}
      value={value}
      selectedLabel={displayLabel}
      onSearch={setQuery}
      loading={term.length >= 2 && results.isLoading}
      disabled={disabled}
      allowClear
      placeholder="— Not linked to a policy —"
      clearLabel="— Not linked to a policy —"
      searchPlaceholder="Policy number or code…"
      emptyHint="Type at least 2 characters to search."
      onChange={(id, option) => onSelect(
        id, option ? [option.label, option.sub].filter(Boolean).join(" · ") : "")}
    />
  );
}

/* ---------------------------------------------------------------- parties -- */

export type PartyKind = "customer" | "broker" | "channel_partner";
export interface Party {
  id: string;
  label: string;
  kind: PartyKind;
  mobile?: string;
}

const KIND_LABEL: Record<PartyKind, string> = {
  customer: "Customer", broker: "Broker", channel_partner: "Channel Partner",
};

/** One search box across customers + brokers + channel partners. */
export function PartyPicker({ value, onChange, disabled = false }: {
  value: Party | null;
  onChange: (party: Party | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim();

  const results = useQuery({
    queryKey: ["party-search", term],
    enabled: term.length >= 2,
    queryFn: async (): Promise<Party[]> => {
      const [cust, brokers, partners] = await Promise.all([
        customersApi.list({ q: term, page_size: 6 }),
        brokersApi.list({ active_only: 1 }),
        usersApi.list({ account_type: "channel_partner", q: term,
          page_size: 6 }),
      ]);
      const lc = term.toLowerCase();
      const out: Party[] = [];
      for (const c of cust.data.items)
        out.push({ id: c.id, label: `${c.name} (${c.code})`,
          kind: "customer", mobile: c.mobile ?? undefined });
      for (const b of brokers.data.filter((b) =>
        b.name.toLowerCase().includes(lc)
        || (b.short_code ?? "").toLowerCase().includes(lc)))
        out.push({ id: b.id, label: `${b.name} (${b.short_code})`,
          kind: "broker" });
      for (const p of partners.data.items)
        out.push({ id: p.id, label: `${p.full_name} (${p.code})`,
          kind: "channel_partner", mobile: p.mobile ?? undefined });
      return out;
    },
  });

  const parties = results.data ?? [];
  // The picker keys on id alone, but ids are only unique WITHIN an entity type
  // — so the option value carries the kind too.
  const key = (p: Party) => `${p.kind}:${p.id}`;
  const options: SearchSelectOption[] = parties.map((p) => ({
    value: key(p), label: p.label, sub: p.mobile,
    badge: KIND_LABEL[p.kind],
  }));

  return (
    <SearchSelect
      options={options}
      value={value ? key(value) : ""}
      selectedLabel={value?.label}
      onSearch={setQuery}
      loading={term.length >= 2 && results.isLoading}
      disabled={disabled}
      allowClear
      placeholder="Select customer, broker or channel partner…"
      searchPlaceholder="Search by name or code…"
      emptyHint="Type at least 2 characters to search."
      onChange={(v) => onChange(parties.find((p) => key(p) === v) ?? null)}
    />
  );
}
