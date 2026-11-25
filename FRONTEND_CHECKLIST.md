# Frontend Redesign & Compactness Checklist

## Spacing & Density Rules Applied
- **PageHeader**: Single compact line (`mb-3`, no bottom border divider, `text-lg font-bold`), title + inline muted subtitle on left, compact action buttons (`h-8`) on right.
- **FilterToolbar**: Single compact row (`flex flex-wrap items-center gap-2`, NO Card wrapper/shadow/padding). Search input + 2–3 primary filters + "More filters" `Popover` + active removable filter chips.
- **DataTable**: Compact rows (`py-2` -> ~40–44px row height, `text-[13px]`), sticky header (`bg-muted/80`), tight cell padding (`px-3 py-2`), pagination footer.
- **Forms & Cards**: Compact `p-4` cards, `gap-x-4 gap-y-3` multi-column grids, `h-9` inputs, small clear labels.
- **AppLayout**: `px-4 py-3 sm:px-5 lg:px-6` main padding; `h-12` compact TopBar; `overflow-x-hidden` on main column.

---

## Inventory & Progress

### 1. App Shell, Global Popups & Navigation
- [x] `AppLayout.tsx` (compact light-mode sidebar, mobile Sheet drawer, tight main padding)
- [x] `TopBar.tsx` (compact `h-12` bar, breadcrumbs, user dropdown)
- [x] `TopBarSearch.tsx` + `SearchResults.tsx` (`Ctrl+K` global search)
- [x] `NotificationBell.tsx` (popover + shadcn Dialog detail via `Modal`)
- [x] `Confirm.tsx` (`confirmDialog` & `promptDialog` with shadcn `Dialog`)
- [x] `PageHeader.tsx`, `FilterToolbar.tsx`, `DataTable.tsx`, `FormSection.tsx`, `StatCard.tsx`, `InfoTooltip.tsx`

### 2. Auth, Onboarding & Public
- [x] `/login` (`LoginPage.tsx` + `AuthShell.tsx`)
- [x] `/forgot-password` (`ForgotPasswordPage.tsx`)
- [x] `/reset-password` (`ResetPasswordPage.tsx`)
- [x] `/change-password` (`ChangePasswordPage.tsx`)
- [x] `/onboarding` (`OnboardingPage.tsx` — 5-step wizard with `Progress`)
- [x] `/upload/:token` (`PublicUploadPage.tsx`)

### 3. Dashboard
- [x] `/dashboard` (`DashboardPage.tsx` — Owner, Employee, Channel Partner views)

### 4. Work (Leads, Customers, Policies, Renewals, Quotes)
- [x] `/leads` (`LeadsListPage.tsx` — compact `FilterToolbar` + `DataTable`)
- [x] `/leads/new` & `/leads/:id/edit` (`LeadFormPage.tsx`)
- [x] `/leads/import`, `/leads/:id`, `/leads/:id/reminders/*` (inherits compact `PageHeader` & `Modal` -> `Dialog`)
- [x] `/customers` (`CustomersListPage.tsx` — compact `FilterToolbar` + "More filters" + `DataTable`)
- [x] `/customers/new` & `/customers/:id/edit` (`CustomerFormPage.tsx` — optional mobile)
- [x] `/customers/:id` (`CustomerDetailPage.tsx` — shadcn `Tabs`)
- [x] `/customers/import` (inherits compact `PageHeader`)
- [x] `/policies` (`PoliciesPage.tsx` — compact `FilterToolbar` + "More filters" + `DataTable`, 13 rows above fold)
- [x] `/policies/new` (`PolicyFormPage.tsx` — "Premium before tax (₹)", QuickAdd dialogs)
- [x] `/policies/:id` & `?view=access-requests` (inherits compact `PageHeader` & `Modal` -> `Dialog`)
- [x] `/renewals` (`RenewalsPage.tsx` — compact `StatCard` + `FilterToolbar` + `DataTable`)
- [x] `/renewals/:id` (`RenewPolicyPage.tsx` — editable Broker & Insurer + live rate preview)
- [x] `/renewals/:id/history` (inherits compact `PageHeader`)
- [x] `/quotes` (`QuotesPage.tsx` — compact `Tabs` + `FilterToolbar` + `DataTable`)
- [x] `/quotes/:id` (inherits compact `PageHeader` & `Modal` -> `Dialog`)

### 5. Finance
- [x] `/finance` (`FinanceOverviewPage.tsx` — compact `PageHeader` + `Modal` -> `Dialog`)
- [x] `/finance/reports` (`FinanceReportsPage.tsx` — paginated >100 users, no 422)
- [x] `/finance/transactions` (`TransactionsPage.tsx` — compact `FilterToolbar` + "More filters" + `DataTable`)
- [x] `/finance/transactions/new`, `/import`, `/pending`, `/:id` (inherits compact `PageHeader` & `Modal` -> `Dialog`)
- [x] `/finance/balance-sheet` & `/finance/entity/:type/:id` (inherits compact `PageHeader` & `Modal` -> `Dialog`)
- [x] `/finance/custom-parties` & `/:id` (`CustomPartiesPage.tsx` — Khata + `Modal` -> `Dialog`)
- [x] `/finance/tds` (`TdsPage.tsx` — `StatCard` + `DataTable`)
- [x] `/finance/banks` & `/new`, `/:id/edit`, `/transfer`, `/:id/statement` (inherits compact `PageHeader` & `ReconcileDialog` -> `Dialog`)

### 6. Workplace HR & People
- [x] `/people/employees` (`EmployeesPage.tsx` — compact `PageHeader` + `Tabs`)
- [x] `/people/partners` (`ChannelPartnersPage.tsx` — compact `PageHeader` + `Tabs`)
- [x] `/people/employees/*`, `/people/partners/*`, `/targets` (inherits compact `PageHeader` & `Modal` -> `Dialog`)
- [x] `/hr/attendance` (`AttendancePage.tsx` — owner lands on Today, no clock-in; `Tabs` + `DataTable` + `Dialog`s)
- [x] `/hr/leave`, `/hr/payslips`, `/hr/holidays` (inherits compact `PageHeader` & `Modal` -> `Dialog`)
- [x] `/documents` (`DocumentsPage.tsx` — compact `Card` layout)

### 7. Administration, Catalog, Settings, Help
- [x] `/organization` & `/organization/roles/*` (`MyOrganizationPage.tsx` — shadcn `Card` + `Badge`)
- [x] `/insurers` & `/insurers/*` (`InsurersPage.tsx` — compact `FilterToolbar` + `DataTable`)
- [x] `/brokers` & `/brokers/*` (`BrokersPage.tsx` — compact `FilterToolbar` + `DataTable` + `RateRulesPanel`)
- [x] `/insurance/policy-types` & `/*` (`PolicyTypesPage.tsx` + `PolicyTypeFormPage.tsx` — sub-type tree + field order manager)
- [x] `/audit` & `/audit/:id` (`AuditPage.tsx` — compact `FilterToolbar` + "More filters" + `DataTable`)
- [x] `/settings` & `/settings/*` (`SettingsPage.tsx` — `Avatar` + `Card` groups)
- [x] `/help` (`HelpPage.tsx` — compact `Select` + `Card`)
- [x] `*` (`NotFoundPage.tsx`)

### 8. Channel Partner Portal
- [x] `/portal/policies`, `/portal/renewals`, `/portal/quotes`, `/portal/earnings`, `/portal/notices` (inherits compact `AppLayout`, `PageHeader`, `Modal` -> `Dialog`)
