import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "./AuthShell";
import { authApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Spinner } from "../../components/ui";

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await authApi.forgot(email.trim(), "email");
      setMsg(res.data.detail);
      setTimeout(
        () => navigate(`/reset-password?email=${encodeURIComponent(email.trim())}`),
        1200
      );
    } catch (err) {
      setError(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we'll send you a verification code"
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="note-out">{error}</div>
        )}
        {msg && (
          <div className="note-in">{msg}</div>
        )}
        <div>
          <label className="label">Email address</label>
          <input
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            placeholder="you@agastyacrm.com"
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? <Spinner /> : "Send reset code"}
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
