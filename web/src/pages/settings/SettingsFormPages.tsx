import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../../api/endpoints";
import { apiError, tokenStore } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field } from "../../components/ui";
import { toast } from "../../components/Toast";
import { useAuth } from "../../store/auth";

/*
  The three account screens reached from Settings.

  Short forms, but pages all the same (owner 2026-08-03) — a password change
  that navigates like everything else is less surprising than one that opens a
  box on top of the page you were reading.
*/

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
    <FormPage backTo={BACK} backLabel={BACK_LABEL} title="Edit profile"
      onSubmit={submit} submitLabel="Save" submitting={busy}
      disabled={name.trim().length < 2}>
      <div className="space-y-5">
        <Field label="Full name" required>
          <input className="input" value={name} autoFocus required
            onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Mobile">
          <div className="flex">
            <span className="inline-flex h-10 items-center rounded-l-control
              border border-r-0 border-line bg-slate-50 px-3 text-sm
              text-slate-500">+91</span>
            <input className="input rounded-l-none" value={mobile}
              inputMode="numeric" maxLength={10}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, ""))} />
          </div>
        </Field>
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
      // Session was invalidated server-side; clear and go to login.
      await logout();
      tokenStore.clear();
      navigate("/login");
    } catch (err) {
      toast.error(apiError(err));
      setBusy(false);
    }
  };

  return (
    <FormPage backTo={BACK} backLabel={BACK_LABEL} title="Edit email"
      onSubmit={submit} submitLabel="Update email & sign out" submitting={busy}
      disabled={!newEmail.trim() || !password}>
      <div className="space-y-5">
        <div className="rounded-control bg-slate-50 px-4 py-3 text-sm
          text-slate-600">
          Current email:{" "}
          <span className="font-medium text-slate-900">{user?.email}</span>
        </div>
        <Field label="New email address" required>
          <input type="email" className="input" value={newEmail} autoFocus
            required onChange={(e) => setNewEmail(e.target.value)} />
        </Field>
        <Field label="Confirm your password" required
          hint="For security, you'll be signed out after changing your email.">
          <input type="password" className="input" value={password} required
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
    </FormPage>
  );
}

export function ChangePasswordSettingsPage() {
  const { loadMe } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password !== confirm) {
      toast.error("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.changePassword(current, password);
      tokenStore.set(res.data.access_token, res.data.refresh_token);
      await loadMe();
      toast.success("Password updated.");
      navigate(BACK);
    } catch (err) {
      toast.error(apiError(err));
      setBusy(false);
    }
  };

  return (
    <FormPage backTo={BACK} backLabel={BACK_LABEL} title="Change password"
      onSubmit={submit} submitLabel="Update password" submitting={busy}
      disabled={!current || password.length < 8 || !confirm}>
      <div className="space-y-5">
        <Field label="Current password" required>
          <input type="password" className="input" value={current} autoFocus
            required onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" required>
          <input type="password" className="input" value={password} required
            placeholder="Min 8 chars, letters + numbers"
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm new password" required
          error={confirm && password !== confirm
            ? "The two passwords do not match." : undefined}>
          <input type="password" className="input" value={confirm} required
            onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </div>
    </FormPage>
  );
}
