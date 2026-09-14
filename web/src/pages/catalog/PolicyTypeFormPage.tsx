import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { categoriesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage, RecordPage } from "../../components/RecordPage";
import { Field } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { toast } from "../../components/Toast";
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
    <div className="space-y-2">
      {fields.map((f, i) => (
        <div key={i} className="rounded-control border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input className="input min-w-[140px] flex-1" placeholder="Field label"
              value={f.label}
              onChange={(e) => update(i, { label: e.target.value })} />
            <select className="select max-w-[150px]" value={f.type}
              onChange={(e) => update(i, {
                type: e.target.value as CustomFieldType })}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 whitespace-nowrap text-xs
              text-slate-500">
              <input type="checkbox" checked={f.required}
                onChange={(e) => update(i, { required: e.target.checked })} />
              Required
            </label>
            <div className="ml-auto flex items-center gap-0.5">
              {/* Icons, not text glyphs: a glyph cannot take a stroke weight
                  or a hover state, and it renders differently in every font. */}
              <button type="button" className="icon-btn" aria-label="Move up"
                title="Move up" onClick={() => move(i, -1)}>
                <Icon.ChevronDown size={15} className="rotate-180" /></button>
              <button type="button" className="icon-btn" aria-label="Move down"
                title="Move down" onClick={() => move(i, 1)}>
                <Icon.ChevronDown size={15} /></button>
              <button type="button" className="icon-btn text-money-out" title="Remove"
                onClick={() => remove(i)}><Icon.Trash size={15} /></button>
            </div>
          </div>

          {CHOICE_TYPES.includes(f.type) && (
            <input className="input mt-2" placeholder="Options, comma separated"
              value={f.options.join(", ")}
              onChange={(e) => update(i, {
                options: e.target.value.split(",").map((s) => s.trimStart()) })} />
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className="input min-w-[140px] flex-1"
              placeholder="Helper text"
              value={f.hint ?? ""}
              onChange={(e) => update(i, { hint: e.target.value })} />
            {NUMERIC_TYPES.includes(f.type) && (
              <>
                <input type="number" className="input max-w-[100px]"
                  placeholder="Min" value={f.min_value ?? ""}
                  onChange={(e) => update(i, {
                    min_value: e.target.value === "" ? null
                      : parseFloat(e.target.value) })} />
                <input type="number" className="input max-w-[100px]"
                  placeholder="Max" value={f.max_value ?? ""}
                  onChange={(e) => update(i, {
                    max_value: e.target.value === "" ? null
                      : parseFloat(e.target.value) })} />
              </>
            )}
            {f.type === "amount" && (
              <label className="flex items-center gap-1 whitespace-nowrap text-xs
                font-medium text-slate-900">
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
            <button type="button" className="icon-btn text-slate-500"
              aria-label="Move up" title="Move up"
              onClick={() => move(i, -1)}>
              <Icon.ChevronDown size={15} className="rotate-180" /></button>
            <button type="button" className="icon-btn text-slate-500"
              aria-label="Move down" title="Move down"
              onClick={() => move(i, 1)}>
              <Icon.ChevronDown size={15} /></button>
            <button type="button" className="icon-btn text-money-out" title="Remove"
              onClick={() => remove(i)}><Icon.Trash size={15} /></button>
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

  return (
    <div className="space-y-2">
      {nodes.map((n, i) => (
        <div key={i} className="rounded-control border border-line p-2.5">
          <div className="flex items-center gap-2">
            <span className="text-slate-300"><Icon.ChevronRight size={14} /></span>
            <input className="input flex-1" placeholder="Sub-type name"
              value={n.label}
              onChange={(e) => update(i, { label: e.target.value })} />
            <label className="flex items-center gap-1 whitespace-nowrap text-xs
              text-slate-500">
              <input type="checkbox" checked={n.active}
                onChange={(e) => update(i, { active: e.target.checked })} />
              Active
            </label>
            <button type="button" className="icon-btn text-money-out" title="Remove"
              onClick={() => remove(i)}><Icon.Trash size={15} /></button>
          </div>
          {(n.children.length > 0 || depth < MAX_SUBCATEGORY_DEPTH) && (
            <div className="ml-5 mt-2 border-l border-line/70 pl-3">
              <TreeEditor nodes={n.children} depth={depth + 1}
                onChange={(ch) => update(i, { children: ch })} />
              {depth < MAX_SUBCATEGORY_DEPTH && (
                <button type="button"
                  className="mt-1 text-xs font-medium text-slate-900 hover:underline"
                  onClick={() => addChild(i)}>
                  + Add sub-type
                </button>
              )}
            </div>
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
      subtitle="Sub-types, the fields collected on a policy of this type,
        and the documents it needs — at booking and at claim."
      onSubmit={() => save.mutate()}
      submitLabel="Save changes"
      submitting={save.isPending}
      disabled={!valid}
      wide
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Policy type name" required>
          <input className="input" value={label} autoFocus
            onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Description">
          <input className="input" value={description}
            onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>

      <p className="mb-2 mt-5 text-sm font-medium text-slate-700">Sub-types</p>
      <p className="mb-3 text-sm text-slate-500">
        Build the nested sub-types for this policy type (up to
        {" "}{MAX_SUBCATEGORY_DEPTH} levels). Rewards are set per node in each
        broker code's rate card. Add a level only if you need it.
      </p>
      <TreeEditor nodes={tree} depth={1} onChange={setTree} />
      <button type="button"
        className="mt-3 text-sm font-medium text-slate-900 hover:underline"
        onClick={() => setTree([...tree, newNode()])}>
        + Add sub-type
      </button>

      {/* --- Custom fields ------------------------------------------------- */}
      <p className="mb-2 mt-6 text-sm font-medium text-slate-700">Custom fields</p>
      <p className="mb-3 text-sm text-slate-500">
        Extra details collected when booking a policy of this type (e.g. Vehicle
        Number, OD Amount, TP Amount). Mark an Amount field "usable as reward
        base" to let it drive the reward % ("Comm On").
      </p>
      <FieldsEditor fields={fields} onChange={setFields} />
      <button type="button"
        className="mt-3 text-sm font-medium text-slate-900 hover:underline"
        onClick={() => setFields([...fields, newField()])}>
        + Add field
      </button>

      {/* --- Default reward base ------------------------------------------ */}
      <div className="mt-5 max-w-md">
        <Field label="Default reward base"
          hint="Which amount the reward % applies to by default. Staff can still
            change this per policy.">
          <select className="select" value={effectiveBase}
            onChange={(e) => setRewardBase(e.target.value)}>
            <option value={COMMISSIONABLE_BASE}>
              Reward Base Premium (net of GST)</option>
            {baseOptions.map((f) => (
              <option key={f.key || slugify(f.label)}
                value={f.key || slugify(f.label)}>{f.label}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* --- Documents to collect ----------------------------------------- */}
      <p className="mb-2 mt-6 text-sm font-medium text-slate-700">
        Documents to collect at booking</p>
      <p className="mb-3 text-sm text-slate-500">
        Supporting files uploaded on the policy form (e.g. RC book, previous
        policy, ID proof). Required documents block saving until attached.
      </p>
      <DocsEditor docs={docs} onChange={setDocs} />
      <button type="button"
        className="mt-3 text-sm font-medium text-slate-900 hover:underline"
        onClick={() => setDocs([...docs, newDoc()])}>
        + Add document
      </button>

      {/* --- Documents to collect on a CLAIM ------------------------------- */}
      {/*
        Owner C3: claim paperwork differs by type — motor wants an FIR, photos
        and an estimate; health wants a discharge summary and bills — and it is
        the SAME mechanism as the booking documents above, configured on the
        same page, rather than a second thing to learn.

        The server has read this list since the portal was rebuilt: it drives
        the "Still needed" checklist a partner sees on their claim, and the
        "This type asks for" line on the staff claim screen. Until now there
        was no way to fill it in, so both rendered empty.
      */}
      <p className="mb-2 mt-8 text-sm font-medium text-slate-700">
        Documents to collect on a claim</p>
      <p className="mb-3 text-sm text-slate-500">
        What this type needs when a claim is raised. The partner sees these as a
        checklist on their claim, so name them the way you would say them on the
        phone.
      </p>
      <DocsEditor docs={claimDocs} onChange={setClaimDocs} />
      <button type="button"
        className="mt-3 text-sm font-medium text-slate-900 hover:underline"
        onClick={() => setClaimDocs([...claimDocs, newDoc()])}>
        + Add claim document
      </button>

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
      <div className="space-y-5">
        <Field label="Name" required hint="e.g. Life, Motor, Health, Marine…">
          <input className="input" value={label} required autoFocus
            onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Description">
          <input className="input" value={description}
            onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {label.trim() && (
          <p className="text-xs text-slate-500">Key: <code>{slugify(label)}</code></p>
        )}
      </div>
    </FormPage>
  );
}

