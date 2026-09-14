import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { useAuth } from "../store/auth";
import { formatDateTime, titleCase } from "../lib/format";


export default function SettingsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div>
      {/* Settings is reached from the account menu, so there is no sidebar
          entry lit up to say where you are and no obvious way back. The
          breadcrumb now covers the first (lib/access OFF_NAV_CRUMBS) and this
          covers the second. */}
      <PageHeader title="Settings" backTo="/dashboard" backLabel="Dashboard" />

      <div className="mx-auto max-w-2xl space-y-6">
        {/* Profile summary */}
        <div className="card flex items-center gap-4 p-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-full
            bg-ink text-lg font-semibold text-white">
            {user.full_name.split(" ").slice(0, 2).map((p) => p[0]).join("")}
          </div>
          <div className="min-w-0">
            <p className="truncate text-section text-slate-900">
              {user.full_name}
            </p>
            <p className="truncate text-sm text-slate-500">{user.email}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {user.role_name || titleCase(user.account_type)} · {user.code}
              {user.last_login_at &&
                ` · Last login ${formatDateTime(user.last_login_at)}`}
            </p>
          </div>
        </div>

        {/* Account settings tile */}
        <div className="card p-6">
          <div className="mb-4 flex items-center gap-2 text-slate-800">
            <Icon.Settings size={20} />
            <h3 className="font-semibold">Account settings</h3>
          </div>
          <div className="divide-y divide-line/70">
            <SettingRow
              icon="Customers" title="Edit profile"
              desc="Update your name and phone number"
              onClick={() => navigate("/settings/profile")} />
            <SettingRow
              icon="Bell" title="Edit email"
              desc="Change your sign-in email address"
              onClick={() => navigate("/settings/email")} />
            <SettingRow
              icon="Shield" title="Change password"
              desc="Update your account password"
              onClick={() => navigate("/settings/password")} />
          </div>
        </div>

        {/* Agency-wide switches. Owner only. The Channel Partner portal moved
            here on 2026-08-06 from a button above the Channel Partners list — a
            master switch that signs every partner out at once does not belong
            above a list of people, it belongs where settings live. Attendance &
            leave joined it on 2026-08-20 for the same reason: a set-once screen
            does not earn a sidebar entry. */}
        {user.account_type === "owner" && (
          <div className="card p-6">
            <div className="mb-4 flex items-center gap-2 text-slate-800">
              <Icon.Users size={20} />
              <h3 className="font-semibold">Agency settings</h3>
            </div>
            <div className="divide-y divide-line/70">
              <SettingRow
                icon="Wallet" title="Channel Partner portal"
                desc="The master switch, and what a signed-in partner may do"
                onClick={() => navigate("/settings/partner-portal")} />
              <SettingRow
                icon="Clock" title="Attendance & leave"
                desc="The shift, what counts as a full day, and the leave policy"
                onClick={() => navigate("/settings/attendance")} />
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

function SettingRow({ icon, title, desc, onClick }: {
  icon: keyof typeof Icon; title: string; desc: string; onClick: () => void;
}) {
  const IconCmp = Icon[icon];
  return (
    <button onClick={onClick}
      className="flex w-full items-center gap-4 py-3.5 text-left
        transition-colors hover:bg-slate-50">
      <span className="rounded-control bg-slate-100 p-2 text-slate-900">
        <IconCmp size={18} />
      </span>
      <span className="flex-1">
        <span className="block text-sm font-medium text-slate-700">{title}</span>
        <span className="block text-xs text-slate-500">{desc}</span>
      </span>
      <span className="text-slate-300">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </button>
  );
}
