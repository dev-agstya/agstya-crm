// Shared API types mirroring the backend schemas.

export type AccountType = "owner" | "employee" | "channel_partner";
export type AccountStatus = "active" | "suspended" | "inactive";

export interface Me {
  id: string;
  code: string;
  full_name: string;
  email: string;
  mobile?: string | null;
  account_type: AccountType;
  role_id?: string | null;
  role_name?: string | null;
  permissions: string[];
  status: AccountStatus;
  must_change_password: boolean;
  onboarded: boolean;
  last_login_at?: string | null;
  relationship_manager_id?: string | null;
}

export interface OnboardingPayload {
  dob?: string | null;
  gender?: string | null;
  address?: string | null;
  // Optional on the wire, and mandatory for EMPLOYEES only — the server holds
  // that half of the rule, because it depends on who is onboarding (owner I1,
  // 2026-08-06). A channel partner who skips both still gets into their portal;
  // staff chase the KYC afterwards.
  pan_number?: string | null;
  aadhaar_number?: string | null;
  irdai_license_no?: string | null;
  bank: {
    account_holder?: string | null;
    bank_name?: string | null;
    account_number?: string | null;
    ifsc?: string | null;
    upi_id?: string | null;
  };
  new_password: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  must_change_password: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

// Reports-to / relationship-manager candidate (employees + the Owner).
export interface AssignableManager {
  id: string;
  full_name: string;
  account_type: AccountType;
}

// An active channel partner a staff member can attribute a policy to.
export interface AssignablePartner {
  id: string;
  full_name: string;
  code: string;
}

// A user's stored KYC document (PAN / Aadhaar, etc.).
export interface UserDoc {
  id: string;
  entity_type: string;
  entity_id: string;
  doc_key?: string | null;
  label: string;
  filename: string;
  content_type?: string | null;
  size_bytes?: number | null;
  status: string;
  uploaded_by?: string | null;
  created_at: string;
}

// --- Roles (custom permission bundles) ---
export interface OrgRole {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  permissions: string[];
  is_system: boolean;
  active: boolean;
  member_count: number;
  created_at: string;
}

// --- Profiles ---
export interface BankDetails {
  account_holder?: string | null;
  account_number?: string | null;
  ifsc?: string | null;
  bank_name?: string | null;
  upi_id?: string | null;
}

export interface ChannelPartnerProfile {
  pan?: string | null;
  aadhaar_last4?: string | null;
  irdai_license_no?: string | null;
  license_expiry?: string | null;
  default_partner_basis?: "percent" | "flat" | null;
  default_partner_value?: number | null;
  bank?: BankDetails | null;
}

export interface EmployeeProfile {
  dob?: string | null;
  gender?: string | null;
  address?: string | null;
  designation?: string | null;
  department?: string | null;
  // LOAD-BEARING since 2026-08-20: leave accrues from this date, and a day
  // before it is never counted as an absence. It was on the type from the
  // beginning and no form ever collected it.
  date_of_joining?: string | null;
  employment_type?: string | null;
  // Paise. STORED AND READ BY NOTHING — the owner dropped automated payroll on
  // 2026-08-20 ("we will store the salary on the profile, but it is calculated
  // manually at the end"), so this is a reference figure on the record. It is
  // ABSENT from the payload for anyone without `view_salary`: the server strips
  // it rather than the client hiding it, so `undefined` here means "not allowed
  // to see" as often as it means "not set".
  //
  // Replaced `salary_ctc` (an annual figure), which no editor in the app ever
  // wrote, so there was nothing to migrate.
  monthly_salary_paise?: number | null;
  // Optional per-person overrides of the agency's attendance policy. Blank uses
  // SystemSettings.hr — see the note there on why these are not on everybody.
  shift_start?: string | null;      // "HH:MM", IST
  shift_end?: string | null;
  monthly_leave_accrual?: number | null;
  pan?: string | null;
  aadhaar_last4?: string | null;
  emergency_contact?: {
    name?: string | null;
    relationship?: string | null;
    phone?: string | null;
  } | null;
  bank?: BankDetails | null;
}

export interface UserRow {
  id: string;
  code: string;
  full_name: string;
  email: string;
  mobile?: string | null;
  account_type: AccountType;
  status: AccountStatus;
  role_id?: string | null;
  role_name?: string | null;
  permissions: string[];
  extra_permissions: string[];
  must_change_password: boolean;
  onboarded?: boolean;
  relationship_manager_id?: string | null;
  // Resolved server-side by the SAME serialiser for the list and the
  // single record, so the People table and the page one click away
  // cannot disagree about who manages this partner.
  relationship_manager_name?: string | null;
  // Channel partners only: whether this account may sign in to the portal at
  // all. Off by default — a partner record exists for attribution first.
  portal_access?: boolean;
  partner_profile?: ChannelPartnerProfile | null;
  employee_profile?: EmployeeProfile | null;
  last_login_at?: string | null;
  suspended_until?: string | null;
  is_deleted?: boolean;
  // Named on a policy, lead, ledger row or wallet entry. Such an account can
  // only be deactivated — the owner's rule is "0 policies / transactions
  // linked can be deleted, else archive" (2026-07-26).
  in_use?: boolean;
  // EMPLOYEES ONLY: channel partners on their roster right now. This is the
  // signpost to the Team tab — without it every row in the directory looks the
  // same and you cannot tell who has a team without opening them one by one.
  partners_under?: number;
  created_at: string;
}

export interface CustomerAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  contact_person?: string | null;
  email?: string | null;
  mobile?: string | null;
  alt_mobile?: string | null;
  address?: CustomerAddress | null;
  renewal_reminders_enabled: boolean;
  notes?: string | null;
  tags: string[];
  origin: "inhouse" | "channel_partner";
  owner_user_id: string;
  partner_id?: string | null;
  created_by_name?: string | null;
  can_edit: boolean;
  is_archived?: boolean;
  // A policy or ledger row names them, so they can only be archived. Their
  // documents and the lead they converted from are cleaned up on delete
  // rather than blocking it.
  in_use?: boolean;
  total_policies?: number;
  active_policies?: number;
  created_at: string;
}

export interface CustomerDocument {
  id: string;
  entity_type: string;
  entity_id: string;
  doc_key?: string | null;
  label: string;
  filename: string;
  content_type?: string | null;
  size_bytes?: number | null;
  status: string;
  uploaded_by?: string | null;
  created_at: string;
}

export interface Insurer {
  id: string;
  code: string;
  name: string;
  short_name?: string | null;
  contact_person?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  active: boolean;
  // Set by the server: something (a policy, a rate card, a ledger row…) points
  // at this record, so it can only be deactivated/archived — never deleted.
  // Defaults matter: treat a missing value as "in use", the safe answer.
  in_use: boolean;
  notes?: string | null;
  created_at: string;
}

// A Broker: a brokerage/aggregator (PolicyBazaar, Cars24) we place business
// through. Owns the rate card + a TDS % and is the finance counterparty.
export interface Broker {
  id: string;
  code: string;              // system id, e.g. BRK-AA00001
  short_code: string;        // human code shown on policies, e.g. "PB"
  name: string;
  tds_percent: number;       // percent*100 (2% -> 200)
  account_login?: string | null;
  reg_mobile?: string | null;   // 10 digits
  active: boolean;
  // Set by the server: something (a policy, a rate card, a ledger row…) points
  // at this record, so it can only be deactivated/archived — never deleted.
  // Defaults matter: treat a missing value as "in use", the safe answer.
  in_use: boolean;
  notes?: string | null;
  created_at: string;
}

// A rate-card rule under a Broker: pins policy-type node (path) + optional insurer
// company -> reward %.
export interface RateRule {
  id: string;
  broker_id: string;
  insurer_id?: string | null;   // null = applies to any insurer company
  category_key: string;
  subcategory_path: string[];
  agency_basis: "percent" | "flat";
  agency_value: number;
  partner_basis: "percent" | "flat";
  partner_value: number;
  label?: string | null;
  active: boolean;
  effective_from?: string | null;
  effective_to?: string | null;
  notes?: string | null;
  created_at: string;
}

// What the rate engine would apply for a scenario (rate_rule -> none).
export interface RatePreview {
  source: "rate_rule" | "none";
  rule_id?: string | null;
  label?: string | null;
  agency_basis: "percent" | "flat";
  agency_value: number;
  partner_basis: "percent" | "flat";
  partner_value: number;
}

export interface RewardTerms {
  agency_basis: "percent" | "flat";
  agency_value: number;
  partner_basis: "percent" | "flat";
  partner_value: number;
}

export type PolicyStatus =
  | "draft" | "active" | "renewal_due" | "renewed" | "lapsed"
  | "cancelled" | "expired";
// --- Finance engine ---
export type BuyerType = "direct" | "channel_partner";
export type PayerType = "agency" | "channel_partner" | "customer";
export type SettlementStatus = "pending" | "partial" | "settled";
export type PartyType = "channel_partner" | "customer" | "broker" | "expense";
export type LedgerTxnType =
  | "premium_due" | "premium_to_insurer" | "premium_paid_by_agency"
  | "premium_collected" | "reward_received" | "tds_deducted"
  | "partner_payout" | "partner_advance" | "refund" | "discount" | "adjustment"
  | "reward_cancelled" | "expense";

export interface PolicyFinance {
  policy_id: string;
  broker_id?: string | null;
  partner_id?: string | null;
  customer_id?: string | null;
  gross_premium: number;
  commissionable: number;
  agency_reward: number;
  partner_share: number;
  discount: number;
  house_profit: number;
  payer: PayerType;
  settlement_status: SettlementStatus;
  premium_paid_to_insurer: number;
  premium_collected: number;
  computed_at: string;
}

export interface LedgerTxn {
  id: string;
  txn_type: LedgerTxnType;
  party_type: PartyType;
  party_id: string;
  party_name?: string | null;
  policy_id?: string | null;
  amount_paise: number;   // >0 receivable (owes us), <0 payment/we owe
  note?: string | null;
  reference?: string | null;
  occurred_at: string;
  expense_category?: string | null;
  paid_to_employee_id?: string | null;
  paid_to_name?: string | null;
  attachment_doc_id?: string | null;
  // Which of OUR accounts the money moved through, and the signed amount that
  // actually hit it — NOT always ±amount_paise (a reward receipt is net of TDS).
  bank_account_id?: string | null;
  bank_account_name?: string | null;
  bank_delta_paise?: number | null;
  created_at: string;
}

// The View-details popup payload: a transaction + its linked policy and the
// resolved names around it.
export interface LedgerTxnDetail extends LedgerTxn {
  policy_code?: string | null;
  policy_number?: string | null;
  customer_name?: string | null;
  partner_name?: string | null;
  broker_name?: string | null;
  created_by_name?: string | null;
}

export interface PartyAccount {
  id: string;
  party_type: PartyType;
  party_id: string;
  party_name?: string | null;
  balance_paise: number;  // >0 receivable, <0 payable
  total_charged_paise: number;
  total_settled_paise: number;
  last_txn_at?: string | null;
}

export interface PartnerDues {
  partner_id: string;
  partner_name?: string | null;
  partner_code?: string | null;
  reward_available_paise: number;
  reward_pending_paise: number;
  premium_balance_paise: number;  // >0 they owe us, <0 we owe them
}

export interface AgencyPayoutResult {
  partner_id: string;
  amount_paise: number;
  paid_from_reward_paise: number;
  advance_paise: number;
  reward_balance_paise: number;
  net_balance_paise: number;   // reward owed − premium/advance owed (after)
}

export interface MonthPoint {
  month: string;
  earnings: number;
  target?: number | null;
}

export interface FinanceOverview {
  basis: "cash" | "accrual";
  earnings: {
    total: number; this_month: number; last_month: number;
    last_3_months: number; growth_pct?: number | null;
  };
  monthly: MonthPoint[];
  pending: {
    collection_customers: number; collection_partners: number;
    reward_brokers: number; rewards_partners: number;
  };
  aging: { bucket_0_30: number; bucket_30_60: number; bucket_60_plus: number };
  fy_label: string;
  fy_earnings: number;
  reward_received_total: number;
  rewards_paid_total: number;
  premium_collected_total?: number;
  premium_fronted_total?: number;
  refunds_total?: number;
  expenses_total?: number;
  tds_deducted_total: number;
  tds_deducted_fy: number;
}

export interface ReportRow {
  key: string;
  label: string;
  policies: number;
  premium: number;
  reward_earned: number;
  reward: number;
  discount: number;
  profit: number;
  pending_collection?: number | null;
  pending_payout?: number | null;
  growth_pct?: number | null;
}

export interface ReportResult {
  dimension: string;
  totals: Omit<ReportRow, "key" | "label" | "pending_collection"
    | "pending_payout" | "growth_pct">;
  rows: ReportRow[];
}

export interface EntityProfile {
  entity_type: string;
  entity_id: string;
  label: string;
  party_type?: string | null;
  metrics: {
    policies: number; premium: number; reward_earned: number;
    reward: number; discount: number; profit: number;
  };
  monthly: { month: string; profit: number; premium: number }[];
  pending: {
    collection?: number | null; payout?: number | null;
    reward_to_receive?: number | null;
  };
  policy_status: Record<string, number>;
}

// --- In-app notifications ---
export interface AppNotification {
  id: string;
  title: string;
  body?: string | null;
  category?: string | null;
  link?: string | null;
  is_read: boolean;
  created_at: string;
}

// --- Redesigned finance dashboard ---
export interface TopPerformer {
  // Employees only: Top Employee ranks on profit AND target achievement.
  attainment_pct?: number;
  has_target?: boolean;
  score?: number;
  rank?: number;
  key: string;
  label: string;
  policies: number;
  premium: number;
  profit: number;
  agency_reward: number;  // agency reward earned (employee / broker)
  reward: number;         // partner share earned (channel partner)
  renewals: number;
}

// One bucket of the overview graph (day / week / month, per the date filter).
export interface SeriesPoint {
  key: string;
  label: string;
  policies: number;
  net_profit: number;
  renewals: number;
  renewal_rate_pct?: number | null;
  // Performance vs Target. `actual` is the BOOKED figure for the selected
  // target metric — NOT net_profit, which is cash. The two used to be plotted
  // against each other, which is how a rupee bar ended up next to a
  // policy-count goal.
  actual: number;
  target: number;
}

export interface EmployeeTarget {
  key: string;
  label: string;
  actual: number;
  target: number;
  has_target: boolean;
  attainment_pct: number;
  profit: number;
  policies: number;
  score: number;
  rank: number;
}

export interface PendingItem {
  party_type: "customer" | "partner" | "broker";
  party_id: string;
  label: string;
  amount: number;         // net amount on this side (owed_to_us − owed_to_them)
  owed_to_us?: number;    // gross the party owes us (premium / commission)
  owed_to_them?: number;  // gross we owe them (reward / discount refund)
}

export interface FinanceDashboard {
  period: string;
  period_label: string;
  date_from?: string | null;
  date_to?: string | null;
  net_profit_30d: number;   // fixed 30-day window, ignores the date filter
  earnings: {
    total_earnings: number;
    reward_received: number;
    rewards_paid: number;
    premium_collected?: number;
    premium_fronted?: number;
    refunds?: number;
    expenses?: number;
    total_policies: number;
  };
  granularity: "day" | "week" | "month";
  series: SeriesPoint[];
  target_metric: TargetMetric;
  target_metric_label: string;
  target_is_money: boolean;
  has_targets: boolean;
  target_employee_id?: string | null;
  top_employees: TopPerformer[];
  top_partners: TopPerformer[];
  top_brokers: TopPerformer[];
  top_categories: TopPerformer[];
  employee_targets: EmployeeTarget[];
  pending: {
    to_collect: number;
    to_pay: number;
    collect_items: PendingItem[];
    pay_items: PendingItem[];
  };
}

// --- Finance Reports insights ---
export interface InsightMetric {
  key: string;
  label: string;
  policies: number;
  premium: number;
  agency_reward: number;
  reward: number;
  profit: number;
  avg_reward_pct?: number | null;
}
export interface InsightSlice {
  key: string; label: string; count: number; premium: number;
}
export interface InsightTrendPoint {
  month: string; premium: number; profit: number; policies: number;
  net_profit: number; target: number;
}
export interface RenewalTrendPoint {
  month: string; new_business: number; renewals: number;
}
export interface CustomerTrendPoint {
  month: string; new: number; returning: number;
}
export interface TargetRow {
  key: string; label: string; actual: number; target: number;
  has_target: boolean; met: boolean;
}
export interface InsightsResult {
  period: string;
  period_label: string;
  date_from?: string | null;
  date_to?: string | null;
  kpis: {
    total_premium: number; policies: number; active_policies: number;
    new_business_premium: number; house_profit: number;
    reward_earned: number; reward: number; avg_premium: number;
    avg_reward_pct?: number | null; renewal_rate?: number | null;
    repeat_rate?: number | null;
    net_profit: number; pending_to_collect: number; pending_to_pay: number;
  };
  trend: InsightTrendPoint[];
  by_category: InsightMetric[];
  by_insurer: InsightMetric[];
  payer_mix: InsightSlice[];
  buyer_mix: InsightSlice[];
  renewal_trend: RenewalTrendPoint[];
  renewals_due: { d30: number; d60: number; d90: number };
  customer_trend: CustomerTrendPoint[];
  retention: {
    total_customers: number; repeat_customers: number;
    repeat_rate?: number | null; avg_policies: number;
  };
  top_partners: InsightMetric[];
  top_employees: InsightMetric[];
  employee_targets: TargetRow[];
  partner_targets: TargetRow[];
  reward_health: {
    received: number; pending: number; rejected: number; not_eligible: number;
    zero_pct: number; refunded: number; realization_pct?: number | null;
  };
  lead_funnel: InsightSlice[];
  lead_conversion_pct?: number | null;
  status_dist: InsightSlice[];
}

// --- Channel-partner printable statement ---
export interface StatementPolicyRow {
  date?: string | null;
  code: string;
  customer: string;
  category: string;
  premium: number;
  reward: number;
}

export interface StatementTxnRow {
  date: string;
  label: string;
  direction: "in" | "out";
  amount: number;
}

export interface PartnerStatement {
  partner_id: string;
  label: string;
  code?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  opening_balance: number;
  policies: StatementPolicyRow[];
  total_premium: number;
  total_reward: number;
  transactions: StatementTxnRow[];
  total_in: number;
  total_out: number;
  net_balance: number;
}

// --- Balance sheets ---
export type BalanceSheetSection = "broker" | "partner" | "customer";

export interface BalanceSheetItem {
  id: string;
  label: string;
  code?: string | null;
  policies: number;
  premium: number;
  earnings: number;          // the party's own earnings in the window
  profit: number;            // house-profit contribution in the window
  // Agency-receivable view: >0 the party owes us, <0 we owe them.
  net_balance: number;
  outstanding: number;       // legacy alias of net_balance
  wallet_balance?: number | null;
}

export interface CategoryStat {
  key: string;
  label: string;
  policies: number;
  premium: number;
}

export interface ProfileStat {
  id: string;
  label: string;
  code?: string | null;
  policies: number;
  premium: number;
  reward_earned: number;
  reward_received: number;
  reward_to_receive: number;
  house_profit: number;
}

// --- TDS report ---
export interface TdsBrokerRow {
  broker_id: string;
  broker_name?: string | null;
  broker_code?: string | null;
  tds_percent: number;
  entries: number;
  gross_reward: number;
  tds_deducted: number;
}

export interface TdsEntryRow {
  id: string;
  date: string;
  broker_id: string;
  broker_name?: string | null;
  policy_id?: string | null;
  policy_code?: string | null;
  gross_reward: number;
  tds_percent: number;
  tds_deducted: number;
  reference?: string | null;
  note?: string | null;
}

export interface TdsReport {
  date_from?: string | null;
  date_to?: string | null;
  fy_label?: string | null;
  total_gross_reward: number;
  total_tds: number;
  by_broker: TdsBrokerRow[];
  entries: TdsEntryRow[];
}

export interface BalanceSheetDetail {
  section: BalanceSheetSection;
  id: string;
  label: string;
  code?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  total_policies: number;
  renewals: number;
  active_policies: number;
  by_category: CategoryStat[];
  premium: number;
  premium_collected: number;
  reward_earned: number;
  reward_received: number;
  reward_to_receive: number;
  tds_deducted?: number;
  tds_percent?: number | null;   // broker TDS rate (percent*100)
  total_earnings?: number;       // broker: rewards received − TDS
  house_profit: number;
  discount: number;
  refund: number;
  avg_reward_pct?: number | null;
  outstanding: number;
  receivable: number;
  payable: number;
  net_balance: number;
  wallet_balance?: number | null;
  profiles: ProfileStat[];
}

export interface Policy {
  id: string;
  code: string;
  policy_number?: string | null;
  category_key: string;
  subcategory_path: string[];
  subcategory_key?: string | null;
  insurer_id: string;
  insurer_name?: string | null;
  broker_id?: string | null;
  broker_name?: string | null;
  broker_code?: string | null;
  customer_id: string;
  customer_name?: string | null;
  status: PolicyStatus;
  premium_amount: number;
  commissionable_premium: number;
  gst_percent: number;
  sum_insured: number;
  issue_date?: string | null;
  start_date?: string | null;
  expiry_date?: string | null;
  reward: RewardTerms;
  details: Record<string, unknown>;
  reward_base_field: string;
  owner_user_id: string;
  partner_id?: string | null;
  partner_name?: string | null;
  buyer_type: BuyerType;
  payer: PayerType;
  discount_basis: "percent" | "flat";
  discount_value: number;
  notes?: string | null;
  reward_status?: RewardStatus | null;
  created_at: string;
}

export type LeadStage = "new" | "contacted" | "quoted" | "converted" | "lost";

// What kind of prospect a lead is (owner 2026-08-03). Three mutually exclusive
// values: a person who will buy, a company that will buy, or someone who will
// bring business in. Replaces the old individual/business flag.
export type LeadType = "customer" | "channel_partner" | "business";

export const LEAD_TYPES: { value: LeadType; label: string }[] = [
  { value: "customer", label: "Customer" },
  { value: "channel_partner", label: "Channel partner" },
  { value: "business", label: "Business" },
];

export const LEAD_TYPE_LABELS: Record<LeadType, string> = {
  customer: "Customer",
  channel_partner: "Channel partner",
  business: "Business",
};
export type RecordOrigin = "inhouse" | "channel_partner";

export interface LeadComment {
  author_id: string;
  author_name: string;
  author_role?: string | null;
  body: string;
  internal: boolean;
  created_at: string;
}

// The soonest open follow-up on a lead, for the list's Reminders column.
// is_overdue / is_due_today are decided server-side against the IST day —
// never re-derive them in the browser (see lib/reminderTiming).
export interface LeadReminderSummary {
  id: string;
  title: string;
  due_at: string;
  is_overdue: boolean;
  is_due_today: boolean;
  open_count: number;
}

export interface LeadTypeCount {
  type: LeadType;
  count: number;
}

export interface LeadCounts {
  total: number;
  by_type: LeadTypeCount[];
}

export interface Lead {
  id: string;
  code: string;
  type: LeadType;
  name: string;
  mobile_country_code: string;
  mobile?: string | null;
  email?: string | null;
  address?: string | null;
  interested_in?: string | null;
  category_key?: string | null;
  estimated_premium?: number | null;
  source?: string | null;
  stage: LeadStage;
  lost_reason?: string | null;
  converted_customer_id?: string | null;
  converted_policy_id?: string | null;
  comments: LeadComment[];
  last_comment?: string | null;
  note?: string | null;
  origin: RecordOrigin;
  owner_user_id: string;
  partner_id?: string | null;
  created_by?: string | null;
  created_by_name?: string | null;
  can_edit: boolean;
  next_reminder?: LeadReminderSummary | null;
  created_at: string;
}

export interface AssignableColleague {
  id: string;
  full_name: string;
  email?: string | null;
  account_type: string;
}

export interface LeadImportResult {
  total: number;
  created: number;
  failed: { row: number; reason: string }[];
  detail: string;
}

export type RewardStatus =
  | "pending" | "received" | "paid_out" | "cancelled"
  | "rejected" | "not_eligible" | "zero_pct" | "refunded";

export interface Reward {
  id: string;
  policy_id: string;
  policy_code?: string | null;
  insurer_id: string;
  customer_id: string;
  customer_name?: string | null;
  category_key?: string | null;
  subcategory_key?: string | null;
  premium_amount: number;
  commissionable_premium: number;
  agency_amount?: number | null;  // hidden for channel partners
  partner_amount: number;
  house_amount?: number | null;
  status: RewardStatus;
  received_at?: string | null;
  paid_out_at?: string | null;
  reference?: string | null;
  owner_user_id: string;
  partner_id?: string | null;
  created_at: string;
}

// One node in a policy type's nested sub-type tree (recursive).
export interface CategoryNode {
  key: string;
  label: string;
  active: boolean;
  children: CategoryNode[];
}

// The kinds of custom field an admin can configure on a policy type.
export type CustomFieldType =
  | "text" | "textarea" | "number" | "amount" | "date" | "select"
  | "multi_select" | "checkbox" | "phone" | "email" | "url";

// One admin-configured field collected when booking a policy of a given type.
export interface CustomFieldSpec {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: string[];               // select / multi_select
  hint?: string | null;
  min_value?: number | null;       // number / amount (natural unit: ₹ for amount)
  max_value?: number | null;
  is_reward_base: boolean;         // amount fields usable as the "Comm On" base
}

export interface RequiredDocSpec {
  key: string;
  label: string;
  required: boolean;
  accepts: string[];
}

// Sentinel reward-base value meaning "the commissionable premium".
export const COMMISSIONABLE_BASE = "commissionable";

export interface PolicyCategory {
  id: string;
  key: string;
  label: string;
  description?: string | null;
  children: CategoryNode[];
  custom_fields: CustomFieldSpec[];
  required_documents: RequiredDocSpec[];
  // Documents to collect when a CLAIM is raised on this type (motor: FIR,
  // photos, estimate; health: discharge summary, bills). Same spec shape as
  // the booking documents and configured on the same page — owner C3 wanted
  // one mechanism, not two. Read by the portal's claim checklist and the staff
  // claim screen.
  claim_documents: RequiredDocSpec[];
  reward_base_field: string;       // COMMISSIONABLE_BASE or an amount field key
  active: boolean;
  // Set by the server: a policy or rate-card rule names this type, so it can
  // only be deactivated. Policies reference the KEY, not the id.
  in_use: boolean;
  sort_order: number;
}

// --- Wallet & withdrawals ---
export interface Wallet {
  partner_id: string;
  available_paise: number;
  pending_paise: number;
  lifetime_earned_paise: number;
  lifetime_withdrawn_paise: number;
}

export interface WalletTxn {
  id: string;
  type: string;
  amount_paise: number;
  balance_after_paise: number;
  note?: string | null;
  ref_type?: string | null;
  ref_id?: string | null;
  created_at: string;
}

export type WithdrawalStatus = "requested" | "approved" | "paid" | "rejected";

export interface Withdrawal {
  id: string;
  code: string;
  partner_id: string;
  partner_name?: string | null;
  partner_code?: string | null;
  amount_paise: number;
  status: WithdrawalStatus;
  note?: string | null;
  reference?: string | null;
  reject_reason?: string | null;
  processed_by?: string | null;
  processed_at?: string | null;
  requested_at: string;
}

export type TargetMetric = "policies" | "premium" | "house_profit" | "renewals";
// Targets are monthly only (owner 2026-07-26). The other values survive in the
// type so an old stored target still parses; nothing creates them any more.
export type TargetPeriod = "month" | "quarter" | "year";

// The dashboard tile's window: this month, one of the two before it, or all
// three added together.
export type TargetWindow = "current" | "prev1" | "prev2" | "last3";

// GET /api/targets/progress — an employee's own month, or (for the owner) the
// whole team's combined position. Already filtered for the viewer.
export interface TargetProgress {
  scope: "self" | "team";
  window: TargetWindow;
  label: string;
  period_start: string;
  period_end: string;
  has_target: boolean;
  metrics: TargetMetricRow[];
  attainment_pct: number;
  people_with_target: number;
  people: number;
}

// A target carries SEVERAL metrics at once — "15 policies and Rs 2,500 profit
// for July" is one target, not two (owner, 2026-07-26). Only the metrics that
// were actually given a number appear in `metrics`.
export interface TargetMetricRow {
  metric: TargetMetric;
  label: string;
  is_money: boolean;
  target_value: number;
  actual_value: number;
  attainment_pct: number;
}

export interface Target {
  id: string;
  assignee_type: string;
  assignee_id: string;
  assignee_name?: string | null;
  period: TargetPeriod;
  period_start: string;
  period_end: string;
  period_label: string;
  metrics: TargetMetricRow[];
  attainment_pct: number;   // headline: house profit if set, else the average
  note?: string | null;
  created_at: string;
}

// One person on the performance leaderboard.
export interface PerformanceRow {
  assignee_id: string;
  assignee_type: string;
  name: string;
  code?: string | null;
  policies: number;
  renewals: number;
  premium: number;
  profit: number;
  has_target: boolean;
  target_id?: string | null;
  attainment_pct: number;
  metrics: TargetMetricRow[];
  score: number;
  rank: number;
}

export interface PerformanceReport {
  period: TargetPeriod;
  period_start: string;
  period_end: string;
  period_label: string;
  rows: PerformanceRow[];
  totals: { policies?: number; renewals?: number; premium?: number;
            profit?: number };
  with_target: number;
  on_track: number;
}

export interface TargetTrendPoint {
  key: string;
  label: string;
  actual: number;
  target: number;
  attainment_pct: number;
}

// Backs the Analytics popup on the Employees / Channel Partners pages.
export interface AssigneeAnalytics {
  assignee_id: string;
  assignee_type: string;
  name: string;
  code?: string | null;
  metric: TargetMetric;
  period_label: string;
  policies: number;
  renewals: number;
  premium: number;
  profit: number;
  partner_payout: number;
  attainment_pct: number;
  has_target: boolean;
  metrics: TargetMetricRow[];
  trend: TargetTrendPoint[];
  top_categories: { key: string; label: string; policies: number;
                    premium: number; profit: number }[];
}

export interface AnalyticsMetrics {
  policies: number;
  premium: number;
  commissionable: number;
  agency_reward: number;
  partner_payout: number;
  house: number;
}
export interface AnalyticsGroup extends AnalyticsMetrics {
  key: string;
  label: string;
}
export interface AnalyticsResult {
  group_by: string;
  totals: AnalyticsMetrics;
  groups: AnalyticsGroup[];
}

export interface RenewalSummary {
  due_30d: number;
  due_30d_premium: number;
  renewed_window: number;
  lapsed_window: number;
  renewal_rate?: number | null;
  window_days: number;
}

export interface DashboardStats {
  // Null whenever the caller lacks the flag that governs the figure: the
  // counts need view_policies, the reward totals view_finance. The server
  // omits them rather than sending a number the UI then has to hide.
  customers?: number | null;
  active_policies?: number | null;
  leads_open?: number | null;
  renewals_due_30d?: number | null;
  new_business_premium_mtd?: number | null;
  reward_pending?: number | null;
  reward_received?: number | null;
  agency_profit_mtd?: number | null;
  partner_earnings?: number | null;
  wallet_available?: number | null;
  wallet_pending?: number | null;
  policies_total?: number | null;
  policies_mtd?: number | null;
  net_profit_mtd?: number | null;
  unrealised_profit?: number | null;
  pending_to_collect?: number | null;
  pending_to_pay?: number | null;
  growth_policies_pct?: number | null;
  growth_earning_pct?: number | null;
}

// --- Third Party Services (owner settings) ---
export interface WhatsAppSettings {
  enabled: boolean;
  send_policy_on_create_customer: boolean;
  send_policy_on_create_partner: boolean;
  renewal_reminders_customers: boolean;
  renewal_reminders_partners: boolean;
  customer_send_scope: "all" | "inhouse" | "channel_partner";
  tpl_policy_customer: string;
  tpl_policy_partner: string;
  tpl_statement_partner: string;
  tpl_renewal_customer: string;
  tpl_renewal_partner: string;
  default_lang: string;
}
export interface EmailSettings { enabled: boolean; }
export interface ServiceStatus {
  key: string; label: string; configured: boolean; detail: string;
}
export interface ServiceSettings {
  whatsapp: WhatsAppSettings;
  email: EmailSettings;
  // The Channel Partner portal's master switch and capability list. `enabled:
  // false` locks every partner out immediately — it is checked on every
  // request, not just at login.
  partner_portal: PortalCapabilities;
  // Attendance & leave policy. Rides this payload because SystemSettings is one
  // document server-side; edited on its own owner-only page at
  // /settings/attendance.
  hr: HrSettings;
  whatsapp_credentials_ready: boolean;
  services: ServiceStatus[];
}

/* ============================================================== workplace HR ==
   Attendance, leave and holidays (2026-08-20).

   NOTHING IN THIS SECTION IS MONEY, and that is a rule rather than an oversight
   (owner 2026-08-20): payslips were designed and dropped in the same
   conversation. The module records days and hours; the salary sits on the
   employee's profile and is worked out by hand from `AttendanceSummary`.
   `hrModule.test.ts` fails if a rupee-shaped field appears here.
   ========================================================================== */

export interface HrSettings {
  // Python weekday(): Monday=0 ... Sunday=6. Sunday only, by default — the
  // agency works Monday to Saturday.
  week_off_days: number[];
  shift_start: string;              // "HH:MM", IST
  shift_end: string;
  late_grace_minutes: number;
  early_out_grace_minutes: number;
  full_day_minutes: number;
  half_day_minutes: number;
  max_break_minutes: number;
  late_marks_per_penalty: number;
  late_penalty_days: number;        // DAYS off the payable count, never rupees
  monthly_leave_accrual: number;
  max_leave_balance: number;
  leave_year_start_month: number;
  missing_punch_nudge_minutes: number;

  // --- Where the punch came from (owner 2026-08-21) ---
  // Still not money: a coordinate and a radius in metres.
  geofence_enabled: boolean;
  office_label: string;
  office_lat: number;
  office_lng: number;
  office_radius_m: number;
  // A reading vaguer than this cannot place somebody inside the circle, so it
  // is recorded as `unknown` rather than guessed at.
  max_accuracy_m: number;
  unknown_counts_as_office: boolean;
  require_location: boolean;

  // --- The correction window before pay locks (owner 2026-09-06) ---
  // Still not money: a count of WORKING days the attendance register stays open
  // after a month ends, before its draft payslips finalise themselves. 0 = off,
  // which leaves finalising entirely manual.
  payroll_auto_finalise_days: number;
}

/** Where a day was worked. A separate fact from how LONG it was worked. */
export type WorkLocation = "office" | "remote" | "unknown";

// Every state a day can be in. `not_marked` is deliberately distinct from
// `absent`: "we have not been told" and "they did not come" are different
// facts, and only the second one costs somebody anything.
export type AttendanceStatus =
  | "present" | "half_day" | "absent" | "on_leave" | "leave_unpaid"
  | "week_off" | "holiday" | "wfh" | "not_marked";

export type HrRequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type LeaveDayPart = "full" | "first_half" | "second_half";
export type LeaveReasonType =
  | "sick" | "personal" | "travel" | "emergency" | "other";

export interface AttendanceBreak {
  start: string;
  end?: string | null;
  auto_closed?: boolean;
}

/** What the punch panel draws itself from. */
export interface PunchState {
  day: string;                      // "YYYY-MM-DD", IST
  // The SERVER's clock. The running counter is drawn from this, not from the
  // browser's: a laptop eleven minutes fast would otherwise show eleven minutes
  // of work that the register does not have.
  server_now: string;
  clock_in?: string | null;
  clock_out?: string | null;
  on_break: boolean;
  break_started_at?: string | null;
  breaks: AttendanceBreak[];
  worked_minutes: number;
  break_minutes: number;
  status: AttendanceStatus;
  is_late: boolean;
  late_minutes: number;
  is_week_off: boolean;
  holiday_name?: string | null;
  on_leave: boolean;
  leave_code?: string | null;
  shift_start: string;
  shift_end: string;
  // False for the owner and for channel partners — they do not clock in.
  can_punch: boolean;

  // --- Where (owner 2026-08-21) ---
  work_location?: WorkLocation | null;
  distance_m?: number | null;
  geofence: GeofenceInfo;
}

/**
 * What the tile needs to know BEFORE the button is pressed — chiefly whether to
 * ask the browser for a location at all. Prompting for one when no geofence is
 * configured is a permission dialog with no purpose behind it.
 */
export interface GeofenceInfo {
  enabled: boolean;
  office_label: string;
  office_lat?: number | null;
  office_lng?: number | null;
  radius_m: number;
  /** The owner has chosen to refuse a punch with no location at all. */
  required: boolean;
}

export interface AttendanceDay {
  day: string;
  weekday: number;                  // Monday=0 ... Sunday=6
  status: AttendanceStatus;
  clock_in?: string | null;
  clock_out?: string | null;
  worked_minutes: number;
  break_minutes: number;
  is_late: boolean;
  late_minutes: number;
  is_early_out: boolean;
  early_out_minutes: number;
  missed_punch_out: boolean;
  holiday_name?: string | null;
  leave_id?: string | null;
  leave_code?: string | null;
  leave_reason?: string | null;
  // Came in on a day they had approved leave for. The balance goes back
  // automatically; this is what says so on screen.
  leave_worked: boolean;
  note?: string | null;
  source?: string | null;
  edited_by_name?: string | null;
  edit_reason?: string | null;
  record_id?: string | null;
  is_future: boolean;
}

/** The month in DAYS and HOURS — the figures pay is worked out from by hand. */
export interface AttendanceSummary {
  total_days: number;
  present: number;
  wfh: number;
  half_days: number;
  absent: number;
  on_leave: number;
  leave_unpaid: number;
  week_offs: number;
  holidays: number;
  not_marked: number;
  late_marks: number;
  late_penalty_days: number;
  worked_minutes: number;
  worked_hours: number;
  // calendar days − absent − unpaid leave − half-day shortfall − late penalty.
  // The number a manager multiplies by the salary themselves.
  payable_days: number;
  // Missed punch-outs and past days that never resolved. Clear these before
  // doing the month's arithmetic.
  unresolved_days: number;
}

export interface AttendanceMonth {
  month: string;
  user_id: string;
  user_name: string;
  days: AttendanceDay[];
  summary: AttendanceSummary;
}

export interface TeamMemberDay {
  user_id: string;
  name: string;
  code: string;
  designation?: string | null;
  status: AttendanceStatus;
  clock_in?: string | null;
  clock_out?: string | null;
  worked_minutes: number;
  is_late: boolean;
  late_minutes: number;
  on_break: boolean;
  missed_punch_out: boolean;
  leave_code?: string | null;
}

export interface TeamDay {
  day: string;
  is_week_off: boolean;
  holiday_name?: string | null;
  members: TeamMemberDay[];
  // Counted server-side so the tiles and the rows under them cannot disagree.
  in_count: number;
  late_count: number;
  leave_count: number;
  absent_count: number;
  not_in_count: number;
}

export interface TeamMonthRow {
  user_id: string;
  name: string;
  code: string;
  designation?: string | null;
  days: AttendanceDay[];
  summary: AttendanceSummary;
}

export interface TeamMonth {
  month: string;
  rows: TeamMonthRow[];
}

export interface AttendanceCorrection {
  id: string;
  user_id: string;
  user_name: string;
  day: string;
  requested_clock_in?: string | null;
  requested_clock_out?: string | null;
  reason: string;
  status: HrRequestStatus;
  decided_by_name?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
  created_at: string;
}

export interface LeaveRequest {
  id: string;
  code: string;
  user_id: string;
  user_name: string;
  start_date: string;
  end_date: string;
  day_part: LeaveDayPart;
  reason_type: LeaveReasonType;
  reason: string;
  days: number;
  // Decided ONCE at approval and frozen. A request that said "1 paid, 1 unpaid"
  // in August must still say that in November, whatever the balance did since.
  paid_days: number;
  unpaid_days: number;
  status: HrRequestStatus;
  on_behalf: boolean;
  applied_by_name?: string | null;
  decided_by_name?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
  is_backdated: boolean;
  created_at: string;
  // Derived server-side, so three screens cannot disagree about whether a
  // request is still yours to withdraw.
  can_cancel: boolean;
  can_edit: boolean;
}

/** Days, and only days. */
export interface LeaveBalance {
  user_id: string;
  user_name: string;
  leave_year: number;
  leave_year_label: string;
  opening: number;
  accrued: number;
  used: number;
  refunded: number;
  adjusted: number;
  lapsed: number;
  available: number;
  monthly_accrual: number;
  max_balance: number;
  // Asked for and not yet decided. Shown BESIDE the balance, never subtracted
  // from it — a pending request reserves nothing.
  pending_days: number;
}

export interface LeaveLedgerRow {
  id: string;
  entry_type: "opening" | "accrual" | "usage" | "refund" | "adjustment"
    | "lapse";
  days: number;
  note: string;
  ref_id?: string | null;
  created_by_name?: string | null;
  created_at: string;
}

/** What the form shows before you submit. Going short is allowed, and never a
    surprise. */
export interface LeaveCostPreview {
  days: number;
  working_days: string[];
  skipped_days: string[];           // week offs and holidays inside the range
  available: number;
  paid_days: number;
  unpaid_days: number;
  is_backdated: boolean;
  conflict?: string | null;
}

/** Names and dates only — never the reason. */
export interface WhoIsOff {
  user_id: string;
  name: string;
  start_date: string;
  end_date: string;
  day_part: LeaveDayPart;
}

export interface Holiday {
  id: string;
  date: string;
  year: number;
  name: string;
  note?: string | null;
  is_past: boolean;
  weekday: number;
  // A holiday on a Sunday changes nothing. Saying so on the row stops somebody
  // adding it twice wondering why it had no effect.
  falls_on_week_off: boolean;
}

export interface HolidayYear {
  year: number;
  holidays: Holiday[];
  // Offered only on an EMPTY year. Suggestions the owner accepts, never rows
  // that appeared by themselves — nothing in this app is seeded.
  suggestions: { date: string; name: string; note?: string | null }[];
  week_off_days: number[];
}

// --- Customer contribution stats (detail view) ---
export interface CustomerStats {
  total_policies: number;
  active_policies: number;
  total_premium: number;
  renewal_rate?: number | null;
  profit_contribution?: number | null;
  can_view_profit: boolean;
  source: string;
}

// --- Staff lead-activity summary ---
export interface LeadActivityRow {
  user_id: string;
  user_name: string;
  leads_created: number;
  leads_updated: number;
  leads_converted: number;
  active_days: number;
}

export interface CustomerImportResult {
  total: number;
  created: number;
  failed: { row: number; reason: string }[];
  detail: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor_id?: string | null;
  actor_name?: string | null;
  actor_role?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  entity_code?: string | null;
  summary: string;
  meta: Record<string, unknown>;
  ip_address?: string | null;
  created_at: string;
}

// --- System observability (owner-only) ---
export interface ApiServiceTotals {
  service: string;
  calls: number;
  errors: number;
  units: number;
  bytes_transferred: number;
  cost_paise: number;
  avg_duration_ms: number;
}
export interface ApiUsageSummary {
  date_from: string;
  date_to: string;
  total_calls: number;
  total_errors: number;
  total_cost_paise: number;
  by_service: ApiServiceTotals[];
  daily: { day: string; calls: number; cost_paise: number }[];
}
export interface ApiCallRow {
  id: string;
  service: string;
  operation: string;
  success: boolean;
  units: number;
  bytes_transferred: number;
  cost_paise: number;
  duration_ms: number;
  error?: string | null;
  created_at: string;
}
export interface ErrorRow {
  id: string;
  ref: string;
  method?: string | null;
  path?: string | null;
  exc_type?: string | null;
  message: string;
  actor_id?: string | null;
  ip_address?: string | null;
  created_at: string;
}
export interface HealthStrip {
  errors_today: number;
  emails_failed_today: number;
  api_calls_today: number;
  api_cost_today_paise: number;
  overdue_renewals: number;
}
export interface SearchHit {
  type: "customer" | "policy" | "lead" | "person" | "log";
  id: string;
  label: string;
  sub: string;
  link: string;
  // A POLICY THAT EXISTS AND THAT YOU MAY NOT OPEN (owner 2026-08-24).
  //
  // The one place in the app that admits a record exists to somebody who
  // cannot read it, and that admission IS the feature: a scoped system with no
  // way to discover what you are missing is one where people ring each other
  // up. The server sends the code, the number and who holds it — nothing else —
  // and `link` points at the request flow rather than at the record.
  locked?: boolean;
}

// The permission model, mirroring server/app/core/permissions.py.
//
// ONE PAIR PER NAVIGABLE SECTION (2026-08-07). `view_x` opens a page, `manage_x`
// adds create + edit + delete inside it. Ticking Manage ticks View (see
// PERMISSION_IMPLIES, enforced again server-side), so a half-granted
// combination cannot be produced from the editor or the API.
//
// The shape is a GROUP of SECTIONS rather than a flat list of flags, because 42
// checkboxes in a column is the screen the owner rejected in the first place. A
// section is one row with a View box and (usually) a Manage box.
//
// The server also serves this catalogue at GET /api/roles/catalog with help
// text; the editor prefers that copy and falls back to this one so the screen
// still renders if the request fails.
export interface PermissionSection {
  name: string;
  view: string;
  /** Absent for a flag that is not a page — export, audit, sensitive PII. */
  manage?: string;
  help: string;
}
export interface PermissionGroup {
  group: string;
  hint: string;
  sections: PermissionSection[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    group: "Work",
    hint: "The day-to-day book of business. Each page is grantable on its " +
          "own — renewals without the rest of the book, for example.",
    sections: [
      { name: "Leads", view: "view_leads", manage: "manage_leads",
        help: "The pipeline: enquiries, follow-ups and reminders." },
      { name: "Customers", view: "view_customers", manage: "manage_customers",
        help: "Customer records and their contact details." },
      { name: "Policies", view: "view_policies", manage: "manage_policies",
        help: "Booking, editing and cancelling policies, and the documents " +
              "attached to them." },
      { name: "The whole book", view: "view_all_policies",
        help: "Without this, Policies shows only what this person booked plus " +
              "what the channel partners on their roster booked. With it, " +
              "every policy in the agency. Moving a partner to another " +
              "manager moves their policies with them, automatically." },
      { name: "Approve access requests", view: "manage_policy_access",
        help: "Grant a colleague temporary sight of a policy that is not " +
              "theirs. Access expires on its own." },
      { name: "Renewals", view: "view_renewals", manage: "manage_renewals",
        help: "Only the expiring book, not the whole of it. Manage adds " +
              "renewing a policy." },
      { name: "Quote requests", view: "view_quotes", manage: "manage_quotes",
        help: "Requests raised by channel partners. Manage adds replying, " +
              "quoting and marking one booked." },
      { name: "Claims", view: "view_claims", manage: "manage_claims",
        help: "Claims raised on policies. Manage adds moving a claim through " +
              "its stages." },
    ],
  },
  {
    group: "Money",
    hint: "Cash, balances and tax. Agency profit is separate on purpose — " +
          "someone can run the money without seeing the margin.",
    sections: [
      { name: "Transactions", view: "view_transactions",
        manage: "manage_transactions",
        help: "The cash ledger. Manage adds recording receipts and payouts, " +
              "and correcting them." },
      { name: "Finance overview", view: "view_finance_overview",
        help: "The Finance Overview page — the agency's money at a glance." },
      { name: "Balance sheet", view: "view_balance_sheet",
        help: "Who owes whom: party balances, receivable and payable, and " +
              "the statement PDFs." },
      { name: "TDS", view: "view_tds", manage: "manage_tds",
        help: "Tax deducted at source. Manage adds editing TDS rates and " +
              "entries." },
      { name: "Bank & cash accounts", view: "view_bank_accounts",
        manage: "manage_bank_accounts",
        help: "The agency's own accounts and what is actually in them. " +
              "Manage adds transfers and reconciliation." },
      { name: "Agency / net profit", view: "view_agency_profit",
        help: "House profit wherever it appears. Without it the server blanks " +
              "the figure — it is not merely hidden." },
    ],
  },
  {
    group: "Catalog",
    hint: "The rules behind the money. Rate cards decide what the agency " +
          "earns and what a partner is paid — grant that one last.",
    sections: [
      { name: "Insurers", view: "view_insurers", manage: "manage_insurers",
        help: "The insurer list and the agency's codes with each." },
      { name: "Brokers", view: "view_brokers", manage: "manage_brokers",
        help: "Brokers, their codes and their TDS settings." },
      { name: "Policy types", view: "view_policy_types",
        manage: "manage_policy_types",
        help: "Categories, their custom fields and their document checklists." },
      { name: "Rate cards", view: "view_rate_cards", manage: "manage_rate_cards",
        help: "Commission and partner-share rates. Manage changes what every " +
              "future policy pays." },
    ],
  },
  {
    group: "People",
    hint: "Staff and channel partners are separate populations — an agency's " +
          "partner manager has no business in staff records.",
    sections: [
      { name: "Employees", view: "view_employees", manage: "manage_employees",
        help: "The staff directory. Manage adds adding, editing, " +
              "deactivating and resetting passwords." },
      { name: "Channel partners", view: "view_partners",
        manage: "manage_partners",
        help: "Every partner. Without it an employee still sees the partners " +
              "they personally manage — that is the job, not a privilege." },
      { name: "Partner notices", view: "view_announcements",
        manage: "manage_announcements",
        help: "Broadcasts to channel partners. A notice reaches their portal " +
              "and their email, and cannot be recalled." },
      { name: "Targets", view: "view_targets", manage: "manage_targets",
        help: "Everyone always sees their own. These cover other people's " +
              "targets and attainment." },
      { name: "Roles & permissions", view: "manage_roles_permissions",
        help: "Decide what everyone else can reach. Nobody can grant a " +
              "permission they do not hold themselves." },
    ],
  },
  {
    group: "Workplace HR",
    hint: "Attendance, leave and the holiday calendar. Everybody always " +
          "reaches their OWN attendance, their own leave and the holiday " +
          "list without any of these — these cover other people's.",
    sections: [
      { name: "Attendance", view: "view_attendance",
        manage: "manage_attendance",
        help: "Everyone's attendance register and the daily board. Manage " +
              "adds editing any day and approving correction requests." },
      { name: "Leave", view: "view_leave", manage: "manage_leave",
        help: "Everyone's leave and their balances. Manage adds approving, " +
              "rejecting and adjusting a balance." },
      { name: "Holidays", view: "view_holidays", manage: "manage_holidays",
        help: "The yearly holiday list. Manage adds declaring a day off, " +
              "which changes the attendance of the whole agency." },
      { name: "Payslips", view: "view_payslips", manage: "manage_payslips",
        help: "Everybody always sees their own. This covers other people's. " +
              "Manage adds regenerating a draft, finalising a month and " +
              "recording the payment." },
      { name: "Salary figures", view: "view_salary",
        help: "The monthly salary on an employee's profile. Without it the " +
              "server strips the figure — it is not merely hidden. It is what " +
              "a payslip is worked out from." },
    ],
  },
  {
    group: "Reports & compliance",
    hint: "Analytics, downloads and the audit trail.",
    sections: [
      { name: "Reports", view: "view_reports",
        help: "Open the Reports pages and the analytics on them." },
      { name: "Export data", view: "export_data",
        help: "Download any list or report as Excel or PDF. Separate from " +
              "reading it: taking data out of the building is its own " +
              "decision." },
      { name: "Audit log", view: "view_audit_logs",
        help: "Read the trail of who changed what." },
      { name: "Sensitive details", view: "view_sensitive_pii",
        help: "Unmask PAN, Aadhaar, bank account, IFSC and UPI values." },
    ],
  },
];

// manage -> the view flags it implies. Mirrors IMPLIES in permissions.py.
export const PERMISSION_IMPLIES: Record<string, string[]> = {
  manage_leads: ["view_leads"],
  manage_customers: ["view_customers"],
  manage_policies: ["view_policies"],
  manage_renewals: ["view_renewals"],
  manage_quotes: ["view_quotes"],
  manage_claims: ["view_claims"],
  manage_transactions: ["view_transactions"],
  manage_tds: ["view_tds"],
  manage_bank_accounts: ["view_bank_accounts"],
  manage_insurers: ["view_insurers"],
  manage_brokers: ["view_brokers"],
  manage_policy_types: ["view_policy_types"],
  manage_rate_cards: ["view_rate_cards"],
  manage_employees: ["view_employees"],
  manage_partners: ["view_partners"],
  manage_announcements: ["view_announcements"],
  manage_targets: ["view_targets"],
  manage_roles_permissions: ["view_employees"],
  manage_attendance: ["view_attendance"],
  manage_leave: ["view_leave"],
  manage_holidays: ["view_holidays"],
  manage_payslips: ["view_payslips"],
  // Seeing the whole book is meaningless without the page it widens; granting
  // one without the other produces a Policies section that is invisible and
  // unrestricted at the same time.
  view_all_policies: ["view_policies"],
  // Deciding "may Ravi read POL-123" while unable to open POL-123 is
  // rubber-stamping a code.
  manage_policy_access: ["view_policies", "view_all_policies"],
};

// Add every implied flag. Used by the editor so ticking "Manage" visibly ticks
// "View" instead of letting you save a set the server would silently widen.
export function expandPermissions(perms: string[]): string[] {
  const held = new Set(perms);
  for (const [flag, implied] of Object.entries(PERMISSION_IMPLIES)) {
    if (held.has(flag)) implied.forEach((p) => held.add(p));
  }
  return [...held];
}

// Removing a "view" must also remove the "manage" that depends on it —
// otherwise unticking View looks like it did nothing (the server re-adds it).
export function revokePermission(perms: string[], key: string): string[] {
  const dropped = new Set([key]);
  for (const [flag, implied] of Object.entries(PERMISSION_IMPLIES)) {
    if (implied.includes(key)) dropped.add(flag);
  }
  return perms.filter((p) => !dropped.has(p));
}

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: string[];
}



/* ------------------------------------------------------- bank accounts -- */

// A credit card is a LIABILITY: spending makes the balance more negative, and
// it is reported apart from cash so "cash in hand" is never understated.
export type BankAccountType = "bank" | "cash" | "upi" | "credit_card";

export interface BankAccount {
  id: string;
  name: string;
  account_type: BankAccountType;
  bank_name?: string | null;
  account_number?: string | null;   // masked unless you hold view_sensitive_pii
  account_last4?: string | null;
  ifsc?: string | null;
  upi_id?: string | null;
  opening_balance_paise: number;
  opening_as_of?: string | null;
  balance_paise: number;
  total_in_paise: number;
  total_out_paise: number;
  last_txn_at?: string | null;
  is_default: boolean;
  active: boolean;
  is_cash_asset: boolean;
  note?: string | null;
  period_in_paise: number;
  period_out_paise: number;
  /** When this was last checked against the real account. null = never. */
  last_reconciled_at?: string | null;
  /** How far out it was at that check. 0 = it agreed with the bank. */
  last_reconciled_diff_paise?: number | null;
}

/* ------------------------------------------- bank statement bulk import -- */

/** One normalised line of an uploaded statement. Nothing here is a decision. */
export interface StatementPreviewRow {
  line: number;
  /** ISO date, or null when the date column could not be read. */
  occurred_on?: string | null;
  description: string;
  reference: string;
  amount_paise: number;
  /** From the FILE, and not editable: if the bank says it left, it left. */
  direction: "in" | "out" | "";
  /** Why this row cannot be used. Shown and skipped, never dropped silently. */
  problem?: string | null;
  /** An existing transaction that looks like this one. A warning, not a block. */
  duplicate_of?: string | null;
  duplicate_note?: string | null;
  /** Words pulled out of the narration, to seed the party search. Advisory. */
  suggested_terms: string[];
}

export interface StatementPreview {
  columns: string[];
  /** What each column was guessed / confirmed to mean. */
  mapping: Record<string, string | null>;
  sample: string[][];
  rows: StatementPreviewRow[];
  total_rows: number;
  truncated: boolean;
  readable: number;
  duplicates: number;
}

// What a person decided about one imported line.
//
// "pending" REPLACED "skip" AS THE DEFAULT (owner 2026-08-24). A skipped row
// used to be counted and then thrown away with the browser tab, which is right
// for a line that genuinely is not ours and wrong for the common case — "I do
// not know what this Rs 12,400 was, I will find out". A pending row is PARKED:
// it becomes a PendingTxn and is finished later from the Pending list.
//
// `skip` survives, because the importer defaults a row it believes is already
// recorded to "leave it alone", and that is a decision rather than an
// unanswered question.
export type StatementAction = "party" | "expense" | "pending" | "skip";

export interface StatementCommitRow {
  line: number;
  occurred_on: string;
  amount_paise: number;
  direction: string;
  reference?: string | null;
  note?: string | null;
  /** Carried back so a PARKED row keeps the only description it will ever
   *  have — the file is gone the moment the tab closes. */
  description?: string | null;
  duplicate_of?: string | null;
  duplicate_note?: string | null;
  suggested_terms?: string[];
  action: StatementAction;
  party_type?: PartyType;
  party_id?: string;
  expense_category?: string;
  policy_id?: string;
  txn_type?: string;
  idempotency_key?: string;
}

export interface StatementCommit {
  bank_account_id: string;
  rows: StatementCommitRow[];
  /** Both are for the PARKED rows: months later, "which statement was this
   *  from" is the first question anybody asks about one. */
  source_file?: string;
  import_batch_id?: string;
}

export interface StatementCommitResult {
  imported: number;
  /** Held for later, not thrown away. Counted apart from `skipped` because
   *  they mean opposite things: work outstanding vs work deliberately not
   *  done. */
  pending: number;
  skipped: number;
  failed: { line: number; reason: string }[];
  detail: string;
}

/* ------------------------------------------- pending transactions (2026-08-24) */

export type PendingTxnStatus = "pending" | "recorded" | "discarded";

// A statement line somebody parked instead of deciding.
//
// Nothing here is in the ledger, in a balance or in a report — it is a to-do
// list that happens to be shaped like money. Every field except `note` is the
// BANK's and is not editable, direction included: if the statement says the
// money left, it left.
export interface PendingTxn {
  id: string;
  bank_account_id: string;
  bank_account_name: string;
  import_batch_id: string;
  source_file: string;
  occurred_on: string;
  description: string;
  reference: string;
  amount_paise: number;
  direction: "in" | "out" | "";
  source_line: number;
  duplicate_of?: string | null;
  duplicate_note?: string | null;
  suggested_terms: string[];
  /** The note whoever parked it left themselves. The one editable field. */
  note?: string | null;
  status: PendingTxnStatus;
  created_at: string;
  created_by_name?: string | null;
  resolved_txn_id?: string | null;
  resolved_by_name?: string | null;
  discarded_by_name?: string | null;
  discard_reason?: string | null;
}

/** One import, summarised. A person works a FILE, not forty unrelated rows. */
export interface PendingBatch {
  import_batch_id: string;
  source_file: string;
  bank_account_id: string;
  bank_account_name: string;
  open_count: number;
  net_paise: number;
  first_date: string;
  last_date: string;
}

export interface PendingTxnList {
  items: PendingTxn[];
  total: number;
  /** ALWAYS the open count, whatever filter is in force — otherwise the badge
   *  goes to zero the moment somebody looks at the discarded rows. */
  open_count: number;
  /** Reported separately, never netted: a Rs 50,000 receipt and a Rs 50,000
   *  payment net to zero, which would read as "nothing outstanding". */
  in_paise: number;
  out_paise: number;
  batches: PendingBatch[];
}

export interface PendingResolveRow {
  id: string;
  action: "party" | "expense";
  party_type?: PartyType;
  party_id?: string;
  expense_category?: string;
  policy_id?: string;
  txn_type?: string;
  reference?: string | null;
  note?: string | null;
  idempotency_key?: string;
}

export interface PendingResolveResult {
  recorded: number;
  failed: { id: string; reason: string }[];
  detail: string;
}

export interface BankTotals {
  cash_in_hand: number;
  credit_outstanding: number;   // positive = owed on cards
  accounts: number;
}

export interface BankAccountList {
  totals: BankTotals;
  items: BankAccount[];
}

/**
 * The outcome of reconciling an account against the real bank balance.
 *
 * `adjusted` is false when the account already agreed — nothing was written,
 * because a ledger full of zero-value adjustments is a ledger people stop
 * reading. `difference_paise` is positive when we were SHORT (the bank holds
 * more than we thought).
 */
export interface BankReconcileResult {
  account_id: string;
  difference_paise: number;
  adjusted: boolean;
  balance_paise: number;
  previous_balance_paise: number;
}

export interface TransferResult {
  from_account_id: string;
  to_account_id: string;
  amount_paise: number;
  from_balance_paise: number;
  to_balance_paise: number;
}

export const BANK_ACCOUNT_TYPES: { value: BankAccountType; label: string }[] = [
  { value: "bank", label: "Bank account" },
  { value: "cash", label: "Cash in hand" },
  { value: "upi", label: "UPI / wallet" },
  { value: "credit_card", label: "Credit card" },
];

/* ------------------------------------------------------------ reminders -- */

export type ReminderStatus = "open" | "done" | "cancelled";

export interface ReminderAssignee {
  id: string;
  name: string;
}

export interface Reminder {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_label?: string | null;
  entity_code?: string | null;
  title: string;
  note?: string | null;
  due_at: string;
  // A reminder is SHARED, not copied: everyone named on it gets the bell and
  // the daily digest, and the first to mark it done closes it for all of them
  // (owner Q3.2a). Always at least one entry.
  assignees: ReminderAssignee[];
  assignee_ids: string[];
  status: ReminderStatus;
  // Derived server-side against the IST day boundary, so every screen agrees
  // about what "overdue" means instead of re-deriving it in the browser.
  is_overdue: boolean;
  is_due_today: boolean;
  completed_at?: string | null;
  completed_by?: string | null;
  completed_by_name?: string | null;
  created_by?: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface ReminderCounts {
  open: number;
  due_today: number;
  overdue: number;
}

/* ---------------------------------------------------------------- teams -- */

export interface ManagerRow {
  manager_id: string;
  manager_name: string;
  manager_code?: string | null;
  active_account: boolean;
  partners: number;
  active_partners: number;
  policies: number;
  premium: number;
  reward_earned: number;
  partner_share: number;
  profit: number;
  renewals: number;
  partner_policies: number;
  partner_premium: number;
  own_policies: number;
  own_premium: number;
}

export interface ManagerRollup {
  can_view_profit: boolean;
  can_view_all: boolean;
  date_from?: string | null;
  date_to?: string | null;
  period_label: string;
  rows: ManagerRow[];
  unassigned?: ManagerRow | null;
}

export interface PartnerRosterRow {
  partner_id: string;
  partner_name: string;
  partner_code?: string | null;
  mobile?: string | null;
  active_account: boolean;
  policies: number;
  premium: number;
  their_reward: number;
  // Current position, NOT windowed. Positive = the agency owes them.
  net_balance: number;
  renewals_due: number;
  last_policy_at?: string | null;
  days_quiet?: number | null;
  is_quiet: boolean;
  // The number this partner was given for the period, and how far along they
  // are. House profit is stripped server-side for anyone who may not see it,
  // so `target_metrics` is already safe to render as-is.
  has_target: boolean;
  target_id?: string | null;
  attainment_pct: number;
  target_metrics: TargetMetricRow[];
}

export interface ManagerRoster {
  manager_id: string;
  manager_name: string;
  manager_code?: string | null;
  can_view_profit: boolean;
  can_manage: boolean;
  // May the viewer SET the targets on this roster? Separate from `can_manage`:
  // a relationship manager splits their own goal across their partners without
  // holding manage_team (owner F1, 2026-08-06).
  can_manage_targets: boolean;
  date_from?: string | null;
  date_to?: string | null;
  period_label: string;
  partners: number;
  active_partners: number;
  quiet_partners: number;
  policies: number;
  premium: number;
  their_reward_total: number;
  renewals_due: number;
  // The MANAGER's own target — the number the per-partner ones were carved out
  // of. Shown above the roster so the split reads as a split.
  manager_has_target: boolean;
  manager_attainment_pct: number;
  manager_metrics: TargetMetricRow[];
  partners_with_target: number;
  /** Per metric: what the manager was asked for vs what they handed out. */
  allocation: TargetAllocationRow[];
  rows: PartnerRosterRow[];
}

/** One metric's allocation: the manager's goal vs the sum of their partners'. */
export interface TargetAllocationRow {
  metric: string;
  label: string;
  is_money: boolean;
  target_value: number;
  allocated: number;
  partners_with_goal: number;
}

/** One policy written by somebody on a manager's roster. */
export interface TeamPolicyRow {
  policy_id: string;
  code: string;
  policy_number?: string | null;
  partner_id?: string | null;
  partner_name?: string | null;
  customer_name?: string | null;
  category_label?: string | null;
  insurer_name?: string | null;
  premium: number;
  their_reward: number;
  status: string;
  is_renewal: boolean;
  booked_at?: string | null;
  expiry_date?: string | null;
}

export interface TeamPolicies {
  manager_id: string;
  manager_name: string;
  date_from?: string | null;
  date_to?: string | null;
  period_label: string;
  total: number;
  premium: number;
  their_reward_total: number;
  rows: TeamPolicyRow[];
  /** More policies in the window than one screen carries — say so, don't hide it. */
  truncated: boolean;
}

/* -------------------------------------------------- partner portal (me) -- */
/* A partner sees the premium, THEIR OWN earning in rupees, and where they
   stand with the agency. Never the agency's reward, house profit, a rate card,
   a broker or a discount — these interfaces mirror the server schemas, which
   have no field for any of it. */

export interface PortalCapabilities {
  enabled: boolean;
  can_request_quotes: boolean;
  can_raise_claims: boolean;
  can_view_earnings: boolean;
  can_download_policy_pdf: boolean;
  can_view_renewals: boolean;
  can_upload_kyc: boolean;
  quote_validity_days: number;
}

export interface PortalMoney {
  // > 0 the agency owes them, < 0 they owe the agency. Both sides are always
  // shown: hiding one makes the other wrong by subtraction.
  net_balance: number;
  reward_earned_unpaid: number;
  premium_owed: number;
  lifetime_earned: number;
  lifetime_paid: number;
}

export interface PortalPolicy {
  id: string;
  code: string;
  policy_number?: string | null;
  customer_name?: string | null;
  customer_mobile?: string | null;
  insurer_name?: string | null;
  category_key: string;
  category_label?: string | null;
  subcategory_label?: string | null;
  status: string;
  premium_amount: number;
  sum_insured: number;
  start_date?: string | null;
  expiry_date?: string | null;
  my_earning: number;
  is_renewal: boolean;
  created_at: string;
}

export interface PortalPolicyDetail extends PortalPolicy {
  details: Record<string, unknown>;
  field_labels: Record<string, string>;
  documents: CustomerDocument[];
  notes?: string | null;
  days_to_expiry?: number | null;
  open_claims: number;
}

export interface PortalRenewal {
  policy_id: string;
  code: string;
  policy_number?: string | null;
  customer_name?: string | null;
  customer_mobile?: string | null;
  category_label?: string | null;
  insurer_name?: string | null;
  premium_amount: number;
  expiry_date?: string | null;
  days_left: number;
  quote_requested: boolean;
}

export interface PortalSummary {
  period_label: string;
  policies: number;
  premium: number;
  my_earning: number;
  money: PortalMoney;
  renewals_30d: number;
  renewals_7d: number;
  open_quotes: number;
  quotes_awaiting_me: number;
  open_claims: number;
  unread_notices: number;
  latest_notice?: {
    id: string; title: string; category: string;
    created_at: string; read: boolean;
  } | null;
  recent_policies: PortalPolicy[];
}

// GET /api/portal/target — what the agency asked this partner for, and where
// they have got to (owner E1-E3, 2026-08-06).
//
// `attainment_pct` is the ONE percentage a partner is ever shown. Owner E1 is
// "rupees only, never a percentage" and it is about MONEY — a reward rate gives
// away what the agency keeps. Progress against a goal the agency handed them on
// purpose is the opposite: it is the point of setting the goal. There is no
// house-profit metric in `metrics`; the server strips it before serialising.
export interface PortalTargetMetric {
  metric: string;
  label: string;
  is_money: boolean;
  target_value: number;
  actual_value: number;
  attainment_pct: number;
}

export interface PortalTarget {
  window: string;
  label: string;
  has_target: boolean;
  attainment_pct: number;
  metrics: PortalTargetMetric[];
}

export interface PortalEarningsRow {
  policy_id: string;
  code: string;
  policy_number?: string | null;
  customer_name?: string | null;
  category_label?: string | null;
  booked_at?: string | null;
  premium_amount: number;
  my_earning: number;
}

export interface PortalEarnings {
  period_label: string;
  date_from?: string | null;
  date_to?: string | null;
  policies: number;
  premium: number;
  my_earning: number;
  rows: PortalEarningsRow[];
}

export interface PortalLedgerEntry {
  date?: string | null;
  label: string;
  reference?: string | null;
  policy?: string | null;
  // Signed, partner-favour: + the agency owes more, - less.
  amount: number;
  balance: number;
}

export interface PortalTransactions {
  period_label: string;
  opening: number;
  closing: number;
  entries: PortalLedgerEntry[];
}

export interface PortalEvent {
  at: string;
  stage?: string | null;
  by_name?: string | null;
  by_side: "agency" | "partner";
  message?: string | null;
}

export interface PortalQuoteOption {
  id: string;
  insurer_name?: string | null;
  premium_amount: number;
  sum_insured: number;
  cover_from?: string | null;
  cover_to?: string | null;
  inclusions?: string | null;
  my_earning: number;
  valid_until?: string | null;
  expired: boolean;
  accepted_at?: string | null;
  declined_at?: string | null;
}

export type QuoteStage =
  | "submitted" | "in_review" | "info_needed" | "quoted"
  | "accepted" | "issued" | "declined" | "lost" | "cancelled";

export interface PortalQuoteRequest {
  id: string;
  code: string;
  stage: QuoteStage;
  customer_name: string;
  customer_mobile: string;
  category_key: string;
  category_label?: string | null;
  subcategory_label?: string | null;
  is_renewal: boolean;
  note?: string | null;
  options: PortalQuoteOption[];
  can_cancel: boolean;
  created_at: string;
  updated_at: string;
}

export interface PortalQuoteDetail extends PortalQuoteRequest {
  details: Record<string, unknown>;
  field_labels: Record<string, string>;
  timeline: PortalEvent[];
  documents: CustomerDocument[];
  policy_id?: string | null;
  closed_reason?: string | null;
}

export interface PortalQuoteIn {
  customer_name: string;
  customer_mobile: string;
  customer_email?: string;
  category_key: string;
  subcategory_path: string[];
  details: Record<string, unknown>;
  note?: string;
  renewal_of_policy_id?: string;
}

export interface PortalDocSlot {
  key: string;
  label: string;
  required: boolean;
}

export interface PortalQuoteCategory {
  key: string;
  label: string;
  children: CategoryNode[];
  fields: {
    key: string; label: string; type: string;
    options: string[]; hint?: string | null;
  }[];
  documents: PortalDocSlot[];
}

export type ClaimStage =
  | "intimated" | "registered" | "docs_pending" | "survey"
  | "approved" | "settled" | "rejected" | "closed";

export interface PortalClaim {
  id: string;
  code: string;
  stage: ClaimStage;
  policy_id: string;
  policy_number?: string | null;
  customer_name?: string | null;
  category_label?: string | null;
  incident_at?: string | null;
  description?: string | null;
  estimated_loss: number;
  insurer_claim_no?: string | null;
  settlement_mode?: string | null;
  surveyor_name?: string | null;
  approved_amount: number;
  settled_amount: number;
  settled_at?: string | null;
  rejection_reason?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PortalClaimDetail extends PortalClaim {
  incident_location?: string | null;
  timeline: PortalEvent[];
  documents: CustomerDocument[];
  required_documents: PortalDocSlot[];
}

export interface PortalClaimIn {
  policy_id: string;
  incident_at: string;
  incident_location?: string;
  description: string;
  estimated_loss: number;
}

export interface PortalNotice {
  id: string;
  code: string;
  title: string;
  body: string;
  category: string;
  valid_until?: string | null;
  read_at?: string | null;
  created_at: string;
}

export interface PortalProfile {
  id: string;
  code: string;
  full_name: string;
  email: string;
  mobile?: string | null;
  relationship_manager?: string | null;
  relationship_manager_mobile?: string | null;
  joined_at?: string | null;
  capabilities: PortalCapabilities;
}

/* ------------------------------------------- quotes & claims (staff side) -- */

export interface StaffQuoteOption extends PortalQuoteOption {
  insurer_id?: string | null;
  partner_earning: number;
  quoted_by_name?: string | null;
  quoted_at?: string | null;
  decline_reason?: string | null;
}

export interface StaffQuote {
  id: string;
  code: string;
  stage: QuoteStage;
  partner_id: string;
  partner_name?: string | null;
  manager_name?: string | null;
  assigned_to_id?: string | null;
  assigned_to_name?: string | null;
  customer_name: string;
  customer_mobile: string;
  customer_email?: string | null;
  category_key: string;
  category_label?: string | null;
  subcategory_label?: string | null;
  is_renewal: boolean;
  note?: string | null;
  options: StaffQuoteOption[];
  policy_id?: string | null;
  closed_reason?: string | null;
  age_hours: number;
  answered: boolean;
  /** The quotation we sent has run out and the partner can no longer accept it. */
  expired: boolean;
  created_at: string;
  updated_at: string;
}

export interface StaffQuoteDetail extends StaffQuote {
  subcategory_path: string[];
  details: Record<string, unknown>;
  field_labels: Record<string, string>;
  timeline: PortalEvent[];
  documents: CustomerDocument[];
  internal_notes?: string | null;
  renewal_of_policy_id?: string | null;
}

export interface StaffClaim {
  id: string;
  code: string;
  stage: ClaimStage;
  policy_id: string;
  policy_number?: string | null;
  customer_name?: string | null;
  category_key?: string | null;
  category_label?: string | null;
  partner_id?: string | null;
  raised_by_name?: string | null;
  raised_by_side: "agency" | "partner";
  assigned_to_id?: string | null;
  assigned_to_name?: string | null;
  incident_at?: string | null;
  description?: string | null;
  estimated_loss: number;
  insurer_claim_no?: string | null;
  settlement_mode?: string | null;
  surveyor_name?: string | null;
  approved_amount: number;
  settled_amount: number;
  settled_at?: string | null;
  rejection_reason?: string | null;
  age_days: number;
  created_at: string;
  updated_at: string;
}

export interface StaffClaimDetail extends StaffClaim {
  incident_location?: string | null;
  surveyor_contact?: string | null;
  surveyor_appointed_at?: string | null;
  filed_at?: string | null;
  internal_notes?: string | null;
  timeline: PortalEvent[];
  documents: CustomerDocument[];
  required_documents: PortalDocSlot[];
}

/* ------------------------------------------------------- notices (staff) -- */

export interface AnnouncementRow {
  id: string;
  code: string;
  title: string;
  body: string;
  category: string;
  valid_until?: string | null;
  audience: string;
  manager_name?: string | null;
  send_email: boolean;
  send_whatsapp: boolean;
  recipients: number;
  read_count: number;
  withdrawn_at?: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface AnnouncementDetail extends AnnouncementRow {
  receipts: {
    partner_id: string;
    partner_name?: string | null;
    read_at?: string | null;
  }[];
}

export interface AudiencePreview {
  count: number;
  names: string[];
  truncated: boolean;
}

/* =========================================================== payroll (2026-08-24) */
//
// PAYROLL WAS DROPPED ON 2026-08-20 AND BROUGHT BACK ON 2026-08-24. The owner:
// "based on the attendance of the employee and the salary which is set of an
// employee, at the end of month, a salary should be calculated... so that the
// owner knows how much to pay each employee."
//
// Every figure below is a SNAPSHOT taken when the payslip was generated. None
// of it is recomputed on read — a payslip that re-derived itself would change
// when somebody's salary was raised in November, and August's payslip would
// silently stop matching the payment made against it.

export type PayslipStatus = "draft" | "finalised" | "paid" | "cancelled";

/** One row of the breakdown. Signed: negative rows are deductions. */
export interface PayslipLine {
  label: string;
  detail: string;
  amount_paise: number;
  days: number;
}

export interface Payslip {
  id: string;
  code: string;
  user_id: string;
  user_name: string;
  user_code: string;
  designation?: string | null;
  month: string;                       // "YYYY-MM", IST

  // The inputs, frozen at generation.
  monthly_salary_paise: number;
  /** salary / 30. A CONSTANT 30, not the month's length — so the same absence
   *  costs the same in February as in March (the owner's worked example). */
  per_day_paise: number;
  days_divisor: number;

  // The attendance behind it, frozen at generation.
  calendar_days: number;
  present_days: number;
  wfh_days: number;
  half_days: number;
  absent_days: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  week_off_days: number;
  holiday_days: number;
  not_marked_days: number;
  late_marks: number;
  late_penalty_days: number;
  /** Days inside this month before the person joined. Deducted, but never
   *  folded into "absent" — being new is not an absence. */
  pre_joining_days: number;
  worked_minutes: number;
  payable_days: number;
  /** Days the register has not resolved. NOT deducted; surfaced so somebody
   *  looks before finalising. */
  unresolved_days: number;

  // The money.
  lop_days: number;
  deduction_paise: number;
  adjustment_paise: number;
  adjustment_note?: string | null;
  net_payable_paise: number;
  lines: PayslipLine[];

  status: PayslipStatus;
  generated_at: string;
  generated_by_name?: string | null;
  finalised_at?: string | null;
  finalised_by_name?: string | null;
  /** Locked by the scheduled job when the correction window closed, rather than
   *  by somebody pressing Finalise. Its own field rather than inferred from a
   *  missing name: "nobody finalised this" and "it locked itself on the 3rd"
   *  are different answers to "who decided this?", which is the first thing an
   *  employee asks about a figure. */
  auto_finalised: boolean;
  /** Why this draft will NOT lock itself when the window closes, in words.
   *  Server-computed with the same function the job refuses on, so the screen
   *  cannot promise a lock the job would decline. Empty once it is ready. */
  blockers: string[];
  /** The date this DRAFT locks itself ("2026-09-03"). On the payslip rather
   *  than only on the pay run because it is the EMPLOYEE'S deadline too — the
   *  last day a correction can still change what they are paid — and they never
   *  open the pay run. Null once locked, or when the automation is off. */
  lock_on?: string | null;
  paid_at?: string | null;
  paid_by_name?: string | null;
  /** The EXPENSE row on the ledger. The payslip links to the money; it is not
   *  a second copy of it. */
  payment_txn_id?: string | null;
  payment_reference?: string | null;
  paid_amount_paise?: number | null;
  note?: string | null;
  updated_at: string;
}

export interface PayRunTotals {
  month: string;
  employees: number;
  payslips: number;
  draft: number;
  finalised: number;
  paid: number;
  gross_paise: number;
  deduction_paise: number;
  net_paise: number;
  /** Finalised but not yet paid — what the agency still owes people. */
  outstanding_paise: number;
  /** NAMES, not a count. "3 employees have no salary on record" sends somebody
   *  hunting; three names is a to-do list. */
  missing_salary: string[];
  unresolved_people: string[];

  // --- The correction window (owner 2026-09-06) ---
  /** Working days the register stays open after the month ends. 0 = automatic
   *  locking is off and the month waits for somebody to press Finalise. */
  auto_finalise_days: number;
  /** The IST date the drafts lock themselves on ("2026-09-03"), or null when
   *  the automation is off. */
  auto_finalise_on?: string | null;
  /** Drafts that will lock as they stand when the window closes. */
  ready: number;
  /** And the ones that will not, each with the reason. */
  blocked: PayRunBlocker[];
}

/** One person the month is waiting on, and why. */
export interface PayRunBlocker {
  payslip_id: string;
  user_id: string;
  name: string;
  reasons: string[];
}

export interface PayRun {
  totals: PayRunTotals;
  rows: Payslip[];
}

/** The strip on an employee's own dashboard: one payslip and a way in. */
export interface MyPayslips {
  latest?: Payslip | null;
  total: number;
  unpaid: number;
}

/* ================================================ policy access (2026-08-24) */
//
// From 2026-08-24 an employee reads their OWN book: what they booked, plus what
// the channel partners on their roster booked. `view_all_policies` opts out of
// that entirely. See server/app/services/policy_scope.py.

/** What the Policies page says it is showing. Computed server-side so the page
 *  cannot claim a different scope from the one the query applied. */
export interface PolicyScope {
  scoped: boolean;
  partner_count: number;
  label: string;
}

/** A policy that exists and that you may not read.
 *
 *  EVERY FIELD IS DELIBERATE, and the absent ones more so: no customer, no
 *  premium, no insurer. Just enough to ask for access, and who to ask. */
export interface RestrictedPolicy {
  id: string;
  code: string;
  policy_number?: string | null;
  /** Who to talk to. Often faster than the request queue, which is why it is
   *  shown at all. */
  held_by?: string | null;
  request_id?: string | null;
  request_status?: PolicyAccessStatus | null;
}

export interface RestrictedSearch {
  items: RestrictedPolicy[];
  /** True when the caller sees everything anyway, so the page can skip the
   *  "you may not see these" framing rather than rendering an empty one. */
  unscoped: boolean;
}

export type PolicyAccessStatus =
  | "pending" | "approved" | "rejected" | "revoked" | "expired" | "cancelled";

export interface PolicyAccessRequest {
  id: string;
  code: string;
  policy_id: string;
  policy_code: string;
  policy_number?: string | null;
  requester_id: string;
  requester_name: string;
  reason: string;
  status: PolicyAccessStatus;
  hours: number;
  expires_at?: string | null;
  decided_by_name?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
  created_at: string;
  /** Computed server-side against the clock, never read off `status` — an
   *  approved grant whose window closed a minute ago reads as closed. */
  is_live: boolean;
}

/** What moving a channel partner is about to change, before it is done. */
export interface ReassignPreview {
  partner_id: string;
  partner_name: string;
  policy_count: number;
  from_manager?: string | null;
  to_manager?: string | null;
}
