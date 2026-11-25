import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { categoriesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage, RecordPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, ChevronDown, Plus, Trash2 } from "lucide-react";
import { toast } from "../../components/Toast";
import { SearchSelect } from "../../components/SearchSelect";
import { COMMISSIONABLE_BASE } from "../../lib/types";
import { MAX_SUBCATEGORY_DEPTH } from "../../lib/rating";
import type {
  CategoryNode, CustomFieldSpec, CustomFieldType, PolicyCategory,
  RequiredDocSpec,
} from "../../lib/types";

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 40) || "item";
}

// Assign stable machine keys before saving: keep existing keys, derive missing
// ones from the label, and de-duplicate among siblings.
function finalize(nodes: CategoryNode[]): CategoryNode[] {
  const used = new Set<string>();
  return nodes.map((n) => {
    let key = n.key || slugify(n.label);
    const base = key;
    let i = 2;
    while (used.has(key)) key = `${base}_${i++}`;
    used.add(key);
    return { key, label: n.label.trim(), active: n.active,
      children: finalize(n.children) };
  });
}

function allLabelled(nodes: CategoryNode[]): boolean {
  return nodes.every((n) => n.label.trim().length > 0 && allLabelled(n.children));
}

const newNode = (): CategoryNode => ({ key: "", label: "", active: true, children: [] });

/* ------------------------------------------------- custom fields + docs -- */

const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text", textarea: "Long text", number: "Number", amount: "Amount (₹)",
  date: "Date", select: "Dropdown", multi_select: "Multi-select",
  checkbox: "Yes / No", phone: "Mobile", email: "Email", url: "Link",
};
const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as CustomFieldType[];
const CHOICE_TYPES: CustomFieldType[] = ["select", "multi_select"];
const NUMERIC_TYPES: CustomFieldType[] = ["number", "amount"];

const newField = (): CustomFieldSpec => ({
  key: "", label: "", type: "text", required: false, options: [],
  hint: "", min_value: null, max_value: null, is_reward_base: false,
});
const newDoc = (): RequiredDocSpec => ({
  key: "", label: "", required: true, accepts: ["pdf", "jpg", "png"],
});

// Assign stable keys to custom fields (keep existing, slug the rest, de-dupe).
function finalizeFields(fields: CustomFieldSpec[]): CustomFieldSpec[] {
  const used = new Set<string>();
  return fields.map((f) => {
    let key = f.key || slugify(f.label);
    const base = key; let i = 2;
    while (used.has(key)) key = `${base}_${i++}`;
    used.add(key);
    return {
      ...f, key, label: f.label.trim(),
      hint: f.hint?.trim() || null,
      options: CHOICE_TYPES.includes(f.type)
        ? f.options.map((o) => o.trim()).filter(Boolean) : [],
      min_value: NUMERIC_TYPES.includes(f.type) ? f.min_value ?? null : null,
      max_value: NUMERIC_TYPES.includes(f.type) ? f.max_value ?? null : null,
      is_reward_base: f.type === "amount" ? f.is_reward_base : false,
    };
  });
}
function finalizeDocs(docs: RequiredDocSpec[]): RequiredDocSpec[] {
  const used = new Set<string>();
  return docs.map((d) => {
    let key = d.key || slugify(d.label);
    const base = key; let i = 2;
    while (used.has(key)) key = `${base}_${i++}`;
    used.add(key);
    return { ...d, key, label: d.label.trim() };
  });
}

// Amount fields flagged usable as the reward base — the "Comm On" options.
function rewardBaseFields(fields: CustomFieldSpec[]): CustomFieldSpec[] {
  return fields.filter((f) => f.type === "amount" && f.is_reward_base
    && f.label.trim());
}

function FieldsEditor({ fields, onChange }: {
  fields: CustomFieldSpec[]; onChange: (f: CustomFieldSpec[]) => void;
}) {
  const update = (i: number, patch: Partial<CustomFieldSpec>) =>
    onChange(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(fields.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {fields.map((f, i) => (
        <div key={i} className="rounded-control border border-line bg-white p-3 shadow-xs hover:border-line-soft transition-colors">
          <div className="flex flex-wrap items-center gap-2">
            <input className="input min-w-[140px] flex-1 text-sm font-medium" placeholder="Field label (e.g. Engine Number)"
              value={f.label}
              onChange={(e) => update(i, { label: e.target.value })} />
            <div className="w-36 shrink-0">
              <SearchSelect
                options={FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABELS[t] }))}
                value={f.type}
                onChange={(v) => update(i, { type: (v || "text") as CustomFieldType })}
              />
            </div>
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-slate-600 cursor-pointer bg-slate-50 px-2.5 py-1.5 rounded border border-line">
              <input type="checkbox" checked={f.required}
                onChange={(e) => update(i, { required: e.target.checked })} />
              Required
            </label>
            <div className="ml-auto flex items-center gap-0.5">
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-slate-800" aria-label="Move up"
                title="Move up" onClick={() => move(i, -1)}>
                <ChevronDown className="h-3.5 w-3.5 rotate-180" /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-slate-800" aria-label="Move down"
                title="Move down" onClick={() => move(i, 1)}>
                <ChevronDown className="h-3.5 w-3.5" /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-red-600 hover:bg-red-50 hover:text-red-700" title="Remove"
                onClick={() => remove(i)}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          </div>

          {CHOICE_TYPES.includes(f.type) && (
            <Input className="mt-2" placeholder="Options, comma separated (e.g. Petrol, Diesel, CNG, Electric)"
              value={f.options.join(", ")}
              onChange={(e) => update(i, {
                options: e.target.value.split(",").map((s) => s.trimStart()) })} />
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input className="h-8 min-w-[140px] flex-1 text-xs"
              placeholder="Helper text / hint for agents"
              value={f.hint ?? ""}
              onChange={(e) => update(i, { hint: e.target.value })} />
            {NUMERIC_TYPES.includes(f.type) && (
              <>
                <input type="number" className="input max-w-[100px] text-xs"
                  placeholder="Min" value={f.min_value ?? ""}
                  onChange={(e) => update(i, {
                    min_value: e.target.value === "" ? null
                      : parseFloat(e.target.value) })} />
                <input type="number" className="input max-w-[100px] text-xs"
                  placeholder="Max" value={f.max_value ?? ""}
                  onChange={(e) => update(i, {
                    max_value: e.target.value === "" ? null
                      : parseFloat(e.target.value) })} />
              </>
            )}
            {f.type === "amount" && (
              <label className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-money-in bg-money-in/10 px-2 py-1 rounded border border-money-in/20 cursor-pointer">
                <input type="checkbox" checked={f.is_reward_base}
                  onChange={(e) =>
                    update(i, { is_reward_base: e.target.checked })} />
                Usable as reward base
              </label>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FormFlowOrderBoard({
  fields,
  onMoveField,
}: {
  fields: CustomFieldSpec[];
  onMoveField: (index: number, dir: -1 | 1) => void;
}) {
  const amountFields = fields.filter((f) => f.type === "amount");
  const otherFields = fields.filter((f) => f.type !== "amount");

  return (
    <div className="rounded-control border border-line bg-white p-4 shadow-xs">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-line-soft">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-800">
            Booking Form Field Sequence
          </h4>
          <p className="text-xs text-slate-500 mt-0.5">
            Standard fields are anchored. Reorder your custom fields with Up and Down arrow buttons.
          </p>
        </div>
        <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
          {fields.length} Custom Field{fields.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="space-y-3 text-xs">
        {/* Section 1: Placement */}
        <div className="rounded-md border border-line-soft bg-slate-50/60 p-2.5">
          <span className="font-semibold text-slate-700 block mb-1">1. Placement</span>
          <div className="flex flex-wrap gap-1.5">
            {["Broker", "Policy type", "Insurer", "Sub-type"].map((name) => (
              <span key={name} className="px-2 py-1 rounded bg-slate-200/80 text-slate-700 font-medium text-[11px]">
                {name}
              </span>
            ))}
          </div>
        </div>

        {/* Section 2: Attribution */}
        <div className="rounded-md border border-line-soft bg-slate-50/60 p-2.5">
          <span className="font-semibold text-slate-700 block mb-1">2. Attribution</span>
          <div className="flex flex-wrap gap-1.5">
            {["Customer", "Channel Partner"].map((name) => (
              <span key={name} className="px-2 py-1 rounded bg-slate-200/80 text-slate-700 font-medium text-[11px]">
                {name}
              </span>
            ))}
          </div>
        </div>

        {/* Section 3: Financials & Policy Identifiers */}
        <div className="rounded-md border border-line-soft bg-slate-50/60 p-2.5">
          <span className="font-semibold text-slate-700 block mb-1">3. Financials & Identifiers</span>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {[
              "Policy number",
              "Gross Premium (₹)",
              "Premium before tax (₹)",
              "Sum Insured (₹)",
              "Start & Expiry dates",
            ].map((name) => (
              <span key={name} className="px-2 py-1 rounded bg-slate-200/80 text-slate-700 font-medium text-[11px]">
                {name}
              </span>
            ))}
          </div>

          {amountFields.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line-soft">
              <span className="text-[10px] uppercase font-bold text-slate-600 block mb-1">
                Amount Custom Fields (Calculated in Financials):
              </span>
              <div className="space-y-1.5">
                {fields.map((f, idx) => {
                  if (f.type !== "amount") return null;
                  return (
                    <div key={idx} className="flex items-center justify-between bg-white px-2.5 py-1.5 rounded border border-money-in/30 text-slate-800 shadow-2xs">
                      <span className="font-medium flex items-center gap-1.5 text-xs">
                        <span className="w-2 h-2 rounded-full bg-money-in" />
                        {f.label.trim() || `Untitled field #${idx + 1}`}
                        <span className="text-[10px] text-money-in font-semibold bg-money-in/10 px-1.5 py-0.2 rounded border border-money-in/20">Amount (₹)</span>
                      </span>
                      <div className="flex items-center gap-0.5">
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-slate-800"
                          onClick={() => onMoveField(idx, -1)} title="Move earlier in order">
                          <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-slate-800"
                          onClick={() => onMoveField(idx, 1)} title="Move later in order">
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Section 4: Specific Details */}
        <div className="rounded-md border border-line-soft bg-slate-50/60 p-2.5">
          <span className="font-semibold text-slate-700 block mb-1">4. Policy Specifics & Custom Details</span>
          {otherFields.length === 0 ? (
            <span className="text-[11px] text-slate-400 italic">No non-amount custom fields yet.</span>
          ) : (
            <div className="space-y-1.5">
              {fields.map((f, idx) => {
                if (f.type === "amount") return null;
                return (
                  <div key={idx} className="flex items-center justify-between bg-white px-2.5 py-1.5 rounded border border-line text-slate-800 shadow-2xs">
                    <span className="font-medium flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full bg-slate-400" />
                      {f.label.trim() || `Untitled field #${idx + 1}`}
                      <span className="text-[10px] text-slate-600 font-semibold bg-slate-100 px-1.5 py-0.2 rounded border border-line">{FIELD_TYPE_LABELS[f.type] || f.type}</span>
                    </span>
                    <div className="flex items-center gap-0.5">
                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-slate-800"
                        onClick={() => onMoveField(idx, -1)} title="Move earlier in order">
                        <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-slate-500 hover:text-slate-800"
                        onClick={() => onMoveField(idx, 1)} title="Move later in order">
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Section 5: Settlement */}
        <div className="rounded-md border border-line-soft bg-slate-50/60 p-2.5">
          <span className="font-semibold text-slate-700 block mb-1">5. Premium Settlement & Rates</span>
          <div className="flex flex-wrap gap-1.5">
            {["Policy Premium Paid By", "Customer Discount", "Commission rate & live ledger preview"].map((name) => (
              <span key={name} className="px-2 py-1 rounded bg-slate-200/80 text-slate-700 font-medium text-[11px]">
                {name}
              </span>
            ))}
          </div>
        </div>

        {/* Section 6: Documents */}
        <div className="rounded-md border border-line-soft bg-slate-50/60 p-2.5">
          <span className="font-semibold text-slate-700 block mb-1">6. Documents & Uploads</span>
          <div className="flex flex-wrap gap-1.5">
            <span className="px-2 py-1 rounded bg-slate-200/80 text-slate-700 font-medium text-[11px]">
              Policy PDF document
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DocsEditor({ docs, onChange }: {
  docs: RequiredDocSpec[]; onChange: (d: RequiredDocSpec[]) => void;
}) {
  const update = (i: number, patch: Partial<RequiredDocSpec>) =>
    onChange(docs.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  const remove = (i: number) => onChange(docs.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= docs.length) return;
    const next = [...docs];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {docs.map((d, i) => (
        <div key={i} className="flex items-center gap-2 rounded-control border
          border-line p-2.5">
          <input className="input flex-1" placeholder="Document name (e.g. RC book)"
            value={d.label}
            onChange={(e) => update(i, { label: e.target.value })} />
          <label className="flex items-center gap-1 whitespace-nowrap text-xs
            text-slate-500">
            <input type="checkbox" checked={d.required}
              onChange={(e) => update(i, { required: e.target.checked })} />
            Required
          </label>
          <div className="flex items-center gap-0.5">
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-slate-500"
              aria-label="Move up" title="Move up"
              onClick={() => move(i, -1)}>
              <ChevronDown className="h-3.5 w-3.5 rotate-180" /></Button>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-slate-500"
              aria-label="Move down" title="Move down"
              onClick={() => move(i, 1)}>
              <ChevronDown className="h-3.5 w-3.5" /></Button>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-red-600 hover:bg-red-50" title="Remove"
              onClick={() => remove(i)}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- tree edit -- */

function TreeEditor({ nodes, depth, onChange }: {
  nodes: CategoryNode[]; depth: number; onChange: (n: CategoryNode[]) => void;
}) {
  const update = (i: number, patch: Partial<CategoryNode>) =>
    onChange(nodes.map((n, idx) => (idx === i ? { ...n, ...patch } : n)));
  const remove = (i: number) => onChange(nodes.filter((_, idx) => idx !== i));
  const addChild = (i: number) =>
    update(i, { children: [...nodes[i].children, newNode()] });

  if (nodes.length === 0) return null;

  return (
    <div className={`space-y-2.5 ${depth > 1 ? "ml-3 sm:ml-5 pl-3 sm:pl-4 border-l-2 border-line-soft mt-2" : ""}`}>
      {nodes.map((n, i) => (
        <div
          key={i}
          className="rounded-control border border-line bg-white p-2.5 sm:px-3 sm:py-2.5 shadow-xs transition-colors hover:border-line-soft"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase bg-slate-100 text-slate-600 rounded">
              Level {depth}
            </span>
            <Input
              className="h-8 min-w-[130px] flex-1 text-sm font-medium"
              placeholder={`Sub-type name (Level ${depth})`}
              value={n.label}
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => update(i, { active: !n.active })}
                className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                  n.active
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                    : "bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100"
                }`}
                title="Toggle active status"
              >
                <Check className={`h-3 w-3 ${n.active ? "text-emerald-700" : "opacity-0"}`} />
                {n.active ? "Active" : "Inactive"}
              </button>
              {depth < MAX_SUBCATEGORY_DEPTH && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => addChild(i)}
                  title="Add a sub-branch under this category"
                >
                  <Plus className="mr-1 h-3 w-3" />
                  Add child
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-red-600 hover:bg-red-50"
                title="Remove sub-type"
                onClick={() => remove(i)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {n.children.length > 0 && (
            <TreeEditor
              nodes={n.children}
              depth={depth + 1}
              onChange={(ch) => update(i, { children: ch })}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ tree modal -- */

/**
 * Configure one policy type (/insurance/policy-types/:id).
 *
 * The heaviest form in the Catalog: a sub-type TREE, a custom-field builder
 * with per-field ordering, and a required-document list. It was the worst
 * possible fit for a dialog — three nested editors inside a scrolling box.
 */
export default function PolicyTypeFormPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const cats = useQuery({
    queryKey: ["categories", "all"],
    queryFn: async () => (await categoriesApi.list(true)).data,
  });
  const category = cats.data?.find((c) => c.id === id);

  if (!category) {
    return (
      <RecordPage backTo="/insurance/policy-types"
        backLabel="Back to policy types" title="Policy type"
        loading={cats.isLoading} notFound={!cats.isLoading}>
        <span />
      </RecordPage>
    );
  }
  return <EditTypeForm key={category.id} category={category}
    qc={qc} navigate={navigate} />;
}

function EditTypeForm({ category, qc, navigate }: {
  category: PolicyCategory;
  qc: ReturnType<typeof useQueryClient>;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [label, setLabel] = useState(category.label);
  const [description, setDescription] = useState(category.description ?? "");
  const [tree, setTree] = useState<CategoryNode[]>(
    () => JSON.parse(JSON.stringify(category.children ?? [])));
  const [fields, setFields] = useState<CustomFieldSpec[]>(
    () => JSON.parse(JSON.stringify(category.custom_fields ?? [])));
  const [docs, setDocs] = useState<RequiredDocSpec[]>(
    () => JSON.parse(JSON.stringify(category.required_documents ?? [])));
  // Same spec shape, same editor, different moment (owner C3).
  const [claimDocs, setClaimDocs] = useState<RequiredDocSpec[]>(
    () => JSON.parse(JSON.stringify(category.claim_documents ?? [])));
  const [rewardBase, setRewardBase] = useState<string>(
    category.reward_base_field || COMMISSIONABLE_BASE);

  // Amount fields flagged as base — recomputed live as the user edits fields.
  const baseOptions = rewardBaseFields(fields);
  // If the current base no longer exists (removed/unflagged), fall back.
  const effectiveBase = rewardBase !== COMMISSIONABLE_BASE
    && !baseOptions.some((f) => (f.key || slugify(f.label)) === rewardBase)
    ? COMMISSIONABLE_BASE : rewardBase;

  const save = useMutation({
    mutationFn: () => {
      const finalFields = finalizeFields(fields);
      const base = effectiveBase === COMMISSIONABLE_BASE ? COMMISSIONABLE_BASE
        : (finalFields.find((f) => f.key === effectiveBase
            || slugify(f.label) === effectiveBase)?.key ?? COMMISSIONABLE_BASE);
      return categoriesApi.update(category.id, {
        label: label.trim(),
        description: description.trim() || null,
        children: finalize(tree),
        custom_fields: finalFields,
        required_documents: finalizeDocs(docs),
        claim_documents: finalizeDocs(claimDocs),
        reward_base_field: base,
      });
    },
    onSuccess: () => {
      toast.success("Policy type saved.");
      qc.invalidateQueries({ queryKey: ["categories"] });
      navigate("/insurance/policy-types");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const fieldsValid = fields.every((f) => f.label.trim().length > 0
    && (!CHOICE_TYPES.includes(f.type)
      || f.options.some((o) => o.trim().length > 0)));
  const docsValid = docs.every((d) => d.label.trim().length > 0)
    && claimDocs.every((d) => d.label.trim().length > 0);
  const valid = label.trim().length > 0 && allLabelled(tree)
    && fieldsValid && docsValid;

  return (
    <FormPage
      backTo="/insurance/policy-types"
      backLabel="Back to policy types"
      title={category.label}
      subtitle="Sub-types, custom booking fields, and document requirements for this insurance category."
      onSubmit={() => save.mutate()}
      submitLabel="Save changes"
      submitting={save.isPending}
      disabled={!valid}
      wide
      maxWidth="max-w-7xl"
    >
      <div className="space-y-6">
        {/* Section 1: Classification Details */}
        <div className="rounded-control border border-line bg-slate-50/40 p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            1. Category Information
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Policy type name" required>
              <Input value={label} autoFocus
                onChange={(e) => setLabel(e.target.value)} />
            </FormField>
            <FormField label="Description" hint="Optional summary of this category">
              <Input value={description}
                onChange={(e) => setDescription(e.target.value)} />
            </FormField>
          </div>
        </div>

        {/* 2-Column Responsive Grid on Desktop */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column (7 cols): Sub-types Tree & Documents */}
          <div className="lg:col-span-7 space-y-6">
            {/* Section 2: Sub-types Hierarchy */}
            <div className="rounded-control border border-line bg-slate-50/40 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    2. Sub-types Tree Hierarchy
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Define the branches for this policy type (up to {MAX_SUBCATEGORY_DEPTH} levels). Rate cards price policies per sub-type.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTree([...tree, newNode()])}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add sub-type
                </Button>
              </div>
              {tree.length === 0 ? (
                <div className="rounded-control border border-dashed border-line p-6 text-center text-sm text-slate-500">
                  No sub-types defined yet. Policies will simply use "{category.label}".
                </div>
              ) : (
                <TreeEditor nodes={tree} depth={1} onChange={setTree} />
              )}
            </div>

            {/* Section 5: Documents at Booking */}
            <div className="rounded-control border border-line bg-slate-50/40 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    5. Documents to Collect at Booking
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Supporting files uploaded on the policy form (e.g. RC book, previous policy).
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDocs([...docs, newDoc()])}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add document
                </Button>
              </div>
              <DocsEditor docs={docs} onChange={setDocs} />
            </div>

            {/* Section 6: Claim Documents */}
            <div className="rounded-control border border-line bg-slate-50/40 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    6. Documents to Collect on a Claim
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Checklist presented to clients and partners when filing a claim for this type.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setClaimDocs([...claimDocs, newDoc()])}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add claim document
                </Button>
              </div>
              <DocsEditor docs={claimDocs} onChange={setClaimDocs} />
            </div>
          </div>

          {/* Right Column (5 cols): Custom Fields & Booking Order Manager & Reward Base */}
          <div className="lg:col-span-5 space-y-6">
            {/* Section 3: Custom Fields & Field Ordering */}
            <div className="rounded-control border border-line bg-slate-50/40 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    3. Custom Fields Configuration
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Add custom fields prompted when booking this policy type.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setFields([...fields, newField()])}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add field
                </Button>
              </div>

              {fields.length === 0 ? (
                <div className="rounded-control border border-dashed border-line p-5 text-center text-xs text-slate-500">
                  No custom fields configured for this type yet.
                </div>
              ) : (
                <FieldsEditor fields={fields} onChange={setFields} />
              )}
            </div>

            {/* Form Flow Order Manager with Move Up / Move Down */}
            <FormFlowOrderBoard
              fields={fields}
              onMoveField={(i, dir) => {
                const j = i + dir;
                if (j < 0 || j >= fields.length) return;
                const next = [...fields];
                [next[i], next[j]] = [next[j], next[i]];
                setFields(next);
              }}
            />

            {/* Section 4: Default Reward Base */}
            <div className="rounded-control border border-line bg-slate-50/40 p-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                4. Default Commission Reward Base
              </h3>
              <FormField
                label="Reward calculated on"
                tooltip="Which amount the reward % applies to by default. Staff can still override per policy."
              >
                <SearchSelect
                  options={[
                    { value: COMMISSIONABLE_BASE, label: "Premium before tax (net of GST)" },
                    ...baseOptions.map((f) => ({ value: f.key || slugify(f.label), label: f.label })),
                  ]}
                  value={effectiveBase}
                  onChange={(v) => setRewardBase(v || COMMISSIONABLE_BASE)}
                />
              </FormField>
            </div>
          </div>
        </div>
      </div>
    </FormPage>
  );
}

// On/off slider used to activate / deactivate a policy type in place. Thin

/* ------------------------------------------------------------- add type -- */

/** Create a policy type (/insurance/policy-types/new). Name only — sub-types,
 *  fields and documents are configured afterwards on the type's own page. */
export function AddPolicyTypePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");

  const save = useMutation({
    mutationFn: () => categoriesApi.create({
      key: slugify(label), label: label.trim(),
      description: description || null,
      children: [], custom_fields: [], required_documents: [],
      reward_base_field: COMMISSIONABLE_BASE,
    }),
    onSuccess: () => {
      toast.success("Policy type added.");
      qc.invalidateQueries({ queryKey: ["categories"] });
      navigate("/insurance/policy-types");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <FormPage
      backTo="/insurance/policy-types"
      backLabel="Back to policy types"
      title="Add policy type"
      subtitle="Just a name for now — sub-types, fields and documents are set up on its own page once it exists."
      onSubmit={() => { if (label.trim()) save.mutate(); }}
      submitLabel="Add type"
      submitting={save.isPending}
      disabled={!label.trim()}
    >
      <div className="space-y-4">
        <FormField label="Name" required hint="e.g. Life, Motor, Health, Marine…">
          <Input value={label} required autoFocus
            onChange={(e) => setLabel(e.target.value)} />
        </FormField>
        <FormField label="Description">
          <Input value={description}
            onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        {label.trim() && (
          <p className="text-xs text-slate-500">Key: <code>{slugify(label)}</code></p>
        )}
      </div>
    </FormPage>
  );
}

