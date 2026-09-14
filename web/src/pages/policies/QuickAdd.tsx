import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { customersApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Field, Modal } from "../../components/ui";
import { toast } from "../../components/Toast";

/*
  The two quick-add popups on the Add Policy form.

  THESE STAY DIALOGS, deliberately, while everything around them became a page
  (owner 2026-08-03). Their whole reason to exist is that you are half-way
  through booking a policy and the customer is not in the system yet — a page
  would navigate away from the form state they are there to protect, which is
  the opposite of the point.
*/

export function AddCustomerModal({ partnerId, initial, onClose, onCreated }: {
  partnerId?: string;
  /**
   * Pre-fill, used when the customer is already NAMED somewhere the app
   * cannot link to a record — today, on the quote request being booked. The
   * fields stay editable; this only saves re-typing a name and a number that
   * are already on the screen behind the dialog.
   */
  initial?: { name?: string; mobile?: string; email?: string };
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  const [f, setF] = useState({
    name: initial?.name ?? "",
    mobile: initial?.mobile ?? "",
    email: initial?.email ?? "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const valid = f.name.trim().length >= 2 && f.mobile.trim().length === 10;

  const create = useMutation({
    mutationFn: () => customersApi.create({
      name: f.name.trim(),
      mobile: f.mobile.trim(),
      email: f.email.trim() || null,
      partner_id: partnerId || null,
    }),
    onSuccess: (res) => {
      toast.success("Customer added.");
      onCreated(res.data.id, res.data.name);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Modal open onClose={onClose} title="Add New Customer">
      <form className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
        <Field label="Full name" required>
          <input className="input" value={f.name} required autoFocus
            onChange={(e) => set("name", e.target.value)} />
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
        <Field label="Email">
          <input type="email" className="input" value={f.email}
            onChange={(e) => set("email", e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel</button>
          <button type="submit" className="btn-primary"
            disabled={!valid || create.isPending}>
            {create.isPending ? "Saving…" : "Save & continue"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Quickly add a channel partner without leaving the policy form (owner 1.13).
// Minimal fields; the full profile can be completed later from the Channel
// Partners page.
//
// This creates a REAL partner account, which means it also emails them their
// sign-in details — the same as the full Add page. Worth saying in the toast:
// an email leaving the building because someone was midway through a policy
// form is not something to discover later.
export function AddPartnerQuickModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [f, setF] = useState({
    full_name: "", mobile: "", email: "", relationship_manager_id: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const managers = useQuery({
    queryKey: ["assignable-managers"],
    queryFn: async () => (await usersApi.assignableManagers()).data,
  });
  // Default the relationship manager to the first assignable one.
  useEffect(() => {
    if (!f.relationship_manager_id && (managers.data?.length ?? 0) > 0)
      set("relationship_manager_id", managers.data![0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managers.data]);

  const valid = f.full_name.trim().length >= 2
    && f.mobile.trim().length === 10
    && /^\S+@\S+\.\S+$/.test(f.email)
    && !!f.relationship_manager_id;

  const create = useMutation({
    mutationFn: () => usersApi.createPartner({
      full_name: f.full_name.trim(),
      email: f.email.trim(),
      mobile: f.mobile.trim(),
      relationship_manager_id: f.relationship_manager_id,
    }),
    onSuccess: (res) => {
      toast.success("Channel Partner added. Sign-in details emailed to them.");
      onCreated(res.data.id);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Modal open onClose={onClose} title="Add Channel Partner">
      <form className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
        <Field label="Full name" required>
          <input className="input" value={f.full_name} required autoFocus
            onChange={(e) => set("full_name", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Mobile" required>
            <div className="flex">
              <span className="inline-flex items-center rounded-l-lg border
                border-r-0 border-slate-300 bg-slate-50 px-3 text-sm
                text-slate-500">+91</span>
              <input className="input rounded-l-none" value={f.mobile} required
                inputMode="numeric" maxLength={10} placeholder="10-digit number"
                onChange={(e) =>
                  set("mobile", e.target.value.replace(/\D/g, ""))} />
            </div>
          </Field>
          <Field label="Email" required>
            <input type="email" className="input" value={f.email} required
              onChange={(e) => set("email", e.target.value)} />
          </Field>
        </div>
        <Field label="Relationship manager" required>
          <select className="select" value={f.relationship_manager_id} required
            onChange={(e) => set("relationship_manager_id", e.target.value)}>
            <option value="">— Select —</option>
            {managers.data?.map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel</button>
          <button type="submit" className="btn-primary"
            disabled={!valid || create.isPending}>
            {create.isPending ? "Saving…" : "Save & select"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Approving requires choosing the Broker the policy is placed through — that
// drives the reward rate (and the channel-partner share). Shows the rate the
// engine would apply for the policy's type + insurer under the chosen broker.
