import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Mail } from "lucide-react";
import { authApi } from "../../api/endpoints";
import { apiError, tokenStore } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { toast } from "../../components/Toast";
import { useAuth } from "../../store/auth";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const BACK = "/settings";
const BACK_LABEL = "Back to settings";

export function EditProfilePage() {
  const { user, loadMe } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.full_name || "");
  const [mobile, setMobile] = useState(user?.mobile || "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await authApi.updateProfile({ full_name: name, mobile });
      await loadMe();
      toast.success("Profile updated.");
      navigate(BACK);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const initials = (name.trim() || user?.full_name || "User")
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <FormPage
      backTo={BACK}
      backLabel={BACK_LABEL}
      title="Edit profile"
      subtitle="Update your personal details and contact information"
      onSubmit={submit}
      submitLabel="Save changes"
      submitting={busy}
      disabled={name.trim().length < 2}
    >
      <div className="grid gap-6 md:grid-cols-12">
        {/* Left Column: Context & Summary */}
        <div className="md:col-span-4 lg:col-span-4 space-y-4 border-b pb-6 md:border-b-0 md:border-r md:pb-0 md:pr-6 border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-base">
              {initials}
            </div>
            <div>
              <p className="font-semibold text-foreground text-sm">{user?.full_name || "Your Account"}</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <Badge variant="secondary" className="text-[10px] uppercase font-semibold">
                  {user?.account_type?.replace(/_/g, " ") || "Member"}
                </Badge>
                {user?.code && (
                  <span className="text-[11px] text-muted-foreground font-mono">
                    {user.code}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Personal Information</p>
            <p>
              Your name and mobile number are displayed on policy bookings, commission statements, and team activity logs.
            </p>
          </div>
        </div>

        {/* Right Column: Form Fields */}
        <div className="md:col-span-8 lg:col-span-8 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Full name" htmlFor="prof-name" required hint="Display name">
              <Input
                id="prof-name"
                value={name}
                autoFocus
                required
                className="h-9 text-sm"
                placeholder="First and last name"
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>

            <FormField label="Mobile number" htmlFor="prof-mobile" hint="10 digits">
              <div className="flex">
                <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-xs font-medium text-muted-foreground">
                  +91
                </span>
                <Input
                  id="prof-mobile"
                  className="h-9 rounded-l-none text-sm"
                  value={mobile}
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="9876543210"
                  onChange={(e) => setMobile(e.target.value.replace(/\D/g, ""))}
                />
              </div>
            </FormField>
          </div>

          <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Note:</span> Changing your mobile number here updates your SMS alert destination and primary contact info.
          </div>
        </div>
      </div>
    </FormPage>
  );
}

export function EditEmailPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await authApi.changeEmail(newEmail.trim(), password);
      toast.success("Email updated. Please sign in again.");
      await logout();
      tokenStore.clear();
      navigate("/login");
    } catch (err) {
      toast.error(apiError(err));
      setBusy(false);
    }
  };

  return (
    <FormPage
      backTo={BACK}
      backLabel={BACK_LABEL}
      title="Edit email"
      subtitle="Change the primary email address for your login"
      onSubmit={submit}
      submitLabel="Update email & sign out"
      submitting={busy}
      disabled={!newEmail.includes("@") || !password}
    >
      <div className="grid gap-6 md:grid-cols-12">
        <div className="md:col-span-4 lg:col-span-4 space-y-3 border-b pb-6 md:border-b-0 md:border-r md:pb-0 md:pr-6 border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Mail className="h-4 w-4" />
            </div>
            <div>
              <p className="font-semibold text-foreground text-sm">Account Email</p>
              <p className="text-xs text-muted-foreground">Login credential</p>
            </div>
          </div>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Current address:</p>
            <p className="font-mono text-foreground font-semibold bg-muted/60 px-2 py-1 rounded inline-block">
              {user?.email || "—"}
            </p>
            <p className="pt-2">
              For security, changing your email requires your current password and will sign you out of all active sessions.
            </p>
          </div>
        </div>

        <div className="md:col-span-8 lg:col-span-8 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="New email address" htmlFor="email-new" required>
              <Input
                id="email-new"
                type="email"
                value={newEmail}
                autoFocus
                required
                className="h-9 text-sm"
                placeholder="name@company.com"
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </FormField>
            <FormField
              label="Current password"
              htmlFor="email-pw"
              required
              hint="To confirm identity"
            >
              <Input
                id="email-pw"
                type="password"
                value={password}
                required
                className="h-9 text-sm"
                placeholder="••••••••"
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
          </div>
        </div>
      </div>
    </FormPage>
  );
}

export function ChangePasswordSettingsPage() {
  const { loadMe } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const valid =
    current.length > 0 &&
    pw.length >= 8 &&
    /[a-z]/i.test(pw) &&
    /\d/.test(pw) &&
    pw === confirm;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await authApi.changePassword(current, pw);
      tokenStore.set(res.data.access_token, res.data.refresh_token);
      await loadMe();
      toast.success("Password updated.");
      navigate(BACK);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormPage
      backTo={BACK}
      backLabel={BACK_LABEL}
      title="Change password"
      subtitle="Update password to keep your account secure"
      onSubmit={submit}
      submitLabel="Update password"
      submitting={busy}
      disabled={!valid}
    >
      <div className="grid gap-6 md:grid-cols-12">
        <div className="md:col-span-4 lg:col-span-4 space-y-3 border-b pb-6 md:border-b-0 md:border-r md:pb-0 md:pr-6 border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="h-4 w-4" />
            </div>
            <div>
              <p className="font-semibold text-foreground text-sm">Security</p>
              <p className="text-xs text-muted-foreground">Password rules</p>
            </div>
          </div>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p>Ensure your account uses a strong password:</p>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>At least 8 characters</li>
              <li>Contains letters and numbers</li>
              <li>Different from current password</li>
            </ul>
          </div>
        </div>

        <div className="md:col-span-8 lg:col-span-8 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Current password" htmlFor="cp-curr" required>
              <Input
                id="cp-curr"
                type="password"
                value={current}
                autoFocus
                required
                className="h-9 text-sm"
                placeholder="••••••••"
                onChange={(e) => setCurrent(e.target.value)}
              />
            </FormField>
            <FormField
              label="New password"
              htmlFor="cp-next"
              required
              hint="Min 8 chars"
            >
              <Input
                id="cp-next"
                type="password"
                value={pw}
                required
                className="h-9 text-sm"
                placeholder="••••••••"
                onChange={(e) => setPw(e.target.value)}
              />
            </FormField>
            <FormField
              label="Confirm password"
              htmlFor="cp-conf"
              required
              error={confirm && pw !== confirm ? "Passwords do not match" : undefined}
            >
              <Input
                id="cp-conf"
                type="password"
                value={confirm}
                required
                className="h-9 text-sm"
                placeholder="••••••••"
                onChange={(e) => setConfirm(e.target.value)}
              />
            </FormField>
          </div>
        </div>
      </div>
    </FormPage>
  );
}
