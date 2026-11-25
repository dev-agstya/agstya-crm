import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rolesApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { PermissionEditor } from "../../components/PermissionEditor";
import {
  EmailAvailabilityHint,
  useEmailAvailable,
} from "../../components/EmailAvailability";
import { DateInput } from "../../components/DateInput";
import { toast } from "../../components/Toast";
import { todayInput } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { OrgRole } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface EmpForm {
  full_name: string;
  email: string;
  mobile: string;
  designation: string;
  date_of_joining: string;
  monthly_salary: string;
}

export default function AddEmployeePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { has } = useAuth();
  const canSeeSalary = has("view_salary");

  const roles = (useQuery({
    queryKey: ["roles"],
    queryFn: async () => (await rolesApi.list()).data,
  }).data ?? []) as OrgRole[];
  const [step, setStep] = useState<"form" | "review">("form");
  const [f, setF] = useState<EmpForm>({
    full_name: "",
    email: "",
    mobile: "",
    designation: "",
    date_of_joining: todayInput(),
    monthly_salary: "",
  });

  const set = (k: keyof EmpForm, v: string) =>
    setF((s) => ({ ...s, [k]: v }));
  const [perms, setPerms] = useState<string[]>([]);

  const emailState = useEmailAvailable(f.email);
  const formValid =
    f.full_name.trim().length >= 2 &&
    /^\S+@\S+\.\S+$/.test(f.email) &&
    f.mobile.trim().length === 10 &&
    emailState !== "taken" &&
    (!canSeeSalary || Number(f.monthly_salary) > 0);

  const create = useMutation({
    mutationFn: () =>
      usersApi.createEmployee({
        full_name: f.full_name.trim(),
        email: f.email.trim(),
        mobile: f.mobile.trim(),
        extra_permissions: perms,
        employee_profile: {
          designation: f.designation || null,
          date_of_joining: f.date_of_joining || null,
          monthly_salary_paise: f.monthly_salary.trim()
            ? Math.round(Number(f.monthly_salary) * 100)
            : null,
        },
      }),
    onSuccess: () => {
      toast.success(
        "Employee added — a temporary password was emailed (valid for 7 days)."
      );
      qc.invalidateQueries({ queryKey: ["users"] });
      navigate("/people/employees");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const reviewRow = (label: string, value: string) => (
    <div className="flex justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs font-medium text-foreground">
        {value || "—"}
      </span>
    </div>
  );

  return (
    <RecordPage
      backTo="/people/employees"
      backLabel="Back to employees"
      title="Add employee"
      subtitle={
        step === "form"
          ? "Their details and what they can reach."
          : "Check this over — the invitation goes out as soon as you confirm."
      }
    >
      <Card className="p-5">
        {step === "form" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (formValid) setStep("review");
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <FormField label="Full name" required>
                <Input
                  value={f.full_name}
                  required
                  onChange={(e) => set("full_name", e.target.value)}
                />
              </FormField>
              <FormField
                label="Email"
                required
                hint="Login + temp password are sent here."
              >
                <Input
                  type="email"
                  value={f.email}
                  required
                  onChange={(e) => set("email", e.target.value)}
                />
                <EmailAvailabilityHint state={emailState} />
              </FormField>
              <FormField label="Mobile" required>
                <div className="flex">
                  <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 text-xs text-muted-foreground">
                    +91
                  </span>
                  <Input
                    className="rounded-l-none"
                    value={f.mobile}
                    required
                    inputMode="numeric"
                    maxLength={10}
                    placeholder="10-digit number"
                    onChange={(e) =>
                      set("mobile", e.target.value.replace(/\D/g, ""))
                    }
                  />
                </div>
              </FormField>
              <FormField label="Designation">
                <Input
                  value={f.designation}
                  onChange={(e) => set("designation", e.target.value)}
                />
              </FormField>
              <FormField
                label="Date of joining"
                required
                hint="Leave accrues from this date."
              >
                <DateInput
                  value={f.date_of_joining}
                  onChange={(v) => set("date_of_joining", v)}
                />
              </FormField>
              {canSeeSalary && (
                <FormField
                  label="Monthly salary"
                  required
                  hint="Payslip is worked out from this (1/30th per day)."
                >
                  <div className="flex">
                    <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 text-xs text-muted-foreground">
                      Rs
                    </span>
                    <Input
                      className="rounded-l-none"
                      inputMode="decimal"
                      value={f.monthly_salary}
                      placeholder="15000"
                      required
                      onChange={(e) =>
                        set(
                          "monthly_salary",
                          e.target.value.replace(/[^\d.]/g, "")
                        )
                      }
                    />
                  </div>
                  {Number(f.monthly_salary) > 0 && (
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      That is Rs{" "}
                      {Math.round(Number(f.monthly_salary) / 30).toLocaleString(
                        "en-IN"
                      )}{" "}
                      a day.
                    </span>
                  )}
                </FormField>
              )}
            </div>

            <div className="rounded-md border border-border p-3.5">
              <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Access &amp; permissions
              </h3>
              <PermissionEditor
                perms={perms}
                onPermsChange={setPerms}
                roles={roles}
                canGrant={has}
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button asChild variant="outline" size="sm">
                <Link to="/people/employees">Cancel</Link>
              </Button>
              <Button type="submit" size="sm" disabled={!formValid}>
                Verify
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-border px-4 py-2">
              {reviewRow("Full name", f.full_name)}
              {reviewRow("Email", f.email)}
              {reviewRow("Mobile", f.mobile)}
              {reviewRow("Designation", f.designation)}
              {reviewRow("Date of joining", f.date_of_joining)}
              {canSeeSalary &&
                reviewRow(
                  "Monthly salary",
                  f.monthly_salary ? `Rs ${f.monthly_salary}` : "—"
                )}
              {reviewRow("Permissions", `${perms.length} granted`)}
            </div>
            <p className="text-xs text-muted-foreground">
              On confirming, the account is created and a temporary password is
              emailed to <strong className="text-foreground">{f.email}</strong>.
              It is valid for <strong className="text-foreground">7 days</strong>;
              the employee completes onboarding on first login.
            </p>
            <div className="flex justify-between gap-2 border-t border-border pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStep("form")}
              >
                Go back &amp; edit
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Adding…" : "Add Employee"}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </RecordPage>
  );
}
