import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { categoriesApi, insurersApi, rateRulesApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { Icon } from "./Icon";
import { ErrorState, EmptyState, Field, PageLoader } from "./ui";
import { toast } from "./Toast";
import { confirmDialog } from "./Confirm";
import { describePath, pathLevels } from "../lib/rating";
import { titleCase } from "../lib/format";
import { refreshFinance } from "../lib/live";
import type { Broker, PolicyCategory, RateRule } from "../lib/types";

type FormState = {
  category_key: string; insurer_id: string; path: string[];
  agency_pct: string; partner_pct: string; label: string;
};
const empty = (category = ""): FormState => ({
  category_key: category, insurer_id: "", path: [],
  agency_pct: "", partner_pct: "", label: "",
});

// Manage the reward rate card (RateRules) under one Broker. Rewards are set per
// policy-type node, optionally pinned to a specific insurer company and drilled into
// its sub-types (RTO zone / vehicle class): choose a type, optionally an insurer,
// optionally drill into sub-types, then set the agency % and the channel-partner %.
export function RateRulesPanel({ broker, canManage, onClose }: {
  broker: Broker; canManage: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<RateRule | null>(null);
  const [f, setF] = useState<FormState>(empty());
  const set = (k: keyof FormState, v: string) => setF((s) => ({ ...s, [k]: v }));

  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await categoriesApi.list()).data,
  });
  const insurers = useQuery({
    queryKey: ["insurers", "", true],
    queryFn: async () => (await insurersApi.list({ page_size: 200 })).data,
  });
  const rules = useQuery({
    queryKey: ["rate-rules", broker.id],
    queryFn: async () => (await rateRulesApi.list(broker.id)).data,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["rate-rules", broker.id] });
    refreshFinance(qc);   // rate-card edits are broker-rate changes (owner Q1.4)
  };
  const reset = () => { setEditing(null); setF(empty(cats.data?.[0]?.key || "")); };

  const catByKey = useMemo(() => {
    const m = new Map<string, PolicyCategory>();
    (cats.data ?? []).forEach((c) => m.set(c.key, c));
    return m;
  }, [cats.data]);
  const insurerName = useMemo(() => {
    const m = new Map<string, string>();
    (insurers.data?.items ?? []).forEach((i) => m.set(i.id, i.name));
    return m;
  }, [insurers.data]);
  const selectedCat = catByKey.get(f.category_key);
  const levels = selectedCat ? pathLevels(selectedCat.children, f.path) : [];

  const setLevel = (i: number, value: string) => setF((s) => {
    const next = s.path.slice(0, i);
    if (value) next.push(value);
    return { ...s, path: next };
  });

  const body = useMemo(() => ({
    broker_id: broker.id,
    insurer_id: f.insurer_id || null,
    category_key: f.category_key,
    subcategory_path: f.path,
    agency_basis: "percent",
    agency_value: f.agency_pct ? Math.round(parseFloat(f.agency_pct) * 100) : 0,
    partner_basis: "percent",
    partner_value: f.partner_pct ? Math.round(parseFloat(f.partner_pct) * 100) : 0,
    label: f.label || null,
  }), [f, broker.id]);

  const save = useMutation({
    mutationFn: () => editing
      ? rateRulesApi.update(editing.id, body)
      : rateRulesApi.create(body),
    onSuccess: () => {
      toast.success(editing ? "Rate updated." : "Rate added.");
      invalidate(); reset();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => rateRulesApi.remove(id),
    onSuccess: () => { toast.success("Rate deleted."); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const toggleActive = useMutation({
    mutationFn: (r: RateRule) => rateRulesApi.update(r.id, { active: !r.active }),
    onSuccess: invalidate,
    onError: (e) => toast.error(apiError(e)),
  });

  const startEdit = (r: RateRule) => {
    setEditing(r);
    setF({
      category_key: r.category_key, insurer_id: r.insurer_id ?? "",
      path: r.subcategory_path ?? [],
      agency_pct: r.agency_value ? String(r.agency_value / 100) : "",
      partner_pct: r.partner_value ? String(r.partner_value / 100) : "",
      label: r.label ?? "",
    });
  };

  const pct = (basis: string, value: number) =>
    basis === "percent" ? `${(value / 100).toFixed(2)}%` : `₹${(value / 100).toFixed(0)}`;
  const scenario = (r: RateRule) => {
    const cat = catByKey.get(r.category_key);
    return cat ? describePath(cat.children, r.subcategory_path)
      : (r.subcategory_path.join(" / ") || "Whole type");
  };
  const canSave = !!f.category_key && !!f.agency_pct;

  return (
    <div className="mt-5 rounded-control border border-brand-100 bg-slate-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-700">
          Rate card — <span className="tracking-wider">{broker.short_code}</span>
          <span className="ml-2 text-xs font-normal text-slate-500">
            {broker.name}</span>
        </p>
        <button className="text-xs font-medium text-slate-500 hover:text-slate-700"
          onClick={onClose}>Close rates</button>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Set the reward per policy type. Pin an insurer company and/or drill into
        sub-types for a more specific rate — the most specific match (insurer-specific,
        then deepest sub-type) applies when a policy is booked through this broker.
      </p>

      {rules.isError ? <ErrorState onRetry={() => rules.refetch()} /> : rules.isLoading ? (
        <PageLoader />
      ) : (rules.data?.length ?? 0) === 0 ? (
        <EmptyState title="No rates yet"
          hint="Add a rate below so policies through this broker get the right %." />
      ) : (
        <div className="overflow-x-auto rounded-control border border-line/70 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="px-5 py-3">Policy type</th>
                <th className="px-5 py-3">Insurer</th>
                <th className="px-5 py-3">Sub-type</th>
                <th className="px-5 py-3">Agency</th>
                <th className="px-5 py-3">Partner</th>
                <th className="px-5 py-3">Status</th>
                {canManage && <th className="px-5 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rules.data!.map((r) => (
                <tr key={r.id} className="border-t border-line-soft">
                  <td className="px-5 py-3 text-slate-700">
                    {catByKey.get(r.category_key)?.label ?? titleCase(r.category_key)}
                    {r.label && (
                      <span className="ml-1 text-xs text-slate-500">· {r.label}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-500">
                    {r.insurer_id ? (insurerName.get(r.insurer_id) ?? "—")
                      : <span className="text-slate-500">Any</span>}
                  </td>
                  <td className="px-5 py-3 text-slate-500">{scenario(r)}</td>
                  <td className="px-5 py-3 font-medium text-slate-700">
                    {pct(r.agency_basis, r.agency_value)}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {r.partner_value ? pct(r.partner_basis, r.partner_value) : "—"}
                  </td>
                  <td className="px-5 py-3">
                    <button
                      disabled={!canManage}
                      onClick={() => canManage && toggleActive.mutate(r)}
                      className={r.active
                        ? "badge bg-money-in/15 text-money-in"
                        : "badge bg-slate-100 text-slate-500"}>
                      {r.active ? "Active" : "Inactive"}
                    </button>
                  </td>
                  {canManage && (
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-1.5">
                        <button className="icon-btn" title="Edit"
                          onClick={() => startEdit(r)}><Icon.Edit size={15} /></button>
                        <button className="icon-btn text-money-out" title="Delete"
                          onClick={async () => {
                            if (await confirmDialog({ message: "Delete this rate?",
                              danger: true })) del.mutate(r.id); }}>
                          <Icon.Trash size={15} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <form onSubmit={(e) => { e.preventDefault(); if (canSave) save.mutate(); }}
          className="mt-4 space-y-3 rounded-control bg-white p-4">
          <p className="text-sm font-medium text-slate-600">
            {editing ? "Edit rate" : "Add a rate"}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Policy type" required>
              <select className="select" value={f.category_key}
                onChange={(e) =>
                  setF((s) => ({ ...s, category_key: e.target.value, path: [] }))}>
                <option value="">Select…</option>
                {cats.data?.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Insurer company"
              hint="Leave as Any to apply to every insurer.">
              <select className="select" value={f.insurer_id}
                onChange={(e) => set("insurer_id", e.target.value)}>
                <option value="">Any insurer</option>
                {insurers.data?.items.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </Field>
            {levels.map((lvl, i) => (
              <Field key={i} label={i === 0 ? "Sub-type" : `Sub-type ${i + 1}`}>
                <select className="select" value={lvl.value}
                  onChange={(e) => setLevel(i, e.target.value)}>
                  <option value="">Any / whole level</option>
                  {lvl.options.map((n) => (
                    <option key={n.key} value={n.key}>{n.label}</option>
                  ))}
                </select>
              </Field>
            ))}
            <Field label="Label">
              <input className="input" value={f.label}
                onChange={(e) => set("label", e.target.value)}
                placeholder="e.g. Zone A package" />
            </Field>
            <Field label="Agency % (from broker)" required>
              <input type="number" step="0.01" min="0" className="input"
                value={f.agency_pct} placeholder="e.g. 30"
                onChange={(e) => set("agency_pct", e.target.value)} />
            </Field>
            <Field label="Channel partner %">
              <input type="number" step="0.01" min="0" className="input"
                value={f.partner_pct} placeholder="e.g. 20"
                onChange={(e) => set("partner_pct", e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-slate-500">
            Applied to the reward-base (GST-net) premium. TDS is deducted
            separately at reward-receipt and never affects these figures.
          </p>
          <div className="flex justify-end gap-2">
            {editing && (
              <button type="button" className="btn-secondary" onClick={reset}>
                Cancel edit
              </button>
            )}
            <button type="submit" className="btn-primary"
              disabled={!canSave || save.isPending}>
              {save.isPending ? "Saving…" : editing ? "Save changes" : "Add rate"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
