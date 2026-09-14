import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "./AuthShell";
import { authApi } from "../../api/endpoints";
import { tokenStore, apiError } from "../../api/client";
import { useAuth } from "../../store/auth";
import { Spinner } from "../../components/ui";
import { TurnstileWidget, captchaConfigured }
  from "../../components/TurnstileWidget";

export default function LoginPage() {
  const navigate = useNavigate();
  const { loadMe, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");

  if (user) navigate("/dashboard");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await authApi.login(email.trim(), password,
        captchaToken || undefined);
      tokenStore.set(res.data.access_token, res.data.refresh_token);
      await loadMe();
      // New employees/partners set their password inside onboarding (step 5), so
      // skip the standalone change-password prompt and go straight there. The
      // change-password page stays for later admin-triggered resets.
      const me = useAuth.getState().user;
      if (me && !me.onboarded && me.account_type !== "owner")
        navigate("/onboarding");
      else if (res.data.must_change_password)
        navigate("/change-password");
      else
        navigate("/dashboard");
    } catch (err) {
      setError(apiError(err, "Unable to sign in."));
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Agstya Associate account">
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="note-out">
            {error}
          </div>
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
        <div>
          <label className="label">Password</label>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="••••••••"
          />
        </div>
        <div className="flex justify-end">
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-slate-900 hover:text-brand-700"
          >
            Forgot password?
          </Link>
        </div>
        {captchaConfigured && failed && (
          <TurnstileWidget onToken={setCaptchaToken} />
        )}
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? <Spinner /> : "Sign in"}
        </button>
      </form>
      <p className="mt-6 text-center text-xs text-slate-500">
        Accounts are provisioned by your administrator.
      </p>
    </AuthShell>
  );
}
