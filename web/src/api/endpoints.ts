import { api } from "./client";
import type { Fix } from "../lib/geo";
import type {
  AnnouncementDetail,
  AnnouncementRow,
  AudiencePreview,
  PortalClaim,
  PortalClaimDetail,
  PortalClaimIn,
  PortalEarnings,
  PortalMoney,
  PortalNotice,
  PortalPolicy,
  PortalPolicyDetail,
  PortalProfile,
  PortalQuoteCategory,
  PortalQuoteDetail,
  PortalQuoteIn,
  PortalQuoteRequest,
  PortalRenewal,
  PortalSummary,
  PortalTarget,
  PortalTransactions,
  StaffClaim,
  StaffClaimDetail,
  StaffQuote,
  StaffQuoteDetail,
  AttendanceCorrection,
  AttendanceDay,
  AttendanceMonth,
  Holiday,
  HolidayYear,
  LeaveBalance,
  LeaveCostPreview,
  LeaveLedgerRow,
  LeaveRequest,
  PunchState,
  TeamDay,
  TeamMonth,
  WhoIsOff,
  Broker,
  AuditEntry,
  Customer,
  DashboardStats,
  Insurer,
  Lead,
  LedgerTxn,
  Me,
  OrgRole,
  Page,
  PartyAccount,
  Policy,
  PolicyCategory,
  PolicyFinance,
  RatePreview,
  RateRule,
  Reward,
  TokenResponse,
  UserRow,
  Withdrawal,
} from "../lib/types";

// --- Auth ---
export const authApi = {
  login: (email: string, password: string, captcha_token?: string) =>
    api.post<TokenResponse>("/api/auth/login",
      { email, password, captcha_token }),
  me: () => api.get<Me>("/api/auth/me"),
  forgot: (email: string, channel: "email" | "whatsapp" = "email") =>
    api.post<{ detail: string }>("/api/auth/forgot-password",
      { email, channel }),
  reset: (email: string, otp: string, new_password: string) =>
    api.post<{ detail: string }>("/api/auth/reset-password", {
      email, otp, new_password,
    }),
  changePassword: (current_password: string, new_password: string) =>
    api.post<TokenResponse>("/api/auth/change-password", {
      current_password, new_password,
    }),
  onboarding: (body: import("../lib/types").OnboardingPayload) =>
    api.post<TokenResponse>("/api/auth/onboarding", body),
  uploadOnboardingDoc: (docKey: string, file: File) => {
    const fd = new FormData();
    fd.append("doc_key", docKey);
    fd.append("file", file);
    return api.post<{ detail: string }>("/api/auth/onboarding/document", fd, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  myDocuments: () =>
    api.get<import("../lib/types").UserDoc[]>("/api/auth/me/documents"),
  uploadMyDoc: (docKey: string, file: File, label?: string) => {
    const fd = new FormData();
    fd.append("doc_key", docKey);
    fd.append("file", file);
    if (label) fd.append("label", label);
    return api.post<import("../lib/types").UserDoc>("/api/auth/me/documents", fd, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  downloadMyDoc: (docId: string) =>
    api.get<{ url: string; expires_in: number }>(
      `/api/auth/me/documents/${docId}/download`),
  deleteMyDoc: (docId: string) =>
    api.delete<{ detail: string }>(`/api/auth/me/documents/${docId}`),
  updateProfile: (body: { full_name?: string; mobile?: string }) =>
    api.patch<Me>("/api/auth/me", body),
  changeEmail: (new_email: string, password: string) =>
    api.post<{ detail: string }>("/api/auth/change-email", { new_email, password }),
  logout: () => api.post("/api/auth/logout"),
};

// --- Generic paginated list helper ---
type ListParams = Record<string, string | number | undefined>;
function qs(params: object): string {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : "";
}

// --- Dashboard / reports ---
export const reportsApi = {
  dashboard: () => api.get<DashboardStats>("/api/reports/dashboard"),
  renewals: (days = 30) => api.get(`/api/reports/renewals?days=${days}`),
  renewalSummary: (windowDays = 90) =>
    api.get<import("../lib/types").RenewalSummary>(
      `/api/reports/renewal-summary?window_days=${windowDays}`),
  analytics: (params: ListParams = {}) =>
    api.get<import("../lib/types").AnalyticsResult>(
      `/api/reports/analytics${qs(params)}`),
  analyticsExport: (params: ListParams = {}) =>
    api.get(`/api/reports/analytics/export${qs(params)}`, { responseType: "blob" }),
  partnerPerformance: () => api.get("/api/reports/partner-performance"),
  leadFunnel: () => api.get("/api/reports/lead-funnel"),
};

// --- Master ---
export const categoriesApi = {
  list: (includeInactive = false) =>
    api.get<PolicyCategory[]>(
      `/api/policy-categories${includeInactive ? "?include_inactive=true" : ""}`),
  create: (body: unknown) =>
    api.post<PolicyCategory>("/api/policy-categories", body),
  update: (id: string, body: unknown) =>
    api.patch<PolicyCategory>(`/api/policy-categories/${id}`, body),
  // Permanent delete: owner-only, and the server refuses while any policy or
  // rate card still names this type. Deactivating is `update(id, {active:false})`.
  remove: (id: string) => api.delete(`/api/policy-categories/${id}`),
};

// --- Roles (My Organization) ---
export const rolesApi = {
  list: () => api.get<OrgRole[]>("/api/roles"),
  // The permission model itself (groups + help text + starter templates),
  // served by the backend so the editor can never drift from permissions.py.
  catalog: () =>
    api.get<{ groups: import("../lib/types").PermissionGroup[];
              templates: import("../lib/types").RoleTemplate[] }>(
      "/api/roles/catalog"),
  create: (body: unknown) => api.post<OrgRole>("/api/roles", body),
  update: (id: string, body: unknown) => api.patch<OrgRole>(`/api/roles/${id}`, body),
  remove: (id: string) => api.delete<{ detail: string }>(`/api/roles/${id}`),
};

// --- Users (employees & channel partners) ---
export const usersApi = {
  list: (params: ListParams = {}) =>
    api.get<Page<UserRow>>(`/api/users${qs(params)}`),
  get: (id: string) => api.get<UserRow>(`/api/users/${id}`),
  assignableManagers: () =>
    api.get<import("../lib/types").AssignableManager[]>(
      "/api/users/assignable-managers"),
  attributablePartners: () =>
    api.get<import("../lib/types").AssignablePartner[]>(
      "/api/users/attributable-partners"),
  // Colleagues holding a given permission — "who can I give this to". Unlike
  // `list`, this does NOT need view_team, so someone who works the pipeline but
  // cannot read the staff directory can still name a colleague on a reminder.
  withPermission: (permission: string) =>
    api.get<import("../lib/types").AssignableColleague[]>(
      `/api/users/with-permission${qs({ permission })}`),
  createEmployee: (body: unknown) =>
    api.post<UserRow>("/api/users/employees", body),
  createPartner: (body: unknown) => api.post<UserRow>("/api/users/partners", body),
  update: (id: string, body: unknown) =>
    api.patch<UserRow>(`/api/users/${id}`, body),
  requestDeleteOtp: (id: string) =>
    api.post<{ detail: string }>(`/api/users/${id}/request-delete-otp`),
  remove: (id: string, otp: string) =>
    api.delete<{ detail: string }>(`/api/users/${id}`, { data: { otp } }),
  // `acknowledgeBalance` re-sends a deactivation the server refused with a 409
  // because the agency still owes the partner money. See
  // routers/users.update_status — refused once, with the figure in the message.
  setStatus: (id: string, status: string, reason?: string,
              acknowledgeBalance = false) =>
    api.patch<UserRow>(`/api/users/${id}/status`,
      { status, reason, acknowledge_balance: acknowledgeBalance }),
  setPermissions: (id: string, extra_permissions: string[]) =>
    api.patch<UserRow>(`/api/users/${id}/permissions`,
      { extra_permissions }),
  // The temporary password is emailed to the account holder and is NOT
  // returned here — only the confirmation message is.
  resetPassword: (id: string) =>
    api.post<{ detail: string }>(`/api/users/${id}/reset-password`),
  // Re-send the portal invitation with a fresh temporary password. The one
  // emailed at creation expires after 7 days, so it is routinely stale by the
  // time a channel partner gets round to signing in.
  resendInvite: (id: string) =>
    api.post<{ detail: string }>(`/api/users/${id}/resend-invite`),
  emailAvailable: (email: string) =>
    api.get<{ email: string; available: boolean }>(
      `/api/users/email-available?email=${encodeURIComponent(email)}`),
  listDocuments: (id: string) =>
    api.get<import("../lib/types").UserDoc[]>(`/api/users/${id}/documents`),
  downloadDocument: (id: string, docId: string) =>
    api.get<{ url: string; expires_in: number }>(
      `/api/users/${id}/documents/${docId}/download`),
};

// --- Customers ---
// Reassigning a channel partner moves their ENTIRE BOOK between two people's
// screens in one edit (services/policy_scope). This is the dry run behind the
// confirmation: "12 policies move to Rahul" is a sentence somebody can
// sanity-check, where a toast saying "Saved" is not.
export const reassignApi = {
  preview: (partnerId: string, managerId: string) =>
    api.get<import("../lib/types").ReassignPreview>(
      `/api/users/${partnerId}/reassign-preview${qs({
        manager_id: managerId })}`),
};

export const customersApi = {
  list: (params: ListParams = {}) =>
    api.get<Page<Customer>>(`/api/customers${qs(params)}`),
  get: (id: string) => api.get<Customer>(`/api/customers/${id}`),
  export: (params: { q?: string; type?: string; fmt?: string } = {}) =>
    api.get(`/api/customers/export${qs(params)}`, { responseType: "blob" }),
  policies: (id: string) => api.get<Policy[]>(`/api/customers/${id}/policies`),
  stats: (id: string) =>
    api.get<import("../lib/types").CustomerStats>(`/api/customers/${id}/stats`),
  create: (body: unknown) => api.post<Customer>("/api/customers", body),
  update: (id: string, body: unknown) =>
    api.patch<Customer>(`/api/customers/${id}`, body),
  remove: (id: string) => api.delete(`/api/customers/${id}`),
  setArchive: (id: string, archived: boolean) =>
    api.patch<{ detail: string }>(
      `/api/customers/${id}/archive${qs({ archived: archived ? 1 : 0 })}`, {}),
  sendPolicy: (customerId: string, policyId: string, toPartner = false) =>
    api.post<{ detail: string }>(
      `/api/customers/${customerId}/policies/${policyId}/send${
        qs({ to_partner: toPartner ? 1 : undefined })}`, {}),
  downloadTemplate: () =>
    api.get("/api/customers/import/template", { responseType: "blob" }),
  import: (file: File, onProgress?: (percent: number) => void) => {
    const fd = new FormData();
    fd.append("file", file);
    return api.post<import("../lib/types").CustomerImportResult>(
      "/api/customers/import", fd, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (e) => {
          if (onProgress && e.total)
            onProgress(Math.round((e.loaded / e.total) * 100));
        },
      });
  },
};

// --- Third Party Services (owner settings) ---
export const servicesApi = {
  get: () => api.get<import("../lib/types").ServiceSettings>(
    "/api/admin/services"),
  update: (body: unknown) =>
    api.patch<import("../lib/types").ServiceSettings>(
      "/api/admin/services", body),
};

// --- Documents ---
export const documentsApi = {
  listFor: (entityType: string, entityId: string) =>
    api.get<import("../lib/types").CustomerDocument[]>(
      `/api/documents/for/${entityType}/${entityId}`),
  presignUpload: (body: {
    entity_type: string; entity_id: string; filename: string;
    content_type?: string; doc_key?: string; label?: string;
  }) => api.post<{ upload_url: string; s3_key: string; expires_in: number }>(
    "/api/documents/presign-upload", body),
  confirm: (body: {
    entity_type: string; entity_id: string; s3_key: string; filename: string;
    content_type?: string; size_bytes?: number; doc_key?: string; label: string;
  }) => api.post<import("../lib/types").CustomerDocument>(
    "/api/documents/confirm", body),
  download: (id: string) =>
    api.get<{ url: string; expires_in: number }>(
      `/api/documents/${id}/download`),
  remove: (id: string) => api.delete(`/api/documents/${id}`),
};

// --- Insurers (companies) ---
export const insurersApi = {
  list: (params: ListParams = {}) =>
    api.get<Page<Insurer>>(`/api/insurers${qs(params)}`),
  // Short name is unique — the form checks while you type, like broker codes.
  shortNameAvailable: (short_name: string, exclude_id?: string) =>
    api.get<{ short_name: string; available: boolean }>(
      `/api/insurers/short-name-available${qs({ short_name, exclude_id })}`),
  create: (body: unknown) => api.post<Insurer>("/api/insurers", body),
  update: (id: string, body: unknown) =>
    api.patch<Insurer>(`/api/insurers/${id}`, body),
  remove: (id: string) => api.delete<{ detail: string }>(`/api/insurers/${id}`),
};

// --- Brokers (brokerages/aggregators we place business through) ---
export const brokersApi = {
  list: (params: ListParams = {}) =>
    api.get<Broker[]>(`/api/brokers${qs(params)}`),
  get: (id: string) => api.get<Broker>(`/api/brokers/${id}`),
  shortCodeAvailable: (short_code: string, exclude_id?: string) =>
    api.get<{ short_code: string; available: boolean }>(
      `/api/brokers/short-code-available${qs({ short_code, exclude_id })}`),
  create: (body: unknown) => api.post<Broker>("/api/brokers", body),
  update: (id: string, body: unknown) =>
    api.patch<Broker>(`/api/brokers/${id}`, body),
  remove: (id: string) => api.delete<{ detail: string }>(`/api/brokers/${id}`),
};

// --- Rate rules (the rate engine under a Broker) ---
export const rateRulesApi = {
  list: (brokerId: string, categoryKey?: string) =>
    api.get<RateRule[]>(`/api/rate-rules${qs({
      broker_id: brokerId, category_key: categoryKey })}`),
  preview: (params: {
    broker_id: string; category_key: string;
    subcategory_path?: string[]; insurer_id?: string;
  }) => {
    const p = new URLSearchParams();
    p.append("broker_id", params.broker_id);
    p.append("category_key", params.category_key);
    if (params.insurer_id) p.append("insurer_id", params.insurer_id);
    (params.subcategory_path ?? []).forEach((k) =>
      p.append("subcategory_path", k));
    return api.get<RatePreview>(`/api/rate-rules/preview?${p.toString()}`);
  },
  create: (body: unknown) => api.post<RateRule>("/api/rate-rules", body),
  update: (id: string, body: unknown) =>
    api.patch<RateRule>(`/api/rate-rules/${id}`, body),
  remove: (id: string) => api.delete(`/api/rate-rules/${id}`),
};

// --- Policies ---
export const policiesApi = {
  list: (params: ListParams = {}) =>
    api.get<Page<Policy>>(`/api/policies${qs(params)}`),
  get: (id: string) => api.get<Policy>(`/api/policies/${id}`),
  create: (body: unknown) => api.post<Policy>("/api/policies", body),
  update: (id: string, body: unknown) =>
    api.patch<Policy>(`/api/policies/${id}`, body),
  setStatus: (id: string, status: string, reason?: string) =>
    api.patch<Policy>(`/api/policies/${id}/status`, { status, reason }),
  setRewardStatus: (id: string, status: string, reference?: string) =>
    api.patch<Policy>(`/api/policies/${id}/reward-status`, { status, reference }),
  export: (params: {
    status?: string; category_key?: string;
    insurer_id?: string; broker_id?: string; partner_id?: string;
    period?: string; date_from?: string; date_to?: string; fmt?: string;
  } = {}) => api.get(`/api/policies/export${qs(params)}`, { responseType: "blob" }),
  // Advisory only — the write-time check and the unique index are what
  // actually decide. This just stops the form finding out at Save.
  numberAvailable: (number: string, excludeId?: string) =>
    api.get<{ number: string; available: boolean; used_by_code?: string | null }>(
      `/api/policies/number-available${qs({ number, exclude_id: excludeId })}`),
  renew: (id: string, body: unknown) =>
    api.post<Policy>(`/api/policies/${id}/renew`, body),
  remove: (id: string) => api.delete<{ detail: string }>(`/api/policies/${id}`),
  notify: (id: string, to: "customer" | "partner") =>
    api.post<{ detail: string }>(
      `/api/policies/${id}/notify${qs({ to })}`, {}),
  renewalChain: (id: string) =>
    api.get<Policy[]>(`/api/policies/${id}/renewal-chain`),
  // What this list is actually showing (2026-08-24). A scoped list that does
  // not SAY it is scoped reads as a list with rows missing, and the first
  // assumption anybody makes is that the software lost them.
  scope: () => api.get<import("../lib/types").PolicyScope>(
    "/api/policies/scope"),
  uploadDocument: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api.post<import("../lib/types").CustomerDocument>(
      `/api/policies/${id}/document`, fd,
      { headers: { "Content-Type": "multipart/form-data" } });
  },
  // Attach an extra supporting document (a configured required_document slot).
  uploadExtraDocument: (id: string, docKey: string, label: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api.post<import("../lib/types").CustomerDocument>(
      `/api/policies/${id}/documents${qs({ doc_key: docKey, label })}`, fd,
      { headers: { "Content-Type": "multipart/form-data" } });
  },
};

// --- Finance engine ---
export const financeApi = {
  policyFinance: (policyId: string) =>
    api.get<PolicyFinance>(`/api/finance/policy/${policyId}`),
  parties: (params: { party_type?: string; outstanding_only?: number } = {}) =>
    api.get<PartyAccount[]>(`/api/finance/parties${qs(params)}`),
  ledger: (params: {
    party_type?: string; party_id?: string; policy_id?: string;
    txn_type?: string; exclude_types?: string;
    date_from?: string; date_to?: string; q?: string;
    // An account id, or the literal "none" for rows carrying no account.
    bank_account_id?: string;
    page?: number; page_size?: number;
  } = {}) => api.get<Page<LedgerTxn>>(`/api/finance/ledger${qs(params)}`),
  ledgerDetail: (id: string) =>
    api.get<import("../lib/types").LedgerTxnDetail>(
      `/api/finance/ledger/${id}`),
  ledgerExport: (params: {
    party_type?: string; party_id?: string; txn_type?: string;
    exclude_types?: string; date_from?: string; date_to?: string;
    bank_account_id?: string;
    q?: string; fmt?: string;
  } = {}) => api.get(`/api/finance/ledger/export${qs(params)}`,
    { responseType: "blob" }),
  overview: (basis: "cash" | "accrual" = "cash") =>
    api.get<import("../lib/types").FinanceOverview>(
      `/api/finance/overview?basis=${basis}`),
  dashboard: (params: {
    period?: string; date_from?: string; date_to?: string;
    // Which goal the Performance-vs-Target graph plots. Actual and target come
    // back in this metric's own units, so the two bars are comparable.
    target_metric?: string;
    // Narrows that graph to one employee; omit for the company total.
    target_employee_id?: string;
  } = {}) => api.get<import("../lib/types").FinanceDashboard>(
    `/api/finance/dashboard${qs(params)}`),
  balanceSheetList: (section: string, params: {
    period?: string; date_from?: string; date_to?: string; sort?: string;
    order?: "asc" | "desc"; q?: string; page?: number; page_size?: number;
  } = {}) => api.get<import("../lib/types").Page<
    import("../lib/types").BalanceSheetItem>>(
    `/api/finance/balance-sheet/${section}${qs(params)}`),
  balanceSheetDetail: (section: string, id: string, params: {
    period?: string; date_from?: string; date_to?: string;
  } = {}) => api.get<import("../lib/types").BalanceSheetDetail>(
    `/api/finance/balance-sheet/${section}/${id}${qs(params)}`),
  // Server-rendered themed PDF statement (broker / partner / customer).
  statementPdf: (section: string, id: string, params: {
    period?: string; date_from?: string; date_to?: string;
  } = {}) => api.get(
    `/api/finance/balance-sheet/${section}/${id}/statement.pdf${qs(params)}`,
    { responseType: "blob" }),
  statementUrl: (section: string, id: string, params: {
    period?: string; date_from?: string; date_to?: string;
  } = {}) =>
    `/api/finance/balance-sheet/${section}/${id}/statement.pdf${qs(params)}`,
  sendStatementWhatsapp: (section: string, id: string, params: {
    period?: string; date_from?: string; date_to?: string;
  } = {}) => api.post<{ ok: boolean; reason?: string }>(
    `/api/finance/balance-sheet/${section}/${id}/statement/whatsapp${qs(params)}`,
    {}),
  recordExpense: (body: {
    amount_paise: number; category: string; note?: string;
    occurred_at?: string; paid_to_employee_id?: string; paid_to_name?: string;
    reference?: string; attachment_doc_id?: string;
    bank_account_id?: string; idempotency_key?: string;
  }) => api.post<LedgerTxn>("/api/finance/expenses", body),
  editExpense: (id: string, body: {
    amount_paise?: number; category?: string; note?: string;
    occurred_at?: string; paid_to_employee_id?: string; paid_to_name?: string;
    reference?: string; bank_account_id?: string;
  }) => api.patch<LedgerTxn>(`/api/finance/expenses/${id}`, body),
  uploadTxnAttachment: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api.post<LedgerTxn>(`/api/finance/ledger/${id}/attachment`, fd,
      { headers: { "Content-Type": "multipart/form-data" } });
  },
  editLedger: (id: string, body: {
    amount_paise?: number; note?: string; reference?: string;
    occurred_at?: string;
    // Corrections. "" on bank_account_id detaches the row; party_type and
    // party_id must be sent together or the server refuses.
    bank_account_id?: string;
    party_type?: string; party_id?: string;
  }) => api.patch<LedgerTxn>(`/api/finance/ledger/${id}`, body),
  /*
    BULK IMPORT FROM A BANK STATEMENT.

    `preview` is called ONCE per file, and again each time the column mapping
    changes — there is no server-side staging between the two steps, so the file
    goes back up with the confirmed mapping. It is a few tens of KB and that is
    cheaper than a staging collection with a lifecycle nobody would maintain.
  */
  statementPreview: (file: File, bankAccountId: string,
                     mapping: Record<string, string | undefined> = {}) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("bank_account_id", bankAccountId);
    for (const [k, v] of Object.entries(mapping)) if (v) fd.append(k, v);
    return api.post<import("../lib/types").StatementPreview>(
      "/api/finance/statement-import/preview", fd,
      { headers: { "Content-Type": "multipart/form-data" } });
  },
  statementCommit: (body: import("../lib/types").StatementCommit) =>
    api.post<import("../lib/types").StatementCommitResult>(
      "/api/finance/statement-import/commit", body),
  cancelLedger: (id: string) =>
    api.post<LedgerTxn>(`/api/finance/ledger/${id}/cancel`, {}),
  deleteLedger: (id: string) =>
    api.delete(`/api/finance/ledger/${id}`),
  reports: (params: {
    dimension: string; date_from?: string; date_to?: string;
  }) => api.get<import("../lib/types").ReportResult>(
    `/api/finance/reports${qs(params)}`),
  insights: (params: {
    period?: string; date_from?: string; date_to?: string;
    insurer_id?: string; category_key?: string; partner_id?: string;
    employee_id?: string;
  } = {}) => api.get<import("../lib/types").InsightsResult>(
    `/api/finance/insights${qs(params)}`),
  tds: (params: { period?: string; date_from?: string; date_to?: string } = {}) =>
    api.get<import("../lib/types").TdsReport>(`/api/finance/tds${qs(params)}`),
  entity: (entityType: string, entityId: string) =>
    api.get<import("../lib/types").EntityProfile>(
      `/api/finance/entity/${entityType}/${entityId}`),
  recordPayment: (body: {
    txn_type: string; party_type: string; party_id: string;
    amount_paise: number; policy_id?: string; note?: string;
    reference?: string; occurred_at?: string;
    increases_receivable?: boolean;
    // Which account the money moved through (required once any account exists)
    // and the key that makes a double-click harmless.
    bank_account_id?: string; bank_direction?: number;
    idempotency_key?: string;
  }) => api.post<LedgerTxn>("/api/finance/payments", body),
  partnerDues: (params: { outstanding_only?: number } = {}) =>
    api.get<import("../lib/types").PartnerDues[]>(
      `/api/finance/partner-dues${qs(params)}`),
};

// --- Leads ---
export const leadsApi = {
  list: (params: ListParams = {}) =>
    api.get<Page<Lead>>(`/api/leads${qs(params)}`),
  create: (body: unknown) => api.post<Lead>("/api/leads", body),
  update: (id: string, body: unknown) =>
    api.patch<Lead>(`/api/leads/${id}`, body),
  setStage: (id: string, stage: string, lost_reason?: string) =>
    api.patch<Lead>(`/api/leads/${id}/stage`, { stage, lost_reason }),
  addComment: (id: string, body: string) =>
    api.post<Lead>(`/api/leads/${id}/comments`, { body }),
  // Counts behind the type tabs. Takes every filter EXCEPT type, so each tab
  // shows what it would give you under the search and stage already applied.
  counts: (params: { stage?: string; q?: string } = {}) =>
    api.get<import("../lib/types").LeadCounts>(`/api/leads/counts${qs(params)}`),
  // NOTE: there is no `convert`. Converting created a customer and deleted the
  // lead, which only made sense for one of the three lead types; a won lead is
  // now moved to the `converted` stage with setStage and stays in the list
  // (owner Q2.1a).
  remove: (id: string) => api.delete<{ detail: string }>(`/api/leads/${id}`),
  export: (params: {
    stage?: string; type?: string; q?: string; fmt?: string } = {}) =>
    api.get(`/api/leads/export${qs(params)}`, { responseType: "blob" }),
  activity: (days = 30) =>
    api.get<import("../lib/types").LeadActivityRow[]>(
      `/api/leads/activity/summary?days=${days}`),
  downloadTemplate: () =>
    api.get("/api/leads/import/template", { responseType: "blob" }),
  import: (file: File, onProgress?: (percent: number) => void) => {
    const fd = new FormData();
    fd.append("file", file);
    return api.post<import("../lib/types").LeadImportResult>(
      "/api/leads/import", fd,
      {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (e) => {
          if (onProgress && e.total) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        },
      }
    );
  },
};

// --- Rewards (formerly commissions) ---
export const rewardsApi = {
  list: (params: ListParams = {}) =>
    api.get<Page<Reward>>(`/api/rewards${qs(params)}`),
  setStatus: (id: string, status: string, reference?: string) =>
    api.patch<Reward>(`/api/rewards/${id}/status`, { status, reference }),
};

// --- Withdrawals (STAFF ONLY) ---
// There is no partner-facing wallet client any more: a partner has no wallet
// screen and cannot ask to be paid (owner A1, 2026-08-05). The team records the
// payout and it reaches the partner as a transaction on their earnings page.
export const withdrawalsApi = {
  list: (params: ListParams = {}) =>
    api.get<Page<Withdrawal>>(`/api/withdrawals${qs(params)}`),
  create: (amount_paise: number, note?: string) =>
    api.post<Withdrawal>("/api/withdrawals", { amount_paise, note }),
  act: (id: string, action: "approve" | "reject" | "pay",
       body: { reference?: string; reason?: string } = {}) =>
    api.patch<Withdrawal>(`/api/withdrawals/${id}`, { action, ...body }),
  // Staff-recorded payout to a partner — the ONLY way a payout happens.
  // Debits the wallet first; any amount ABOVE the reward balance is booked as
  // an advance the partner owes back.
  agencyPayout: (body: {
    partner_id: string; amount_paise: number;
    reference?: string; note?: string; occurred_at?: string;
    // Real cash leaving a real account, plus the key that makes a
    // double-clicked payout harmless.
    bank_account_id?: string; idempotency_key?: string;
  }) => api.post<import("../lib/types").AgencyPayoutResult>(
    "/api/wallet/payouts", body),
};

// --- Targets ---
export const targetsApi = {
  list: (assigneeId?: string) =>
    api.get<import("../lib/types").Target[]>(
      `/api/targets${assigneeId ? `?assignee_id=${assigneeId}` : ""}`),
  create: (body: unknown) => api.post("/api/targets", body),
  update: (id: string, body: unknown) => api.patch(`/api/targets/${id}`, body),
  remove: (id: string) => api.delete(`/api/targets/${id}`),
  // The dashboard tile: my own month, or the team's combined for the owner.
  progress: (params: { window?: string } = {}) =>
    api.get<import("../lib/types").TargetProgress>(
      `/api/targets/progress${qs(params)}`),
  // The leaderboard for one month — also what the Targets page assigns against.
  performance: (params: { month?: string; period?: string; kind?: string }) =>
    api.get<import("../lib/types").PerformanceReport>(
      `/api/targets/performance${qs(params)}`),
  // Assign a whole team's goals in one save (upsert; empty metrics = remove).
  bulk: (body: unknown) =>
    api.post<import("../lib/types").Target[]>("/api/targets/bulk", body),
  analytics: (assigneeId: string,
              params: { months?: number; metric?: string } = {}) =>
    api.get<import("../lib/types").AssigneeAnalytics>(
      `/api/targets/analytics/${assigneeId}${qs(params)}`),
};

// --- Notifications ---
export const notificationsApi = {
  list: (params: { unread_only?: number; limit?: number } = {}) =>
    api.get<import("../lib/types").AppNotification[]>(
      `/api/notifications${qs(params)}`),
  unreadCount: () =>
    api.get<{ count: number }>("/api/notifications/unread-count"),
  markRead: (id: string) =>
    api.post<import("../lib/types").AppNotification>(
      `/api/notifications/${id}/read`, {}),
  markAllRead: () => api.post("/api/notifications/read-all", {}),
  remove: (id: string) => api.delete(`/api/notifications/${id}`),
};

// --- Audit ---
export interface AuditFilters {
  action?: string; actor_id?: string; entity_type?: string; entity_id?: string;
  date_from?: string; date_to?: string; q?: string;
  page?: number; page_size?: number;
}
export const auditApi = {
  list: (params: AuditFilters = {}) =>
    api.get<Page<AuditEntry>>(`/api/audit${qs(params)}`),
  get: (id: string) => api.get<AuditEntry>(`/api/audit/${id}`),
  export: (params: AuditFilters & { fmt?: string } = {}) =>
    api.get(`/api/audit/export${qs(params)}`, { responseType: "blob" }),
};

// --- System (owner-only observability: API usage + errors) ---
export const systemApi = {
  usageSummary: (params: { date_from?: string; date_to?: string } = {}) =>
    api.get<import("../lib/types").ApiUsageSummary>(
      `/api/system/api-usage/summary${qs(params)}`),
  usageList: (params: {
    service?: string; success?: boolean; date_from?: string; date_to?: string;
    page?: number; page_size?: number;
  } = {}) => api.get<Page<import("../lib/types").ApiCallRow>>(
    `/api/system/api-usage${qs(params)}`),
  usageExport: (params: {
    fmt?: string; service?: string; date_from?: string; date_to?: string;
  } = {}) => api.get(`/api/system/api-usage/export${qs(params)}`,
    { responseType: "blob" }),
  errors: (params: { q?: string; page?: number; page_size?: number } = {}) =>
    api.get<Page<import("../lib/types").ErrorRow>>(
      `/api/system/errors${qs(params)}`),
  health: () => api.get<import("../lib/types").HealthStrip>(
    "/api/system/health"),
};

// --- Global quick search ---
export const searchApi = {
  query: (q: string) => api.get<{ hits: import("../lib/types").SearchHit[] }>(
    `/api/search${qs({ q })}`),
};


// --- Bank & cash accounts ---
// Gated on its own permission pair (view/manage_bank_accounts), not view_finance:
// the ledger says who owes what, this says how much money the house is holding.
export const banksApi = {
  list: (params: {
    include_inactive?: boolean; date_from?: string; date_to?: string;
  } = {}) => api.get<import("../lib/types").BankAccountList>(
    `/api/banks${qs(params)}`),
  totals: () => api.get<import("../lib/types").BankTotals>("/api/banks/totals"),
  create: (body: unknown) =>
    api.post<import("../lib/types").BankAccount>("/api/banks", body),
  update: (id: string, body: unknown) =>
    api.patch<import("../lib/types").BankAccount>(`/api/banks/${id}`, body),
  remove: (id: string) => api.delete(`/api/banks/${id}`),
  statement: (id: string, params: {
    date_from?: string; date_to?: string; page?: number; page_size?: number;
  } = {}) => api.get<Page<LedgerTxn>>(`/api/banks/${id}/statement${qs(params)}`),
  recompute: (id: string) =>
    api.post<import("../lib/types").BankAccount>(
      `/api/banks/${id}/recompute`, {}),
  // Make the balance match the real account by POSTING the difference as a
  // dated adjustment. Never an overwrite — see the endpoint's docstring and
  // schemas/bank.BankReconcile for why that cannot work.
  reconcile: (id: string, body: {
    actual_balance_paise: number; reason: string;
    occurred_at?: string; idempotency_key?: string;
  }) => api.post<import("../lib/types").BankReconcileResult>(
    `/api/banks/${id}/reconcile`, body),
  transfer: (body: {
    from_account_id: string; to_account_id: string; amount_paise: number;
    note?: string; reference?: string; occurred_at?: string;
    idempotency_key?: string;
  }) => api.post<import("../lib/types").TransferResult>(
    "/api/banks/transfers", body),
};

// --- Follow-up reminders ---
export const remindersApi = {
  list: (params: {
    entity_type?: string; entity_id?: string; scope?: string;
    status?: string; due?: string; assigned_to?: string; limit?: number;
  } = {}) => api.get<import("../lib/types").Reminder[]>(
    `/api/reminders${qs(params)}`),
  counts: (params: { scope?: string } = {}) =>
    api.get<import("../lib/types").ReminderCounts>(
      `/api/reminders/counts${qs(params)}`),
  create: (body: {
    entity_type: string; entity_id: string; title: string; note?: string;
    // Empty / omitted means "me". Several ids is one SHARED reminder, not a
    // copy each — see the Reminder type.
    due_at: string; assignee_ids?: string[];
  }) => api.post<import("../lib/types").Reminder>("/api/reminders", body),
  update: (id: string, body: unknown) =>
    api.patch<import("../lib/types").Reminder>(`/api/reminders/${id}`, body),
  done: (id: string) =>
    api.post<import("../lib/types").Reminder>(`/api/reminders/${id}/done`, {}),
  snooze: (id: string, days = 1) =>
    api.post<import("../lib/types").Reminder>(
      `/api/reminders/${id}/snooze${qs({ days })}`, {}),
  remove: (id: string) => api.delete(`/api/reminders/${id}`),
};

// --- Relationship managers (an employee and the partners under them) ---
// Replaces teamsApi (owner 2026-08-05). A VIEW, not a boundary: every in-house
// user can still open every record — this is only "whose numbers am I reading".
export const managersApi = {
  rollup: (params: Record<string, string | undefined> = {}) =>
    api.get<import("../lib/types").ManagerRollup>(`/api/managers${qs(params)}`),
  myPartners: (params: Record<string, string | undefined> = {}) =>
    api.get<import("../lib/types").ManagerRoster>(
      `/api/managers/me/partners${qs(params)}`),
  partners: (id: string, params: Record<string, string | undefined> = {}) =>
    api.get<import("../lib/types").ManagerRoster>(
      `/api/managers/${id}/partners${qs(params)}`),
  // The business behind the roster's totals. Without it the Team view could say
  // what a partner was GIVEN and what they TOTALLED, and show no line of the
  // actual policies — so "why is that number what it is" meant leaving for
  // /policies and filtering by partner, one at a time.
  myTeamPolicies: (params: Record<string, string | undefined> = {}) =>
    api.get<import("../lib/types").TeamPolicies>(
      `/api/managers/me/policies${qs(params)}`),
  teamPolicies: (id: string, params: Record<string, string | undefined> = {}) =>
    api.get<import("../lib/types").TeamPolicies>(
      `/api/managers/${id}/policies${qs(params)}`),
  // NOTE: there is deliberately no `reassign` here. Moving a partner to another
  // manager is a change to `relationship_manager_id`, which usersApi.update
  // already makes — audited, permission-checked, from the picker on the
  // partner's own page. There WAS a reassign() calling
  // POST /api/managers/{id}/partners/{id}, an endpoint the server has never
  // had; nothing called it, so nothing failed, and it sat here looking like a
  // supported way to do the thing the router explicitly refuses to duplicate.
};

// --- Business report (one download for a whole period) ---
// The whole business for a period in one file (Reports page, bottom section).
// The period presets are the app's shared ones — see components/finance
// /DateFilter and services/finance_reports.resolve_period on the server, which
// is the single place that knows what "last 3 months" means.
export const businessReportApi = {
  download: (params: {
    period?: string; date_from?: string; date_to?: string;
    fmt?: "excel" | "pdf";
  }) => api.get(`/api/reports/business-report${qs(params)}`,
    { responseType: "blob" }),
};

// --- Channel Partner portal (partner accounts only) ---
// The ONLY surface a partner can reach; every staff router refuses their token.
type PeriodQ = { period?: string; date_from?: string; date_to?: string };

// --- The Channel Partner portal ---
// A partner can WRITE exactly two things: a quote request and a claim.
// Everything else here is a read. Policies, premiums, rewards and payouts are
// written by staff on staff screens — see server/app/routers/portal.py.
export const portalApi = {
  summary: (params: PeriodQ = {}) =>
    api.get<PortalSummary>(`/api/portal/summary${qs(params)}`),
  profile: () => api.get<PortalProfile>("/api/portal/profile"),

  policies: (params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<PortalPolicy>>(`/api/portal/policies${qs(params)}`),
  policy: (id: string) =>
    api.get<PortalPolicyDetail>(`/api/portal/policies/${id}`),
  policyDocumentUrl: (policyId: string, documentId: string) =>
    api.get<{ url: string; expires_in: number }>(
      `/api/portal/policies/${policyId}/documents/${documentId}`),

  renewals: (days?: number) =>
    api.get<PortalRenewal[]>(`/api/portal/renewals${qs({ days })}`),

  earnings: (params: PeriodQ = {}) =>
    api.get<PortalEarnings>(`/api/portal/earnings${qs(params)}`),
  money: () => api.get<PortalMoney>("/api/portal/money"),
  // The partner's own target for one month. Its own request rather than a
  // field on /summary because the card has a month switcher and /summary's
  // window is a date filter over the policy book — see routers/portal.my_target.
  target: (window?: string) =>
    api.get<PortalTarget>(`/api/portal/target${qs({ window })}`),
  transactions: (params: PeriodQ = {}) =>
    api.get<PortalTransactions>(`/api/portal/transactions${qs(params)}`),

  quoteOptions: () =>
    api.get<PortalQuoteCategory[]>("/api/portal/quote-options"),
  quotes: (params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<PortalQuoteRequest>>(`/api/portal/quotes${qs(params)}`),
  quote: (id: string) =>
    api.get<PortalQuoteDetail>(`/api/portal/quotes/${id}`),
  raiseQuote: (body: PortalQuoteIn) =>
    api.post<PortalQuoteDetail>("/api/portal/quotes", body),
  uploadQuoteDocument: (id: string, file: File, label: string,
                        docKey?: string) => {
    const form = new FormData();
    form.append("file", file);
    return api.post<import("../lib/types").CustomerDocument>(
      `/api/portal/quotes/${id}/documents${qs({ label, doc_key: docKey })}`,
      form, { headers: { "Content-Type": "multipart/form-data" } });
  },
  replyOnQuote: (id: string, message: string) =>
    api.post<{ detail: string }>(`/api/portal/quotes/${id}/reply`, { message }),
  decideOnQuote: (id: string, body: {
    option_id: string; accept: boolean; reason?: string;
  }) => api.post<PortalQuoteDetail>(
    `/api/portal/quotes/${id}/decision`, body),
  cancelQuote: (id: string) =>
    api.post<{ detail: string }>(`/api/portal/quotes/${id}/cancel`, {}),
  // A partner could not open a document they had uploaded themselves until
  // 2026-08-19 — the screen showed an error telling them to ask their
  // relationship manager for a copy of their own photo.
  quoteDocumentUrl: (quoteId: string, documentId: string) =>
    api.get<{ url: string; expires_in: number }>(
      `/api/portal/quotes/${quoteId}/documents/${documentId}`),
  // "That quotation expired — please re-price it." Re-opens the SAME request.
  refreshQuote: (id: string) =>
    api.post<PortalQuoteDetail>(`/api/portal/quotes/${id}/refresh`, {}),

  claims: (params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<PortalClaim>>(`/api/portal/claims${qs(params)}`),
  claim: (id: string) =>
    api.get<PortalClaimDetail>(`/api/portal/claims/${id}`),
  raiseClaim: (body: PortalClaimIn) =>
    api.post<PortalClaimDetail>("/api/portal/claims", body),
  uploadClaimDocument: (id: string, file: File, label: string,
                        docKey?: string) => {
    const form = new FormData();
    form.append("file", file);
    return api.post<import("../lib/types").CustomerDocument>(
      `/api/portal/claims/${id}/documents${qs({ label, doc_key: docKey })}`,
      form, { headers: { "Content-Type": "multipart/form-data" } });
  },
  replyOnClaim: (id: string, message: string) =>
    api.post<{ detail: string }>(`/api/portal/claims/${id}/reply`, { message }),

  notices: () => api.get<PortalNotice[]>("/api/portal/notices"),
  markNoticeRead: (id: string) =>
    api.post<{ detail: string }>(`/api/portal/notices/${id}/read`, {}),
};

// --- Quote requests, staff side ---
export const quotesApi = {
  list: (params: Record<string, string | number | boolean | undefined> = {}) =>
    api.get<Page<StaffQuote>>(`/api/quotes${qs(params)}`),
  get: (id: string) => api.get<StaffQuoteDetail>(`/api/quotes/${id}`),
  documentUrl: (id: string, documentId: string) =>
    api.get<{ url: string; expires_in: number }>(
      `/api/quotes/${id}/documents/${documentId}`),
  pickUp: (id: string) =>
    api.post<StaffQuoteDetail>(`/api/quotes/${id}/claim`, {}),
  assign: (id: string, assigned_to_id: string | null) =>
    api.post<StaffQuoteDetail>(`/api/quotes/${id}/assign`,
      { assigned_to_id }),
  note: (id: string, message: string, requestInfo: boolean) =>
    api.post<StaffQuoteDetail>(`/api/quotes/${id}/note`,
      { message, request_info: requestInfo }),
  internalNotes: (id: string, internal_notes: string) =>
    api.patch<StaffQuoteDetail>(`/api/quotes/${id}/internal-notes`,
      { internal_notes }),
  sendQuote: (id: string, body: Record<string, unknown>) =>
    api.post<StaffQuoteDetail>(`/api/quotes/${id}/quote`, body),
  close: (id: string, stage: string, reason?: string) =>
    api.post<StaffQuoteDetail>(`/api/quotes/${id}/close`, { stage, reason }),
  markBooked: (id: string, policyId: string) =>
    api.post<StaffQuoteDetail>(
      `/api/quotes/${id}/booked${qs({ policy_id: policyId })}`, {}),
  export: (params: Record<string, string | number | boolean | undefined> = {}) =>
    api.get(`/api/quotes/export${qs(params)}`, { responseType: "blob" }),
};

// --- Claims, staff side ---
export const claimsApi = {
  list: (params: Record<string, string | number | boolean | undefined> = {}) =>
    api.get<Page<StaffClaim>>(`/api/claims${qs(params)}`),
  get: (id: string) => api.get<StaffClaimDetail>(`/api/claims/${id}`),
  documentUrl: (id: string, documentId: string) =>
    api.get<{ url: string; expires_in: number }>(
      `/api/claims/${id}/documents/${documentId}`),
  create: (body: Record<string, unknown>) =>
    api.post<StaffClaimDetail>("/api/claims", body),
  update: (id: string, body: Record<string, unknown>) =>
    api.patch<StaffClaimDetail>(`/api/claims/${id}`, body),
  setStage: (id: string, stage: string, message?: string) =>
    api.post<StaffClaimDetail>(`/api/claims/${id}/stage`,
      { stage, message }),
  note: (id: string, message: string) =>
    api.post<StaffClaimDetail>(`/api/claims/${id}/note`, { message }),
};

// --- Notices to channel partners (broadcasts) ---
export const announcementsApi = {
  list: (params: { page?: number; page_size?: number } = {}) =>
    api.get<Page<AnnouncementRow>>(`/api/announcements${qs(params)}`),
  get: (id: string) =>
    api.get<AnnouncementDetail>(`/api/announcements/${id}`),
  preview: (body: Record<string, unknown>) =>
    api.post<AudiencePreview>("/api/announcements/preview", body),
  send: (body: Record<string, unknown>) =>
    api.post<AnnouncementDetail>("/api/announcements", body),
  withdraw: (id: string) =>
    api.post<{ detail: string }>(`/api/announcements/${id}/withdraw`, {}),
};

/* =============================================================== Workplace HR ==
   Attendance, leave and holidays (2026-08-20).

   THREE APIS, ONE PER SIDEBAR PAGE, mirroring the three permission pairs behind
   them. Notice what is NOT here: there is no payslip call and no money endpoint
   of any kind. The owner dropped automated payroll on 2026-08-20 — the module
   records days and hours, and pay is worked out by hand from the month summary.

   Every "mine vs everybody" read defaults to MINE server-side, so a call that
   forgets the flag gets the safe answer rather than the whole agency's.
   ========================================================================== */

export const attendanceApi = {
  // My own day — the punch panel's whole state in one call.
  today: () => api.get<PunchState>("/api/hr/attendance/today"),
  // All four punches answer with the SAME PunchState the GET returns, so the
  // panel never needs a second round trip to find out what changed.
  // The body carries WHERE the browser thinks it is, and nothing else — the
  // server classifies it (services/hr_geo). Optional on purpose: a punch with
  // no location still succeeds and is recorded as unplaceable.
  punchIn: (where?: Fix | null) =>
    api.post<PunchState>("/api/hr/attendance/punch-in", where ?? {}),
  punchOut: (where?: Fix | null) =>
    api.post<PunchState>("/api/hr/attendance/punch-out", where ?? {}),
  breakStart: () =>
    api.post<PunchState>("/api/hr/attendance/break/start", {}),
  breakEnd: () => api.post<PunchState>("/api/hr/attendance/break/end", {}),

  // One person's month. `user_id` omitted = mine; somebody else's needs
  // view_attendance and is refused server-side otherwise.
  month: (params: { month?: string; user_id?: string } = {}) =>
    api.get<AttendanceMonth>(`/api/hr/attendance/month${qs(params)}`),
  // Today's board (view_attendance).
  teamDay: (params: { day?: string } = {}) =>
    api.get<TeamDay>(`/api/hr/attendance/team${qs(params)}`),
  // The month grid, with each person's summary on their row (view_attendance).
  teamMonth: (params: { month?: string } = {}) =>
    api.get<TeamMonth>(`/api/hr/attendance/team/month${qs(params)}`),

  // A manager correcting one day. The reason is mandatory server-side.
  editDay: (body: {
    user_id: string; day: string; clock_in?: string | null;
    clock_out?: string | null; status?: string | null; note?: string | null;
    reason: string;
  }) => api.patch<AttendanceDay>("/api/hr/attendance/day", body),

  // Paginated (owner 2026-09-12) — a queue running for months easily passes 25.
  corrections: (params: {
    mine?: boolean; status?: string; page?: number; page_size?: number;
  } = {}) => api.get<import("../lib/types").Page<AttendanceCorrection>>(
    `/api/hr/attendance/corrections${qs(params)}`),
  raiseCorrection: (body: {
    day: string; clock_in?: string | null; clock_out?: string | null;
    reason: string;
  }) => api.post<AttendanceCorrection>("/api/hr/attendance/corrections", body),
  decideCorrection: (id: string, approve: boolean, note?: string) =>
    api.post<AttendanceCorrection>(
      `/api/hr/attendance/corrections/${id}/decide`, { approve, note }),

  // The monthly register. Days and hours only — no rupee column.
  exportRegister: (params: { month?: string } = {}) =>
    api.get(`/api/hr/attendance/export${qs(params)}`, { responseType: "blob" }),
};

export const leaveApi = {
  balance: (params: { user_id?: string; leave_year?: number } = {}) =>
    api.get<LeaveBalance>(`/api/hr/leave/balance${qs(params)}`),
  // Every movement of the balance — the balance IS the sum of these, so this is
  // the explanation rather than a report about it. Paginated (owner
  // 2026-09-12) — a whole leave year of accrual + usage rows can pass 25.
  ledger: (params: {
    user_id?: string; leave_year?: number; page?: number; page_size?: number;
  } = {}) => api.get<import("../lib/types").Page<LeaveLedgerRow>>(
    `/api/hr/leave/ledger${qs(params)}`),
  adjust: (body: {
    user_id: string; days: number; reason: string; is_opening?: boolean;
  }) => api.post<LeaveBalance>("/api/hr/leave/balance/adjust", body),

  // Paginated (owner 2026-09-12) — the approval queue across every
  // employee's history easily passes 25.
  requests: (params: {
    mine?: boolean; status?: string; user_id?: string; month?: string;
    page?: number; page_size?: number;
  } = {}) => api.get<import("../lib/types").Page<LeaveRequest>>(
    `/api/hr/leave/requests${qs(params)}`),
  // Names and dates only. The reason stays between the applicant and whoever
  // approves it, so the schema has no field for it.
  whoIsOff: (days = 7) =>
    api.get<WhoIsOff[]>(`/api/hr/leave/who-is-off${qs({ days })}`),
  // What the request will cost, BEFORE it is sent. Going short on balance is
  // allowed and never blocked — it is just never a surprise.
  preview: (params: {
    start_date: string; end_date: string; day_part?: string; user_id?: string;
  }) => api.get<LeaveCostPreview>(`/api/hr/leave/preview${qs(params)}`),

  apply: (body: {
    start_date: string; end_date: string; day_part?: string;
    reason_type?: string; reason: string; user_id?: string;
  }) => api.post<LeaveRequest>("/api/hr/leave/requests", body),
  edit: (id: string, body: Record<string, unknown>) =>
    api.patch<LeaveRequest>(`/api/hr/leave/requests/${id}`, body),
  decide: (id: string, approve: boolean, note?: string) =>
    api.post<LeaveRequest>(`/api/hr/leave/requests/${id}/decide`,
      { approve, note }),
  cancel: (id: string) =>
    api.post<LeaveRequest>(`/api/hr/leave/requests/${id}/cancel`, {}),
};

export const holidaysApi = {
  // Open to every employee — a holiday list is not sensitive and everybody
  // needs it to plan.
  year: (year?: number) =>
    api.get<HolidayYear>(`/api/hr/holidays${qs({ year })}`),
  add: (body: { date: string; name: string; note?: string | null }) =>
    api.post<Holiday>("/api/hr/holidays", body),
  update: (id: string, body: Record<string, unknown>) =>
    api.patch<Holiday>(`/api/hr/holidays/${id}`, body),
  remove: (id: string) =>
    api.delete<{ detail: string }>(`/api/hr/holidays/${id}`),
  // 80% of a year's list repeats. Without this, January is fifteen rows of
  // re-typing, which is how the list stops being maintained.
  copyYear: (from_year: number, to_year: number) =>
    api.post<HolidayYear>("/api/hr/holidays/copy-year", { from_year, to_year }),
};

/* ========================================================= payroll (2026-08-24) */
//
// Payslips were dropped on 2026-08-20 and brought back four days later. The
// arithmetic is entirely server-side (`services/payroll`) — there is no
// client-side pay rule to drift from it, and there must not be one.
export const payslipsApi = {
  /** My own latest payslip and how many are unpaid. No flag needed — being told
   *  what you are owed is not a privilege. */
  mine: () => api.get<import("../lib/types").MyPayslips>(
    "/api/hr/payslips/mine"),
  // No `user_id` and no `month` means MY OWN history, which is the safe answer
  // a client that forgets a parameter should land on. Paginated (owner
  // 2026-09-12) — one payslip a month passes 25 well within a career here.
  list: (params: {
    user_id?: string; month?: string; status?: string;
    page?: number; page_size?: number;
  } = {}) => api.get<import("../lib/types").Page<import("../lib/types").Payslip>>(
    `/api/hr/payslips${qs(params)}`),
  get: (id: string) =>
    api.get<import("../lib/types").Payslip>(`/api/hr/payslips/${id}`),

  /** Everybody's payslip for one month, plus what it costs and what is stuck.
   *  Needs view_payslips. */
  run: (month: string) =>
    api.get<import("../lib/types").PayRun>(`/api/hr/payslips/run/${month}`),
  // Runs on its own from the daily job on and after the 1st; this is the manual
  // trigger for the month somebody corrected afterwards. `regenerate` re-reads
  // the register into existing DRAFTS and never touches a finalised or paid one.
  generate: (body: {
    month?: string; regenerate?: boolean; user_id?: string;
  }) => api.post<import("../lib/types").PayRun>(
    "/api/hr/payslips/generate", body),
  adjust: (id: string, amount_paise: number, note: string) =>
    api.patch<import("../lib/types").Payslip>(
      `/api/hr/payslips/${id}/adjust`, { amount_paise, note }),
  finalise: (month: string, payslip_ids: string[] = []) =>
    api.post<import("../lib/types").PayRun>(
      "/api/hr/payslips/finalise", { month, payslip_ids }),
  reopen: (id: string) =>
    api.post<import("../lib/types").Payslip>(
      `/api/hr/payslips/${id}/reopen`, {}),
  // Posts a real EXPENSE through the same path the Add-transaction form uses,
  // and tells the employee. Not a bookkeeping flag on the payslip.
  pay: (id: string, body: {
    bank_account_id?: string; reference?: string; occurred_at?: string;
    amount_paise?: number; idempotency_key?: string; notify?: boolean;
  }) => api.post<import("../lib/types").Payslip>(
    `/api/hr/payslips/${id}/pay`, body),
  cancel: (id: string) =>
    api.delete<{ detail: string }>(`/api/hr/payslips/${id}`),
  exportRun: (month: string) =>
    api.get(`/api/hr/payslips/run/${month}/export`, { responseType: "blob" }),
};

/* ============================================= pending transactions (2026-08-24) */
//
// Statement lines somebody parked instead of deciding. Resolving one goes
// through the importer's own posting path server-side, so a row decided on
// Tuesday and one decided in November produce the identical ledger entry.
export const pendingTxnsApi = {
  list: (params: {
    status?: string; bank_account_id?: string; import_batch_id?: string;
    limit?: number;
  } = {}) => api.get<import("../lib/types").PendingTxnList>(
    `/api/finance/pending-transactions${qs(params)}`),
  // Just the number, for the badge on Transactions. Its own endpoint because
  // the badge is read from every finance screen and must not drag rows with it.
  count: () => api.get<{ open_count: number }>(
    "/api/finance/pending-transactions/count"),
  resolve: (rows: import("../lib/types").PendingResolveRow[]) =>
    api.post<import("../lib/types").PendingResolveResult>(
      "/api/finance/pending-transactions/resolve", { rows }),
  setNote: (id: string, note: string | null) =>
    api.patch<import("../lib/types").PendingTxn>(
      `/api/finance/pending-transactions/${id}/note`, { note }),
  // A DELETE that does not delete: the row is marked discarded, with who and
  // why, and can be put back. The owner asked for the confirmation dialog
  // because "we don't want to delete any of the transactions actually".
  discard: (id: string, reason: string) =>
    api.delete<{ detail: string }>(
      `/api/finance/pending-transactions/${id}`, { data: { reason } }),
  restore: (id: string) =>
    api.post<import("../lib/types").PendingTxn>(
      `/api/finance/pending-transactions/${id}/restore`, {}),
};

/* ================================================ policy access (2026-08-24) */
export const policyAccessApi = {
  /** Policies matching `q` that I may NOT read. Answers the question a scoped
   *  list cannot: "is it not there, or is it not mine?" */
  search: (q: string) =>
    api.get<import("../lib/types").RestrictedSearch>(
      `/api/policy-access/search${qs({ q })}`),
  request: (policy_id: string, reason: string) =>
    api.post<import("../lib/types").PolicyAccessRequest>(
      "/api/policy-access", { policy_id, reason }),
  // `mine=true` is my own asks; `mine=false` is the approval queue.
  // Paginated (owner 2026-09-12) — a queue running for months easily passes 25.
  list: (params: {
    mine?: boolean; status?: string; page?: number; page_size?: number;
  } = {}) => api.get<import("../lib/types").Page<
    import("../lib/types").PolicyAccessRequest>>(
    `/api/policy-access${qs(params)}`),
  decide: (id: string, approve: boolean, hours = 12, note?: string) =>
    api.post<import("../lib/types").PolicyAccessRequest>(
      `/api/policy-access/${id}/decide`, { approve, hours, note }),
  revoke: (id: string) =>
    api.post<import("../lib/types").PolicyAccessRequest>(
      `/api/policy-access/${id}/revoke`, {}),
  cancel: (id: string) =>
    api.post<{ detail: string }>(`/api/policy-access/${id}/cancel`, {}),
};
