import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { Field } from "../../components/ui";
import {
  EmailAvailabilityHint, useEmailAvailable,
} from "../../components/EmailAvailability";
import { toast } from "../../components/Toast";
import type { AssignableManager } from "../../lib/types";

/**
 * Add a channel partner (/people/partners/new). Two steps, like employees.
 *
 * Creating the account INVITES them, in the same breath — portal access is
 * granted and the sign-in email goes out (routers/users.create_partner). The
 * temporary password exists nowhere else, so there is no version of this that
 * creates the account quietly.
 *
 * This page used to read a `partner_portal_launched` flag and say "no
 * invitation was sent". That flag was deleted when the portal shipped, so it
 * read as false forever and the screen reported the opposite of what the
 * server had just done. Every sentence here now states one outcome, because
 * there is only one.
 */
export default function AddPartnerPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const managers = (useQuery({
    queryKey: ["assignable-managers"],
    queryFn: async () => (await usersApi.assignableManagers()).data,
  }).data ?? []) as AssignableManager[];

  const [step, setStep] = useState<"form" | "review">("form");
  const [f, setF] = useState({
    full_name: "", email: "", mobile: "",
    relationship_manager_id: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const emailState = useEmailAvailable(f.email);
  const formValid = f.full_name.trim().length >= 2 &&
    /^\S+@\S+\.\S+$/.test(f.email) && f.mobile.trim().length === 10 &&
    !!f.relationship_manager_id && emailState !== "taken";

  const mgrLabel = (m: AssignableManager) =>
    m.account_type === "owner" ? `${m.full_name} (Owner)` : m.full_name;

  const create = useMutation({
    mutationFn: () => usersApi.createPartner({
      full_name: f.full_name.trim(),
      email: f.email.trim(),
      mobile: f.mobile.trim(),
      relationship_manager_id: f.relationship_manager_id,
    }),
    onSuccess: () => {
      toast.success("Channel Partner added. An invitation with their sign-in "
        + `details was emailed to ${f.email.trim()}.`);
      qc.invalidateQueries({ queryKey: ["users"] });
      navigate("/people/partners");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const reviewRow = (label: string, value: string) => (
    <div className="flex justify-between gap-4 border-b border-line/70 py-2">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-right text-sm font-medium text-slate-800">
        {value || "—"}</span>
    </div>
  );

  return (
    <RecordPage
      backTo="/people/partners"
      backLabel="Back to channel partners"
      title="Add channel partner"
      subtitle={step === "form"
        ? "They get portal access and an emailed invitation as soon as the "
          + "account is created."
        : "Check this over before creating the account."}
    >
      <div className="card px-6 py-5">
      {step === "form" ? (
        <form
          onSubmit={(e) => { e.preventDefault(); if (formValid) setStep("review"); }}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-4">
            <Field label="Full name" required>
              <input className="input" value={f.full_name} required
                onChange={(e) => set("full_name", e.target.value)} />
            </Field>
            <Field label="Email" required>
              <input type="email" className="input" value={f.email} required
                onChange={(e) => set("email", e.target.value)} />
              <EmailAvailabilityHint state={emailState} />
            </Field>
            <Field label="Mobile" required>
              <div className="flex">
                <span className="inline-flex items-center rounded-l-lg border
                  border-r-0 border-slate-300 bg-slate-50 px-3 text-sm
                  text-slate-500">+91</span>
                <input className="input rounded-l-none" value={f.mobile} required
                  inputMode="numeric" maxLength={10} placeholder="10-digit number"
                  onChange={(e) => set("mobile", e.target.value.replace(/\D/g, ""))} />
              </div>
            </Field>
            <div className="col-span-2">
              <Field label="Relationship manager" required>
                <select className="select" value={f.relationship_manager_id} required
                  onChange={(e) => set("relationship_manager_id", e.target.value)}>
                  <option value="">— Select a manager —</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>{mgrLabel(m)}</option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Link to="/people/partners" className="btn-secondary">
              Cancel</Link>
            <button type="submit" className="btn-primary" disabled={!formValid}>
              Verify
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="rounded-control border border-line p-4">
            {reviewRow("Full name", f.full_name)}
            {reviewRow("Email", f.email)}
            {reviewRow("Mobile", f.mobile)}
            {reviewRow("Relationship manager",
              managers.find((m) => m.id === f.relationship_manager_id)?.full_name
              ?? "")}
          </div>
          <p className="text-sm text-slate-500">
            On confirming, the account is created with portal access and an
            onboarding email goes to <b className="text-slate-700">
            {f.email.trim() || "their address"}</b> carrying their sign-in
            address and a temporary password. It stays valid until they sign
            in for the first time, and they set their own password straight
            away. You can revoke portal access at any time from their page.
          </p>
          <div className="flex justify-between gap-2">
            <button type="button" className="btn-secondary"
              onClick={() => setStep("form")}>
              Go back &amp; edit
            </button>
            <button type="button" className="btn-primary"
              disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Adding…" : "Add Channel Partner"}
            </button>
          </div>
        </div>
      )}
      </div>
    </RecordPage>
  );
}
