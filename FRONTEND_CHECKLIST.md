# Frontend Redesign & Compactness Checklist

## Spacing & Density Rules Applied
- **PageHeader**: Single compact line (`mb-3`, no bottom divider, `text-lg font-bold`), title + inline muted subtitle on left, compact action buttons (`h-8`) on right.
- **FilterToolbar**: Single compact row (`flex flex-wrap items-center gap-2`, NO Card wrapper/shadow/padding). Search input + 2–3 primary filters + "More filters" `Popover` + active removable filter chips.
- **DataTable**: Compact rows (`py-2` -> ~40–44px row height, `text-[13px]`), sticky header (`bg-muted/50`), tight cell padding (`px-3 py-2`), pagination footer.
- **Forms & Cards**: Compact `p-4` cards, `gap-3`/`gap-4` multi-column grids, `h-9` inputs, small clear labels.
- **AppLayout**: `px-4 py-3 sm:px-5 lg:px-6` main padding; `h-12` compact TopBar.

---

## Inventory & Progress

### 1. App Shell, Global Popups & Navigation
- [ ] `AppLayout.tsx` (compact sidebar, mobile Sheet drawer, tight main padding)
- [ ] `TopBar.tsx` (compact `h-12` bar, breadcrumbs, user dropdown)
- [ ] `TopBarSearch.tsx` + `SearchResults.tsx` (`Ctrl+K` global search)
- [ ] `NotificationBell.tsx` (popover + shadcn Dialog detail)
- [ ] `Confirm.tsx` (`confirmDialog` & `promptDialog` with shadcn Dialog)
- [ ] `PageHeader.tsx`, `FilterToolbar.tsx`, `DataTable.tsx`, `FormSection.tsx`, `StatCard.tsx`

### 2. Auth, Onboarding & Public
- [ ] `/login` (`LoginPage.tsx` + `AuthShell.tsx`)
- [ ] `/forgot-password` (`ForgotPasswordPage.tsx`)
- [ ] `/reset-password` (`ResetPasswordPage.tsx`)
- [ ] `/change-password` (`ChangePasswordPage.tsx`)
- [ ] `/onboarding` (`OnboardingPage.tsx` — 5-step wizard)
- [ ] `/upload/:token` (`PublicUploadPage.tsx`)

### 3. Dashboard
- [ ] `/dashboard` (`DashboardPage.tsx` — Owner, Employee, Channel Partner views)

### 4. Work (Leads, Customers, Policies, Renewals, Quotes)
- [ ] `/leads` (`LeadsListPage.tsx` — compact single-row filter + compact table)
- [ ] `/leads/new` & `/leads/:id/edit` (`LeadFormPage.tsx`)
- [ ] `/leads/import` (`LeadImportPage.tsx`)
- [ ] `/leads/:id` (`LeadDetailPage.tsx` + reminders/stage dialogs)
- [ ] `/leads/:id/reminders/new` & `/:reminderId` (`LeadReminderFormPage.tsx`)
- [ ] `/customers` (`CustomersListPage.tsx` — compact single-row filter + compact table)
- [ ] `/customers/new` & `/customers/:id/edit` (`CustomerFormPage.tsx` — optional mobile)
- [ ] `/customers/import` (`CustomerImportPage.tsx`)
- [ ] `/customers/:id` (`CustomerDetailPage.tsx` — Details, Summary, Policies, Documents)
- [ ] `/policies` (`PoliciesPage.tsx` — compact single-row toolbar + More filters popover + compact table)
- [ ] `/policies/new` (`PolicyFormPage.tsx` — compact multi-column, "Premium before tax (₹)", QuickAdd dialogs)
- [ ] `/policies/:id` (`PolicyDetailPage.tsx` + `PolicyDetailBody.tsx` + `PolicyDocuments.tsx`)
- [ ] `/policies?view=access-requests` (`PolicyAccess.tsx`)
- [ ] `/renewals` (`RenewalsPage.tsx` — compact KPIs + toolbar + table)
- [ ] `/renewals/:id` (`RenewPolicyPage.tsx` — editable Broker & Insurer + live rate preview)
- [ ] `/renewals/:id/history` (`RenewalHistoryPage.tsx`)
- [ ] `/quotes` (`QuotesPage.tsx` — compact tabs + toolbar + table)
- [ ] `/quotes/:id` (`QuoteDetailPage.tsx`)

### 5. Finance
- [ ] `/finance` (`FinanceOverviewPage.tsx` — compact KPIs, charts, pending summary)
- [ ] `/finance/reports` (`FinanceReportsPage.tsx` — paginated >100 users, compact filters + tables)
- [ ] `/finance/transactions` (`TransactionsPage.tsx` — compact toolbar + More filters + compact table)
- [ ] `/finance/transactions/new` (`RecordPaymentPage.tsx` + `RecordPaymentForm.tsx`)
- [ ] `/finance/transactions/import` (`StatementImportPage.tsx`)
- [ ] `/finance/transactions/pending` (`PendingTransactionsPage.tsx`)
- [ ] `/finance/transactions/:id` (`TransactionDetailPage.tsx`)
- [ ] `/finance/balance-sheet` (`BalanceSheetPage.tsx`)
- [ ] `/finance/custom-parties` & `/:id` (`CustomPartiesPage.tsx` — Khata + Add Party & Log Payment dialogs)
- [ ] `/finance/entity/:type/:id` (`EntityFinancePage.tsx`)
- [ ] `/finance/tds` (`TdsPage.tsx`)
- [ ] `/finance/banks` (`BanksPage.tsx` + `ReconcileDialog.tsx`)
- [ ] `/finance/banks/new` & `/:id/edit` (`BankAccountFormPage.tsx`)
- [ ] `/finance/banks/transfer` (`BankTransferPage.tsx`)
- [ ] `/finance/banks/:id/statement` (`BankStatementPage.tsx`)

### 6. Workplace HR & People
- [ ] `/people/employees` (`EmployeesPage.tsx`)
- [ ] `/people/employees/new` (`AddEmployeePage.tsx`)
- [ ] `/people/employees/:id` (`PersonDetailPage.tsx`)
- [ ] `/people/employees/:id/targets` (`PersonTargetsPage.tsx`)
- [ ] `/people/employees/:id/performance` (`PersonPerformancePage.tsx`)
- [ ] `/people/partners` (`ChannelPartnersPage.tsx` + `PartnerRoster.tsx`)
- [ ] `/people/partners/new` (`AddPartnerPage.tsx`)
- [ ] `/people/partners/:id` (`PersonDetailPage.tsx`)
- [ ] `/people/partners/:id/targets` (`PersonTargetsPage.tsx`)
- [ ] `/people/partners/:id/performance` (`PersonPerformancePage.tsx`)
- [ ] `/targets` (`TargetsPage.tsx`)
- [ ] `/hr/attendance` (`AttendancePage.tsx` — owner lands on Today, no clock-in; Edit/Correction dialogs)
- [ ] `/hr/leave` (`LeavePage.tsx` + `LeaveForm.tsx` dialog)
- [ ] `/hr/payslips` (`PayslipsPage.tsx` + `PayslipDetail.tsx`)
- [ ] `/hr/holidays` (`HolidaysPage.tsx` + Add/Edit Holiday dialog)
- [ ] `/documents` (`DocumentsPage.tsx`)

### 7. Administration, Catalog, Settings, Help
- [ ] `/organization` (`MyOrganizationPage.tsx` — Roles & Permissions)
- [ ] `/organization/roles/new` & `/:id/edit` (`RoleFormPage.tsx`)
- [ ] `/insurers` (`InsurersPage.tsx`)
- [ ] `/insurers/new` & `/:id/edit` (`InsurerFormPage.tsx`)
- [ ] `/brokers` (`BrokersPage.tsx` + `RateRulesPanel.tsx`)
- [ ] `/brokers/new` & `/:id/edit` (`BrokerFormPage.tsx`)
- [ ] `/insurance/policy-types` (`PolicyTypesPage.tsx`)
- [ ] `/insurance/policy-types/new` & `/:id` (`PolicyTypeFormPage.tsx` — sub-type tree + field order manager)
- [ ] `/audit` (`AuditPage.tsx`)
- [ ] `/audit/:id` (`AuditDetailPage.tsx`)
- [ ] `/settings` (`SettingsPage.tsx`)
- [ ] `/settings/profile`, `/settings/email`, `/settings/password` (`SettingsFormPages.tsx`)
- [ ] `/settings/attendance` (`AttendanceSettingsPage.tsx`)
- [ ] `/settings/partner-portal` (`PartnerPortalSettingsPage.tsx`)
- [ ] `/help` (`HelpPage.tsx`)
- [ ] `*` (`NotFoundPage.tsx`)

### 8. Channel Partner Portal
- [ ] `/portal/policies` & `/:id` (`PortalPoliciesPage.tsx`)
- [ ] `/portal/renewals` (`PortalRenewalsPage.tsx`)
- [ ] `/portal/quotes`, `/portal/quotes/new`, `/:id` (`PortalQuotesPage.tsx`)
- [ ] `/portal/earnings` (`PortalEarningsPage.tsx`)
- [ ] `/portal/notices` (`PortalNoticesPage.tsx`)
