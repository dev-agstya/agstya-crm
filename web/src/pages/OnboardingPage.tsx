import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../api/endpoints";
import { tokenStore, apiError } from "../api/client";
import { useAuth } from "../store/auth";
import { Icon } from "../components/Icon";
import { DateInput } from "../components/DateInput";
import { Field, Spinner } from "../components/ui";
import { toast } from "../components/Toast";

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAAR_RE = /^\d{12}$/;

type StepKey = "welcome" | "personal" | "documents" | "bank" | "password";
const STEPS: { key: StepKey; label: string }[] = [
  { key: "welcome", label: "Welcome" },
  { key: "personal", label: "Personal" },
  { key: "documents", label: "Documents" },
  { key: "bank", label: "Bank" },
  { key: "password", label: "Password" },
];

const DOCS: { key: string; label: string }[] = [
  { key: "pan_card", label: "PAN card" },
  { key: "aadhaar_front", label: "Aadhaar — front" },
  { key: "aadhaar_back", label: "Aadhaar — back" },
];

type DocState = { name?: string; status: "idle" | "uploading" | "done" | "error";
  error?: string };

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { user, loadMe, logout, initialized } = useAuth();
  const [stepIdx, setStepIdx] = useState(0);
  const step = STEPS[stepIdx].key;

  // Redirect out if not applicable.
  useEffect(() => {
    if (!initialized) return;
    if (!user) navigate("/login", { replace: true });
    else if (user.onboarded) navigate("/dashboard", { replace: true });
  }, [initialized, user, navigate]);

  // Form state
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [address, setAddress] = useState("");
  const [pan, setPan] = useState("");
  const [aadhaar, setAadhaar] = useState("");
  const [bank, setBank] = useState({
    account_holder: "", bank_name: "", account_number: "", ifsc: "", upi_id: "",
  });
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [docs, setDocs] = useState<Record<string, DocState>>(
    Object.fromEntries(DOCS.map((d) => [d.key, { status: "idle" }])));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const setB = (k: keyof typeof bank, v: string) =>
    setBank((s) => ({ ...s, [k]: v }));

  const uploadDoc = async (docKey: string, file: File) => {
    setDocs((s) => ({ ...s, [docKey]: { name: file.name, status: "uploading" } }));
    try {
      await authApi.uploadOnboardingDoc(docKey, file);
      setDocs((s) => ({ ...s, [docKey]: { name: file.name, status: "done" } }));
    } catch (e) {
      setDocs((s) => ({
        ...s, [docKey]: { name: file.name, status: "error", error: apiError(e) },
      }));
    }
  };

  /*
    KYC IS OPTIONAL FOR A CHANNEL PARTNER (owner I1, 2026-08-06).

    A partner is external. The agency creates the account, emails them a
    password, and then this wizard refused to let them past step two without a
    PAN and a twelve-digit Aadhaar nobody had asked them for on the phone. That
    was the one thing standing between "invited" and "signed in" — so a partner
    can now skip both and get straight into their portal, and staff chase the
    documents afterwards from the KYC tab on their record.

    Staff are unchanged: an employee is on the payroll and their KYC is not
    optional. The server enforces the same split
    (routers/auth.complete_onboarding), so this is the UX half, not the rule.

    Optional is NOT unvalidated: a value that is typed must be a real PAN /
    Aadhaar. A malformed one is worse than a missing one — it looks collected.
  */
  const isPartner = user?.account_type === "channel_partner";
  const panOk = !pan.trim() ? isPartner : PAN_RE.test(pan.toUpperCase());
  const aadhaarOk = !aadhaar.trim()
    ? isPartner : AADHAAR_RE.test(aadhaar.replace(/\s+/g, ""));
  const personalOk = panOk && aadhaarOk;
  // Same reasoning for the uploads: a partner has nothing to photograph yet if
  // they have not given the numbers.
  const docsOk = isPartner
    || DOCS.every((d) => docs[d.key].status === "done");
  const passwordOk = pw.length >= 8 && /[a-z]/i.test(pw) && /\d/.test(pw)
    && pw === pw2;

  const next = () => { setError(""); setStepIdx((i) => Math.min(i + 1, STEPS.length - 1)); };
  const back = () => { setError(""); setStepIdx((i) => Math.max(i - 1, 0)); };

  const finish = async () => {
    setError("");
    setSubmitting(true);
    try {
      const res = await authApi.onboarding({
        dob: dob || null,
        gender: gender || null,
        address: address || null,
        // Empty means "not supplied", which the server stores as nothing
        // rather than as an empty KYC field.
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
      toast.success("You're all set.");
      navigate("/dashboard", { replace: true });
    } catch (e) {
      setError(apiError(e));
      setSubmitting(false);
    }
  };

  const signOut = async () => { await logout(); navigate("/login"); };

  if (!user) return null;
  const firstName = user.full_name.split(" ")[0];

  return (
    <div className="min-h-screen bg-canvas px-4 py-8">
      <div className="mx-auto max-w-2xl">
        {/* Brand + sign out */}
        <div className="mb-6 flex items-center justify-between">
          <img src="/agastya_hindi_full_logo.png" alt="Agstya Associate"
            className="h-9 w-auto object-contain" />
          <button onClick={signOut}
            className="text-sm text-slate-500 hover:text-slate-700">
            Sign out
          </button>
        </div>

        {/* Stepper */}
        <div className="mb-6 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex flex-1 items-center gap-2">
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center
                rounded-full text-xs font-semibold ${
                  i < stepIdx ? "bg-money-in text-white"
                    : i === stepIdx ? "bg-ink text-white"
                    : "bg-slate-200 text-slate-500"}`}>
                {i < stepIdx ? "✓" : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-0.5 flex-1 rounded ${
                  i < stepIdx ? "bg-money-in" : "bg-slate-200"}`} />
              )}
            </div>
          ))}
        </div>

        <div className="card p-6 sm:p-8">
          {error && (
            <div className="note-out mb-4">{error}</div>
          )}

          {/* --- Welcome --- */}
          {step === "welcome" && (
            <div className="py-6 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center
                rounded-full bg-slate-100 text-slate-900">
                <Icon.Check size={34} />
              </div>
              <h1 className="text-page-title text-slate-900">
                Welcome to the Team, {firstName}!
              </h1>
              <p className="mx-auto mt-3 max-w-md text-sm text-slate-500">
                Let's finish setting up your account. We'll collect a few personal
                and KYC details, your documents and bank details, and then you'll
                set your own password. It only takes a couple of minutes.
              </p>
              <button className="btn-primary mt-6" onClick={next}>
                Let's get started →
              </button>
            </div>
          )}

          {/* --- Personal --- */}
          {step === "personal" && (
            <div className="space-y-4">
              <h2 className="text-section text-slate-900">
                Personal details
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Date of birth">
                  <DateInput value={dob} onChange={setDob} />
                </Field>
                <Field label="Gender">
                  <select className="select" value={gender}
                    onChange={(e) => setGender(e.target.value)}>
                    <option value="">—</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="other">Other</option>
                  </select>
                </Field>
                <Field label="PAN number" required={!isPartner}
                  hint={pan && !PAN_RE.test(pan.toUpperCase())
                    ? "Format: ABCDE1234F"
                    : isPartner ? "You can add this later" : undefined}>
                  <input className="input uppercase" value={pan} maxLength={10}
                    onChange={(e) => setPan(e.target.value.toUpperCase())} />
                </Field>
                <Field label="Aadhaar number" required={!isPartner}
                  hint={aadhaar && !AADHAAR_RE.test(aadhaar.replace(/\s+/g, ""))
                    ? "12 digits"
                    : isPartner ? "You can add this later" : undefined}>
                  <input className="input" value={aadhaar} inputMode="numeric"
                    maxLength={14}
                    onChange={(e) =>
                      setAadhaar(e.target.value.replace(/[^\d\s]/g, ""))} />
                </Field>
                <div className="col-span-2">
                  <Field label="Address">
                    <input className="input" value={address}
                      onChange={(e) => setAddress(e.target.value)} />
                  </Field>
                </div>
              </div>
              <StepNav onBack={back} onNext={next} nextDisabled={!personalOk} />
            </div>
          )}

          {/* --- Documents --- */}
          {step === "documents" && (
            <div className="space-y-4">
              <h2 className="text-section text-slate-900">Documents</h2>
              <p className="text-sm text-slate-500">
                Upload clear photos or PDFs. Max 10&nbsp;MB each.
                {isPartner && " You can skip these for now and send them to "
                  + "your relationship manager later."}
              </p>
              <div className="space-y-3">
                {DOCS.map((d) => {
                  const st = docs[d.key];
                  return (
                    <div key={d.key}
                      className="flex items-center justify-between gap-3 rounded-control
                        border border-line p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-700">{d.label}</p>
                        <p className="truncate text-xs text-slate-500">
                          {st.status === "error"
                            ? <span className="text-money-out">{st.error}</span>
                            : st.name || "No file selected"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {st.status === "uploading" && <Spinner className="h-4 w-4" />}
                        {st.status === "done" && (
                          <span className="text-money-in"><Icon.Check size={18} /></span>
                        )}
                        <label className="btn-secondary cursor-pointer text-xs">
                          {st.status === "done" ? "Replace" : "Upload"}
                          <input type="file" className="hidden"
                            accept="image/*,application/pdf"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) uploadDoc(d.key, file);
                            }} />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
              <StepNav onBack={back} onNext={next} nextDisabled={!docsOk} />
            </div>
          )}

          {/* --- Bank --- */}
          {step === "bank" && (
            <div className="space-y-4">
              <h2 className="text-section text-slate-900">
                Bank account
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Account holder name">
                  <input className="input" value={bank.account_holder}
                    onChange={(e) => setB("account_holder", e.target.value)} />
                </Field>
                <Field label="Bank name">
                  <input className="input" value={bank.bank_name}
                    onChange={(e) => setB("bank_name", e.target.value)} />
                </Field>
                <Field label="Account number">
                  <input className="input" value={bank.account_number}
                    inputMode="numeric"
                    onChange={(e) => setB("account_number", e.target.value)} />
                </Field>
                <Field label="IFSC">
                  <input className="input uppercase" value={bank.ifsc}
                    onChange={(e) => setB("ifsc", e.target.value.toUpperCase())} />
                </Field>
                <div className="col-span-2">
                  <Field label="UPI ID">
                    <input className="input" value={bank.upi_id}
                      onChange={(e) => setB("upi_id", e.target.value)} />
                  </Field>
                </div>
              </div>
              <StepNav onBack={back} onNext={next} />
            </div>
          )}

          {/* --- Password --- */}
          {step === "password" && (
            <div className="space-y-4">
              <h2 className="text-section text-slate-900">
                Set your password
              </h2>
              <p className="text-sm text-slate-500">
                Create a password to replace the temporary one you were emailed.
              </p>
              <Field label="New password" required
                hint="Min 8 characters, with letters and numbers.">
                <input type="password" className="input" value={pw}
                  onChange={(e) => setPw(e.target.value)} />
              </Field>
              <Field label="Confirm password" required
                hint={pw2 && pw !== pw2 ? "Passwords don't match." : undefined}>
                <input type="password" className="input" value={pw2}
                  onChange={(e) => setPw2(e.target.value)} />
              </Field>
              <div className="flex items-center justify-between gap-2 pt-2">
                <button className="btn-secondary" onClick={back}>← Back</button>
                <button className="btn-primary" disabled={!passwordOk || submitting}
                  onClick={finish}>
                  {submitting ? <Spinner /> : "Complete sign-up"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepNav({ onBack, onNext, nextDisabled }: {
  onBack: () => void; onNext: () => void; nextDisabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 pt-2">
      <button className="btn-secondary" onClick={onBack}>← Back</button>
      <button className="btn-primary" onClick={onNext} disabled={nextDisabled}>
        Continue →
      </button>
    </div>
  );
}
