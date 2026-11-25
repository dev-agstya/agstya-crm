import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Upload,
} from "lucide-react";
import { authApi } from "../api/endpoints";
import { tokenStore, apiError } from "../api/client";
import { useAuth } from "../store/auth";
import { DateInput } from "../components/DateInput";
import { toast } from "../components/Toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAAR_RE = /^\d{12}$/;

type StepKey = "welcome" | "personal" | "documents" | "bank" | "password";
const STEPS: { key: StepKey; label: string }[] = [
  { key: "welcome", label: "Welcome" },
  { key: "personal", label: "Personal Details" },
  { key: "documents", label: "KYC Documents" },
  { key: "bank", label: "Bank Details" },
  { key: "password", label: "Set Password" },
];

const DOCS: { key: string; label: string }[] = [
  { key: "pan_card", label: "PAN card" },
  { key: "aadhaar_front", label: "Aadhaar — front" },
  { key: "aadhaar_back", label: "Aadhaar — back" },
];

type DocState = {
  name?: string;
  status: "idle" | "uploading" | "done" | "error";
  error?: string;
};

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { user, loadMe, logout, initialized } = useAuth();
  const [stepIdx, setStepIdx] = useState(0);
  const step = STEPS[stepIdx].key;

  useEffect(() => {
    if (!initialized) return;
    if (!user) navigate("/login", { replace: true });
    else if (user.onboarded) navigate("/dashboard", { replace: true });
  }, [initialized, user, navigate]);

  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [address, setAddress] = useState("");
  const [pan, setPan] = useState("");
  const [aadhaar, setAadhaar] = useState("");
  const [bank, setBank] = useState({
    account_holder: "",
    bank_name: "",
    account_number: "",
    ifsc: "",
    upi_id: "",
  });
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [docs, setDocs] = useState<Record<string, DocState>>(
    Object.fromEntries(DOCS.map((d) => [d.key, { status: "idle" }]))
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const setB = (k: keyof typeof bank, v: string) =>
    setBank((s) => ({ ...s, [k]: v }));

  const uploadDoc = async (docKey: string, file: File) => {
    setDocs((s) => ({
      ...s,
      [docKey]: { name: file.name, status: "uploading" },
    }));
    try {
      await authApi.uploadOnboardingDoc(docKey, file);
      setDocs((s) => ({
        ...s,
        [docKey]: { name: file.name, status: "done" },
      }));
    } catch (e) {
      setDocs((s) => ({
        ...s,
        [docKey]: { name: file.name, status: "error", error: apiError(e) },
      }));
    }
  };

  const isPartner = user?.account_type === "channel_partner";
  const panOk = !pan.trim() ? isPartner : PAN_RE.test(pan.toUpperCase());
  const aadhaarOk = !aadhaar.trim()
    ? isPartner
    : AADHAAR_RE.test(aadhaar.replace(/\s+/g, ""));
  const personalOk = panOk && aadhaarOk;
  const docsOk =
    isPartner || DOCS.every((d) => docs[d.key].status === "done");
  const passwordOk =
    pw.length >= 8 && /[a-z]/i.test(pw) && /\d/.test(pw) && pw === pw2;

  const next = () => {
    setError("");
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  };
  const back = () => {
    setError("");
    setStepIdx((i) => Math.max(i - 1, 0));
  };

  const finish = async () => {
    setError("");
    setSubmitting(true);
    try {
      const res = await authApi.onboarding({
        dob: dob || null,
        gender: gender || null,
        address: address || null,
        pan_number: pan.trim() ? pan.toUpperCase() : null,
        aadhaar_number: aadhaar.trim() ? aadhaar.replace(/\s+/g, "") : null,
        bank: {
          account_holder: bank.account_holder || null,
          bank_name: bank.bank_name || null,
          account_number: bank.account_number || null,
          ifsc: bank.ifsc.toUpperCase() || null,
          upi_id: bank.upi_id || null,
        },
        new_password: pw,
      });
      tokenStore.set(res.data.access_token, res.data.refresh_token);
      await loadMe();
      toast.success("Account setup complete!");
      navigate("/dashboard", { replace: true });
    } catch (e) {
      setError(apiError(e));
      setSubmitting(false);
    }
  };

  const signOut = async () => {
    await logout();
    navigate("/login");
  };

  if (!user) return null;
  const firstName = user.full_name.split(" ")[0];
  const progressPct = ((stepIdx + 1) / STEPS.length) * 100;

  return (
    <div className="min-h-screen bg-muted/40 px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <img
            src="/agastya_hindi_full_logo.png"
            alt="Agstya Associate"
            className="h-9 w-auto object-contain"
          />
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>
              Step {stepIdx + 1} of {STEPS.length}: {STEPS[stepIdx].label}
            </span>
            <span>{Math.round(progressPct)}%</span>
          </div>
          <Progress value={progressPct} className="h-2" />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          {step === "welcome" && (
            <>
              <CardHeader>
                <CardTitle>Welcome, {firstName}</CardTitle>
                <CardDescription>
                  Let's finish setting up your account. This only takes a couple
                  of minutes.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">
                    What we'll ask for:
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>Your basic personal details (PAN & Aadhaar)</li>
                    <li>Photos or PDFs of your KYC documents</li>
                    <li>Bank or UPI details for payouts</li>
                    <li>A new password only you know</li>
                  </ul>
                </div>
                <div className="flex justify-end pt-2">
                  <Button onClick={next}>
                    Get started
                    <ChevronRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {step === "personal" && (
            <>
              <CardHeader>
                <CardTitle>Personal Details</CardTitle>
                <CardDescription>
                  {isPartner
                    ? "Optional for now — you can fill these in later."
                    : "Enter your date of birth, address, PAN and Aadhaar."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Date of birth</Label>
                    <DateInput value={dob} onChange={setDob} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Gender</Label>
                    <Select value={gender} onValueChange={setGender}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select gender" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="male">Male</SelectItem>
                        <SelectItem value="female">Female</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="onb-pan">
                      PAN Number {!isPartner && "*"}
                    </Label>
                    <Input
                      id="onb-pan"
                      value={pan}
                      onChange={(e) => setPan(e.target.value.toUpperCase())}
                      placeholder="ABCDE1234F"
                      maxLength={10}
                    />
                    {!panOk && pan && (
                      <p className="text-xs text-destructive">
                        Enter a valid 10-character PAN (e.g. ABCDE1234F).
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="onb-aadhaar">
                      Aadhaar Number {!isPartner && "*"}
                    </Label>
                    <Input
                      id="onb-aadhaar"
                      value={aadhaar}
                      onChange={(e) =>
                        setAadhaar(e.target.value.replace(/\D/g, ""))
                      }
                      placeholder="12-digit number"
                      maxLength={12}
                    />
                    {!aadhaarOk && aadhaar && (
                      <p className="text-xs text-destructive">
                        Enter a valid 12-digit Aadhaar number.
                      </p>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="onb-addr">Address</Label>
                  <Textarea
                    id="onb-addr"
                    rows={2}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Current residential address"
                  />
                </div>
                <div className="flex justify-between pt-2">
                  <Button variant="outline" onClick={back}>
                    <ChevronLeft className="mr-1.5 h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={next} disabled={!personalOk}>
                    Continue
                    <ChevronRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {step === "documents" && (
            <>
              <CardHeader>
                <CardTitle>KYC Documents</CardTitle>
                <CardDescription>
                  {isPartner
                    ? "Optional for now — upload if you have them handy."
                    : "Upload clear photos or PDFs of your PAN and Aadhaar."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  {DOCS.map((d) => {
                    const st = docs[d.key];
                    return (
                      <div
                        key={d.key}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border p-3.5"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{d.label}</p>
                          {st.name && (
                            <p className="truncate text-xs text-muted-foreground">
                              {st.name}
                            </p>
                          )}
                          {st.error && (
                            <p className="text-xs text-destructive">{st.error}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {st.status === "done" && (
                            <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                              <CheckCircle2 className="mr-1 h-3 w-3" />
                              Uploaded
                            </Badge>
                          )}
                          <Button
                            asChild
                            size="sm"
                            variant="outline"
                            disabled={st.status === "uploading"}
                            className="cursor-pointer"
                          >
                            <label>
                              <Upload className="mr-1.5 h-3.5 w-3.5" />
                              {st.status === "uploading"
                                ? "Uploading..."
                                : st.status === "done"
                                  ? "Replace"
                                  : "Upload"}
                              <input
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.webp"
                                className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) uploadDoc(d.key, f);
                                  e.target.value = "";
                                }}
                              />
                            </label>
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between pt-2">
                  <Button variant="outline" onClick={back}>
                    <ChevronLeft className="mr-1.5 h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={next} disabled={!docsOk}>
                    Continue
                    <ChevronRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {step === "bank" && (
            <>
              <CardHeader>
                <CardTitle>Bank & Payout Details</CardTitle>
                <CardDescription>
                  Optional — add where you'd like to receive salary or payouts.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Account holder name</Label>
                    <Input
                      value={bank.account_holder}
                      onChange={(e) => setB("account_holder", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Bank name</Label>
                    <Input
                      value={bank.bank_name}
                      onChange={(e) => setB("bank_name", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Account number</Label>
                    <Input
                      value={bank.account_number}
                      onChange={(e) => setB("account_number", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>IFSC code</Label>
                    <Input
                      value={bank.ifsc}
                      onChange={(e) => setB("ifsc", e.target.value.toUpperCase())}
                      placeholder="SBIN0001234"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>UPI ID (optional)</Label>
                  <Input
                    value={bank.upi_id}
                    onChange={(e) => setB("upi_id", e.target.value)}
                    placeholder="name@upi"
                  />
                </div>
                <div className="flex justify-between pt-2">
                  <Button variant="outline" onClick={back}>
                    <ChevronLeft className="mr-1.5 h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={next}>
                    Continue
                    <ChevronRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {step === "password" && (
            <>
              <CardHeader>
                <CardTitle>Create Your Password</CardTitle>
                <CardDescription>
                  Choose a strong password to secure your account.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="onb-pw">New password *</Label>
                  <Input
                    id="onb-pw"
                    type="password"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="At least 8 characters with letters & numbers"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="onb-pw2">Confirm password *</Label>
                  <Input
                    id="onb-pw2"
                    type="password"
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                  />
                </div>
                <div className="flex justify-between pt-2">
                  <Button variant="outline" onClick={back}>
                    <ChevronLeft className="mr-1.5 h-4 w-4" />
                    Back
                  </Button>
                  <Button
                    onClick={finish}
                    disabled={!passwordOk || submitting}
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Finishing setup...
                      </>
                    ) : (
                      "Finish setup"
                    )}
                  </Button>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
