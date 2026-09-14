import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rolesApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { Field } from "../../components/ui";
import { PermissionEditor } from "../../components/PermissionEditor";
import {
  EmailAvailabilityHint, useEmailAvailable,
} from "../../components/EmailAvailability";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { todayInput } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { OrgRole } from "../../lib/types";

interface EmpForm {
  full_name: string; email: string; mobile: string;
  designation: string;
  // Workplace HR (2026-08-20), and LOAD-BEARING since payroll shipped
  // (2026-08-24). The owner: "when the owner is creating a new employee
  // account, at that time we do not ask for the salary right now. But from here
  // onwards we are going to ask what is the salary of that employee."
  //
  // Both are collected AT CREATION rather than left for later, because both are
  // wrong-by-default until somebody fills them in: leave accrues from the
  // joining date, and an employee with no salary gets a payslip that reads zero
  // and cannot be finalised — which is discovered on the 1st, by the person
  // trying to run payroll.
  date_of_joining: string;
  monthly_salary: string;      // rupees in the box, paise on the wire
}

/**
 * Add an employee (/people/employees/new).
 *
 * A two-step wizard — details, then review — so it keeps its own step buttons
 * and uses RecordPage rather than FormPage: the primary action is "next", not
 * "save", until the last step.
 */
export default function AddEmployeePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { has } = useAuth();

  // The salary field is drawn only for somebody who may read one back. Without
  // the flag the server strips it from every response, so offering the input
  // would be offering a write-only field.
  const canSeeSalary = has("view_salary");

  const roles = (useQuery({
    queryKey: ["roles"],
    queryFn: async () => (await rolesApi.list()).data,
  }).data ?? []) as OrgRole[];
  const [step, setStep] = useState<"form" | "review">("form");
  const [f, setF] = useState<EmpForm>({
    full_name: "", email: "", mobile: "", designation: "",
    date_of_joining: todayInput(), monthly_salary: "",
  });

  const set = (k: keyof EmpForm, v: string) => setF((s) => ({ ...s, [k]: v }));
  const [perms, setPerms] = useState<string[]>([]);

  const emailState = useEmailAvailable(f.email);
  // The salary is REQUIRED from 2026-08-24 — but only for somebody who can see
  // the field. An account without `view_salary` never has it drawn, and
  // demanding a value they cannot enter would make the form unsubmittable for
  // them; the server accepts a blank and the pay run reports the gap by name.
  const formValid = f.full_name.trim().length >= 2 &&
    /^\S+@\S+\.\S+$/.test(f.email) && f.mobile.trim().length === 10 &&
    emailState !== "taken" &&
    (!canSeeSalary || Number(f.monthly_salary) > 0);

  const create = useMutation({
    mutationFn: () => usersApi.createEmployee({
      full_name: f.full_name.trim(),
      email: f.email.trim(),
      mobile: f.mobile.trim(),
      extra_permissions: perms,
      employee_profile: {
        designation: f.designation || null,
        date_of_joining: f.date_of_joining || null,
        // Blank is null, never 0 — zero would be a claim that somebody is
        // unpaid rather than that nobody has entered a figure yet.
        monthly_salary_paise: f.monthly_salary.trim()
          ? Math.round(Number(f.monthly_salary) * 100) : null,
      },
    }),
    onSuccess: () => {
      toast.success("Employee added — a temporary password was emailed "
        + "(valid for 7 days).");
      qc.invalidateQueries({ queryKey: ["users"] });
      navigate("/people/employees");
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
      backTo="/people/employees"
      backLabel="Back to employees"
      title="Add employee"
      subtitle={step === "form"
        ? "Their details and what they can reach."
        : "Check this over — the invitation goes out as soon as you confirm."}
    >
      <div className="card px-6 py-5">
      {step === "form" ? (
        <form
          onSubmit={(e) => { e.preventDefault(); if (formValid) setStep("review"); }}
          className="space-y-5"
        >
          <div className="grid grid-cols-2 gap-4">
            <Field label="Full name" required>
              <input className="input" value={f.full_name} required
                onChange={(e) => set("full_name", e.target.value)} />
            </Field>
            <Field label="Email" required
              hint="Login + temp password are sent here.">
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
            <Field label="Designation">
              <input className="input" value={f.designation}
                onChange={(e) => set("designation", e.target.value)} />
            </Field>
            <Field label="Date of joining" required
              hint="Leave accrues from this date, and days before it are never
                counted as absences.">
              <DateInput value={f.date_of_joining}
                onChange={(v) => set("date_of_joining", v)} />
            </Field>
            {canSeeSalary && (
              <Field label="Monthly salary" required
                hint="Their payslip is worked out from this and their
                  attendance. A day costs one thirtieth of it, whatever the
                  month's length.">
                <div className="flex">
                  <span className="inline-flex items-center rounded-l-lg border
                    border-r-0 border-slate-300 bg-slate-50 px-3 text-sm
                    text-slate-500">Rs</span>
                  <input className="input rounded-l-none" inputMode="decimal"
                    value={f.monthly_salary} placeholder="15000" required
                    onChange={(e) => set("monthly_salary",
                      e.target.value.replace(/[^\d.]/g, ""))} />
                </div>
                {/* The per-day rate, live. A wrong salary is caught here or on
                    the 1st of next month, and here is cheaper. */}
                {Number(f.monthly_salary) > 0 && (
                  <span className="hint">
                    That is Rs {Math.round(Number(f.monthly_salary) / 30)
                      .toLocaleString("en-IN")} a day.
                  </span>
                )}
              </Field>
            )}
            {/* No "Reports to" (owner 2026-08-05). It was collected here and
                read by nothing — one of three overlapping hierarchies. An
                employee's structure is now the channel partners they hold,
                assigned when a partner is created. */}
          </div>

          <div className="rounded-control border border-line p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">
              Access &amp; permissions
            </h3>
            <PermissionEditor perms={perms}
              onPermsChange={setPerms} roles={roles} canGrant={has} />
          </div>

          <div className="flex justify-end gap-2">
            <Link to="/people/employees" className="btn-secondary">
              Cancel
            </Link>
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
            {reviewRow("Designation", f.designation)}
            {reviewRow("Date of joining", f.date_of_joining)}
            {canSeeSalary && reviewRow("Monthly salary",
              f.monthly_salary ? `Rs ${f.monthly_salary}` : "—")}
            {reviewRow("Permissions", `${perms.length} granted`)}
          </div>
          <p className="text-sm text-slate-500">
            On confirming, the account is created and a temporary password is
            emailed to <b>{f.email}</b>. It is valid for <b>7 days</b>; the
            employee completes onboarding on first login.
          </p>
          <div className="flex justify-between gap-2">
            <button type="button" className="btn-secondary"
              onClick={() => setStep("form")}>
              Go back &amp; edit
            </button>
            <button type="button" className="btn-primary"
              disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Adding…" : "Add Employee"}
            </button>
          </div>
        </div>
      )}
      </div>
    </RecordPage>
  );
}
