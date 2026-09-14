import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import { reassignApi, usersApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { Icon } from "./Icon";
import { Field, Spinner, Toggle } from "./ui";
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

type Tab = "profile" | "team" | "policies" | "hr" | "permissions" | "documents"
  | "account";

// A small labelled status chip, e.g. "Account: Active" — so the header badges
// say what they mean instead of two bare words (owner 2026-07-26).
function StatusChip({ label, value, tone }: {
  label: string; value: string; tone: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="font-normal opacity-70">{label}:</span>
      <span className="ml-1 font-semibold">{value}</span>
    </span>
  );
}

// One consolidated "View" popup for an Employee or Channel Partner: edit their
// profile, (employees) fine-tune permissions, review KYC documents, and run
// account actions (activate/deactivate, reset password, OTP-verified delete).
/**
 * The body of a person's record — profile, permissions, KYC and account
 * actions. Rendered inside a RecordPage (pages/people/PersonDetailPage), which
 * owns the heading, the back link and the Analytics action.
 *
 * It was a dialog until 2026-08-03. `onClose` survives because the account
 * actions that REMOVE the person still need somewhere to go — it now navigates
 * back to the list instead of closing a popup.
 */
export function PersonDetailBody({
  user, kind, managers, roles, onClose, onChanged,
}: {
  user: UserRow;
  kind: "employee" | "channel_partner";
  managers: AssignableManager[];
  roles: OrgRole[];
  /** Called when the record goes away (deleted / deactivated). */
  onClose: () => void;
  onChanged: () => void;
}) {
  const { has, user: me } = useAuth();
  const nav = useNavigate();
  const isEmp = kind === "employee";
  const canPerms = isEmp && has("manage_roles_permissions");
  const canAnalytics = has("view_balance_sheet") || has("view_reports");

  // This employee's TEAM: their own target, and the channel partners under
  // them against the numbers they were given. It replaced a whole separate page
  // (/people/managers/:id) — an employee's roster is part of their record, not
  // a screen of its own (owner 2026-08-05) — and it is called "Team" because
  // that is what the owner calls it (2026-08-06).
  //
  // Reading somebody else's roster needs view_partners; your own does not,
  // because seeing the partners you personally manage is the job. It is shown
  // even when the roster is empty (owner G7): a missing tab reads as a bug, and
  // the employee's own target is on it either way.
  const canRoster = isEmp
    && (has("view_partners") || me?.id === user.id);

  // Attendance, leave and the salary for ONE person, in one place (owner H7).
  // A tab rather than a page, exactly like Team above: everything about
  // somebody belongs on their record instead of making a manager filter three
  // separate screens by their name.
  //
  // EMPLOYEES ONLY — channel partners are external and the HR module does not
  // cover them at all. Your own record needs no flag (the same rule the whole
  // module follows); somebody else's needs view_attendance or view_leave,
  // because the panel shows both and either one makes the tab worth opening.
  const canHr = isEmp
    && (me?.id === user.id || has("view_attendance") || has("view_leave"));

  // A CHANNEL PARTNER'S OWN POLICIES, on their own record (owner 2026-08-24):
  // "when they go to their channel partner's profile, they should be able to
  // see all the policies that this channel partner has, so that we can go to a
  // channel partner and filter out the specific policies that they only have."
  //
  // Partners only — an employee's business is the Team tab, which rolls up
  // their whole roster. Behind `view_policies`, because that is what the list
  // endpoint underneath demands; the SCOPE is the server's, so a manager
  // opening one of their own partners sees everything and nobody else reaches
  // this record at all.
  const canPolicies = !isEmp && has("view_policies");

  // Deep-linkable, so the Performance view can send you straight to it.
  // `?tab=partners` is honoured alongside `?tab=team`: the Performance view
  // linked to it for weeks and somebody has it bookmarked.
  const requestedTab = new URLSearchParams(window.location.search).get("tab");
  const initialTab: Tab =
    canHr && requestedTab === "hr" ? "hr"
      : canPolicies && requestedTab === "policies" ? "policies"
        : canRoster && (requestedTab === "team" || requestedTab === "partners")
          ? "team" : "profile";
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
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line
        px-5 py-3">
        <span className="text-sm text-slate-500">{user.email}</span>
        <span className="ml-auto flex items-center gap-2">
          {isEmp && (
            <StatusChip label="Onboarding"
              value={user.onboarded === false ? "Pending" : "Done"}
              tone={user.onboarded === false
                ? "bg-due/10 text-due"
                : "bg-money-in/10 text-money-in"} />
          )}
          <StatusChip label="Account" value={titleCase(user.status)}
            tone={activeAcct ? "bg-money-in/10 text-money-in"
              : "bg-money-out/10 text-money-out"} />
          {canAnalytics && (
            <button className="btn-secondary btn-sm"
              title="Open this person's analytics & performance"
              onClick={() => nav(`/finance/entity/${
                isEmp ? "employee" : "partner"}/${user.id}`)}>
              <Icon.Trend size={14} /> Analytics
            </button>
          )}
        </span>
      </div>

      <RecordTabs
        tabs={tabs.map((t) => ({ value: t.key, label: t.label }))}
        value={tab}
        onChange={(v) => setTab(v as Tab)} />

      <div className="px-5 py-5">
      {tab === "profile" && (
        <ProfileTab user={user} isEmp={isEmp} managers={managers}
          onChanged={onChanged} onClose={onClose} />
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
    </div>
  );
}

/* -------------------------------------------------------------- Profile tab -- */

function ProfileTab({ user, isEmp, managers, onChanged, onClose }: {
  user: UserRow; isEmp: boolean; managers: AssignableManager[];
  onChanged: () => void; onClose: () => void;
}) {
  const ep = user.employee_profile ?? {};
  const bp = user.partner_profile ?? {};
  const bank = bp.bank ?? {};
  const initial = {
    full_name: user.full_name, email: user.email, mobile: user.mobile ?? "",
    relationship_manager_id: user.relationship_manager_id ?? "",
    designation: ep.designation ?? "",
    // Workplace HR reads these three (2026-08-20). `date_of_joining` has been
    // on the model since the beginning and NO FORM IN THE APP EVER COLLECTED
    // IT, which is why leave accrual and "days before you joined are not
    // absences" had nothing to work from until now.
    date_of_joining: ep.date_of_joining
      ? String(ep.date_of_joining).slice(0, 10) : "",
    // Rupees in the box, paise on the wire. Blank means "not set" and is sent
    // as null — never as 0, which would be a claim that somebody is unpaid.
    monthly_salary: ep.monthly_salary_paise != null
      ? String(ep.monthly_salary_paise / 100) : "",
    shift_start: ep.shift_start ?? "",
    shift_end: ep.shift_end ?? "",
    account_holder: bank.account_holder ?? "",
    account_number: bank.account_number ?? "",
    ifsc: bank.ifsc ?? "", bank_name: bank.bank_name ?? "",
    upi_id: bank.upi_id ?? "",
  };
  const [f, setF] = useState(initial);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  // The whole profile is read-only until "Edit" is pressed (owner 2026-07-26:
  // one Edit button, not a per-field "Allow edit").
  const [editing, setEditing] = useState(false);
  const ro = !editing;
  // A relationship manager can OPEN one of their own partners' records without
  // the manage right (owner G1/G4, 2026-08-06) — reading it is the job. CHANGING it
  // is not: PATCH /api/users/{id} still demands it, so without the
  // flag there is no Edit button rather than one that 403s on save.
  const { has } = useAuth();
  const canEdit = has(isEmp ? "manage_employees" : "manage_partners");
  // The salary is stripped from the payload without this flag, so the field is
  // not merely hidden — there is nothing to render. Everybody may see their
  // own.
  const { user: me } = useAuth();
  const canSeeSalary = has("view_salary") || me?.id === user.id;

  const mgrOptions = managers.filter((m) => m.id !== user.id);
  const mgrLabel = (m: AssignableManager) =>
    m.account_type === "owner" ? `${m.full_name} (Owner)` : m.full_name;

  const cancel = () => { setF(initial); setEditing(false); };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        full_name: f.full_name, mobile: f.mobile,
      };
      if (f.email.trim().toLowerCase() !== user.email.toLowerCase())
        body.email = f.email.trim();
      if (isEmp) {
        const salary = f.monthly_salary.trim();
        body.employee_profile = {
          ...ep,
          designation: f.designation || null,
          date_of_joining: f.date_of_joining || null,
          // Only written when the actor may SEE it. Without `view_salary` the
          // server has already stripped the value out of `ep`, so spreading it
          // back would post `null` and wipe a figure the editor was never
          // shown — the classic shape of an edit form silently deleting a
          // field it could not render.
          ...(canSeeSalary ? {
            monthly_salary_paise: salary
              ? Math.round(Number(salary) * 100) : null,
          } : {}),
          shift_start: f.shift_start || null,
          shift_end: f.shift_end || null,
        };
      } else {
        body.relationship_manager_id = f.relationship_manager_id || null;
        body.partner_profile = {
          ...bp,
          bank: {
            account_holder: f.account_holder || null,
            account_number: f.account_number || null, ifsc: f.ifsc || null,
            bank_name: f.bank_name || null, upi_id: f.upi_id || null,
          },
        };
      }
      return usersApi.update(user.id, body);
    },
    onSuccess: () => { toast.success("Saved."); onChanged(); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (editing) save.mutate(); }}
      className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Full name" required>
          <input className="input" value={f.full_name} required disabled={ro}
            onChange={(e) => set("full_name", e.target.value)} />
        </Field>
        <Field label="Email"
          hint={editing
            ? "Changing the email forces the user to sign in again." : undefined}>
          <input type="email" className="input" value={f.email} disabled={ro}
            onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Mobile" required>
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg border border-r-0
              border-slate-300 bg-slate-50 px-3 text-sm text-slate-500">+91</span>
            <input className="input rounded-l-none" value={f.mobile} required
              inputMode="numeric" maxLength={10} disabled={ro}
              onChange={(e) => set("mobile", e.target.value.replace(/\D/g, ""))} />
          </div>
        </Field>
        {isEmp ? (
          <>
            <Field label="Designation">
              <input className="input" value={f.designation} disabled={ro}
                onChange={(e) => set("designation", e.target.value)} />
            </Field>
            {/* "Reports to" is gone (owner 2026-08-05). It was collected here
                and read by nothing in the app — one of the three overlapping
                hierarchies the relationship-manager rebuild replaced with one.
                An employee's structural relationship is now the partners they
                hold, on People -> Relationship Managers. */}
            <Field label="Date of joining"
              hint={editing
                ? "Leave accrues from this date, and days before it are never counted as absences."
                : undefined}>
              <DateInput value={f.date_of_joining} disabled={ro}
                onChange={(v) => set("date_of_joining", v)} />
            </Field>
            {canSeeSalary && (
              <Field label="Monthly salary"
                hint={editing
                  ? "Their payslip is worked out from this and their attendance. A day costs one thirtieth of it, whatever the month's length."
                  : undefined}>
                <div className="flex">
                  <span className="inline-flex items-center rounded-l-lg border
                    border-r-0 border-slate-300 bg-slate-50 px-3 text-sm
                    text-slate-500">Rs</span>
                  <input className="input rounded-l-none" inputMode="decimal"
                    value={f.monthly_salary} disabled={ro}
                    onChange={(e) => set("monthly_salary",
                      e.target.value.replace(/[^\d.]/g, ""))} />
                </div>
              </Field>
            )}
            <Field label="Shift start"
              hint={editing ? "Blank follows the agency default." : undefined}>
              <input type="time" className="input" value={f.shift_start}
                disabled={ro}
                onChange={(e) => set("shift_start", e.target.value)} />
            </Field>
            <Field label="Shift end">
              <input type="time" className="input" value={f.shift_end}
                disabled={ro}
                onChange={(e) => set("shift_end", e.target.value)} />
            </Field>
          </>
        ) : (
          <div className="col-span-2">
            {/*
              THIS ONE FIELD MOVES AN ENTIRE BOOK OF BUSINESS (2026-08-24).

              Since policies became scoped, a partner's relationship manager
              decides who can READ every policy that partner ever booked — and
              changing it moves all of them, instantly, with no migration
              (services/policy_scope). The owner asked for exactly that: "if I
              want to move one channel partner to other employee, as soon as I
              do that, all the policies related to that channel partner should
              also be moved to that new employee."

              So the field says what it is about to do, with the count, BEFORE
              anything is saved. A dropdown that silently reassigns forty
              policies is a dropdown somebody changes by accident.
            */}
            <Field label="Relationship manager" required
              hint={editing
                ? "Their policies follow them: whoever manages this partner can see everything the partner has booked."
                : undefined}>
              <select className="select" value={f.relationship_manager_id} required
                disabled={ro}
                onChange={(e) => set("relationship_manager_id", e.target.value)}>
                <option value="">— Select —</option>
                {mgrOptions.map((m) => (
                  <option key={m.id} value={m.id}>{mgrLabel(m)}</option>
                ))}
              </select>
            </Field>
            {editing
              && f.relationship_manager_id
              && f.relationship_manager_id !== (user.relationship_manager_id ?? "")
              && (
                <ReassignNotice partnerId={user.id}
                  managerId={f.relationship_manager_id} />
              )}
          </div>
        )}
      </div>

      {!isEmp && (
        <details className="rounded-control bg-slate-50 p-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-600">
            Bank / payout details
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Account holder">
              <input className="input" value={f.account_holder} disabled={ro}
                onChange={(e) => set("account_holder", e.target.value)} />
            </Field>
            <Field label="Account number">
              <input className="input" value={f.account_number} disabled={ro}
                onChange={(e) => set("account_number", e.target.value)} />
            </Field>
            <Field label="IFSC">
              <input className="input" value={f.ifsc} disabled={ro}
                onChange={(e) => set("ifsc", e.target.value.toUpperCase())} />
            </Field>
            <Field label="Bank name">
              <input className="input" value={f.bank_name} disabled={ro}
                onChange={(e) => set("bank_name", e.target.value)} />
            </Field>
            <Field label="UPI ID">
              <input className="input" value={f.upi_id} disabled={ro}
                onChange={(e) => set("upi_id", e.target.value)} />
            </Field>
          </div>
        </details>
      )}

      {/* The keys are load-bearing, don't drop them. Both branches render two
          buttons in the same slot, so without keys React reuses the DOM nodes
          and merely flips the Edit button's type to "submit" — and the browser
          reads that type AFTER the click handler, so the very click that turned
          editing on also submitted the form and saved instantly. Distinct keys
          make React swap the elements instead of mutating them. */}
      <div className="flex justify-end gap-2">
        {editing ? (
          <>
            <button key="cancel" type="button" className="btn-secondary"
              onClick={cancel}>
              Cancel</button>
            <button key="save" type="submit" className="btn-primary"
              disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
          </>
        ) : (
          <>
            <button key="close" type="button" className="btn-secondary"
              onClick={onClose}>
              Close</button>
            {canEdit && (
              <button key="edit" type="button" className="btn-primary"
                onClick={() => setEditing(true)}>
                <Icon.Edit size={16} /> Edit
              </button>
            )}
          </>
        )}
      </div>
    </form>
  );
}

/* ---------------------------------------------------------- Permissions tab -- */

function PermissionsTab({ user, roles, onChanged }: {
  user: UserRow; roles: OrgRole[]; onChanged: () => void;
}) {
  const { has } = useAuth();
  const [perms, setPerms] = useState<string[]>(user.permissions ?? []);
  const save = useMutation({
    mutationFn: () => usersApi.setPermissions(user.id, perms),
    onSuccess: () => { toast.success("Permissions updated."); onChanged(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Tick roles to grant bundles, then add or remove individual permissions.
        What's ticked is exactly what this employee can do.
      </p>
      <PermissionEditor perms={perms}
        onPermsChange={setPerms} roles={roles} canGrant={has} />
      <div className="flex justify-end">
        <button className="btn-primary" onClick={() => save.mutate()}
          disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save permissions"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Documents tab -- */

function DocumentsTab({ user }: { user: UserRow }) {
  const docs = useQuery({
    queryKey: ["user-docs", user.id],
    queryFn: async () => (await usersApi.listDocuments(user.id)).data,
  });

  const open = async (docId: string) => {
    try {
      const r = await usersApi.downloadDocument(user.id, docId);
      window.open(r.data.url, "_blank", "noopener");
    } catch (e) { toast.error(apiError(e)); }
  };

  if (docs.isLoading)
    return <div className="py-8 text-center"><Spinner className="mx-auto h-6 w-6" /></div>;
  const items = docs.data ?? [];
  if (items.length === 0)
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        No KYC documents uploaded yet. The user uploads these during onboarding.
      </p>
    );

  return (
    <div className="space-y-2">
      {items.map((d) => (
        <div key={d.id}
          className="flex items-center justify-between gap-3 rounded-control border
            border-line p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-700">{d.label}</p>
            <p className="truncate text-xs text-slate-500">
              {d.filename} · {formatDate(d.created_at)}
            </p>
          </div>
          <button className="btn-secondary"
            onClick={() => open(d.id)}>
            <Icon.Download size={15} /> View / download
          </button>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- Account tab -- */

function AccountTab({ user, onChanged, onClose }: {
  user: UserRow; onChanged: () => void; onClose: () => void;
}) {
  const { has } = useAuth();
  // Removal is impossible once anything points at the person (owner
  // 2026-07-26). `in_use` is computed server-side; a missing value is treated
  // as "linked", the safe answer.
  const linked = user.in_use !== false;
  const isEmp = user.account_type !== "channel_partner";
  // Staff and channel partners are separate grants since the 2026-08-07 split,
  // so the right that draws these buttons is the one for THIS person's
  // population — matching routers/users._can_manage, which is what the server
  // checks. Getting it wrong here draws a button that 403s.
  const canEdit = has(isEmp ? "manage_employees" : "manage_partners");
  const [acctStatus, setAcctStatus] = useState(user.status);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");

  const status = useMutation({
    mutationFn: (v: { next: string; acknowledged?: boolean }) =>
      usersApi.setStatus(user.id, v.next, undefined, v.acknowledged),
    onSuccess: (_r, v) => {
      setAcctStatus(v.next as typeof acctStatus);
      toast.success("Status updated."); onChanged();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  /*
    Deactivating a channel partner the agency still OWES money.

    The server refuses that once with a 409 and the amount in the message,
    because switching a partner off also takes away their portal — so the money
    owed to them stops being visible to the one person it matters most to, with
    no screen left that mentions it. It is not forbidden (deactivating someone
    you are in dispute with is a normal thing to want); it just must not happen
    by accident. Confirming re-sends with the acknowledgement.
  */
  const changeStatus = async (next: string) => {
    try {
      await status.mutateAsync({ next });
    } catch (e) {
      const conflict = isAxiosError(e) && e.response?.status === 409;
      if (!conflict) return;         // onError already surfaced it
      if (await confirmDialog({
        title: "Deactivate anyway?",
        message: apiError(e),
        confirmLabel: "Deactivate anyway",
        danger: true,
      })) status.mutate({ next, acknowledged: true });
    }
  };
  const [portalOn, setPortalOn] = useState(user.portal_access ?? false);
  const portalAccess = useMutation({
    mutationFn: (value: boolean) =>
      usersApi.update(user.id, { portal_access: value }),
    onSuccess: (_r, value) => {
      setPortalOn(value);
      toast.success(value
        ? "Portal access granted. Send them an invitation to sign in."
        : "Portal access revoked — they are signed out immediately.");
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
      toast.success("Temporary password emailed (valid 7 days). The user will "
        + "set a new password on next login."),
    onError: (e) => toast.error(apiError(e)),
  });
  const requestOtp = useMutation({
    mutationFn: () => usersApi.requestDeleteOtp(user.id),
    onSuccess: (r) => { setOtpSent(true); toast.success(r.data.detail); },
    onError: (e) => toast.error(apiError(e)),
  });
  const del = useMutation({
    mutationFn: () => usersApi.remove(user.id, otp.trim()),
    onSuccess: () => { toast.success("Account deleted."); onChanged(); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const active = acctStatus === "active";

  return (
    <div className="space-y-5">
      {/* Account status. The button is the manage right's, like every other action
          on this tab — a relationship manager reads their partner's record
          without it (owner G1/G4) and must not be offered a control that will
          be refused. The state itself is still worth showing them. */}
      <div className="flex items-center justify-between rounded-control border
        border-line p-4">
        <div>
          <p className="text-sm font-medium text-slate-700">Account status</p>
          <p className="text-xs text-slate-500">
            {active ? "Active — the user can sign in."
              : "Deactivated — the user cannot sign in."}
          </p>
        </div>
        {canEdit ? (
          <button
            className={active ? "btn-secondary text-due" : "btn-primary"}
            disabled={status.isPending}
            onClick={() => changeStatus(active ? "inactive" : "active")}>
            {active ? "Deactivate" : "Activate"}
          </button>
        ) : (
          <StatusChip label="Status" value={active ? "Active" : "Deactivated"}
            tone={active ? "bg-money-in/10 text-money-in"
              : "bg-money-out/10 text-money-out"} />
        )}
      </div>

      {/* Portal access — channel partners only. Granted when the account is
          created (owner 2026-08-04) and revocable here: switching it off signs
          them out immediately and leaves the record intact for attribution and
          payouts. */}
      {!isEmp && canEdit && (
        <div className="flex items-center justify-between rounded-control border
          border-line p-4">
          <div className="pr-4">
            <p className="text-sm font-medium text-slate-700">Portal access</p>
            <p className="text-xs text-slate-500">
              {portalOn
                ? "This partner can sign in and see their own policies, "
                  + "renewals, earnings and notices."
                : "Revoked — this partner cannot sign in. The record still "
                  + "carries their policies and payouts. Switch on to let "
                  + "them back in, then send an invitation."}
            </p>
          </div>
          <Toggle checked={portalOn} label="Portal access"
            onChange={(v) => portalAccess.mutate(v)} />
        </div>
      )}

      {/* Invitation / password */}
      {canEdit && (
        <div className="flex items-center justify-between rounded-control border
          border-line p-4">
          <div className="pr-4">
            <p className="text-sm font-medium text-slate-700">
              {isEmp ? "Reset password" : "Send portal invitation"}</p>
            <p className="text-xs text-slate-500">
              {isEmp
                ? "Emails a temporary password valid for 7 days; the user is "
                  + "forced to set a new one."
                : "The invitation already went out when the account was "
                  + "created. Send it again if it never arrived — a partner's "
                  + "temporary password lasts until their first sign-in."}
            </p>
          </div>
          {isEmp ? (
            <button className="btn-secondary"
              disabled={reset.isPending} onClick={() => reset.mutate()}>
              <Icon.Refresh size={15} /> {reset.isPending ? "Sending…" : "Reset"}
            </button>
          ) : (
            <button className="btn-secondary"
              disabled={!portalOn || invite.isPending}
              title={portalOn ? undefined : "Switch on portal access first"}
              onClick={() => invite.mutate()}>
              <Icon.Mail size={15} />
              {invite.isPending ? "Sending…" : "Send invite"}
            </button>
          )}
        </div>
      )}

      {/* Delete (OTP-verified). Offered to anyone who can manage the account —
          the LINKS decide, not the account type (owner 2026-07-26). Once
          someone is named on a policy, a lead or a ledger row, Deactivate above
          is the only option: reports and the audit trail read those links. The
          server enforces it; this decides which of the two panels to show, so
          the reason is on screen rather than hidden behind a failed click.

          Not shown at all without the manage right: a relationship manager reading
          their own partner's record has no business being offered a delete. */}
      {!canEdit ? null : linked ? (
        <div className="rounded-control border border-line p-4">
          <p className="text-sm font-medium text-slate-700">Delete account</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Not available — this person is named on policies or transactions, and
            removing them would leave those records pointing at nobody. Use
            Deactivate above: they lose access, everything they worked on stays.
          </p>
        </div>
      ) : (
      <div className="note-out">
        <p className="text-sm font-medium text-money-out">Delete account</p>
        <p className="mt-0.5 text-xs text-slate-500">
          Nothing is linked to this account yet, so it can be removed. The record
          is kept for history and the email address is freed for reuse. Requires
          an emailed confirmation code.
        </p>
        {!otpSent ? (
          <button className="btn-secondary mt-3
            text-money-out"
            disabled={requestOtp.isPending} onClick={() => requestOtp.mutate()}>
            <Icon.Trash size={15} />
            {requestOtp.isPending ? "Sending code…" : "Delete — send code"}
          </button>
        ) : (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="Confirmation code">
              <input className="input w-40" value={otp} inputMode="numeric"
                placeholder="6-digit code"
                onChange={(e) => setOtp(e.target.value)} />
            </Field>
            <button className="btn-secondary"
              onClick={() => requestOtp.mutate()} disabled={requestOtp.isPending}>
              Resend
            </button>
            <button className="btn-primary bg-money-out hover:bg-money-out"
              disabled={del.isPending || otp.trim().length === 0}
              onClick={() => del.mutate()}>
              {del.isPending ? "Deleting…" : "Confirm delete"}
            </button>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/* --------------------------------------------------- reassigning a partner -- */

/**
 * What changing this partner's relationship manager is about to do.
 *
 * Shown INLINE the moment the dropdown changes and before Save is pressed,
 * because the consequence is invisible otherwise: one field moves every policy
 * this partner ever booked onto somebody else's Policies page and off the
 * current manager's. "12 policies move to Rahul" is a sentence somebody can
 * sanity-check; a toast saying "Saved" afterwards is not.
 *
 * It also says what does NOT change, which is the half people get wrong.
 * `Policy.manager_id` is frozen at booking, so the old manager keeps CREDIT for
 * what this partner brought in while they held them — targets, the league table
 * and every report are untouched. Two different questions about the same
 * policy, and they are meant to diverge.
 */
function ReassignNotice({ partnerId, managerId }: {
  partnerId: string; managerId: string;
}) {
  const preview = useQuery({
    queryKey: ["reassign-preview", partnerId, managerId],
    queryFn: async () => (await reassignApi.preview(partnerId, managerId)).data,
    // A dry run: it reads and writes nothing, and the person may still abandon
    // the form.
    retry: false,
  });

  if (preview.isLoading) {
    return (
      <p className="hint mt-2 flex items-center gap-2">
        <Spinner className="h-3 w-3" /> Working out what moves…
      </p>
    );
  }
  // A failed preview must never block the edit — it is an explanation, not a
  // gate. The server re-checks the manager on save either way.
  if (!preview.data) return null;

  const n = preview.data.policy_count;
  return (
    <p className="note-due mt-2">
      <b>
        {n === 0 ? "No policies" : `${n} polic${n === 1 ? "y" : "ies"}`}
      </b>{" "}
      {n === 1 ? "moves" : "move"} to{" "}
      <b>{preview.data.to_manager ?? "the new manager"}</b>
      {preview.data.from_manager
        ? <> and {n === 1 ? "comes" : "come"} off{" "}
          <b>{preview.data.from_manager}</b>'s list</>
        : null}
      {" "}when you save. Nobody loses credit for what they booked — targets and
      reports are worked out from who held the partner at the time, and those do
      not change.
    </p>
  );
}
