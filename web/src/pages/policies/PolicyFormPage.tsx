import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  brokersApi, categoriesApi, customersApi, insurersApi, policiesApi,
  quotesApi, rateRulesApi, usersApi,
} from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field, Toggle } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { DateInput } from "../../components/DateInput";
import { SearchSelect } from "../../components/SearchSelect";
import { CustomerPicker } from "../../components/pickers";
import {
  AmountCustomFields,
  OtherCustomFields,
  RequiredDocuments,
  splitCustomFields,
  validateDetailsClient,
} from "../../components/PolicyCustomFields";
import { toast } from "../../components/Toast";
import {
  formatINR, fromDateInput, rupeesToPaise, toDateInput, todayInput,
} from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import { useAuth } from "../../store/auth";
import { PAID_BY_OPTIONS } from "../../lib/payer";
import { COMMISSIONABLE_BASE } from "../../lib/types";
import { pathLevels } from "../../lib/rating";
import { AddCustomerModal, AddPartnerQuickModal } from "./QuickAdd";
import type { Broker, PolicyCategory } from "../../lib/types";

const EMPTY_FORM = {
  category_key: "",
  subcategory_path: [] as string[],
  insurer_id: "",
  broker_id: "",
  customer_id: "",
  customer_name: "",
  policy_number: "",
  status: "active",
  premium: "",
  commissionable: "",
  sum_insured: "",
  start_date: "",
  expiry_date: "",
  partner_id: "",
  payer: "customer",
  discount_value: "",
  agency_value: "",
  partner_value: "",
};

/**
 * Book a policy — a page (/policies/new), not a dialog.
 *
 * This is the longest form in the app: broker, insurer, a type tree, money,
 * reward percentages with a live preview, type-specific custom fields and a
 * required-document list. It was always the worst fit for a popup, and it is
 * the form most likely to be interrupted — which is now survivable, because the
 * URL is real.
 *
 * The two quick-add popups it opens (customer, channel partner) STAY popups on
 * purpose: they exist so a half-filled policy is not lost, and turning them into
 * pages would navigate away from the very state they protect.
 */
export default function PolicyFormPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { has, user } = useAuth();
  const isPartner = user?.account_type === "channel_partner";

  /*
    BOOKING A POLICY OUT OF AN ACCEPTED QUOTE REQUEST.

    The quote screen has sent people here with `?quote=<id>` since quote
    requests shipped, and this form read the parameter NOWHERE. So the whole
    hand-off was cosmetic: nothing was pre-filled, and — much worse — the two
    records were never linked on save. `quotesApi.markBooked` existed, was
    correct, and was called from nowhere in the app. The quote therefore sat at
    ACCEPTED for ever, never reached ISSUED, the partner was never told their
    policy was on cover, and neither the staff nor the portal screen could show
    the "Open the policy" button, because `policy_id` was never written.

    Two halves, and the SECOND is the one that matters:
      * pre-fill what the quotation already decided (type, insurer, premium,
        sum insured, cover dates, the type's own fields, the partner)
      * call markBooked() after a successful save

    What is deliberately NOT pre-filled is the BROKER and the reward %. Those
    are the human decisions the whole design is built around (owner A3) — the
    broker choice is what prices the reward, and a quoted `partner_earning` is
    a figure a person typed, not a rate this form could reverse-engineer.
  */
  const quoteId = search.get("quote") ?? "";
  const quote = useQuery({
    queryKey: ["quote", quoteId],
    enabled: !!quoteId && has("view_quotes"),
    retry: false,
    queryFn: async () => (await quotesApi.get(quoteId)).data,
  });
  // Pre-fill exactly once. The user is allowed to change anything afterwards,
  // and a re-render must not undo their edit.
  const prefilled = useRef(false);

  const [form, setForm] = useState({
    ...EMPTY_FORM, start_date: todayInput() });
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [commTouched, setCommTouched] = useState(false);
  // Reward % fields auto-fill from the rate card until the user types their
  // own value (owner 1.9) — these flags remember "the user took over".
  const [agencyTouched, setAgencyTouched] = useState(false);
  const [partnerTouched, setPartnerTouched] = useState(false);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [addingPartner, setAddingPartner] = useState(false);
  const [discountOn, setDiscountOn] = useState(false);
  // Type-specific custom fields, reward base choice, and per-slot document files.
  const [details, setDetails] = useState<Record<string, unknown>>({});
  const [rewardBaseField, setRewardBaseField] =
    useState<string>(COMMISSIONABLE_BASE);
  const [docFiles, setDocFiles] = useState<Record<string, File | null>>({});

  // Auto-fill the commissionable premium (net of 18% GST) as the user types the
  // gross premium — until they edit it themselves.
  useEffect(() => {
    if (commTouched) return;
    const p = parseFloat(form.premium || "0");
    setForm((f) => ({ ...f, commissionable: p > 0 ? (p / 1.18).toFixed(2) : "" }));
  }, [form.premium, commTouched]);

  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await categoriesApi.list()).data,
  });
  const insurers = useQuery({
    queryKey: ["insurers-all"],
    queryFn: async () => (await insurersApi.list({ page_size: 200 })).data,
  });

  // Default to the first policy type once they load, so the type-driven fields
  // below have something to work with.
  useEffect(() => {
    if (!form.category_key && cats.data?.length)
      setForm((f) => ({ ...f, category_key: cats.data![0].key }));
  }, [cats.data, form.category_key]);

  const partners = useQuery({
    queryKey: ["attributable-partners"],
    queryFn: async () => (await usersApi.attributablePartners()).data,
    enabled: !isPartner,
  });
  // Brokers we place business through — picked first; drives the rate card + TDS.
  // Internal to the agency, so partners never pick one.
  const brokers = useQuery({
    queryKey: ["brokers-picker"],
    queryFn: async () => (await brokersApi.list({ active_only: 1 })).data,
    enabled: !isPartner,
  });
  const selectedBroker: Broker | undefined = useMemo(
    () => brokers.data?.find((b) => b.id === form.broker_id),
    [brokers.data, form.broker_id]);

  // Live rate lookup under the selected broker for this scenario (insurer + path).
  const ratePreview = useQuery({
    queryKey: ["rate-preview", form.broker_id, form.insurer_id, form.category_key,
      form.subcategory_path.join("/")],
    queryFn: async () => (await rateRulesApi.preview({
      broker_id: form.broker_id,
      insurer_id: form.insurer_id || undefined,
      category_key: form.category_key,
      subcategory_path: form.subcategory_path,
    })).data,
    enabled: !!form.broker_id && !!form.category_key,
  });

  // The matched rate card supplies the default %s — shown as placeholders on the
  // reward fields. Leaving a field blank means "use the rate card"; typing a value
  // overrides just that side (the backend fills only the terms left unset).
  const rate = ratePreview.data;
  const rateHit = !!rate && rate.source !== "none";
  const agencyPlaceholder = rateHit && rate!.agency_basis === "percent"
    && rate!.agency_value ? String(rate!.agency_value / 100) : "e.g. 33";
  const partnerPlaceholder = rateHit && rate!.partner_basis === "percent"
    && rate!.partner_value ? String(rate!.partner_value / 100) : "e.g. 25";

  // Fill the % INPUTS with the rate-card values (owner 1.9: real values, not
  // placeholders). Re-fills whenever the matched rate changes (broker / type /
  // sub-type / insurer), until the user types their own number in that field.
  useEffect(() => {
    if (isPartner) return;
    const agencyDefault = rateHit && rate!.agency_basis === "percent"
      && rate!.agency_value ? String(rate!.agency_value / 100) : "";
    const partnerDefault = rateHit && rate!.partner_basis === "percent"
      && rate!.partner_value ? String(rate!.partner_value / 100) : "";
    setForm((f) => {
      const next = { ...f };
      if (!agencyTouched) next.agency_value = agencyDefault;
      if (!partnerTouched) next.partner_value = partnerDefault;
      return next.agency_value === f.agency_value
        && next.partner_value === f.partner_value ? f : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate, rateHit, isPartner, agencyTouched, partnerTouched]);

  // EVERY policy type is offered, whichever broker is selected (owner
  // 2026-07-23). The rate card is about the reward RATE, not about what the
  // agency is allowed to place: a type the broker has no rule for is still a
  // policy you can book, you just enter the % yourself. Filtering the list by
  // the rate card made real policy types silently vanish.
  const allCats = cats.data ?? [];

  // True once a type is chosen but the broker's rate card has no rule for it —
  // the reward fields stay blank and the user must fill them in.
  const noRateForType = !isPartner && !!form.broker_id && !!form.category_key
    && !ratePreview.isLoading && !rateHit;

  const selectedCat: PolicyCategory | undefined = useMemo(
    () => cats.data?.find((c) => c.key === form.category_key),
    [cats.data, form.category_key]);
  const levels = useMemo(
    () => (selectedCat ? pathLevels(selectedCat.children, form.subcategory_path)
      : []),
    [selectedCat, form.subcategory_path]);
  const setLevel = (i: number, value: string) => setForm((f) => {
    const next = f.subcategory_path.slice(0, i);
    if (value) next.push(value);
    return { ...f, subcategory_path: next };
  });

  // On changing the policy type, reset the type-specific inputs and adopt the
  // type's default reward base.
  useEffect(() => {
    setDetails({});
    setDocFiles({});
    setRewardBaseField(selectedCat?.reward_base_field || COMMISSIONABLE_BASE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.category_key]);

  /* ------------------------------------------------- pre-fill from a quote -- */

  // The quote's own `details` cannot be written in the same pass as its
  // category: the effect directly above wipes `details` whenever the category
  // changes, and it would wipe these too. They are parked here and applied by
  // the effect below, which is declared AFTER the reset so React runs it second
  // within the same commit.
  const pendingDetails = useRef<{ key: string; details: Record<string, unknown> }
    | null>(null);

  useEffect(() => {
    const q = quote.data;
    // Wait for the policy types as well: the effect that defaults
    // `category_key` to the first type would otherwise land on top of ours.
    if (!q || prefilled.current || !cats.data?.length) return;
    prefilled.current = true;

    // The accepted option is what the customer actually bought. Fall back to
    // the only option when nothing was formally accepted (staff can book a case
    // the partner settled over the phone).
    const opt = q.options.find((o) => o.accepted_at) ?? q.options[0];
    const known = cats.data.some((c) => c.key === q.category_key);
    if (Object.keys(q.details ?? {}).length && known)
      pendingDetails.current = { key: q.category_key, details: { ...q.details } };

    setForm((f) => ({
      ...f,
      // A policy type that has since been deleted or deactivated must not blank
      // the field — leave whatever the form already defaulted to.
      category_key: known ? q.category_key : f.category_key,
      subcategory_path: known ? q.subcategory_path : f.subcategory_path,
      insurer_id: opt?.insurer_id || f.insurer_id,
      partner_id: q.partner_id || f.partner_id,
      premium: opt?.premium_amount ? String(opt.premium_amount / 100) : f.premium,
      sum_insured: opt?.sum_insured
        ? String(opt.sum_insured / 100) : f.sum_insured,
      start_date: opt?.cover_from ? toDateInput(opt.cover_from) : f.start_date,
      expiry_date: opt?.cover_to ? toDateInput(opt.cover_to) : f.expiry_date,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote.data, cats.data]);

  useEffect(() => {
    const pending = pendingDetails.current;
    if (!pending || pending.key !== form.category_key) return;
    pendingDetails.current = null;
    setDetails(pending.details);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.category_key]);

  // The quote carries the customer's NAME and MOBILE, never a customer id — a
  // partner enquiring about a case has not created anybody. Customers are
  // unique by mobile, so an exact single match is the customer, and picking it
  // for them saves the one search everybody would otherwise do by hand. A miss
  // is not an error: the banner offers to create them, pre-filled.
  const quoteCustomer = useQuery({
    queryKey: ["quote-customer", quote.data?.customer_mobile],
    enabled: !!quote.data?.customer_mobile && !form.customer_id,
    queryFn: async () => (await customersApi.list({
      q: quote.data!.customer_mobile, page_size: 5 })).data,
  });
  useEffect(() => {
    const items = quoteCustomer.data?.items ?? [];
    const exact = items.filter(
      (c) => c.mobile === quote.data?.customer_mobile);
    if (exact.length !== 1 || form.customer_id) return;
    setForm((f) => f.customer_id
      ? f
      : { ...f, customer_id: exact[0].id, customer_name: exact[0].name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteCustomer.data, quote.data]);

  /*
    IS THIS POLICY NUMBER ALREADY USED?

    The rule was enforced twice already — at write time and by a unique index —
    and told you at the worst possible moment: after a broker, an insurer, a
    premium, the type's custom fields and a mandatory PDF upload, a 409 on the
    field you typed first. Asking while it is being typed costs one small GET.

    Advisory. It races anybody typing the same number right now, so a clear
    answer here is "nothing found", never a reservation — the write-time check
    is still what decides.
  */
  const [numberProbe, setNumberProbe] = useState("");
  useEffect(() => {
    const value = form.policy_number.trim();
    const t = setTimeout(() => setNumberProbe(value), 400);
    return () => clearTimeout(t);
  }, [form.policy_number]);
  const numberCheck = useQuery({
    queryKey: ["policy-number-free", numberProbe],
    enabled: numberProbe.length >= 3,
    queryFn: async () =>
      (await policiesApi.numberAvailable(numberProbe)).data,
  });
  // Only trust the answer when it is about what is CURRENTLY in the field —
  // otherwise the previous number's verdict shows against the new one for as
  // long as the request is in flight.
  const numberVerdict = numberCheck.data?.number === form.policy_number.trim()
    ? numberCheck.data : undefined;

  const customFields = selectedCat?.custom_fields ?? [];
  const requiredDocs = selectedCat?.required_documents ?? [];
  // Split so amount fields render with the money block and the rest group after
  // it — the type's saved field order is preserved within each group.
  const { amount: amountCustomFields, other: otherCustomFields } =
    useMemo(() => splitCustomFields(customFields), [customFields]);
  const setDetail = (key: string, v: unknown) =>
    setDetails((d) => {
      if (v === undefined) { const { [key]: _drop, ...rest } = d; return rest; }
      return { ...d, [key]: v };
    });

  const save = useMutation({
    mutationFn: async () => {
      const premiumPaise = form.premium ? rupeesToPaise(parseFloat(form.premium)) : 0;
      const reward =
        form.agency_value || form.partner_value
          ? {
              agency_basis: "percent",
              agency_value: form.agency_value
                ? Math.round(parseFloat(form.agency_value) * 100) : 0,
              partner_basis: "percent",
              partner_value: form.partner_value
                ? Math.round(parseFloat(form.partner_value) * 100) : 0,
            }
          : undefined;
      const res = await policiesApi.create({
        category_key: form.category_key,
        subcategory_path: form.subcategory_path,
        insurer_id: form.insurer_id,
        broker_id: form.broker_id || null,
        customer_id: form.customer_id,
        policy_number: form.policy_number || null,
        status: form.status,
        premium_amount: premiumPaise,
        commissionable_premium: form.commissionable
          ? rupeesToPaise(parseFloat(form.commissionable)) : 0,
        sum_insured: form.sum_insured
          ? rupeesToPaise(parseFloat(form.sum_insured)) : 0,
        start_date: fromDateInput(form.start_date),
        expiry_date: fromDateInput(form.expiry_date),
        partner_id: form.partner_id || null,
        payer: form.payer,
        discount_basis: "flat",
        discount_value: discountOn && form.discount_value
          ? rupeesToPaise(parseFloat(form.discount_value))
          : 0,
        reward,
        details,
        reward_base_field: rewardBaseField,
      });
      if (pdfFile) await policiesApi.uploadDocument(res.data.id, pdfFile);
      // Attach the configured supporting documents (best-effort, sequential).
      for (const doc of requiredDocs) {
        const file = docFiles[doc.key];
        if (file)
          await policiesApi.uploadExtraDocument(
            res.data.id, doc.key, doc.label, file);
      }
      return res;
    },
    onSuccess: async ({ data: created }) => {
      toast.success("Policy created.");
      // Link the quote request this came out of, which is what finally moves it
      // to ISSUED and notifies the partner. Best-effort and AFTER the policy is
      // safely saved: a failure here must not read as "the policy did not
      // save", because it did — so it becomes a warning naming the one manual
      // step left, not an error.
      if (quoteId) {
        try {
          await quotesApi.markBooked(quoteId, created.id);
          qc.invalidateQueries({ queryKey: ["quote", quoteId] });
          qc.invalidateQueries({ queryKey: ["quotes"] });
        } catch {
          toast.error("The policy saved, but it could not be linked to the "
            + "quote request. Open the request and link it from there.");
        }
      }
      qc.invalidateQueries({ queryKey: ["policies"] });
      refreshFinance(qc); // an owner-created policy books finance immediately
      navigate(`/policies/${created.id}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const submit = () => {
    if (!isPartner && !form.broker_id)
      return toast.error("Please select a broker.");
    if (!form.customer_id) return toast.error("Please select a customer.");
    if (!form.insurer_id) return toast.error("Please select an insurer.");
    if (!form.policy_number.trim())
      return toast.error("Please enter the policy number.");
    if (!isPartner && form.agency_value === "")
      return toast.error(
        "Please enter the Agency % — this broker has no rate-card value "
        + "for this policy type.");
    if (!isPartner && form.partner_id && form.partner_value === "")
      return toast.error("Please enter the Channel Partner %.");
    if (!form.start_date) return toast.error("Please set the start date.");
    if (!form.expiry_date) return toast.error("Please set the expiry date.");
    if (discountOn && parseFloat(form.discount_value || "0")
        > parseFloat(form.premium || "0"))
      return toast.error("Discount cannot exceed the premium (100%).");
    if (!pdfFile) return toast.error("Please upload the policy PDF.");
    const detailErr = validateDetailsClient(customFields, details);
    if (detailErr) return toast.error(detailErr);
    const missingDoc = requiredDocs.find((d) => d.required && !docFiles[d.key]);
    if (missingDoc)
      return toast.error(`Please attach "${missingDoc.label}".`);
    save.mutate();
  };

  // Live reward preview (mirrors the backend: partner never exceeds agency).
  // A blank field uses the rate-card default, so the preview falls back to it too.
  const preview = useMemo(() => {
    const premium = parseFloat(form.premium || "0");
    // When commission is booked on an amount field (e.g. OD), that field's value
    // (stored in paise) is the base; else the commissionable premium.
    const baseAmt = rewardBaseField !== COMMISSIONABLE_BASE
      ? Number(details[rewardBaseField]) : NaN;
    const base = baseAmt > 0
      ? baseAmt / 100
      : form.commissionable
        ? parseFloat(form.commissionable)
        : premium / 1.18;
    const rateAgency = rateHit && rate!.agency_basis === "percent"
      ? rate!.agency_value / 100 : 0;
    const ratePartner = rateHit && rate!.partner_basis === "percent"
      ? rate!.partner_value / 100 : 0;
    const agencyPct = form.agency_value !== ""
      ? parseFloat(form.agency_value || "0") : rateAgency;
    const partnerPct = form.partner_value !== ""
      ? parseFloat(form.partner_value || "0") : ratePartner;
    const agency = base * (agencyPct / 100);
    const hasPartner = isPartner || !!form.partner_id;
    let partner = hasPartner ? base * (partnerPct / 100) : 0;
    if (!isPartner) partner = Math.min(partner, agency);
    // A discount is house-borne, so it comes straight out of the house margin
    // (owner 1.3: the preview must move the moment the discount is typed).
    const discount = discountOn && !form.partner_id
      ? parseFloat(form.discount_value || "0") || 0 : 0;
    return { base, agency, partner, discount,
      house: agency - partner - discount };
  }, [form, isPartner, rate, rateHit, details, rewardBaseField, discountOn]);

  return (
    <>
      <FormPage
        backTo="/policies"
        backLabel="Back to policies"
        title="Add policy"
        subtitle={isPartner
          ? "Booking a policy records its reward and finance immediately."
          : "Booking a policy records its reward and finance immediately."}
        onSubmit={submit}
        submitLabel="Create policy"
        submitting={save.isPending}
        wide
      >
      <div className="space-y-5">
          {/* Where this booking came from. It is a real panel rather than a
              line of subtitle text because it carries the two facts the form
              itself cannot show — WHO the customer is on the quote, and that
              saving will close the request — plus the escape hatch when the
              customer does not exist yet. */}
          {quoteId && quote.data && (
            <div className="card border-l-4 border-l-ink px-4 py-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1
                text-sm font-medium text-slate-800">
                <Icon.Lead size={15} className="text-slate-500" />
                Booking quote request
                <span className="chip">{quote.data.code}</span>
                <span className="font-normal text-slate-500">
                  for {quote.data.partner_name ?? "a channel partner"}
                </span>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Type, insurer, premium, cover dates and the partner are filled
                in from the quotation. Choose the broker yourself — that is what
                prices the reward. Saving links the two and tells the partner
                their policy is issued.
              </p>
              {!form.customer_id && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2
                  rounded-control bg-due/10 px-3 py-2 text-sm text-due">
                  <span>
                    No customer on file for {quote.data.customer_name} (
                    {quote.data.customer_mobile}).
                  </span>
                  <button type="button" className="btn-secondary btn-sm"
                    onClick={() => setAddingCustomer(true)}>
                    <Icon.Plus size={14} /> Add this customer
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Broker sits IN the grid rather than beside it — as a bare
              full-width Field it was the widest control on the page and set an
              edge nothing else matched. */}
          {!isPartner && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Broker" required className="sm:col-span-2">
              <SearchSelect
                options={(brokers.data ?? []).map((b) => ({
                  value: b.id, label: `${b.name} (${b.short_code})` }))}
                value={form.broker_id}
                placeholder="Select broker…"
                // The policy type is NOT cleared here any more: it no longer
                // depends on the broker, so wiping it just lost the user's work.
                onChange={(v) => setForm({ ...form, broker_id: v })} />
            </Field>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Policy type" required>
              <select className="select" value={form.category_key} required
                onChange={(e) => setForm({
                  ...form, category_key: e.target.value, subcategory_path: [] })}>
                <option value="">Select…</option>
                {allCats.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
              {noRateForType && (
                <span className="text-xs text-due">
                  {selectedBroker?.name ?? "This broker"} has no rate card for
                  this type — enter the % below yourself.
                </span>
              )}
            </Field>
            <Field label="Insurer" required>
              <SearchSelect
                options={(insurers.data?.items ?? []).map((i) => ({
                  value: i.id, label: i.name, sub: i.code }))}
                value={form.insurer_id}
                placeholder="Select insurer…"
                onChange={(v) => setForm({ ...form, insurer_id: v })} />
            </Field>
          </div>

          {levels.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {levels.map((lvl, i) => (
                <Field key={i} label={i === 0 ? "Sub-type" : `Sub-type ${i + 1}`}>
                  <select className="select" value={lvl.value}
                    onChange={(e) => setLevel(i, e.target.value)}>
                    <option value="">— Select —</option>
                    {lvl.options.map((n) => (
                      <option key={n.key} value={n.key}>{n.label}</option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Customer" required>
              <CustomerPicker
                value={form.customer_id}
                displayName={form.customer_name}
                onSelect={(id, name) =>
                  setForm({ ...form, customer_id: id, customer_name: name })}
                onAddNew={has("manage_customers")
                  ? () => setAddingCustomer(true) : undefined}
              />
            </Field>
            {!isPartner && (
              <Field label="Channel Partner"
                hint="Attributes the reward to this partner's wallet.">
                <SearchSelect
                  options={(partners.data ?? []).map((b) => ({
                    value: b.id, label: b.full_name, sub: b.code }))}
                  value={form.partner_id}
                  placeholder="— None (in-house sale) —"
                  allowClear clearLabel="— None (in-house sale) —"
                  onChange={(v) => {
                    // No discount on partner-attributed policies (owner Q5).
                    if (v) setDiscountOn(false);
                    setForm({ ...form, partner_id: v,
                      ...(v ? { discount_value: "" } : {}) });
                  }}
                  onAddNew={has("manage_partners")
                    ? () => setAddingPartner(true) : undefined}
                  addNewLabel="Add Channel Partner" />
              </Field>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Policy number" required>
              <input className="input" value={form.policy_number} required
                onChange={(e) => setForm({ ...form, policy_number: e.target.value })} />
              {numberVerdict && !numberVerdict.available && (
                <span className="inline-flex items-center gap-1 text-xs
                  font-medium text-money-out">
                  <Icon.Alert size={13} />
                  Already used on {numberVerdict.used_by_code}
                </span>
              )}
              {numberVerdict?.available && (
                <span className="inline-flex items-center gap-1 text-xs
                  font-medium text-money-in">
                  <Icon.Check size={13} /> Not used yet
                </span>
              )}
            </Field>
            <Field label="Premium — gross incl. GST (₹)" required>
              <input type="number" step="0.01" className="input" value={form.premium}
                required
                onChange={(e) => setForm({ ...form, premium: e.target.value })} />
            </Field>
            <Field label="Reward base premium (₹)"
              hint="Auto-filled net of 18% GST; edit if the insurer differs.">
              <input type="number" step="0.01" className="input"
                value={form.commissionable}
                onChange={(e) => {
                  setCommTouched(true);
                  setForm({ ...form, commissionable: e.target.value });
                }} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Sum insured (₹)">
              <input type="number" step="0.01" className="input"
                value={form.sum_insured}
                onChange={(e) => setForm({ ...form, sum_insured: e.target.value })} />
            </Field>
            <Field label="Start date" required>
              <DateInput value={form.start_date} required
                onChange={(v) => setForm({ ...form, start_date: v })} />
            </Field>
            <Field label="Expiry date" required>
              <DateInput value={form.expiry_date} required
                onChange={(v) => setForm({ ...form, expiry_date: v })} />
            </Field>
          </div>

          {/* Amount-type custom fields sit right after the built-in amounts;
              everything else groups below (order set on the Policy Types page). */}
          <AmountCustomFields title={selectedCat?.label ?? "Policy"}
            fields={amountCustomFields} details={details} setDetail={setDetail}
            rewardBaseField={rewardBaseField}
            setRewardBaseField={setRewardBaseField} />
          <OtherCustomFields title={selectedCat?.label ?? "Policy"}
            fields={otherCustomFields} details={details} setDetail={setDetail} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Policy Premium Paid By" required
              hint="Who paid the insurer (drives who owes the agency).">
              <select className="select" value={form.payer} required
                onChange={(e) => setForm({ ...form, payer: e.target.value })}>
                {PAID_BY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            {!isPartner && !form.partner_id && (
              <Field label="Discount"
                hint="Discount to the customer — borne by the house.">
                <div className="flex items-center gap-2.5">
                  <Toggle
                    checked={discountOn}
                    label="Apply a discount"
                    onChange={(next) => {
                      if (!next) setForm((f) => ({ ...f, discount_value: "" }));
                      setDiscountOn(next);
                    }}
                  />
                  <span className="text-sm text-slate-500">
                    {discountOn ? "Discount applied" : "No discount"}
                  </span>
                </div>
                {discountOn && (
                  <input type="number" step="0.01" min="0"
                    className="input mt-2"
                    value={form.discount_value}
                    placeholder="Discount amount (₹) — e.g. 500"
                    onChange={(e) =>
                      setForm({ ...form, discount_value: e.target.value })} />
                )}
              </Field>
            )}
          </div>

          {!isPartner && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Agency % (received from insurer)" required
                hint="Auto-filled from the rate card — type over it to override.">
                <input type="number" step="0.01" min="0" className="input"
                  value={form.agency_value} placeholder={agencyPlaceholder}
                  required
                  onChange={(e) => {
                    setAgencyTouched(true);
                    setForm({ ...form, agency_value: e.target.value });
                  }} />
              </Field>
              {form.partner_id && (
                <Field label="Channel Partner % (paid to partner)" required
                  hint="Auto-filled from the rate card — type over it to override.">
                  <input type="number" step="0.01" min="0" className="input"
                    value={form.partner_value} placeholder={partnerPlaceholder}
                    required
                    onChange={(e) => {
                      setPartnerTouched(true);
                      setForm({ ...form, partner_value: e.target.value });
                    }} />
                </Field>
              )}
            </div>
          )}

          {!isPartner && parseFloat(form.premium || "0") > 0 && (
            <div className="flex flex-wrap gap-4 text-xs text-slate-500">
              <span>Base: <b className="text-slate-700">
                {formatINR(rupeesToPaise(preview.base))}</b></span>
              <span>Agency: <b className="text-slate-700">
                {formatINR(rupeesToPaise(preview.agency))}</b></span>
              {form.partner_id && (
                <span>Channel Partner: <b className="text-slate-700">
                  {formatINR(rupeesToPaise(preview.partner))}</b></span>
              )}
              {preview.discount > 0 && (
                <span>Discount: <b className="text-money-out">
                  -{formatINR(rupeesToPaise(preview.discount))}</b></span>
              )}
              <span>House: <b className={preview.house < 0
                ? "text-money-out" : "text-slate-900"}>
                {formatINR(rupeesToPaise(preview.house))}</b></span>
            </div>
          )}

          {/* Policy PDF, with the type's document-collection slots right after
              it (owner 2026-07-24). */}
          <Field label="Policy PDF" required
            hint="Upload the policy document (PDF, max 20 MB).">
            <input type="file" accept="application/pdf,.pdf" className="input py-1.5"
              onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)} />
            {pdfFile && (
              <span className="text-xs font-medium text-money-in">
                ✓ {pdfFile.name}
              </span>
            )}
          </Field>
          <RequiredDocuments docs={requiredDocs} docFiles={docFiles}
            setDocFiles={setDocFiles} />

      </div>
      </FormPage>

      {/* Quick-add stays a DIALOG on purpose — see the note at the top. */}
      {addingCustomer && (
        <AddCustomerModal
          partnerId={isPartner ? undefined : (form.partner_id || undefined)}
          initial={quote.data ? {
            name: quote.data.customer_name,
            mobile: quote.data.customer_mobile,
            email: quote.data.customer_email ?? "",
          } : undefined}
          onClose={() => setAddingCustomer(false)}
          onCreated={(id, name) => {
            setForm((f) => ({ ...f, customer_id: id, customer_name: name }));
            setAddingCustomer(false);
          }} />
      )}
      {addingPartner && (
        <AddPartnerQuickModal
          onClose={() => setAddingPartner(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ["attributable-partners"] });
            setDiscountOn(false);
            setForm((f) => ({ ...f, partner_id: id, discount_value: "" }));
            setAddingPartner(false);
          }} />
      )}
    </>
  );
}
