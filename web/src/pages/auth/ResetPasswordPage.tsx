import { FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AuthShell } from "./AuthShell";
import { authApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Spinner } from "../../components/ui";
import { toast } from "../../components/Toast";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") || "");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await authApi.reset(email.trim(), otp.trim(), password);
      toast.success("Password reset. Please sign in.");
      navigate("/login");
    } catch (err) {
      setError(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Enter reset code"
      subtitle="Check your email for the 6-digit verification code"
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="note-out">{error}</div>
        )}
        <div>
          <label className="label">Email address</label>
          <input type="email" className="input" value={email}
            onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label">Verification code</label>
          <input
            className="input tracking-[0.5em] text-center text-lg"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            maxLength={6}
            required
            placeholder="000000"
          />
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
          {loading ? <Spinner /> : "Reset password"}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        <Link to="/login" className="font-medium text-slate-900 hover:text-brand-700">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
