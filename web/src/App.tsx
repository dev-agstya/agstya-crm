import { useEffect } from "react";
import {
  Navigate, Route, Routes, useLocation, useNavigate, useParams,
} from "react-router-dom";
import { useAuth } from "./store/auth";
import { tokenStore } from "./api/client";
import { ToastHost, toast } from "./components/Toast";
import { ConfirmHost } from "./components/Confirm";
import { PageLoader } from "./components/ui";
import { canAccess, gateForPath, lockedFeatureAt } from "./lib/access";
import { AppLayout } from "./components/layout/AppLayout";
import LoginPage from "./pages/auth/LoginPage";
import ForgotPasswordPage from "./pages/auth/ForgotPasswordPage";
import ResetPasswordPage from "./pages/auth/ResetPasswordPage";
import ChangePasswordPage from "./pages/auth/ChangePasswordPage";
import PublicUploadPage from "./pages/PublicUploadPage";
import DashboardPage from "./pages/DashboardPage";
import CustomersListPage from "./pages/customers/CustomersListPage";
import CustomerDetailPage from "./pages/customers/CustomerDetailPage";
import CustomerFormPage from "./pages/customers/CustomerFormPage";
import CustomerImportPage from "./pages/customers/CustomerImportPage";
import PoliciesPage from "./pages/PoliciesPage";
import LeadsListPage from "./pages/leads/LeadsListPage";
import LeadDetailPage from "./pages/leads/LeadDetailPage";
import LeadFormPage from "./pages/leads/LeadFormPage";
import LeadImportPage from "./pages/leads/LeadImportPage";
import LeadReminderFormPage from "./pages/leads/LeadReminderFormPage";
import InsurersPage from "./pages/InsurersPage";
import InsurerFormPage from "./pages/catalog/InsurerFormPage";
import BrokersPage from "./pages/BrokersPage";
import BrokerFormPage from "./pages/catalog/BrokerFormPage";
import MyOrganizationPage from "./pages/MyOrganizationPage";
import RoleFormPage from "./pages/org/RoleFormPage";
import AuditPage from "./pages/AuditPage";
import AuditDetailPage from "./pages/audit/AuditDetailPage";
// System & Usage is paused (owner 2026-07-17). The page itself is finished and
// kept on disk; re-enabling it means restoring this import and its route, and
// dropping `locked` from the nav entry in lib/access.ts.
// import SystemPage from "./pages/SystemPage";
import SettingsPage from "./pages/SettingsPage";
import {
  ChangePasswordSettingsPage, EditEmailPage, EditProfilePage,
} from "./pages/settings/SettingsFormPages";
import HelpPage from "./pages/HelpPage";
import EmployeesPage from "./pages/EmployeesPage";
import PersonDetailPage from "./pages/people/PersonDetailPage";
import AddEmployeePage from "./pages/people/AddEmployeePage";
import AddPartnerPage from "./pages/people/AddPartnerPage";
import PartnerPortalSettingsPage from "./pages/people/PartnerPortalSettingsPage";
import PersonTargetsPage from "./pages/people/PersonTargetsPage";
import PersonPerformancePage from "./pages/people/PersonPerformancePage";
import ChannelPartnersPage from "./pages/ChannelPartnersPage";
import TransactionsPage from "./pages/TransactionsPage";
import TransactionDetailPage from "./pages/finance/TransactionDetailPage";
import RecordPaymentPage from "./pages/finance/RecordPaymentPage";
import StatementImportPage from "./pages/finance/StatementImportPage";
import PendingTransactionsPage from
  "./pages/finance/PendingTransactionsPage";
import PolicyDetailPage from "./pages/policies/PolicyDetailPage";
import PolicyFormPage from "./pages/policies/PolicyFormPage";
import FinanceOverviewPage from "./pages/FinanceOverviewPage";
import FinanceReportsPage from "./pages/FinanceReportsPage";
import BalanceSheetPage from "./pages/BalanceSheetPage";
import EntityFinancePage from "./pages/EntityFinancePage";
import RenewalsPage from "./pages/RenewalsPage";
import RenewPolicyPage from "./pages/renewals/RenewPolicyPage";
import RenewalHistoryPage from "./pages/renewals/RenewalHistoryPage";
// Third Party Services is paused (owner 2026-07-17) — same arrangement as
// System & Usage above.
// import ServicesPage from "./pages/ServicesPage";
import OnboardingPage from "./pages/OnboardingPage";
import DocumentsPage from "./pages/DocumentsPage";
import PolicyTypesPage from "./pages/PolicyTypesPage";
import PolicyTypeFormPage, {
  AddPolicyTypePage,
} from "./pages/catalog/PolicyTypeFormPage";
import TdsPage from "./pages/TdsPage";
import BanksPage from "./pages/BanksPage";
import BankAccountFormPage from "./pages/finance/BankAccountFormPage";
import BankTransferPage from "./pages/finance/BankTransferPage";
import BankStatementPage from "./pages/finance/BankStatementPage";
import QuotesPage from "./pages/quotes/QuotesPage";
import QuoteDetailPage from "./pages/quotes/QuoteDetailPage";
import {
  PortalPoliciesPage, PortalPolicyDetailPage,
} from "./pages/portal/PortalPoliciesPage";
import {
  PortalQuoteDetailPage, PortalQuoteFormPage, PortalQuotesPage,
} from "./pages/portal/PortalQuotesPage";
import PortalRenewalsPage from "./pages/portal/PortalRenewalsPage";
import PortalEarningsPage from "./pages/portal/PortalEarningsPage";
import PortalNoticesPage from "./pages/portal/PortalNoticesPage";
import TargetsPage from "./pages/TargetsPage";
// Workplace HR, live 2026-08-20. Payslips deliberately have NO page — the owner
// dropped automated payroll in the same conversation that specified the rest,
// so that nav entry stays locked and the attendance register's month summary is
// what pay is worked out from by hand.
import AttendancePage from "./pages/hr/AttendancePage";
import LeavePage from "./pages/hr/LeavePage";
import HolidaysPage from "./pages/hr/HolidaysPage";
import PayslipsPage from "./pages/hr/PayslipsPage";
import AttendanceSettingsPage from "./pages/settings/AttendanceSettingsPage";
import NotFoundPage from "./pages/NotFoundPage";

function Protected({ children }: { children: JSX.Element }) {
  const { user, initialized } = useAuth();
  if (!initialized) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  // Employees/partners finish a first-login onboarding wizard (which also sets
  // their password) before reaching the app.
  if (user.onboarded === false && user.account_type !== "owner")
    return <Navigate to="/onboarding" replace />;
  if (user.must_change_password) return <Navigate to="/change-password" replace />;
  return children;
}

// Page-level access guard. The sidebar already hides links a user can't use, but
// a URL can be typed directly — so every gated route is also enforced here. The
// gate comes from lib/access.ts (same source the sidebar uses). Denied users are
// bounced to the Dashboard (visible to every account) with a notice.
function Guard({ path, children }: { path: string; children: JSX.Element }) {
  const { user, has } = useAuth();
  const gate = gateForPath(path);
  const ok = !gate || canAccess(gate, user?.account_type, has);
  useEffect(() => {
    if (!ok) toast.error("You don't have access to that page.");
  }, [ok]);
  if (!ok) return <Navigate to="/dashboard" replace />;
  return children;
}

// /people/managers/:id used to be a manager's own screen. That screen is now the
// Team tab on their employee record — same data, one fewer page — so an old
// link lands exactly where it used to, on the tab it used to be. (The tab was
// called "Partners" until 2026-08-06; both spellings of the query still open
// it, but new links use the current name.)
function ManagerRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={`/people/employees/${id}?tab=team`} replace />;
}

// Catch-all inside the app shell. A coming-soon path says so by name and bounces
// to the dashboard (a locked bookmark shouldn't look like the app broke — owner
// A3); any other unknown URL renders the 404 page.
function UnknownRoute() {
  const { pathname } = useLocation();
  const feature = lockedFeatureAt(pathname);
  useEffect(() => {
    if (feature) toast.info(`${feature} isn't available yet — coming soon.`);
  }, [feature]);
  if (feature) return <Navigate to="/dashboard" replace />;
  return <NotFoundPage />;
}

export default function App() {
  const { loadMe, initialized, setUser } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // Global forced-logout event from the axios interceptor.
  useEffect(() => {
    const onLogout = () => {
      tokenStore.clear();
      setUser(null);
      navigate("/login");
    };
    window.addEventListener("auth:logout", onLogout);
    return () => window.removeEventListener("auth:logout", onLogout);
  }, [navigate, setUser]);

  if (!initialized) return <PageLoader />;

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/upload/:token" element={<PublicUploadPage />} />

        <Route
          element={
            <Protected>
              <AppLayout />
            </Protected>
          }
        >
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/customers"
            element={<Guard path="/customers"><CustomersListPage /></Guard>} />
          <Route path="/customers/new"
            element={<Guard path="/customers"><CustomerFormPage /></Guard>} />
          <Route path="/customers/import"
            element={<Guard path="/customers"><CustomerImportPage /></Guard>} />
          <Route path="/customers/:id"
            element={<Guard path="/customers"><CustomerDetailPage /></Guard>} />
          <Route path="/customers/:id/edit"
            element={<Guard path="/customers"><CustomerFormPage /></Guard>} />
          <Route path="/policies"
            element={<Guard path="/policies"><PoliciesPage /></Guard>} />
          <Route path="/policies/new"
            element={<Guard path="/policies"><PolicyFormPage /></Guard>} />
          <Route path="/policies/:id"
            element={<Guard path="/policies"><PolicyDetailPage /></Guard>} />
          {/* Leads. The detail / add / edit / import screens are PAGES, not
              dialogs (owner 2026-08-03): a record you can link to, refresh and
              open in a second tab. Static segments (new, import) are declared
              before /:id so the dynamic one cannot shadow them. */}
          <Route path="/leads"
            element={<Guard path="/leads"><LeadsListPage /></Guard>} />
          <Route path="/leads/new"
            element={<Guard path="/leads"><LeadFormPage /></Guard>} />
          <Route path="/leads/import"
            element={<Guard path="/leads"><LeadImportPage /></Guard>} />
          <Route path="/leads/:id"
            element={<Guard path="/leads"><LeadDetailPage /></Guard>} />
          <Route path="/leads/:id/edit"
            element={<Guard path="/leads"><LeadFormPage /></Guard>} />
          <Route path="/leads/:id/reminders/new"
            element={<Guard path="/leads"><LeadReminderFormPage /></Guard>} />
          <Route path="/leads/:id/reminders/:reminderId"
            element={<Guard path="/leads"><LeadReminderFormPage /></Guard>} />
          <Route path="/insurers"
            element={<Guard path="/insurers"><InsurersPage /></Guard>} />
          <Route path="/insurers/new"
            element={<Guard path="/insurers"><InsurerFormPage /></Guard>} />
          <Route path="/insurers/:id/edit"
            element={<Guard path="/insurers"><InsurerFormPage /></Guard>} />
          <Route path="/brokers"
            element={<Guard path="/brokers"><BrokersPage /></Guard>} />
          <Route path="/brokers/new"
            element={<Guard path="/brokers"><BrokerFormPage /></Guard>} />
          <Route path="/brokers/:id/edit"
            element={<Guard path="/brokers"><BrokerFormPage /></Guard>} />
          <Route path="/organization"
            element={<Guard path="/organization"><MyOrganizationPage /></Guard>} />
          <Route path="/organization/roles/new"
            element={<Guard path="/organization"><RoleFormPage /></Guard>} />
          <Route path="/organization/roles/:id/edit"
            element={<Guard path="/organization"><RoleFormPage /></Guard>} />
          <Route path="/people/employees"
            element={<Guard path="/people/employees"><EmployeesPage /></Guard>} />
          <Route path="/people/employees/new"
            element={<Guard path="/people/employees">
              <AddEmployeePage /></Guard>} />
          <Route path="/people/employees/:id"
            element={<Guard path="/people/employees">
              <PersonDetailPage kind="employee" /></Guard>} />
          <Route path="/people/employees/:id/targets"
            element={<Guard path="/people/employees">
              <PersonTargetsPage kind="employee" /></Guard>} />
          <Route path="/people/employees/:id/performance"
            element={<Guard path="/people/employees">
              <PersonPerformancePage kind="employee" /></Guard>} />
          <Route path="/people/partners"
            element={<Guard path="/people/partners"><ChannelPartnersPage /></Guard>} />
          <Route path="/people/partners/new"
            element={<Guard path="/people/partners/new">
              <AddPartnerPage /></Guard>} />
          {/* The portal's settings moved to /settings/partner-portal
              (owner 2026-08-06). This URL was linked from a button above the
              Channel Partners list for weeks — redirect rather than 404. */}
          <Route path="/people/partners/portal"
            element={<Navigate to="/settings/partner-portal" replace />} />
          <Route path="/people/partners/:id"
            element={<Guard path="/people/partners">
              <PersonDetailPage kind="channel_partner" /></Guard>} />
          <Route path="/people/partners/:id/targets"
            element={<Guard path="/people/partners">
              <PersonTargetsPage kind="channel_partner" /></Guard>} />
          <Route path="/people/partners/:id/performance"
            element={<Guard path="/people/partners">
              <PersonPerformancePage kind="channel_partner" /></Guard>} />
          {/* "My Partners" was its own page rendering the roster panel. That
              panel is now the "My Team" VIEW of the Channel Partners page
              (owner G1/G2), so this is one page rather than two — and the URL
              was in the sidebar for weeks, so it redirects to that view rather
              than 404ing. */}
          <Route path="/people/my-partners"
            element={<Navigate to="/people/partners?view=team" replace />} />
          {/*
            "Relationship Managers" was its own page with its own league table
            and its own per-manager screen. The owner's verdict (2026-08-05) was
            that it "doesn't need to be a separate page" — so the league table
            is the Performance view of Employees, and one manager's roster is
            the Partners tab on their record.

            Both old URLs redirect rather than 404: they were linked from the
            nav for weeks and somebody has them bookmarked.
          */}
          <Route path="/people/managers"
            element={<Navigate to="/people/employees?view=performance"
              replace />} />
          <Route path="/people/managers/:id"
            element={<ManagerRedirect />} />
          <Route path="/targets"
            element={<Guard path="/targets"><TargetsPage /></Guard>} />
          <Route path="/audit"
            element={<Guard path="/audit"><AuditPage /></Guard>} />
          <Route path="/audit/:id"
            element={<Guard path="/audit"><AuditDetailPage /></Guard>} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/profile" element={<EditProfilePage />} />
          <Route path="/settings/email" element={<EditEmailPage />} />
          <Route path="/settings/password"
            element={<ChangePasswordSettingsPage />} />
          <Route path="/settings/partner-portal"
            element={<Guard path="/settings/partner-portal">
              <PartnerPortalSettingsPage /></Guard>} />
          <Route path="/settings/attendance"
            element={<Guard path="/settings/attendance">
              <AttendanceSettingsPage /></Guard>} />
          <Route path="/help" element={<HelpPage />} />

          {/* Workplace HR. All three are open to every employee: the punch
              clock, your own register, your own leave and the holiday list need
              no permission at all (owner G2). The `view_*` flags decide whose
              numbers you may read once you are on the page, and the server
              scopes every query to the caller without them — so hiding a tab is
              UX, never the gate. */}
          <Route path="/hr/attendance"
            element={<Guard path="/hr/attendance"><AttendancePage /></Guard>} />
          <Route path="/hr/leave"
            element={<Guard path="/hr/leave"><LeavePage /></Guard>} />
          <Route path="/hr/holidays"
            element={<Guard path="/hr/holidays"><HolidaysPage /></Guard>} />
          <Route path="/hr/payslips"
            element={<Guard path="/hr/payslips"><PayslipsPage /></Guard>} />

          {/* Coming-soon sections (Claims, Follow-ups & Tasks, the four HR
              pages, Targets, Third Party Services, System & Usage, Contact
              Support and Feedback) deliberately have NO route. Their sidebar
              entries are inert, and a typed URL is handled by the catch-all
              below. */}
          <Route path="/renewals"
            element={<Guard path="/renewals"><RenewalsPage /></Guard>} />
          <Route path="/renewals/:id"
            element={<Guard path="/renewals"><RenewPolicyPage /></Guard>} />
          <Route path="/renewals/:id/history"
            element={<Guard path="/renewals"><RenewalHistoryPage /></Guard>} />
          <Route path="/finance"
            element={<Guard path="/finance">
              <FinanceOverviewPage /></Guard>} />
          <Route path="/finance/transactions"
            element={<Guard path="/finance/transactions">
              <TransactionsPage /></Guard>} />
          <Route path="/finance/transactions/new"
            element={<Guard path="/finance/transactions">
              <RecordPaymentPage /></Guard>} />
          {/* STATIC BEFORE DYNAMIC — /import and /pending must be registered
              above /:id or the detail route matches them as transaction ids. */}
          <Route path="/finance/transactions/import"
            element={<Guard path="/finance/transactions">
              <StatementImportPage /></Guard>} />
          <Route path="/finance/transactions/pending"
            element={<Guard path="/finance/transactions">
              <PendingTransactionsPage /></Guard>} />
          <Route path="/finance/transactions/:id"
            element={<Guard path="/finance/transactions">
              <TransactionDetailPage /></Guard>} />
          <Route path="/finance/reports"
            element={<Guard path="/finance/reports">
              <FinanceReportsPage /></Guard>} />
          <Route path="/finance/balance-sheet"
            element={<Guard path="/finance/balance-sheet">
              <BalanceSheetPage /></Guard>} />
          <Route path="/finance/tds"
            element={<Guard path="/finance/tds"><TdsPage /></Guard>} />
          <Route path="/finance/banks"
            element={<Guard path="/finance/banks"><BanksPage /></Guard>} />
          <Route path="/finance/banks/new"
            element={<Guard path="/finance/banks">
              <BankAccountFormPage /></Guard>} />
          <Route path="/finance/banks/transfer"
            element={<Guard path="/finance/banks">
              <BankTransferPage /></Guard>} />
          <Route path="/finance/banks/:id/edit"
            element={<Guard path="/finance/banks">
              <BankAccountFormPage /></Guard>} />
          <Route path="/finance/banks/:id/statement"
            element={<Guard path="/finance/banks">
              <BankStatementPage /></Guard>} />
          <Route path="/finance/entity/:type/:id"
            element={<Guard path="/finance/entity">
              <EntityFinancePage /></Guard>} />
          <Route path="/insurance/policy-types"
            element={<Guard path="/insurance/policy-types">
              <PolicyTypesPage /></Guard>} />
          <Route path="/insurance/policy-types/new"
            element={<Guard path="/insurance/policy-types">
              <AddPolicyTypePage /></Guard>} />
          <Route path="/insurance/policy-types/:id"
            element={<Guard path="/insurance/policy-types">
              <PolicyTypeFormPage /></Guard>} />
          <Route path="/documents"
            element={<Guard path="/documents"><DocumentsPage /></Guard>} />

          {/* Quote requests — the staff side of the one thing a channel
              partner can still raise. Claims were PAUSED on 2026-08-19: the
              routes are gone (a locked nav entry with a live route behind it is
              a lock in name only), while pages/claims/ClaimsPage.tsx,
              routers/claims.py and the view_claims/manage_claims pair are all
              untouched. Restoring the two <Route>s below and deleting
              `locked: true` in lib/access.ts is the whole of turning it back
              on. /claims/:id is caught by lockedFeatureAt()'s prefix match, so
              an old bookmark is told the feature is paused rather than 404'd. */}
          <Route path="/quotes"
            element={<Guard path="/quotes"><QuotesPage /></Guard>} />
          <Route path="/quotes/:id"
            element={<Guard path="/quotes"><QuoteDetailPage /></Guard>} />
          {/* Partner Notices is PAUSED (owner 2026-09-12), same arrangement
              as Claims / Third Party Services: the nav entry carries
              `locked: true` in lib/access.ts and no <Route> renders the
              page here — a locked nav entry with a live route behind it is
              how Claims stayed reachable by URL after it was "paused" the
              first time. `NoticesPage` and `NoticeComposerPage` are
              untouched; turning this back on is restoring these two routes
              and deleting `locked: true`. */}

          {/* The Channel Partner portal. Partner-only by gate; the API
              refuses a partner token everywhere else, so these are the only
              pages that can load data for them.

              STATIC BEFORE DYNAMIC everywhere here — "new" would otherwise
              resolve as a record id (CLAUDE.md routing gotcha). */}
          <Route path="/portal/policies"
            element={<Guard path="/portal/policies">
              <PortalPoliciesPage /></Guard>} />
          <Route path="/portal/policies/:id"
            element={<Guard path="/portal/policies">
              <PortalPolicyDetailPage /></Guard>} />

          <Route path="/portal/renewals"
            element={<Guard path="/portal/renewals">
              <PortalRenewalsPage /></Guard>} />

          <Route path="/portal/quotes/new"
            element={<Guard path="/portal/quotes/new">
              <PortalQuoteFormPage /></Guard>} />
          <Route path="/portal/quotes"
            element={<Guard path="/portal/quotes">
              <PortalQuotesPage /></Guard>} />
          <Route path="/portal/quotes/:id"
            element={<Guard path="/portal/quotes">
              <PortalQuoteDetailPage /></Guard>} />

          <Route path="/portal/earnings"
            element={<Guard path="/portal/earnings">
              <PortalEarningsPage /></Guard>} />
          <Route path="/portal/notices"
            element={<Guard path="/portal/notices">
              <PortalNoticesPage /></Guard>} />

          <Route path="*" element={<UnknownRoute />} />
        </Route>

        {/* Unknown URL while signed out / outside the app shell. */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <ToastHost />
      <ConfirmHost />
    </>
  );
}
