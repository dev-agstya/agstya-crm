import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import {
  Download,
  Loader2,
  Mail,
  Pencil,
  RefreshCw,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { reassignApi, usersApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { FormField } from "./shared/FormSection";
import { RecordTabs } from "./RecordPage";
import { DateInput } from "./DateInput";
import { ManagerRosterPanel } from "./ManagerRosterPanel";
import { PersonHrPanel } from "./hr/PersonHrPanel";
import { PartnerPolicies } from "./policies/PartnerPolicies";
import { PermissionEditor } from "./PermissionEditor";
import { toast } from "./Toast";
import { confirmDialog } from "./Confirm";
import { formatDate, titleCase } from "../lib/format";
import { useAuth } from "../store/auth";
import type { AssignableManager, OrgRole, UserRow } from "../lib/types";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";

type Tab =
  | "profile"
  | "team"
  | "policies"
  | "hr"
  | "permissions"
  | "documents"
  | "account";

function StatusChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <Badge variant="outline" className={`h-5 px-2 text-[11px] font-medium ${tone}`}>
      <span className="font-normal opacity-75">{label}:</span>
      <span className="ml-1 font-semibold">{value}</span>
    </Badge>
  );
}

export function PersonDetailBody({
  user,
  kind,
  managers,
  roles,
  onClose,
  onChanged,
}: {
  user: UserRow;
  kind: "employee" | "channel_partner";
  managers: AssignableManager[];
  roles: OrgRole[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { has, user: me } = useAuth();
  const nav = useNavigate();
  const isEmp = kind === "employee";
  const canPerms = isEmp && has("manage_roles_permissions");
  const canAnalytics = has("view_balance_sheet") || has("view_reports");
  const canRoster = isEmp && (has("view_partners") || me?.id === user.id);
  const canHr =
    isEmp &&
    (me?.id === user.id || has("view_attendance") || has("view_leave"));
  const canPolicies = !isEmp && has("view_policies");

  const requestedTab = new URLSearchParams(window.location.search).get("tab");
  const initialTab: Tab =
    canHr && requestedTab === "hr"
      ? "hr"
      : canPolicies && requestedTab === "policies"
        ? "policies"
        : canRoster && (requestedTab === "team" || requestedTab === "partners")
          ? "team"
          : "profile";
  const [tab, setTab] = useState<Tab>(initialTab);

  const tabs: { key: Tab; label: string }[] = [
    { key: "profile", label: "Profile" },
    ...(canRoster ? [{ key: "team" as Tab, label: "Team" }] : []),
    ...(canPolicies ? [{ key: "policies" as Tab, label: "Policies" }] : []),
    ...(canHr ? [{ key: "hr" as Tab, label: "Attendance & leave" }] : []),
    ...(canPerms ? [{ key: "permissions" as Tab, label: "Permissions" }] : []),
    { key: "documents", label: "KYC documents" },
    { key: "account", label: "Account" },
  ];

  const activeAcct = user.status === "active";

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-xs text-muted-foreground">{user.email}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {isEmp && (
            <StatusChip
              label="Onboarding"
              value={user.onboarded === false ? "Pending" : "Done"}
              tone={
                user.onboarded === false
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }
            />
          )}
          <StatusChip
            label="Account"
            value={titleCase(user.status)}
            tone={
              activeAcct
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }
          />
          {canAnalytics && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              title="Open this person's analytics & performance"
              onClick={() =>
                nav(
                  `/finance/entity/${isEmp ? "employee" : "partner"}/${user.id}`
                )
              }
            >
              <TrendingUp className="mr-1.5 h-3.5 w-3.5" /> Analytics
            </Button>
          )}
        </div>
      </div>

      <RecordTabs
        tabs={tabs.map((t) => ({ value: t.key, label: t.label }))}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
      />

      <div className="p-4 sm:p-5">
        {tab === "profile" && (
          <ProfileTab
            user={user}
            isEmp={isEmp}
            managers={managers}
            onChanged={onChanged}
            onClose={onClose}
          />
        )}
        {tab === "team" && canRoster && (
          <ManagerRosterPanel managerId={user.id} />
        )}
        {tab === "policies" && canPolicies && (
          <PartnerPolicies partnerId={user.id} partnerName={user.full_name} />
        )}
        {tab === "hr" && canHr && <PersonHrPanel user={user} />}
        {tab === "permissions" && canPerms && (
          <PermissionsTab user={user} roles={roles} onChanged={onChanged} />
        )}
        {tab === "documents" && <DocumentsTab user={user} />}
        {tab === "account" && (
          <AccountTab user={user} onChanged={onChanged} onClose={onClose} />
        )}
      </div>
    </Card>
  );
}

function ProfileTab({
  user,
  isEmp,
  managers,
  onChanged,
  onClose,
}: {
  user: UserRow;
  isEmp: boolean;
  managers: AssignableManager[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const ep = user.employee_profile ?? {};
  const bp = user.partner_profile ?? {};
  const bank = bp.bank ?? {};
  const initial = {
    full_name: user.full_name,
    email: user.email,
    mobile: user.mobile ?? "",
    relationship_manager_id: user.relationship_manager_id ?? "",
    designation: ep.designation ?? "",
    date_of_joining: ep.date_of_joining
      ? String(ep.date_of_joining).slice(0, 10)
      : "",
    monthly_salary:
      ep.monthly_salary_paise != null
        ? String(ep.monthly_salary_paise / 100)
        : "",
    shift_start: ep.shift_start ?? "",
    shift_end: ep.shift_end ?? "",
    account_holder: bank.account_holder ?? "",
    account_number: bank.account_number ?? "",
    ifsc: bank.ifsc ?? "",
    bank_name: bank.bank_name ?? "",
    upi_id: bank.upi_id ?? "",
  };
  const [f, setF] = useState(initial);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const [editing, setEditing] = useState(false);
  const ro = !editing;
  const { has, user: me } = useAuth();
  const canEdit = has(isEmp ? "manage_employees" : "manage_partners");
  const canSeeSalary = has("view_salary") || me?.id === user.id;

  const mgrOptions = managers.filter((m) => m.id !== user.id);
  const mgrLabel = (m: AssignableManager) =>
    m.account_type === "owner" ? `${m.full_name} (Owner)` : m.full_name;

  const cancel = () => {
    setF(initial);
    setEditing(false);
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        full_name: f.full_name,
        mobile: f.mobile,
      };
      if (f.email.trim().toLowerCase() !== user.email.toLowerCase())
        body.email = f.email.trim();
      if (isEmp) {
        const salary = f.monthly_salary.trim();
        body.employee_profile = {
          ...ep,
          designation: f.designation || null,
          date_of_joining: f.date_of_joining || null,
          ...(canSeeSalary
            ? {
                monthly_salary_paise: salary
                  ? Math.round(Number(salary) * 100)
                  : null,
              }
            : {}),
          shift_start: f.shift_start || null,
          shift_end: f.shift_end || null,
        };
      } else {
        body.relationship_manager_id = f.relationship_manager_id || null;
        body.partner_profile = {
          ...bp,
          bank: {
            account_holder: f.account_holder || null,
            account_number: f.account_number || null,
            ifsc: f.ifsc || null,
            bank_name: f.bank_name || null,
            upi_id: f.upi_id || null,
          },
        };
      }
      return usersApi.update(user.id, body);
    },
    onSuccess: () => {
      toast.success("Saved.");
      onChanged();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (editing) save.mutate();
      }}
      className="space-y-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FormField label="Full name" required>
          <Input
            value={f.full_name}
            required
            disabled={ro}
            onChange={(e) => set("full_name", e.target.value)}
          />
        </FormField>
        <FormField
          label="Email"
          hint={
            editing
              ? "Changing the email forces the user to sign in again."
              : undefined
          }
        >
          <Input
            type="email"
            value={f.email}
            disabled={ro}
            onChange={(e) => set("email", e.target.value)}
          />
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
              disabled={ro}
              onChange={(e) => set("mobile", e.target.value.replace(/\D/g, ""))}
            />
          </div>
        </FormField>

        {isEmp ? (
          <>
            <FormField label="Designation">
              <Input
                value={f.designation}
                disabled={ro}
                onChange={(e) => set("designation", e.target.value)}
              />
            </FormField>
            <FormField
              label="Date of joining"
              hint={editing ? "Leave accrues from this date." : undefined}
            >
              <DateInput
                value={f.date_of_joining}
                disabled={ro}
                onChange={(v) => set("date_of_joining", v)}
              />
            </FormField>
            {canSeeSalary && (
              <FormField
                label="Monthly salary"
                hint={
                  editing
                    ? "Payslip is worked out from this (1/30th per day)."
                    : undefined
                }
              >
                <div className="flex">
                  <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 text-xs text-muted-foreground">
                    Rs
                  </span>
                  <Input
                    className="rounded-l-none"
                    inputMode="decimal"
                    value={f.monthly_salary}
                    disabled={ro}
                    onChange={(e) =>
                      set(
                        "monthly_salary",
                        e.target.value.replace(/[^\d.]/g, "")
                      )
                    }
                  />
                </div>
              </FormField>
            )}
            <FormField
              label="Shift start"
              hint={editing ? "Blank follows agency default." : undefined}
            >
              <Input
                type="time"
                value={f.shift_start}
                disabled={ro}
                onChange={(e) => set("shift_start", e.target.value)}
              />
            </FormField>
            <FormField label="Shift end">
              <Input
                type="time"
                value={f.shift_end}
                disabled={ro}
                onChange={(e) => set("shift_end", e.target.value)}
              />
            </FormField>
          </>
        ) : (
          <div className="sm:col-span-2 lg:col-span-3">
            <FormField
              label="Relationship manager"
              required
              hint={
                editing
                  ? "Their policies follow them: whoever manages this partner can see everything the partner has booked."
                  : undefined
              }
            >
              <Select
                value={f.relationship_manager_id}
                disabled={ro}
                onValueChange={(v) => set("relationship_manager_id", v)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="— Select —" />
                </SelectTrigger>
                <SelectContent>
                  {mgrOptions.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {mgrLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {editing &&
              f.relationship_manager_id &&
              f.relationship_manager_id !==
                (user.relationship_manager_id ?? "") && (
                <ReassignNotice
                  partnerId={user.id}
                  managerId={f.relationship_manager_id}
                />
              )}
          </div>
        )}
      </div>

      {!isEmp && (
        <details className="rounded-md border border-border bg-muted/30 p-3.5">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            Bank / payout details
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Account holder">
              <Input
                value={f.account_holder}
                disabled={ro}
                onChange={(e) => set("account_holder", e.target.value)}
              />
            </FormField>
            <FormField label="Account number">
              <Input
                value={f.account_number}
                disabled={ro}
                onChange={(e) => set("account_number", e.target.value)}
              />
            </FormField>
            <FormField label="IFSC">
              <Input
                value={f.ifsc}
                disabled={ro}
                onChange={(e) => set("ifsc", e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label="Bank name">
              <Input
                value={f.bank_name}
                disabled={ro}
                onChange={(e) => set("bank_name", e.target.value)}
              />
            </FormField>
            <FormField label="UPI ID">
              <Input
                value={f.upi_id}
                disabled={ro}
                onChange={(e) => set("upi_id", e.target.value)}
              />
            </FormField>
          </div>
        </details>
      )}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        {editing ? (
          <>
            <Button
              key="cancel"
              type="button"
              variant="outline"
              size="sm"
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button
              key="save"
              type="submit"
              size="sm"
              disabled={save.isPending}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </>
        ) : (
          <>
            <Button
              key="close"
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
            >
              Close
            </Button>
            {canEdit && (
              <Button
                key="edit"
                type="button"
                size="sm"
                onClick={() => setEditing(true)}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
              </Button>
            )}
          </>
        )}
      </div>
    </form>
  );
}

function PermissionsTab({
  user,
  roles,
  onChanged,
}: {
  user: UserRow;
  roles: OrgRole[];
  onChanged: () => void;
}) {
  const { has } = useAuth();
  const [perms, setPerms] = useState<string[]>(user.permissions ?? []);
  const save = useMutation({
    mutationFn: () => usersApi.setPermissions(user.id, perms),
    onSuccess: () => {
      toast.success("Permissions updated.");
      onChanged();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Tick roles to grant bundles, then add or remove individual permissions.
        What&apos;s ticked is exactly what this employee can do.
      </p>
      <PermissionEditor
        perms={perms}
        onPermsChange={setPerms}
        roles={roles}
        canGrant={has}
      />
      <div className="flex justify-end border-t border-border pt-3">
        <Button
          size="sm"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save permissions"}
        </Button>
      </div>
    </div>
  );
}

function DocumentsTab({ user }: { user: UserRow }) {
  const docs = useQuery({
    queryKey: ["user-docs", user.id],
    queryFn: async () => (await usersApi.listDocuments(user.id)).data,
  });

  const open = async (docId: string) => {
    try {
      const r = await usersApi.downloadDocument(user.id, docId);
      window.open(r.data.url, "_blank", "noopener");
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  if (docs.isLoading)
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  const items = docs.data ?? [];
  if (items.length === 0)
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        No KYC documents uploaded yet. The user uploads these during onboarding.
      </p>
    );

  return (
    <div className="space-y-2">
      {items.map((d) => (
        <div
          key={d.id}
          className="flex items-center justify-between gap-3 rounded-md border border-border px-3.5 py-2.5"
        >
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{d.label}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {d.filename} · {formatDate(d.created_at)}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => open(d.id)}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" /> View / download
          </Button>
        </div>
      ))}
    </div>
  );
}

function AccountTab({
  user,
  onChanged,
  onClose,
}: {
  user: UserRow;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { has } = useAuth();
  const linked = user.in_use !== false;
  const isEmp = user.account_type !== "channel_partner";
  const canEdit = has(isEmp ? "manage_employees" : "manage_partners");
  const [acctStatus, setAcctStatus] = useState(user.status);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");

  const status = useMutation({
    mutationFn: (v: { next: string; acknowledged?: boolean }) =>
      usersApi.setStatus(user.id, v.next, undefined, v.acknowledged),
    onSuccess: (_r, v) => {
      setAcctStatus(v.next as typeof acctStatus);
      toast.success("Status updated.");
      onChanged();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const changeStatus = async (next: string) => {
    try {
      await status.mutateAsync({ next });
    } catch (e) {
      const conflict = isAxiosError(e) && e.response?.status === 409;
      if (!conflict) return;
      if (
        await confirmDialog({
          title: "Deactivate anyway?",
          message: apiError(e),
          confirmLabel: "Deactivate anyway",
          danger: true,
        })
      )
        status.mutate({ next, acknowledged: true });
    }
  };
  const [portalOn, setPortalOn] = useState(user.portal_access ?? false);
  const portalAccess = useMutation({
    mutationFn: (value: boolean) =>
      usersApi.update(user.id, { portal_access: value }),
    onSuccess: (_r, value) => {
      setPortalOn(value);
      toast.success(
        value
          ? "Portal access granted. Send them an invitation to sign in."
          : "Portal access revoked — they are signed out immediately."
      );
      onChanged();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const invite = useMutation({
    mutationFn: () => usersApi.resendInvite(user.id),
    onSuccess: (r) => toast.success(r.data.detail),
    onError: (e) => toast.error(apiError(e)),
  });
  const reset = useMutation({
    mutationFn: () => usersApi.resetPassword(user.id),
    onSuccess: () =>
      toast.success(
        "Temporary password emailed (valid 7 days). The user will set a new password on next login."
      ),
    onError: (e) => toast.error(apiError(e)),
  });
  const requestOtp = useMutation({
    mutationFn: () => usersApi.requestDeleteOtp(user.id),
    onSuccess: (r) => {
      setOtpSent(true);
      toast.success(r.data.detail);
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const del = useMutation({
    mutationFn: () => usersApi.remove(user.id, otp.trim()),
    onSuccess: () => {
      toast.success("Account deleted.");
      onChanged();
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const active = acctStatus === "active";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3.5">
        <div>
          <p className="text-xs font-medium text-foreground">Account status</p>
          <p className="text-[11px] text-muted-foreground">
            {active
              ? "Active — the user can sign in."
              : "Deactivated — the user cannot sign in."}
          </p>
        </div>
        {canEdit ? (
          <Button
            type="button"
            variant={active ? "outline" : "default"}
            size="sm"
            className={active ? "text-amber-700 hover:text-amber-800" : ""}
            disabled={status.isPending}
            onClick={() => changeStatus(active ? "inactive" : "active")}
          >
            {active ? "Deactivate" : "Activate"}
          </Button>
        ) : (
          <StatusChip
            label="Status"
            value={active ? "Active" : "Deactivated"}
            tone={
              active
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }
          />
        )}
      </div>

      {!isEmp && canEdit && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3.5">
          <div>
            <p className="text-xs font-medium text-foreground">Portal access</p>
            <p className="text-[11px] text-muted-foreground">
              {portalOn
                ? "This partner can sign in and see their own policies, renewals, earnings and notices."
                : "Revoked — this partner cannot sign in. Switch on to let them back in."}
            </p>
          </div>
          <Switch
            checked={portalOn}
            aria-label="Portal access"
            onCheckedChange={(v) => portalAccess.mutate(v)}
          />
        </div>
      )}

      {canEdit && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3.5">
          <div>
            <p className="text-xs font-medium text-foreground">
              {isEmp ? "Reset password" : "Send portal invitation"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {isEmp
                ? "Emails a temporary password valid for 7 days; the user is forced to set a new one."
                : "Send the onboarding email again if it never arrived."}
            </p>
          </div>
          {isEmp ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />{" "}
              {reset.isPending ? "Sending…" : "Reset"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!portalOn || invite.isPending}
              title={portalOn ? undefined : "Switch on portal access first"}
              onClick={() => invite.mutate()}
            >
              <Mail className="mr-1.5 h-3.5 w-3.5" />
              {invite.isPending ? "Sending…" : "Send invite"}
            </Button>
          )}
        </div>
      )}

      {!canEdit ? null : linked ? (
        <div className="rounded-md border border-border p-3.5">
          <p className="text-xs font-medium text-foreground">Delete account</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Not available — this person is named on policies or transactions.
            Use Deactivate above instead.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3.5">
          <p className="text-xs font-medium text-destructive">Delete account</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Nothing is linked to this account yet, so it can be removed.
            Requires an emailed confirmation code.
          </p>
          {!otpSent ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2.5 border-destructive/40 text-destructive hover:bg-destructive/10"
              disabled={requestOtp.isPending}
              onClick={() => requestOtp.mutate()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {requestOtp.isPending ? "Sending code…" : "Delete — send code"}
            </Button>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-end gap-2">
              <FormField label="Confirmation code">
                <Input
                  className="w-36"
                  value={otp}
                  inputMode="numeric"
                  placeholder="6-digit code"
                  onChange={(e) => setOtp(e.target.value)}
                />
              </FormField>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => requestOtp.mutate()}
                disabled={requestOtp.isPending}
              >
                Resend
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={del.isPending || otp.trim().length === 0}
                onClick={() => del.mutate()}
              >
                {del.isPending ? "Deleting…" : "Confirm delete"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReassignNotice({
  partnerId,
  managerId,
}: {
  partnerId: string;
  managerId: string;
}) {
  const preview = useQuery({
    queryKey: ["reassign-preview", partnerId, managerId],
    queryFn: async () =>
      (await reassignApi.preview(partnerId, managerId)).data,
    retry: false,
  });

  if (preview.isLoading) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Working out what moves…
      </p>
    );
  }
  if (!preview.data) return null;

  const n = preview.data.policy_count;
  return (
    <p className="mt-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
      <strong>
        {n === 0 ? "No policies" : `${n} polic${n === 1 ? "y" : "ies"}`}
      </strong>{" "}
      {n === 1 ? "moves" : "move"} to{" "}
      <strong>{preview.data.to_manager ?? "the new manager"}</strong>
      {preview.data.from_manager ? (
        <>
          {" "}
          and {n === 1 ? "comes" : "come"} off{" "}
          <strong>{preview.data.from_manager}</strong>&apos;s list
        </>
      ) : null}{" "}
      when you save. Targets and reports are untouched.
    </p>
  );
}
