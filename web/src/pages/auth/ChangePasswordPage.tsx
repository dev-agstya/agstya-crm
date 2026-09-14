import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "./AuthShell";
import { authApi } from "../../api/endpoints";
import { tokenStore, apiError } from "../../api/client";
import { useAuth } from "../../store/auth";
import { Spinner } from "../../components/ui";
import { toast } from "../../components/Toast";

export default function ChangePasswordPage() {
  const navigate = useNavigate();
  const { user, loadMe, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const forced = user?.must_change_password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.changePassword(current, password);
      tokenStore.set(res.data.access_token, res.data.refresh_token);
      await loadMe();
      toast.success("Password updated.");
      navigate("/dashboard");
    } catch (err) {
      setError(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  const cancel = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <AuthShell
      title={forced ? "Set a new password" : "Change password"}
      subtitle={
        forced
          ? "For your security, set a new password before continuing."
          : "Update your account password."
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="note-out">{error}</div>
        )}
        <div>
          <label className="label">
            {forced ? "Temporary password" : "Current password"}
          </label>
          <input type="password" className="input" value={current}
            onChange={(e) => setCurrent(e.target.value)} required autoFocus />
        </div>
        <div>
          <label className="label">New password</label>
          <input type="password" className="input" value={password}
            onChange={(e) => setPassword(e.target.value)} required
            placeholder="Min 8 chars, letters + numbers" />
        </div>
        <div>
          <label className="label">Confirm new password</label>
          <input type="password" className="input" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? <Spinner /> : "Update password"}
        </button>
        <button type="button" onClick={cancel}
          className="btn-secondary w-full">
          Sign out
        </button>
      </form>
    </AuthShell>
  );
}
