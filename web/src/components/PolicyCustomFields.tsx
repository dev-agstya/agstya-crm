// Shared rendering + validation for a policy type's admin-configured custom
// fields and document-collection slots. Used by BOTH the Add Policy form and the
// Renewal form so the two stay in lock-step (owner 2026-07-24).
//
// Ordering rule the owner asked for: amount-type custom fields sit right after
// the built-in amount fields (via AmountCustomFields), everything else groups
// into OtherCustomFields, and the document slots render right after the policy
// PDF field (RequiredDocuments). Within each group the type's own saved order is
// preserved — admins reorder fields with the ▲▼ controls on the Policy Types
// page, and both forms follow that order.

import { Input } from "@/components/ui/input";
import { FormField } from "./shared/FormSection";
import { DateInput } from "./DateInput";
import { SearchSelect } from "./SearchSelect";
import { FileUpload } from "./FileUpload";
import { rupeesToPaise } from "../lib/format";
import { COMMISSIONABLE_BASE } from "../lib/types";
import type { CustomFieldSpec, RequiredDocSpec } from "../lib/types";

export type Details = Record<string, unknown>;

// Split a type's custom fields into the amount group and the rest, preserving
// each field's saved order.
export function splitCustomFields(fields: CustomFieldSpec[]) {
  return {
    amount: fields.filter((f) => f.type === "amount"),
    other: fields.filter((f) => f.type !== "amount"),
  };
}

// Validate collected custom-field values against a type's specs (mirrors the
// backend). Returns a user-facing message on the first problem, else null.
export function validateDetailsClient(
  specs: CustomFieldSpec[], details: Details,
): string | null {
  for (const s of specs) {
    const v = details[s.key];
    const blank = v === undefined || v === null || v === ""
      || (Array.isArray(v) && v.length === 0);
    if (blank) {
      if (s.required) return `"${s.label}" is required.`;
      continue;
    }
    if (s.type === "amount" || s.type === "number") {
      // Amount is stored in paise; bounds are in rupees.
      const natural = s.type === "amount" ? (v as number) / 100 : (v as number);
      if (s.min_value != null && natural < s.min_value)
        return `"${s.label}" must be at least ${s.min_value}.`;
      if (s.max_value != null && natural > s.max_value)
        return `"${s.label}" must be at most ${s.max_value}.`;
    }
    if (s.type === "phone" && !/^\d{10}$/.test(String(v)))
      return `"${s.label}" must be a 10-digit mobile number.`;
    if (s.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v)))
      return `"${s.label}" must be a valid email.`;
  }
  return null;
}

// A single dynamic input rendered from a custom-field spec. Values are stored in
// the backend format: paise for `amount`, number for `number`, boolean for
// `checkbox`, string[] for `multi_select`, string otherwise.
export function CustomFieldInput({ spec, value, onChange }: {
  spec: CustomFieldSpec; value: unknown; onChange: (v: unknown) => void;
}) {
  switch (spec.type) {
    case "textarea":
      return (
        <textarea className="input" rows={2} value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)} />
      );
    case "amount":
      return (
        <input type="number" step="0.01" min="0" className="input"
          placeholder="₹"
          value={value != null ? String((value as number) / 100) : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined
            : rupeesToPaise(parseFloat(e.target.value)))} />
      );
    case "number":
      return (
        <input type="number" className="input"
          value={value != null ? String(value) : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined
            : parseFloat(e.target.value))} />
      );
    case "date":
      return (
        <DateInput value={(value as string) ?? ""}
          onChange={(v) => onChange(v || undefined)} />
      );
    case "checkbox":
      return (
        <label className="flex h-[38px] items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={!!value}
            onChange={(e) => onChange(e.target.checked || undefined)} />
          Yes
        </label>
      );
    case "select":
      return (
        <SearchSelect
          options={spec.options.map((o) => ({ value: o, label: o }))}
          value={(value as string) ?? ""}
          placeholder="— Select —"
          allowClear
          onChange={(v) => onChange(v || undefined)}
        />
      );
    case "multi_select": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5 py-1.5">
          {spec.options.map((o) => {
            const on = arr.includes(o);
            return (
              <button type="button" key={o}
                className={`rounded-full border px-3 py-1 text-xs transition ${on
                  ? "border-ink bg-slate-100 text-slate-900"
                  : "border-slate-300 text-slate-500 hover:border-slate-300"}`}
                onClick={() => onChange(
                  on ? arr.filter((x) => x !== o) : [...arr, o])}>
                {o}
              </button>
            );
          })}
        </div>
      );
    }
    case "phone":
      return (
        <Input inputMode="numeric" maxLength={10}
          placeholder="10-digit number" value={(value as string) ?? ""}
          onChange={(e) =>
            onChange(e.target.value.replace(/\D/g, "") || undefined)} />
      );
    case "email":
      return (
        <Input type="email" value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)} />
      );
    default: // text, url
      return (
        <Input value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)} />
      );
  }
}

function FieldsGrid({ fields, details, setDetail }: {
  fields: CustomFieldSpec[]; details: Details;
  setDetail: (key: string, v: unknown) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {fields.map((spec) => (
        <FormField key={spec.key} label={spec.label} required={spec.required}
          hint={spec.hint || undefined}>
          <CustomFieldInput spec={spec} value={details[spec.key]}
            onChange={(v) => setDetail(spec.key, v)} />
        </FormField>
      ))}
    </div>
  );
}

// Amount-type custom fields, rendered immediately after the built-in amount
// inputs, together with the "reward calculated on" selector when any amount
// field is flagged usable as the reward base.
//
// The reward-base pair is OPTIONAL, and its absence is what the channel-partner
// submission form uses (2026-08-04): which amount the commission is calculated
// on is an agency decision, and the portal API has no field for it, so the
// selector must not be on screen for a partner. Omitting the props drops the
// control rather than rendering one that silently does nothing.
export function AmountCustomFields({ title, fields, details, setDetail,
  rewardBaseField, setRewardBaseField }: {
  title: string;
  fields: CustomFieldSpec[];
  details: Details;
  setDetail: (key: string, v: unknown) => void;
  rewardBaseField?: string;
  setRewardBaseField?: (v: string) => void;
}) {
  const canPickBase = rewardBaseField !== undefined && !!setRewardBaseField;
  const baseFieldOptions = canPickBase
    ? fields.filter((f) => f.is_reward_base) : [];
  if (fields.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/40 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {title} Amounts & Specifics
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((spec) => (
          <FormField key={spec.key} label={spec.label} required={spec.required}
            hint={spec.hint || undefined}>
            <CustomFieldInput spec={spec} value={details[spec.key]}
              onChange={(v) => setDetail(spec.key, v)} />
          </FormField>
        ))}
        {baseFieldOptions.length > 0 && (
          <FormField label="Reward calculated on"
            hint="Which amount the reward % applies to for this policy.">
            <SearchSelect
              options={[
                { value: COMMISSIONABLE_BASE, label: "Premium before tax (net of GST)" },
                ...baseFieldOptions.map((f) => ({ value: f.key, label: f.label })),
              ]}
              value={rewardBaseField || COMMISSIONABLE_BASE}
              onChange={(v) => setRewardBaseField?.(v || COMMISSIONABLE_BASE)}
            />
            {rewardBaseField && rewardBaseField !== COMMISSIONABLE_BASE
              && !(Number(details[rewardBaseField]) > 0) && (
              <p className="mt-1 text-xs text-amber-700">
                No amount entered — reward falls back to commissionable premium.
              </p>
            )}
          </FormField>
        )}
      </div>
    </div>
  );
}

// Non-amount custom fields (text, dropdown, date, …) grouped together.
export function OtherCustomFields({ title, fields, details, setDetail }: {
  title: string;
  fields: CustomFieldSpec[];
  details: Details;
  setDetail: (key: string, v: unknown) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/40 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {title} Details & Specifics
      </h3>
      <FieldsGrid fields={fields} details={details} setDetail={setDetail} />
    </div>
  );
}

export function RequiredDocuments({ docs, docFiles, setDocFiles }: {
  docs: RequiredDocSpec[];
  docFiles: Record<string, File | null>;
  setDocFiles: (updater: (m: Record<string, File | null>) =>
    Record<string, File | null>) => void;
}) {
  if (docs.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/40 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
        Supporting Documents Required for {docs.length === 1 ? "this Type" : "these Types"}
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {docs.map((doc) => (
          <FormField key={doc.key} label={doc.label} required={doc.required}>
            <FileUpload
              file={docFiles[doc.key] ?? null}
              onChange={(f) => setDocFiles((m) => ({ ...m, [doc.key]: f }))}
              hint="PDF or image up to 20 MB"
            />
          </FormField>
        ))}
      </div>
    </div>
  );
}
