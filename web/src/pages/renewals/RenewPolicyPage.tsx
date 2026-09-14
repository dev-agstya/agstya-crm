import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import {
  categoriesApi, documentsApi, policiesApi, rateRulesApi,
} from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage, RecordPage } from "../../components/RecordPage";
import { Field, ToggleField } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { DateInput } from "../../components/DateInput";
import {
  AmountCustomFields, OtherCustomFields, RequiredDocuments,
  splitCustomFields, validateDetailsClient, type Details,
} from "../../components/PolicyCustomFields";
import { toast } from "../../components/Toast";
import { fromDateInput, rupeesToPaise } from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import { useAuth } from "../../store/auth";
import { COMMISSIONABLE_BASE } from "../../lib/types";
import type { Policy } from "../../lib/types";

// A cover runs to the day BEFORE the anniversary, so a 1-Apr policy expires on
// 31-Mar. Shared with RenewalsPage.
const RATE_SOURCE_LABEL: Record<string, string> = {
  rate_rule: "matched rate card",
};

const dateInput = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
const addYear = (d: string) => {
  const dt = new Date(d || Date.now());
  dt.setFullYear(dt.getFullYear() + 1);
  dt.setDate(dt.getDate() - 1);
  return dt.toISOString().slice(0, 10);
};

/** Renew one policy (/renewals/:id). */
export default function RenewPolicyPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isPartner = user?.account_type === "channel_partner";

  const loaded = useQuery({
    queryKey: ["policy", id],
    retry: false,
    queryFn: async () => (await policiesApi.get(id)).data,
  });
  const policy = loaded.data;
  const missing = isAxiosError(loaded.error)
    && loaded.error.response?.status === 404;

  if (!policy) {
    return (
      <RecordPage backTo="/renewals" backLabel="Back to renewals"
        title="Renew policy" loading={loaded.isLoading}
        error={missing ? undefined : loaded.error}
        onRetry={() => loaded.refetch()} notFound={missing}>
        <span />
      </RecordPage>
    );
  }
  return <RenewForm key={policy.id} policy={policy} qc={qc}
    isPartner={isPartner} navigate={navigate} />;
}

function RenewForm({ policy, qc, isPartner, navigate }: {
  policy: Policy;
  qc: ReturnType<typeof useQueryClient>;
  isPartner: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const startDefault = dateInput(policy.expiry_date) || new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    premium: String(policy.premium_amount / 100),
    commissionable: "",
    policy_number: "",
    start_date: startDefault,
    expiry_date: addYear(startDefault),
    agency_value: policy.reward.agency_value
      ? String(policy.reward.agency_value / 100) : "",
    partner_value: policy.reward.partner_value
      ? String(policy.reward.partner_value / 100) : "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  // The policy type's custom fields + document-collection slots so the renewal
  // form matches the add form (owner 2026-07-24). Values pre-fill from the
  // expiring policy and are re-collected (required ones block saving).
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await categoriesApi.list()).data,
  });
  const cat = cats.data?.find((c) => c.key === policy.category_key);
  const customFields = useMemo(() => cat?.custom_fields ?? [], [cat]);
  const requiredDocs = cat?.required_documents ?? [];
  const { amount: amountCustomFields, other: otherCustomFields } =
    useMemo(() => splitCustomFields(customFields), [customFields]);
  const [details, setDetails] = useState<Details>(
    () => ({ ...(policy.details ?? {}) }));
  const setDetail = (key: string, v: unknown) =>
    setDetails((d) => {
      if (v === undefined) { const { [key]: _drop, ...rest } = d; return rest; }
      return { ...d, [key]: v };
    });
  const [rewardBaseField, setRewardBaseField] = useState<string>(
    policy.reward_base_field || COMMISSIONABLE_BASE);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [docFiles, setDocFiles] = useState<Record<string, File | null>>({});

  /*
    CARRYING LAST YEAR'S PAPERWORK FORWARD.

    A renewal started with an EMPTY document set. The RC book, the KYC and the
    previous-policy copy collected at the original booking were all still on
    the expiring policy and none of them came across — so a document that had
    not changed in a year had to be found and re-uploaded, and every one of the
    type's required slots showed as MISSING on a policy where nothing was
    actually missing.

    Default ON, because "nothing changed" is the normal case for a renewal.
    Anything genuinely new is simply attached below: uploading to a slot
    REPLACES whatever is in it (the server matches on policy + doc_key), so the
    two mechanisms compose instead of fighting.

    The POLICY PDF is never copied and is never optional — it describes one
    term's cover, and last year's certificate under this year's number is the
    wrong document in the customer's hands.
  */
  const [copyDocs, setCopyDocs] = useState(true);
  const existingDocs = useQuery({
    // Same key the policy record uses, so opening a renewal off a policy page
    // reuses what is already cached.
    queryKey: ["policy-docs", policy.id],
    queryFn: async () =>
      (await documentsApi.listFor("policy", policy.id)).data,
  });
  // Which of the type's slots last year's policy can fill. The policy PDF is
  // excluded here exactly as it is server-side.
  const carriedKeys = useMemo(() => new Set(
    (existingDocs.data ?? [])
      .map((d) => d.doc_key)
      .filter((k): k is string => !!k && k !== "policy_pdf")),
  [existingDocs.data]);

  const preview = useQuery({
    queryKey: ["rate-preview-renew", policy.id],
    queryFn: async () => (await rateRulesApi.preview({
      broker_id: policy.broker_id!,
      insurer_id: policy.insurer_id || undefined,
      category_key: policy.category_key,
      subcategory_path: policy.subcategory_path || [],
    })).data,
    enabled: !!policy.broker_id,
  });
  const rate = preview.data;
  const applyRate = () => {
    if (!rate || rate.source === "none" || rate.agency_basis !== "percent") return;
    setForm((f) => ({
      ...f,
      agency_value: rate.agency_value ? String(rate.agency_value / 100) : f.agency_value,
      partner_value: rate.partner_value
        ? String(rate.partner_value / 100) : f.partner_value,
    }));
  };
  // The rate is already reflected in the % inputs when they equal the rate card,
  // so hide the redundant "Apply" then (owner Q4c) — it returns only if the user
  // edits a value away from the card.
  const rateAgency = rate && rate.source !== "none" && rate.agency_basis === "percent"
    && rate.agency_value ? String(rate.agency_value / 100) : "";
  const ratePartner = rate && rate.source !== "none" && rate.partner_value
    ? String(rate.partner_value / 100) : "";
  const alreadyApplied = form.agency_value === rateAgency
    && (!ratePartner || form.partner_value === ratePartner);
  const showApply = !!rate && rate.source !== "none"
    && rate.agency_basis === "percent" && !alreadyApplied;

  const save = useMutation({
    mutationFn: async () => {
      const reward = form.agency_value || form.partner_value ? {
        agency_basis: "percent",
        agency_value: form.agency_value
          ? Math.round(parseFloat(form.agency_value) * 100) : 0,
        partner_basis: "percent",
        partner_value: form.partner_value
          ? Math.round(parseFloat(form.partner_value) * 100) : 0,
      } : undefined;
      const res = await policiesApi.renew(policy.id, {
        premium_amount: rupeesToPaise(parseFloat(form.premium || "0")),
        commissionable_premium: form.commissionable
          ? rupeesToPaise(parseFloat(form.commissionable)) : 0,
        start_date: fromDateInput(form.start_date),
        expiry_date: fromDateInput(form.expiry_date),
        policy_number: form.policy_number || null,
        reward,
        details,
        reward_base_field: rewardBaseField,
        copy_documents: copyDocs,
      });
      const newId = res.data.id;
      if (pdfFile) await policiesApi.uploadDocument(newId, pdfFile);
      for (const doc of requiredDocs) {
        const file = docFiles[doc.key];
        if (file)
          await policiesApi.uploadExtraDocument(newId, doc.key, doc.label, file);
      }
      return res;
    },
    onSuccess: () => {
      toast.success("Policy renewed.");
      qc.invalidateQueries({ queryKey: ["renewals-due"] });
      qc.invalidateQueries({ queryKey: ["policies"] });
      refreshFinance(qc); // an owner renewal books a new policy's finance
      navigate("/renewals");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canSave = parseFloat(form.premium || "0") > 0
    && !!form.start_date && !!form.expiry_date;

  const submit = () => {
    if (!canSave) return;
    const detailErr = validateDetailsClient(customFields, details);
    if (detailErr) return toast.error(detailErr);
    if (!pdfFile) return toast.error("Please upload the policy PDF.");
    // A required slot the expiring policy already fills is NOT missing — it is
    // about to be carried across. Demanding a re-upload for it was the whole
    // complaint.
    const missingDoc = requiredDocs.find((d) => d.required && !docFiles[d.key]
      && !(copyDocs && carriedKeys.has(d.key)));
    if (missingDoc) return toast.error(`Please attach "${missingDoc.label}".`);
    save.mutate();
  };

  return (
    <FormPage
      backTo="/renewals"
      backLabel="Back to renewals"
      title={`Renew ${policy.code}`}
      subtitle={[policy.customer_name, policy.insurer_name]
        .filter(Boolean).join(" · ") || undefined}
      onSubmit={submit}
      submitLabel={isPartner ? "Submit renewal" : "Renew policy"}
      submitting={save.isPending}
      disabled={!canSave}
      wide
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="New premium (₹)" required>
            <input type="number" step="0.01" className="input" value={form.premium}
              required onChange={(e) => set("premium", e.target.value)} />
          </Field>
          <Field label="Reward base (₹)"
            hint="Blank = net of GST from premium.">
            <input type="number" step="0.01" className="input"
              value={form.commissionable}
              onChange={(e) => set("commissionable", e.target.value)} />
          </Field>
          <Field label="New policy number">
            <input className="input" value={form.policy_number}
              onChange={(e) => set("policy_number", e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Start date" required>
            <DateInput value={form.start_date} required
              onChange={(v) => set("start_date", v)} />
          </Field>
          <Field label="Expiry date" required>
            <DateInput value={form.expiry_date} required
              onChange={(v) => set("expiry_date", v)} />
          </Field>
        </div>

        {/* Type-specific amounts + other details, carried over from the policy
            (order set on the Policy Types page). */}
        <AmountCustomFields title={cat?.label ?? "Policy"}
          fields={amountCustomFields} details={details} setDetail={setDetail}
          rewardBaseField={rewardBaseField}
          setRewardBaseField={setRewardBaseField} />
        <OtherCustomFields title={cat?.label ?? "Policy"}
          fields={otherCustomFields} details={details} setDetail={setDetail} />

        <div className="rounded-control bg-slate-50 p-4">
          <p className="mb-3 text-sm font-medium text-slate-600">
            {isPartner ? "Your reward" : "Reward rates"}</p>
          {rate && rate.source !== "none"
            && (!isPartner || !!rate.partner_value) && (
            <div className="note mb-3 flex flex-wrap items-center gap-2 text-xs">
              <Icon.Tag size={14} />
              <span>Current rate:{" "}
                {!isPartner && (
                  <b>{rate.agency_basis === "percent"
                    ? `${(rate.agency_value / 100).toFixed(2)}% agency`
                    : `₹${(rate.agency_value / 100).toFixed(0)} agency`}</b>
                )}
                {rate.partner_value
                  ? `${isPartner ? "" : ", "}${(rate.partner_value / 100)
                      .toFixed(2)}% partner`
                  : ""}
              </span>
              <span className="text-slate-500">({RATE_SOURCE_LABEL[rate.source]})</span>
              {showApply && (
                <button type="button" onClick={applyRate}
                  className="ml-auto font-medium underline">Apply</button>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            {!isPartner && (
              <Field label="Agency %">
                <input type="number" step="0.01" className="input"
                  value={form.agency_value}
                  onChange={(e) => set("agency_value", e.target.value)} />
              </Field>
            )}
            <Field label={isPartner ? "Your reward %" : "Channel Partner %"}>
              <input type="number" step="0.01" className="input"
                value={form.partner_value}
                onChange={(e) => set("partner_value", e.target.value)} />
            </Field>
          </div>
        </div>

        {/* Policy PDF is mandatory on a renewal too, with the type's document
            slots right after it (owner 2026-07-24). */}
        <Field label="Policy PDF" required
          hint="Upload the renewed policy document (PDF, max 20 MB).">
          <input type="file" accept="application/pdf,.pdf" className="input py-1.5"
            onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)} />
          {pdfFile && (
            <span className="text-xs font-medium text-money-in">
              ✓ {pdfFile.name}
            </span>
          )}
        </Field>
        {/* Carry last year's supporting paperwork across. Above the upload
            slots, because it changes what those slots are asking for. */}
        {carriedKeys.size > 0 && (
          <div className="rounded-control border border-line px-3 py-3">
            <ToggleField checked={copyDocs} onChange={setCopyDocs}
              label={`Bring forward ${carriedKeys.size} document${
                carriedKeys.size === 1 ? "" : "s"} from the expiring policy`} />
            <p className="mt-1 text-xs text-slate-500">
              {[...carriedKeys].map((k) =>
                requiredDocs.find((d) => d.key === k)?.label ?? k).join(", ")}.
              {" "}Attach a file below to replace any of them. The policy PDF is
              never carried forward.
            </p>
          </div>
        )}

        <RequiredDocuments docs={requiredDocs} docFiles={docFiles}
          setDocFiles={setDocFiles} />

      </div>
    </FormPage>
  );
}
