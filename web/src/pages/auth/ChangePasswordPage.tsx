import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { AuthShell } from "./AuthShell";
import { authApi } from "../../api/endpoints";
import { tokenStore, apiError } from "../../api/client";
import { useAuth } from "../../store/auth";
import { toast } from "../../components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

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
          ? "For your security, please set a new password before continuing."
          : "Update your account password."
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="cp-current">
            {forced ? "Temporary password" : "Current password"}
          </Label>
          <Input
            id="cp-current"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cp-new">New password</Label>
          <Input
            id="cp-new"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="At least 8 characters with letters & numbers"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cp-confirm">Confirm new password</Label>
          <Input
            id="cp-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        <Button type="submit" className="w-full" size="lg" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Updating...
            </>
          ) : (
            "Update password"
          )}
        </Button>

        <Button
          type="button"
          variant="outline"
          onClick={cancel}
          className="w-full"
        >
          Sign out
        </Button>
      </form>
    </AuthShell>
  );
}
