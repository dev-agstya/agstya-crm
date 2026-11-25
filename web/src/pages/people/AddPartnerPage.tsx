import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import {
  EmailAvailabilityHint,
  useEmailAvailable,
} from "../../components/EmailAvailability";
import { toast } from "../../components/Toast";
import type { AssignableManager } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function AddPartnerPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const managers = (useQuery({
    queryKey: ["assignable-managers"],
    queryFn: async () => (await usersApi.assignableManagers()).data,
  }).data ?? []) as AssignableManager[];

  const [step, setStep] = useState<"form" | "review">("form");
  const [f, setF] = useState({
    full_name: "",
    email: "",
    mobile: "",
    relationship_manager_id: "",
  });
  const set = (k: keyof typeof f, v: string) =>
    setF((s) => ({ ...s, [k]: v }));

  const emailState = useEmailAvailable(f.email);
  const formValid =
    f.full_name.trim().length >= 2 &&
    /^\S+@\S+\.\S+$/.test(f.email) &&
    f.mobile.trim().length === 10 &&
    !!f.relationship_manager_id &&
    emailState !== "taken";

  const mgrLabel = (m: AssignableManager) =>
    m.account_type === "owner" ? `${m.full_name} (Owner)` : m.full_name;

  const create = useMutation({
    mutationFn: () =>
      usersApi.createPartner({
        full_name: f.full_name.trim(),
        email: f.email.trim(),
        mobile: f.mobile.trim(),
        relationship_manager_id: f.relationship_manager_id,
      }),
    onSuccess: () => {
      toast.success(
        `Channel Partner added. An invitation with their sign-in details was emailed to ${f.email.trim()}.`
      );
      qc.invalidateQueries({ queryKey: ["users"] });
      navigate("/people/partners");
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
      backTo="/people/partners"
      backLabel="Back to channel partners"
      title="Add channel partner"
      subtitle={
        step === "form"
          ? "They get portal access and an emailed invitation as soon as the account is created."
          : "Check this over before creating the account."
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Full name" required>
                <Input
                  value={f.full_name}
                  required
                  onChange={(e) => set("full_name", e.target.value)}
                />
              </FormField>
              <FormField label="Email" required>
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
              <FormField label="Relationship manager" required>
                <Select
                  value={f.relationship_manager_id}
                  onValueChange={(v) => set("relationship_manager_id", v)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select a manager" />
                  </SelectTrigger>
                  <SelectContent>
                    {managers.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {mgrLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button asChild variant="outline" size="sm">
                <Link to="/people/partners">Cancel</Link>
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
              {reviewRow(
                "Relationship manager",
                managers.find((m) => m.id === f.relationship_manager_id)
                  ?.full_name ?? ""
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              On confirming, the account is created with portal access and an
              onboarding email goes to{" "}
              <strong className="text-foreground">
                {f.email.trim() || "their address"}
              </strong>{" "}
              carrying their sign-in address and a temporary password. You can
              revoke portal access at any time from their page.
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
                {create.isPending ? "Adding…" : "Add Channel Partner"}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </RecordPage>
  );
}
