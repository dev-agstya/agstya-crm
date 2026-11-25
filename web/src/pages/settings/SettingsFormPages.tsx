import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../../api/endpoints";
import { apiError, tokenStore } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { toast } from "../../components/Toast";
import { useAuth } from "../../store/auth";
import { Input } from "@/components/ui/input";

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

  return (
    <FormPage
      backTo={BACK}
      backLabel={BACK_LABEL}
      title="Edit profile"
      subtitle="Update your name and mobile number"
      onSubmit={submit}
      submitLabel="Save changes"
      submitting={busy}
      disabled={name.trim().length < 2}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Full name" htmlFor="prof-name" required>
          <Input
            id="prof-name"
            value={name}
            autoFocus
            required
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>
        <FormField label="Mobile number" htmlFor="prof-mobile" hint="10 digits without +91">
          <div className="flex">
            <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground">
              +91
            </span>
            <Input
              id="prof-mobile"
              className="rounded-l-none"
              value={mobile}
              inputMode="numeric"
              maxLength={10}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        </FormField>
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
      subtitle={`Current email: ${user?.email || "—"}`}
      onSubmit={submit}
      submitLabel="Update email & sign out"
      submitting={busy}
      disabled={!newEmail.includes("@") || !password}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="New email address" htmlFor="email-new" required>
          <Input
            id="email-new"
            type="email"
            value={newEmail}
            autoFocus
            required
            onChange={(e) => setNewEmail(e.target.value)}
          />
        </FormField>
        <FormField
          label="Current password"
          htmlFor="email-pw"
          required
          hint="Confirm your password to change email"
        >
          <Input
            id="email-pw"
            type="password"
            value={password}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>
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
      subtitle="Choose a strong password you don't use elsewhere"
      onSubmit={submit}
      submitLabel="Update password"
      submitting={busy}
      disabled={!valid}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Current password" htmlFor="cp-curr" required>
          <Input
            id="cp-curr"
            type="password"
            value={current}
            autoFocus
            required
            onChange={(e) => setCurrent(e.target.value)}
          />
        </FormField>
        <FormField
          label="New password"
          htmlFor="cp-next"
          required
          hint="Min 8 chars, letters + numbers"
        >
          <Input
            id="cp-next"
            type="password"
            value={pw}
            required
            onChange={(e) => setPw(e.target.value)}
          />
        </FormField>
        <FormField
          label="Confirm new password"
          htmlFor="cp-conf"
          required
          error={confirm && pw !== confirm ? "Passwords do not match" : undefined}
        >
          <Input
            id="cp-conf"
            type="password"
            value={confirm}
            required
            onChange={(e) => setConfirm(e.target.value)}
          />
        </FormField>
      </div>
    </FormPage>
  );
}
