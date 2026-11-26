import { useNavigate } from "react-router-dom";
import {
  ChevronRight,
  Clock,
  Lock,
  Mail,
  Settings,
  Shield,
  User,
  Users,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../store/auth";
import { formatDateTime, initials, titleCase } from "../lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

export default function SettingsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        subtitle="Manage your profile, sign-in credentials, and agency preferences."
        backTo="/dashboard"
        backLabel="Dashboard"
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 p-6">
          <Avatar className="h-14 w-14">
            <AvatarFallback className="bg-primary text-lg font-semibold text-primary-foreground">
              {initials(user.full_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-lg font-semibold text-foreground">
                {user.full_name}
              </p>
              <Badge variant="secondary">
                {user.role_name || titleCase(user.account_type)}
              </Badge>
            </div>
            <p className="truncate text-sm text-muted-foreground">
              {user.email}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              ID: {user.code}
              {user.last_login_at &&
                ` · Last signed in ${formatDateTime(user.last_login_at)}`}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Settings className="h-4 w-4 text-primary" />
            Account Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border p-0">
          <SettingRow
            icon={User}
            title="Edit profile"
            desc="Update your full name and phone number"
            onClick={() => navigate("/settings/profile")}
          />
          <SettingRow
            icon={Mail}
            title="Email address"
            desc="Change your sign-in email address"
            onClick={() => navigate("/settings/email")}
          />
          <SettingRow
            icon={Lock}
            title="Change password"
            desc="Update your account password"
            onClick={() => navigate("/settings/password")}
          />
        </CardContent>
      </Card>

      {user.account_type === "owner" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <Shield className="h-4 w-4 text-primary" />
              Agency Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border p-0">
            <SettingRow
              icon={Clock}
              title="Attendance & leave policy"
              desc="Configure office hours, half-day rules, and leave quotas"
              onClick={() => navigate("/settings/attendance")}
            />
            <SettingRow
              icon={Users}
              title="Partner portal"
              desc="Control channel partner portal access and settings"
              onClick={() => navigate("/settings/partner-portal")}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SettingRow({
  icon: IconComp,
  title,
  desc,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-muted/40"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        <IconComp className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
