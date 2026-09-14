import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  brokersApi, categoriesApi, documentsApi, policiesApi, usersApi,
} from "../api/endpoints";
import { apiError } from "../api/client";
import { Icon } from "./Icon";
import { DateInput } from "./DateInput";
import { SearchSelect } from "./SearchSelect";
import { Field, StatusBadge } from "./ui";
import { toast } from "./Toast";
import { PolicyDocuments } from "./PolicyDocuments";
import {
  AmountCustomFields,
  OtherCustomFields,
  splitCustomFields,
  validateDetailsClient,
} from "./PolicyCustomFields";
import { refreshFinance } from "../lib/live";
import { pickPolicyPdf } from "../lib/policyDocs";
import { pathLevels } from "../lib/rating";
import { PAID_BY_OPTIONS, paidByLabel } from "../lib/payer";
import {
  daysUntil,
  formatDate,
  formatINR,
  fromDateInput,
  rupeesToPaise,
  titleCase,
  toDateInput,
} from "../lib/format";
import { useAuth } from "../store/auth";
import { COMMISSIONABLE_BASE } from "../lib/types";
import type { Policy, RewardStatus } from "../lib/types";
import { moneyToneQuiet } from "../lib/tone";

// Mirrors server/app/services/money.py so the numbers shown here always match
// what the backend books: base = commissionable (or premium net of GST),
// partner capped at agency, house = agency − partner.
export function computeRewardPreview(p: {
  premium_amount: number; commissionable_premium: number; gst_percent: number;
  reward: Policy["reward"]; partner_id?: string | null;
  reward_base_field?: string | null;
  details?: Record<string, unknown> | null;
}) {
  // When commission is booked on an amount field (e.g. OD), that field's paise
  // value is the base; else the commissionable premium (or GST-net default).
  const fieldBase = p.reward_base_field && p.reward_base_field !== "commissionable"
    ? Number(p.details?.[p.reward_base_field]) : NaN;
  const base = fieldBase > 0
    ? fieldBase
    : p.commissionable_premium > 0
      ? p.commissionable_premium
      : Math.round(p.premium_amount / (1 + p.gst_percent / 10000));
  const apply = (basis: string, value: number) =>
    basis === "percent" ? Math.round((base * value) / 10000) : value;
  const agency = apply(p.reward.agency_basis, p.reward.agency_value);
  let partner = p.partner_id
    ? Math.max(0, apply(p.reward.partner_basis, p.reward.partner_value)) : 0;
  // Cap at the agency amount like the backend — but only when we can actually
  // see the agency side (it is zeroed out for partner viewers).
  if (p.reward.agency_value > 0) partner = Math.min(partner, agency);
  return { base, agency, partner, house: agency - partner };
}

/**
 * What this policy earns, as a small P&L (owner 2026-08-04, C1b).
 *
 * It was a flat grey box holding one run-on sentence — "Agency 30.00% =
 * ₹1,350.00  Partner 20.00% = ₹900.00  House = ₹450.00" — with the eligibility
 * dropdown and a three-line paragraph bolted underneath. Three figures that add
 * up were set as prose, so nothing showed that they did.
 *
 * Now: one row per figure, the rate and the base under each label so the maths
 * is on screen, money right-aligned and tabular, the partner share carrying its
 * minus sign, and House on a heavier rule as the bottom line. Green for house
 * profit, red when it is negative — the app's money colours, not a new palette.
 *
 * Marked NOT ELIGIBLE the whole ledger greys out and strikes through, because
 * none of it is receivable any more; the banner says so in one sentence rather
 * than leaving the dropdown to be the only clue (owner C2).
 *
 * What has HAPPENED to the money — received from the broker, paid to the
 * partner — deliberately is not here (owner C3a): it needs a finance read this
 * page does not make, and it lives on the party's ledger.
 */
function RewardPanel({
  money, reward, baseLabel, hasPartner, partnerName, seesAgency, seesHouse,
  notEligible, canReward, rewardStatus, onRewardStatus, onSave, saving, dirty,
}: {
  money: { base: number; agency: number; partner: number; house: number };
  reward: Policy["reward"];
  baseLabel: string;
  hasPartner: boolean;
  partnerName?: string;
  seesAgency: boolean;
  seesHouse: boolean;
  notEligible: boolean;
  canReward: boolean;
  rewardStatus: string;
  onRewardStatus: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
}) {
  const rate = (basis: string, value: number) =>
    basis === "percent" ? `${(value / 100).toFixed(2)}%` : formatINR(value);
  const of = `of ${formatINR(money.base)}`;
  // Struck-through figures on a policy earning nothing. The rows stay on screen
  // — what the reward WOULD have been is the thing being explained.
  //
  // The colour goes on a SPAN, not on the <td>. `.card table tbody td` in
  // index.css is `.card` + three element selectors, which outranks a bare
  // `text-*` utility on the same cell — a colour set here would be silently
  // repainted slate-700. Alignment (`.num`) is safe because that rule sets no
  // text-align of its own.
  const figure = `text-sm font-semibold ${notEligible
    ? "text-slate-500 line-through" : "text-slate-900"}`;

  return (
    <section className="overflow-hidden rounded-control border border-line">
      <header className="flex flex-wrap items-center justify-between gap-2
        border-b border-line bg-slate-50/70 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-slate-700">Reward</h3>
        {notEligible ? (
          <span className="badge bg-money-out/15 text-money-out">Not eligible</span>
        ) : (
          <span className="text-xs text-slate-500">
            Priced on {baseLabel.toLowerCase()} · {formatINR(money.base)}
          </span>
        )}
      </header>

      {notEligible && (
        <p className="border-b border-line bg-money-out/10 px-4 py-2 text-xs
          text-money-out">
          Nothing is receivable on this policy — the commission is out of
          pending-to-collect and any reward credited to the channel partner has
          been reversed.
        </p>
      )}

      <table className="w-full">
        <tbody>
          {seesAgency && (
            <tr className="border-b border-line/70">
              <td className="px-4 py-2.5">
                <p className="text-sm text-slate-700">Agency reward</p>
                <p className="text-xs text-slate-500">
                  {rate(reward.agency_basis, reward.agency_value)} {of}
                </p>
              </td>
              <td className="num px-4 py-2.5">
                <span className={figure}>{formatINR(money.agency)}</span>
              </td>
            </tr>
          )}
          {hasPartner && (
            <tr className="border-b border-line/70">
              <td className="px-4 py-2.5">
                <p className="text-sm text-slate-700">
                  Channel partner{partnerName ? ` · ${partnerName}` : ""}
                </p>
                <p className="text-xs text-slate-500">
                  {rate(reward.partner_basis, reward.partner_value)} {of}
                </p>
              </td>
              <td className="num px-4 py-2.5">
                <span className={figure}>
                  {seesAgency ? "− " : ""}{formatINR(money.partner)}
                </span>
              </td>
            </tr>
          )}
          {seesHouse && (
            <tr className="bg-slate-50/60">
              {/* The bottom line, ruled off like one. The heavy rule goes on
                  the CELLS: a border on <tr> is dropped by some engines under
                  border-collapse, and this is the one rule that carries the
                  meaning. */}
              <td className="border-t-2 border-ink/80 px-4 py-2.5">
                <p className="text-sm font-semibold text-slate-900">
                  House keeps</p>
                <p className="text-xs text-slate-500">
                  agency reward{hasPartner ? " − partner share" : ""}
                </p>
              </td>
              <td className="num border-t-2 border-ink/80 px-4 py-2.5">
                <span className={`text-sm font-bold ${notEligible
                  ? "text-slate-500 line-through"
                  : moneyToneQuiet(money.house)}`}>
                  {formatINR(money.house)}
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Reward eligibility — the only per-policy reward control. */}
      {canReward && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line
          bg-slate-50/70 px-4 py-2.5">
          <label className="text-xs font-medium text-slate-600"
            htmlFor="reward-eligibility">Eligibility</label>
          <select id="reward-eligibility" className="select h-9 w-auto text-sm"
            value={rewardStatus}
            onChange={(e) => onRewardStatus(e.target.value)}>
            {REWARD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button type="button" className="btn-secondary btn-sm"
            disabled={saving || !dirty} onClick={onSave}>
            {saving ? "Saving…" : "Update"}
          </button>
          <span className="text-xs text-slate-500">
            {notEligible
              ? "Set back to Eligible to put it into pending-to-collect again."
              : "Counted in pending-to-collect."}
          </span>
        </div>
      )}
    </section>
  );
}

function DetailRow({ label, children }: {
  label: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b
      border-line/70 py-2 last:border-0">
      <span className="shrink-0 text-sm text-slate-500">{label}</span>
      <span className="text-right text-sm font-medium text-slate-800">
        {children}
      </span>
    </div>
  );
}

export function ExpiryChip({ expiry, status }: {
  expiry?: string | null; status: string;
}) {
  const days = daysUntil(expiry);
  if (days === null || !["active", "renewal_due", "draft"].includes(status))
    return null;
  if (days < 0)
    return <span className="badge bg-money-out/15 text-money-out">expired</span>;
  if (days <= 7)
    return <span className="badge bg-money-out/15 text-money-out">{days}d left</span>;
  if (days <= 45)
    return <span className="badge bg-due/15 text-due">{days}d left</span>;
  return null;
}

type EditForm = {
  policy_number: string; premium: string; commissionable: string;
  sum_insured: string; start_date: string; expiry_date: string;
  agency_value: string; partner_value: string;
  payer: string; discount_basis: string; discount_value: string;
  notes: string;
  // Cross-checked against the Add Policy form 2026-08-04 (owner D1): these
  // existed there and nowhere here, so a value entered at booking could never
  // be corrected. The backend's PolicyUpdate already accepted every one of
  // them — only the inputs were missing.
  broker_id: string; partner_id: string; subcategory_path: string[];
};

// Reward eligibility — the only per-policy reward control. Eligible (default)
// counts the commission as pending-to-collect (and the partner share as pending-
// to-pay); Not eligible removes both and reverses any partner credit. Stored as
// the reward status pending / not_eligible.
const REWARD_OPTIONS: { value: RewardStatus; label: string }[] = [
  { value: "pending", label: "Eligible" },
  { value: "not_eligible", label: "Not eligible" },
];
// Which stored statuses map onto the "Eligible" choice in the two-state control.
const ELIGIBLE_STATES = new Set<RewardStatus>(["pending", "received"]);
const toEligibility = (s?: RewardStatus | null): RewardStatus =>
  s && !ELIGIBLE_STATES.has(s) ? "not_eligible" : "pending";

// Full policy record: everything the owner needs to review a policy in one
// place, with inline editing for staff (partners: only while pending review).
/**
 * The body of the policy record — details, reward maths, the PDF and the edit
 * form. Rendered inside a RecordPage (pages/policies/PolicyDetailPage), which
 * owns the heading, the back link and the delete action.
 *
 * It was a dialog until 2026-08-03. Everything below the wrapper is unchanged;
 * the only difference is that finishing an edit no longer closes anything, it
 * just drops back out of edit mode on a page that is already open.
 */
export function PolicyDetailBody({ policy, onDelete, deleting }: {
  policy: Policy;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const qc = useQueryClient();
  const { has, user } = useAuth();
  const isPartner = user?.account_type === "channel_partner";
  const canEdit = has("manage_policies")
    && !isPartner;
  // Agency % + house profit are income figures — only for users who may see
  // agency profit. Other staff still see what the channel partner (agent) gets.
  const seesAgency = !isPartner && has("view_agency_profit");
  const seesHouse = seesAgency;
  const canReward = !isPartner && has("manage_policies");
  // The eligibility dropdown is a local draft of a server value. It is seeded
  // once, so it has to be re-seeded when the RECORD changes underneath it —
  // after our own save, or after someone else's. Comparing against the last
  // server value seen (rather than syncing on every render) is what keeps a
  // half-made choice from being wiped by an ordinary refetch-on-focus.
  const serverEligibility = toEligibility(policy.reward_status);
  const [rewardStatus, setRewardStatus] = useState<string>(serverEligibility);
  const [seenEligibility, setSeenEligibility] = useState(serverEligibility);
  if (seenEligibility !== serverEligibility) {
    setSeenEligibility(serverEligibility);
    setRewardStatus(serverEligibility);
  }
  const [editing, setEditing] = useState(false);
  // Replacement PDF chosen while editing (uploaded on save).
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  // The server resolves the partner's name onto the policy. The lookup below is
  // only a fallback for a cached record serialised before it did, and it needs
  // view_partners — which is exactly why it can't be the primary source: a staff
  // user without that flag would sit on "…" forever.
  const partner = useQuery({
    queryKey: ["user", policy.partner_id],
    queryFn: async () => (await usersApi.get(policy.partner_id!)).data,
    enabled: !!policy.partner_id && !policy.partner_name
      && has("view_partners"),
  });

  // EVERY document attached to this policy — the policy PDF and the supporting
  // files collected at booking. Listing needs view_policies on the backend; if
  // the viewer lacks it the query just yields nothing.
  const docs = useQuery({
    queryKey: ["policy-docs", policy.id],
    queryFn: async () =>
      (await documentsApi.listFor("policy", policy.id)).data,
    enabled: has("view_policies"),
    retry: false,
  });
  const pdf = pickPolicyPdf(docs.data);

  // Brokers, for the edit form. Internal to the agency, so a partner never
  // sees the list (and the server refuses them the endpoint anyway).
  const brokers = useQuery({
    queryKey: ["brokers-picker"],
    queryFn: async () => (await brokersApi.list({ active_only: 1 })).data,
    enabled: editing && !isPartner,
  });
  const partners = useQuery({
    queryKey: ["attributable-partners"],
    queryFn: async () => (await usersApi.attributablePartners()).data,
    enabled: editing && !isPartner && has("manage_policies"),
  });

  // The policy type's field specs — to label + format the collected `details`.
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await categoriesApi.list()).data,
  });
  const cat = cats.data?.find((c) => c.key === policy.category_key);
  const fieldSpecs = cat?.custom_fields ?? [];
  const filledDetails = fieldSpecs
    .map((s) => ({ spec: s, value: policy.details?.[s.key] }))
    .filter((d) => d.value !== undefined && d.value !== null && d.value !== ""
      && !(Array.isArray(d.value) && d.value.length === 0));
  const fmtDetail = (spec: typeof fieldSpecs[number], v: unknown): string => {
    if (spec.type === "amount") return formatINR(Number(v));
    if (spec.type === "checkbox") return v ? "Yes" : "No";
    if (spec.type === "multi_select" && Array.isArray(v)) return v.join(", ");
    return String(v);
  };
  const baseLabel = policy.reward_base_field
    && policy.reward_base_field !== "commissionable"
    ? (fieldSpecs.find((s) => s.key === policy.reward_base_field)?.label
        ?? policy.reward_base_field)
    : "Reward base premium";

  const openPdf = async (docId: string) => {
    try {
      const { data } = await documentsApi.download(docId);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  const [f, setF] = useState<EditForm>({
    policy_number: policy.policy_number ?? "",
    premium: policy.premium_amount ? String(policy.premium_amount / 100) : "",
    commissionable: policy.commissionable_premium
      ? String(policy.commissionable_premium / 100) : "",
    sum_insured: policy.sum_insured ? String(policy.sum_insured / 100) : "",
    start_date: toDateInput(policy.start_date),
    expiry_date: toDateInput(policy.expiry_date),
    agency_value: policy.reward.agency_value
      ? String(policy.reward.agency_value / 100) : "",
    partner_value: policy.reward.partner_value
      ? String(policy.reward.partner_value / 100) : "",
    payer: policy.payer,
    discount_basis: policy.discount_basis,
    discount_value: policy.discount_value
      ? String(policy.discount_value / 100) : "",
    notes: policy.notes ?? "",
    broker_id: policy.broker_id ?? "",
    partner_id: policy.partner_id ?? "",
    subcategory_path: policy.subcategory_path ?? [],
  });
  const set = (k: keyof EditForm, v: string) => setF((s) => ({ ...s, [k]: v }));

  // The type's own fields, editable — they were collected at booking and then
  // frozen, because only the Add and Renew forms ever rendered them (owner D1).
  const [details, setDetails] = useState<Record<string, unknown>>(
    { ...(policy.details ?? {}) });
  const [rewardBaseField, setRewardBaseField] = useState<string>(
    policy.reward_base_field || COMMISSIONABLE_BASE);
  const setDetail = (key: string, v: unknown) =>
    setDetails((d) => {
      if (v === undefined) { const { [key]: _drop, ...rest } = d; return rest; }
      return { ...d, [key]: v };
    });
  const { amount: amountCustomFields, other: otherCustomFields } =
    useMemo(() => splitCustomFields(fieldSpecs), [fieldSpecs]);

  // Sub-type levels for the policy's type tree, following the chosen path.
  const levels = useMemo(
    () => (cat ? pathLevels(cat.children, f.subcategory_path) : []),
    [cat, f.subcategory_path]);
  const setLevel = (i: number, value: string) => setF((s) => {
    const next = s.subcategory_path.slice(0, i);
    if (value) next.push(value);
    return { ...s, subcategory_path: next };
  });

  /** Drop back out of edit mode, discarding anything typed. */
  const cancelEdit = () => {
    setEditing(false);
    setPdfFile(null);
    setDetails({ ...(policy.details ?? {}) });
    setRewardBaseField(policy.reward_base_field || COMMISSIONABLE_BASE);
    setF((s) => ({ ...s,
      broker_id: policy.broker_id ?? "",
      partner_id: policy.partner_id ?? "",
      subcategory_path: policy.subcategory_path ?? [] }));
  };

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        policy_number: f.policy_number || null,
        premium_amount: f.premium
          ? rupeesToPaise(parseFloat(f.premium)) : 0,
        commissionable_premium: f.commissionable
          ? rupeesToPaise(parseFloat(f.commissionable)) : 0,
        sum_insured: f.sum_insured
          ? rupeesToPaise(parseFloat(f.sum_insured)) : 0,
        start_date: fromDateInput(f.start_date),
        expiry_date: fromDateInput(f.expiry_date),
        payer: f.payer,
        // Flat ₹ only — same as the add form (owner 1.9).
        discount_basis: "flat",
        // No discount on partner-attributed policies (owner Q5) — editing a
        // legacy partner+discount policy clears the discount.
        discount_value: !f.partner_id && f.discount_value
          ? rupeesToPaise(parseFloat(f.discount_value))
          : 0,
        notes: f.notes || null,
        // The type's own fields, and which amount the reward is priced on.
        details,
        reward_base_field: rewardBaseField,
      };
      // Partners never touch the reward terms, the broker or the attribution —
      // those are the agency's. The server strips them too; this keeps the
      // request honest rather than relying on it.
      if (!isPartner) {
        body.broker_id = f.broker_id || null;
        body.partner_id = f.partner_id || null;
        body.subcategory_path = f.subcategory_path;
        body.reward = {
          agency_basis: policy.reward.agency_basis,
          agency_value: policy.reward.agency_basis === "percent"
            ? Math.round(parseFloat(f.agency_value || "0") * 100)
            : rupeesToPaise(parseFloat(f.agency_value || "0")),
          partner_basis: policy.reward.partner_basis,
          partner_value: policy.reward.partner_basis === "percent"
            ? Math.round(parseFloat(f.partner_value || "0") * 100)
            : rupeesToPaise(parseFloat(f.partner_value || "0")),
        };
      }
      await policiesApi.update(policy.id, body);
      // Replace the attached PDF if a new one was chosen while editing.
      if (pdfFile) await policiesApi.uploadDocument(policy.id, pdfFile);
    },
    onSuccess: () => {
      toast.success("Policy updated.");
      qc.invalidateQueries({ queryKey: ["policies"] });
      qc.invalidateQueries({ queryKey: ["policy-docs", policy.id] });
      qc.invalidateQueries({ queryKey: ["policy", policy.id] });
      // Broker / partner / reward-base edits re-price the reward and re-book
      // the finance snapshot server-side, so the money pages are stale.
      refreshFinance(qc);
      setEditing(false);
      setPdfFile(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const saveReward = useMutation({
    mutationFn: (s: string) => policiesApi.setRewardStatus(policy.id, s),
    onSuccess: () => {
      toast.success("Reward outcome updated.");
      // THIS record, not just the list. Everything the reward block draws —
      // the struck-through figures, the Not eligible badge, whether Update is
      // still enabled — reads `policy.reward_status`, which comes from the
      // ["policy", id] query the page is built on. Invalidating only
      // ["policies"] refreshed the list you were not looking at and left the
      // open record stale until a hard browser refresh.
      qc.invalidateQueries({ queryKey: ["policy", policy.id] });
      qc.invalidateQueries({ queryKey: ["policies"] });
      // A reversal outcome moves the partner wallet / net balance.
      refreshFinance(qc);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.partner_id && parseFloat(f.discount_value || "0")
        > parseFloat(f.premium || "0"))
      return toast.error("Discount cannot exceed the premium (100%).");
    // Same client-side check the Add form runs, against the same specs — the
    // server re-validates, this just says which field is wrong before the trip.
    const detailErr = validateDetailsClient(fieldSpecs, details);
    if (detailErr) return toast.error(detailErr);
    save.mutate();
  };

  const money = computeRewardPreview(policy);

  return (
    <>
      {/* Status header — the policy's lifecycle state (active / expiring / expired
          / cancelled), read-only. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge value={policy.status} />
        <ExpiryChip expiry={policy.expiry_date} status={policy.status} />
        {!editing && (
          <div className="ml-auto flex items-center gap-2">
            {pdf && (
              <button className="btn-secondary btn-sm"
                title="Download the policy PDF"
                onClick={() => openPdf(pdf.id)}>
                <Icon.Download size={14} /> Download
              </button>
            )}
            {canEdit && (
              <button className="btn-secondary btn-sm"
                onClick={() => setEditing(true)}>
                <Icon.Edit size={14} /> Edit
              </button>
            )}
            {onDelete && (
              <button className="inline-flex items-center gap-1 rounded-md border
                border-money-out/25 px-3 py-1.5 text-xs font-medium text-money-out
                hover:bg-money-out/10 disabled:opacity-50"
                disabled={deleting} onClick={onDelete}>
                <Icon.Trash size={14} /> {deleting ? "Deleting…" : "Delete"}
              </button>
            )}
          </div>
        )}
      </div>

      {!editing ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <div>
              <DetailRow label="Customer">
                {policy.customer_name || "—"}</DetailRow>
              <DetailRow label="Insurer">
                {policy.insurer_name || "—"}</DetailRow>
              <DetailRow label="Category">
                {titleCase(policy.category_key)}
                {policy.subcategory_key
                  ? ` · ${titleCase(policy.subcategory_key)}` : ""}
              </DetailRow>
              {policy.broker_id && !isPartner && (
                <DetailRow label="Broker">
                  {policy.broker_name
                    ? `${policy.broker_name}${policy.broker_code
                        ? ` · ${policy.broker_code}` : ""}`
                    : "—"}
                </DetailRow>
              )}
              <DetailRow label="Policy number">
                {policy.policy_number || "—"}</DetailRow>
              {policy.partner_id && (
                <DetailRow label="Channel partner">
                  {isPartner ? "You"
                    : policy.partner_name || partner.data?.full_name || "—"}
                </DetailRow>
              )}
            </div>
            <div>
              <DetailRow label="Premium (gross)">
                {formatINR(policy.premium_amount)}</DetailRow>
              <DetailRow label="Reward base">
                {formatINR(money.base)}
                {policy.commissionable_premium === 0 && (
                  <span className="ml-1 text-xs font-normal text-slate-500">
                    (auto, net of GST)</span>
                )}
              </DetailRow>
              <DetailRow label="Sum insured">
                {policy.sum_insured ? formatINR(policy.sum_insured) : "—"}
              </DetailRow>
              <DetailRow label="Start date">
                {formatDate(policy.start_date)}</DetailRow>
              <DetailRow label="Expiry date">
                {formatDate(policy.expiry_date)}</DetailRow>
              <DetailRow label="Premium Paid By">
                {paidByLabel(policy.payer)}</DetailRow>
              {policy.discount_value > 0 && (
                <DetailRow label="Discount (house-borne)">
                  {policy.discount_basis === "percent"
                    ? `${(policy.discount_value / 100).toFixed(2)}%`
                    : formatINR(policy.discount_value)}
                </DetailRow>
              )}
            </div>
          </div>

          {/* What this policy earns — see RewardPanel. Agency % + house profit
              are income figures gated to finance viewers; the partner (agent)
              share is operational and shown to all staff. */}
          {(seesAgency || !!policy.partner_id || canReward) && (
            <RewardPanel
              money={money}
              reward={policy.reward}
              baseLabel={baseLabel}
              hasPartner={!!policy.partner_id}
              partnerName={isPartner ? "You"
                : policy.partner_name || partner.data?.full_name || undefined}
              seesAgency={seesAgency}
              seesHouse={seesHouse}
              notEligible={serverEligibility === "not_eligible"}
              canReward={canReward}
              rewardStatus={rewardStatus}
              onRewardStatus={setRewardStatus}
              onSave={() => saveReward.mutate(rewardStatus)}
              saving={saveReward.isPending}
              dirty={rewardStatus !== serverEligibility}
            />
          )}

          {/* Type-specific collected details (vehicle no, OD/TP, …) */}
          {filledDetails.length > 0 && (
            <div className="rounded-control border border-line/70 p-3">
              <p className="mb-2 text-sm font-medium text-slate-600">
                {cat?.label ?? "Policy"} details
              </p>
              <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                {filledDetails.map(({ spec, value }) => (
                  <DetailRow key={spec.key} label={spec.label}>
                    {fmtDetail(spec, value)}
                  </DetailRow>
                ))}
              </div>
              {policy.reward_base_field
                && policy.reward_base_field !== "commissionable" && (
                <p className="mt-2 text-xs text-slate-500">
                  Reward calculated on: <b>{baseLabel}</b>
                </p>
              )}
            </div>
          )}

          {/* EVERYTHING attached to this policy — the PDF, the type's document
              slots (filled and empty) and any one-off uploads. This replaced a
              card that showed the policy PDF alone, which is why the supporting
              documents collected at booking were invisible (owner 2026-08-04). */}
          <PolicyDocuments
            policyId={policy.id}
            docs={docs.data}
            slots={cat?.required_documents ?? []}
            loading={docs.isLoading}
            canManage={canEdit}
            canView={has("view_policies")}
            onChanged={() =>
              qc.invalidateQueries({ queryKey: ["policy-docs", policy.id] })}
          />

          {policy.notes && (
            <div className="rounded-control border border-line/70 p-3 text-sm
              text-slate-600">{policy.notes}</div>
          )}
          <p className="text-xs text-slate-500">
            Created {formatDate(policy.created_at)}
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {/* Placement — the broker, the sub-type and who the policy is
              attributed to. All three were on the Add form and on none of the
              edit one, so a wrong choice at booking could only be fixed by
              deleting the policy (owner D1, 2026-08-04). Changing the broker or
              the sub-type re-prices the reward from the rate card server-side;
              the % fields below still win if you set them. */}
          {!isPartner && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Broker"
                hint="Drives the rate card. Changing it re-prices the reward.">
                <SearchSelect
                  options={(brokers.data ?? []).map((b) => ({
                    value: b.id, label: `${b.name} (${b.short_code})` }))}
                  value={f.broker_id}
                  placeholder="Select broker…"
                  onChange={(v) => set("broker_id", v)} />
              </Field>
              {has("manage_policies") && (
                <Field label="Channel Partner"
                  hint="Attributes the reward to this partner's wallet.">
                  <SearchSelect
                    options={(partners.data ?? []).map((p) => ({
                      value: p.id, label: p.full_name, sub: p.code }))}
                    value={f.partner_id}
                    placeholder="— None (in-house sale) —"
                    allowClear clearLabel="— None (in-house sale) —"
                    onChange={(v) => setF((s) => ({ ...s, partner_id: v,
                      // No discount on partner-attributed policies (owner Q5).
                      ...(v ? { discount_value: "" } : {}) }))} />
                </Field>
              )}
            </div>
          )}

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
            <Field label="Policy number">
              <input className="input" value={f.policy_number}
                onChange={(e) => set("policy_number", e.target.value)} />
            </Field>
            <Field label="Premium — gross incl. GST (₹)" required>
              <input type="number" step="0.01" min="0" className="input"
                value={f.premium} required
                onChange={(e) => set("premium", e.target.value)} />
            </Field>
            <Field label="Reward base premium (₹)"
              hint="Leave blank to auto-derive net of GST.">
              <input type="number" step="0.01" min="0" className="input"
                value={f.commissionable}
                onChange={(e) => set("commissionable", e.target.value)} />
            </Field>
            <Field label="Sum insured (₹)">
              <input type="number" step="0.01" min="0" className="input"
                value={f.sum_insured}
                onChange={(e) => set("sum_insured", e.target.value)} />
            </Field>
            <Field label="Start date" required>
              <DateInput value={f.start_date} required
                onChange={(v) => set("start_date", v)} />
            </Field>
            <Field label="Expiry date" required>
              <DateInput value={f.expiry_date} required
                onChange={(v) => set("expiry_date", v)} />
            </Field>
          </div>

          {/* The type's OWN fields — collected on the Add form, editable here
              since 2026-08-04. Amount fields sit with the amounts above and
              carry the "reward calculated on" selector; the rest group after. */}
          <AmountCustomFields title={cat?.label ?? "Policy"}
            fields={amountCustomFields} details={details} setDetail={setDetail}
            {...(isPartner ? {} : {
              rewardBaseField, setRewardBaseField })} />
          <OtherCustomFields title={cat?.label ?? "Policy"}
            fields={otherCustomFields} details={details} setDetail={setDetail} />

          {!isPartner && (seesAgency || !!f.partner_id) && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {seesAgency && (
                <Field label={policy.reward.agency_basis === "percent"
                  ? "Agency % (received from broker)" : "Agency flat (₹)"}>
                  <input type="number" step="0.01" min="0" className="input"
                    value={f.agency_value}
                    onChange={(e) => set("agency_value", e.target.value)} />
                </Field>
              )}
              {!!f.partner_id && (
                <Field label={policy.reward.partner_basis === "percent"
                  ? "Channel Partner % (paid to partner)"
                  : "Channel Partner flat (₹)"}>
                  <input type="number" step="0.01" min="0" className="input"
                    value={f.partner_value}
                    onChange={(e) => set("partner_value", e.target.value)} />
                </Field>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Premium Paid By">
              <select className="select" value={f.payer}
                onChange={(e) => set("payer", e.target.value)}>
                {PAID_BY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            {/* No discount on partner-attributed policies (owner Q5).
                Flat ₹ only — same as the add form (owner 1.9). Follows the
                partner picker above, not the saved value, so clearing the
                partner opens the field in the same edit. */}
            {!f.partner_id && (
              <Field label="Discount (₹)"
                hint="Flat amount, borne by the house. Cannot exceed the premium.">
                <input type="number" step="0.01" min="0" className="input"
                  value={f.discount_value}
                  onChange={(e) => set("discount_value", e.target.value)} />
              </Field>
            )}
          </div>
          <Field label="Replace policy PDF"
            hint={pdf
              ? `Current: ${pdf.filename}. Choose a file to replace it.`
              : "Upload the policy PDF (max 20 MB)."}>
            <input type="file" accept="application/pdf,.pdf"
              className="input py-1.5"
              onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)} />
            {pdfFile && (
              <p className="mt-1 inline-flex items-center gap-1 text-xs
                text-money-in"><Icon.Check size={13} /> {pdfFile.name}</p>
            )}
          </Field>
          {/* Supporting documents are NOT re-collected here: the Documents list
              on the record itself uploads, replaces and deletes them, so a file
              picker in this form would be a second way to do the same thing
              that only works while you happen to be editing. */}
          <Field label="Notes">
            <textarea className="input" rows={2} value={f.notes}
              onChange={(e) => set("notes", e.target.value)} />
          </Field>

          <p className="text-xs text-slate-500">
            Saving recomputes the reward and finance snapshot from the new
            amounts. Supporting documents are managed from the Documents list on
            the record.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={cancelEdit}>
              Cancel</button>
            <button type="submit" className="btn-primary"
              disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
