import { FormEvent, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Loader2, Sparkles, Tag } from "lucide-react";
import {
  brokersApi,
  categoriesApi,
  documentsApi,
  insurersApi,
  policiesApi,
  rateRulesApi,
} from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { FormField, FormSection } from "../../components/shared/FormSection";
import { FormSkeleton } from "../../components/shared/LoadingSkeleton";
import { ErrorState } from "../../components/shared/ErrorState";
import { FileUpload } from "../../components/ui";
import { SearchSelect } from "../../components/SearchSelect";
import { DateInput } from "../../components/DateInput";
import {
  AmountCustomFields,
  OtherCustomFields,
  RequiredDocuments,
  splitCustomFields,
  validateDetailsClient,
  type Details,
} from "../../components/PolicyCustomFields";
import { toast } from "../../components/Toast";
import { fromDateInput, rupeesToPaise } from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import { useAuth } from "../../store/auth";
import { COMMISSIONABLE_BASE } from "../../lib/types";
import type { Policy } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

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
  const missing =
    isAxiosError(loaded.error) && loaded.error.response?.status === 404;

  if (loaded.isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader
          backTo="/renewals"
          backLabel="Back to renewals"
          title="Renew policy"
        />
        <FormSkeleton sections={3} />
      </div>
    );
  }

  if (missing) {
    return (
      <div className="space-y-4">
        <PageHeader
          backTo="/renewals"
          backLabel="Back to renewals"
          title="Renew policy"
        />
        <ErrorState
          title="Policy not found"
          message="The policy you are trying to renew could not be found."
        />
      </div>
    );
  }

  if (loaded.isError || !policy) {
    return (
      <div className="space-y-4">
        <PageHeader
          backTo="/renewals"
          backLabel="Back to renewals"
          title="Renew policy"
        />
        <ErrorState onRetry={() => loaded.refetch()} />
      </div>
    );
  }

  return (
    <RenewForm
      key={policy.id}
      policy={policy}
      qc={qc}
      isPartner={isPartner}
      navigate={navigate}
    />
  );
}

function RenewForm({
  policy,
  qc,
  isPartner,
  navigate,
}: {
  policy: Policy;
  qc: ReturnType<typeof useQueryClient>;
  isPartner: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const startDefault =
    dateInput(policy.expiry_date) || new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    broker_id: policy.broker_id || "",
    insurer_id: policy.insurer_id || "",
    premium: String(policy.premium_amount / 100),
    commissionable: "",
    policy_number: "",
    start_date: startDefault,
    expiry_date: addYear(startDefault),
    agency_value: policy.reward.agency_value
      ? String(policy.reward.agency_value / 100)
      : "",
    partner_value: policy.reward.partner_value
      ? String(policy.reward.partner_value / 100)
      : "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const brokers = useQuery({
    queryKey: ["brokers-picker"],
    queryFn: async () => (await brokersApi.list({ active_only: 1 })).data,
    enabled: !isPartner,
  });
  const insurers = useQuery({
    queryKey: ["insurers-all"],
    queryFn: async () => (await insurersApi.list({ page_size: 200 })).data,
  });

  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await categoriesApi.list()).data,
  });
  const cat = cats.data?.find((c) => c.key === policy.category_key);
  const customFields = useMemo(() => cat?.custom_fields ?? [], [cat]);
  const requiredDocs = cat?.required_documents ?? [];
  const { amount: amountCustomFields, other: otherCustomFields } = useMemo(
    () => splitCustomFields(customFields),
    [customFields]
  );
  const [details, setDetails] = useState<Details>(() => ({
    ...(policy.details ?? {}),
  }));
  const setDetail = (key: string, v: unknown) =>
    setDetails((d) => {
      if (v === undefined) {
        const { [key]: _drop, ...rest } = d;
        return rest;
      }
      return { ...d, [key]: v };
    });
  const [rewardBaseField, setRewardBaseField] = useState<string>(
    policy.reward_base_field || COMMISSIONABLE_BASE
  );
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [docFiles, setDocFiles] = useState<Record<string, File | null>>({});

  const [copyDocs, setCopyDocs] = useState(true);
  const existingDocs = useQuery({
    queryKey: ["policy-docs", policy.id],
    queryFn: async () =>
      (await documentsApi.listFor("policy", policy.id)).data,
  });
  const carriedKeys = useMemo(
    () =>
      new Set(
        (existingDocs.data ?? [])
          .map((d) => d.doc_key)
          .filter((k): k is string => !!k && k !== "policy_pdf")
      ),
    [existingDocs.data]
  );

  const preview = useQuery({
    queryKey: [
      "rate-preview-renew",
      policy.id,
      form.broker_id,
      form.insurer_id,
    ],
    queryFn: async () =>
      (
        await rateRulesApi.preview({
          broker_id: form.broker_id,
          insurer_id: form.insurer_id || undefined,
          category_key: policy.category_key,
          subcategory_path: policy.subcategory_path || [],
        })
      ).data,
    enabled: !!form.broker_id,
  });

  const rate = preview.data;
  const applyRate = () => {
    if (!rate || rate.source === "none" || rate.agency_basis !== "percent")
      return;
    setForm((f) => ({
      ...f,
      agency_value: rate.agency_value
        ? String(rate.agency_value / 100)
        : f.agency_value,
      partner_value: rate.partner_value
        ? String(rate.partner_value / 100)
        : f.partner_value,
    }));
  };

  const rateAgency =
    rate &&
    rate.source !== "none" &&
    rate.agency_basis === "percent" &&
    rate.agency_value
      ? String(rate.agency_value / 100)
      : "";
  const ratePartner =
    rate && rate.source !== "none" && rate.partner_value
      ? String(rate.partner_value / 100)
      : "";
  const alreadyApplied =
    form.agency_value === rateAgency &&
    (!ratePartner || form.partner_value === ratePartner);
  const showApply =
    !!rate &&
    rate.source !== "none" &&
    rate.agency_basis === "percent" &&
    !alreadyApplied;

  const save = useMutation({
    mutationFn: async () => {
      const reward =
        form.agency_value || form.partner_value
          ? {
              agency_basis: "percent",
              agency_value: form.agency_value
                ? Math.round(parseFloat(form.agency_value) * 100)
                : 0,
              partner_basis: "percent",
              partner_value: form.partner_value
                ? Math.round(parseFloat(form.partner_value) * 100)
                : 0,
            }
          : undefined;
      const res = await policiesApi.renew(policy.id, {
        broker_id: form.broker_id || undefined,
        insurer_id: form.insurer_id || undefined,
        premium_amount: rupeesToPaise(parseFloat(form.premium || "0")),
        commissionable_premium: form.commissionable
          ? rupeesToPaise(parseFloat(form.commissionable))
          : 0,
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
      toast.success("Policy renewed successfully.");
      qc.invalidateQueries({ queryKey: ["renewals-due"] });
      qc.invalidateQueries({ queryKey: ["policies"] });
      refreshFinance(qc);
      navigate("/renewals");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canSave =
    parseFloat(form.premium || "0") > 0 &&
    !!form.start_date &&
    !!form.expiry_date &&
    (!isPartner ? !!form.broker_id && !!form.insurer_id : !!form.insurer_id);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || save.isPending) return;
    const detailErr = validateDetailsClient(customFields, details);
    if (detailErr) return toast.error(detailErr);
    if (!pdfFile) return toast.error("Please upload the renewed policy PDF.");
    const missingDoc = requiredDocs.find(
      (d) =>
        d.required &&
        !docFiles[d.key] &&
        !(copyDocs && carriedKeys.has(d.key))
    );
    if (missingDoc) return toast.error(`Please attach "${missingDoc.label}".`);
    save.mutate();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        backTo="/renewals"
        backLabel="Back to renewals"
        title={`Renew ${policy.policy_number || policy.code}`}
        subtitle={[policy.customer_name, cat?.label, policy.insurer_name].filter(Boolean).join(" · ")}
      />

      <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-8">
          <FormSection
            title="1. Broker & Insurer"
            description="Change the broker or insurer if placing this renewal with someone else."
            columns={2}
          >
            {!isPartner && (
              <FormField label="Broker" required>
                <SearchSelect
                  options={(brokers.data ?? []).map((b) => ({
                    value: b.id,
                    label: `${b.name} (${b.short_code})`,
                  }))}
                  value={form.broker_id}
                  placeholder="Select broker..."
                  onChange={(v) => set("broker_id", v)}
                />
              </FormField>
            )}
            <FormField label="Insurer" required>
              <SearchSelect
                options={(insurers.data?.items ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                  sub: i.code,
                }))}
                value={form.insurer_id}
                placeholder="Select insurer..."
                onChange={(v) => set("insurer_id", v)}
              />
            </FormField>
          </FormSection>

          <FormSection
            title="2. New Premium & Dates"
            description="Enter the renewed premium amount and coverage dates."
            columns={2}
          >
            <FormField label="Total Premium (₹)" required>
              <Input
                type="number"
                step="0.01"
                value={form.premium}
                required
                placeholder="0.00"
                onChange={(e) => set("premium", e.target.value)}
              />
            </FormField>

            <FormField
              label="Premium before tax (₹)"
              tooltip="Calculated net of 18% GST. Edit if commission is calculated on a different amount."
            >
              <Input
                type="number"
                step="0.01"
                value={form.commissionable}
                placeholder="Auto-calculated if blank"
                onChange={(e) => set("commissionable", e.target.value)}
              />
            </FormField>

            <FormField
              label="New Policy Number"
              hint="Optional if not yet issued"
              className="md:col-span-2"
            >
              <Input
                value={form.policy_number}
                placeholder="e.g. POL-2027-1002"
                onChange={(e) => set("policy_number", e.target.value)}
              />
            </FormField>

            <FormField label="Start date" required>
              <DateInput
                value={form.start_date}
                required
                onChange={(v) => set("start_date", v)}
              />
            </FormField>

            <FormField label="Expiry date" required>
              <DateInput
                value={form.expiry_date}
                required
                onChange={(v) => set("expiry_date", v)}
              />
            </FormField>
          </FormSection>

          <AmountCustomFields
            title={cat?.label ?? "Policy"}
            fields={amountCustomFields}
            details={details}
            setDetail={setDetail}
            rewardBaseField={rewardBaseField}
            setRewardBaseField={setRewardBaseField}
          />
          <OtherCustomFields
            title={cat?.label ?? "Policy"}
            fields={otherCustomFields}
            details={details}
            setDetail={setDetail}
          />

          <FormSection title="3. Policy Documents" columns={1}>
            <FormField label="Renewed Policy PDF" required>
              <FileUpload
                file={pdfFile}
                onChange={setPdfFile}
                accept="application/pdf,.pdf"
                hint="Upload the new policy PDF (up to 20 MB)"
              />
            </FormField>

            {carriedKeys.size > 0 && (
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label
                      htmlFor="carry-docs"
                      className="cursor-pointer font-medium"
                    >
                      Keep {carriedKeys.size} supporting document
                      {carriedKeys.size === 1 ? "" : "s"} from last year
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[...carriedKeys]
                        .map(
                          (k) =>
                            requiredDocs.find((d) => d.key === k)?.label ?? k
                        )
                        .join(", ")}
                      . Upload a file below to replace any of them.
                    </p>
                  </div>
                  <Switch
                    id="carry-docs"
                    checked={copyDocs}
                    onCheckedChange={setCopyDocs}
                  />
                </div>
              </div>
            )}

            <RequiredDocuments
              docs={requiredDocs}
              docFiles={docFiles}
              setDocFiles={setDocFiles}
            />
          </FormSection>
        </div>

        <div className="space-y-4 lg:col-span-4 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">
                {isPartner ? "Your Commission Rate" : "Commission Rates"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {rate &&
                rate.source !== "none" &&
                (!isPartner || !!rate.partner_value) && (
                  <Alert className="border-primary/20 bg-primary/5">
                    <Tag className="h-4 w-4 text-primary" />
                    <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span>
                        Rate card ({RATE_SOURCE_LABEL[rate.source]}):{" "}
                        {!isPartner && (
                          <strong>
                            {rate.agency_basis === "percent"
                              ? `${(rate.agency_value / 100).toFixed(2)}% agency`
                              : `₹${(rate.agency_value / 100).toFixed(0)} agency`}
                          </strong>
                        )}
                        {rate.partner_value
                          ? `${isPartner ? "" : ", "}${(
                              rate.partner_value / 100
                            ).toFixed(2)}% partner`
                          : ""}
                      </span>
                      {showApply && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={applyRate}
                          className="h-7 px-2 text-xs"
                        >
                          <Sparkles className="mr-1 h-3 w-3" />
                          Apply
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

              {!isPartner && (
                <FormField label="Agency Commission %">
                  <Input
                    type="number"
                    step="0.01"
                    value={form.agency_value}
                    placeholder="e.g. 15.0"
                    onChange={(e) => set("agency_value", e.target.value)}
                  />
                </FormField>
              )}

              <FormField
                label={isPartner ? "Your reward %" : "Channel Partner %"}
              >
                <Input
                  type="number"
                  step="0.01"
                  value={form.partner_value}
                  placeholder="e.g. 10.0"
                  onChange={(e) => set("partner_value", e.target.value)}
                />
              </FormField>

              <div className="border-t border-border pt-4">
                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  disabled={!canSave || save.isPending}
                >
                  {save.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {isPartner ? "Submit renewal" : "Save & Renew Policy"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-2 w-full"
                  onClick={() => navigate("/renewals")}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </form>
    </div>
  );
}
