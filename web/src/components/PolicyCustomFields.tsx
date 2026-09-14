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

import { Field } from "./ui";
import { Icon } from "./Icon";
import { DateInput } from "./DateInput";
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
        <select className="select" value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">— Select —</option>
          {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
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
        <input inputMode="numeric" maxLength={10} className="input"
          placeholder="10-digit number" value={(value as string) ?? ""}
          onChange={(e) =>
            onChange(e.target.value.replace(/\D/g, "") || undefined)} />
      );
    case "email":
      return (
        <input type="email" className="input" value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)} />
      );
    default: // text, url
      return (
        <input className="input" value={(value as string) ?? ""}
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
        <Field key={spec.key} label={spec.label} required={spec.required}
          hint={spec.hint || undefined}>
          <CustomFieldInput spec={spec} value={details[spec.key]}
            onChange={(v) => setDetail(spec.key, v)} />
        </Field>
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
    <div className="rounded-control border border-line p-3">
      <p className="mb-3 text-sm font-medium text-slate-600">{title} amounts</p>
      <FieldsGrid fields={fields} details={details} setDetail={setDetail} />
      {baseFieldOptions.length > 0 && (
        <div className="mt-3 max-w-xs border-t border-line/70 pt-3">
          <Field label="Reward calculated on"
            hint="Which amount the reward % applies to for this policy.">
            <select className="select" value={rewardBaseField}
              onChange={(e) => setRewardBaseField?.(e.target.value)}>
              <option value={COMMISSIONABLE_BASE}>
                Reward Base Premium (net of GST)</option>
              {baseFieldOptions.map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
          </Field>
          {rewardBaseField && rewardBaseField !== COMMISSIONABLE_BASE
            && !(Number(details[rewardBaseField]) > 0) && (
            <p className="mt-1 text-xs text-due">
              No amount entered — reward will fall back to the commissionable
              premium.
            </p>
          )}
        </div>
      )}
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
    <div className="rounded-control border border-line p-3">
      <p className="mb-3 text-sm font-medium text-slate-600">{title} details</p>
      <FieldsGrid fields={fields} details={details} setDetail={setDetail} />
    </div>
  );
}

// Document-collection slots for a policy type, rendered right after the policy
// PDF field. Required slots block saving until attached (validated by callers).
export function RequiredDocuments({ docs, docFiles, setDocFiles }: {
  docs: RequiredDocSpec[];
  docFiles: Record<string, File | null>;
  setDocFiles: (updater: (m: Record<string, File | null>) =>
    Record<string, File | null>) => void;
}) {
  if (docs.length === 0) return null;
  return (
    <div className="rounded-control border border-line p-3">
      <p className="mb-3 text-sm font-medium text-slate-600">
        Supporting documents</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {docs.map((doc) => (
          <Field key={doc.key} label={doc.label} required={doc.required}>
            <input type="file" className="input py-1.5"
              onChange={(e) => setDocFiles((m) => ({
                ...m, [doc.key]: e.target.files?.[0] ?? null }))} />
            {docFiles[doc.key] && (
              <span className="inline-flex items-center gap-1 text-xs
                font-medium text-money-in">
                <Icon.Check size={13} /> {docFiles[doc.key]!.name}
              </span>
            )}
          </Field>
        ))}
      </div>
    </div>
  );
}
