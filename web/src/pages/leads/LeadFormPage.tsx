import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { leadsApi } from "../../api/endpoints";
import { api, apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field } from "../../components/ui";
import { toast } from "../../components/Toast";
import { LEAD_TYPES } from "../../lib/types";
import type { Lead, LeadType } from "../../lib/types";

// Address is deliberately NOT collected on a lead (owner 2026-08-03). It stays
// on the model as history, but a prospect is chased by phone — the address is
// asked for when they become a customer, and an empty box on every form is
// worse than no box.
interface LeadFormState {
  name: string;
  type: LeadType;
  mobile: string;
  email: string;
  interested_in: string;
  note: string;
}

const EMPTY: LeadFormState = {
  name: "", type: "customer", mobile: "", email: "",
  interested_in: "", note: "",
};

/** Add (/leads/new) and edit (/leads/:id/edit) — one form, two routes. */
export default function LeadFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;

  const [form, setForm] = useState<LeadFormState>(() => ({
    ...EMPTY,
    // Adding from a filtered list carries the type across: on the Channel
    // partner filter you are almost certainly adding a channel partner.
    type: (params.get("type") as LeadType) || "customer",
  }));
  const [loaded, setLoaded] = useState(!editing);

  const lead = useQuery({
    queryKey: ["lead", id],
    enabled: editing,
    retry: false,
    queryFn: async () => (await api.get<Lead>(`/api/leads/${id}`)).data,
  });

  useEffect(() => {
    if (loaded || !lead.data) return;
    const d = lead.data;
    setForm({
      name: d.name,
      type: d.type,
      mobile: d.mobile || "",
      email: d.email || "",
      interested_in: d.interested_in || d.category_key || "",
      note: d.note || "",
    });
    setLoaded(true);
  }, [loaded, lead.data]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        type: form.type,
        mobile: form.mobile,
        email: form.email.trim() || null,
        interested_in: form.interested_in.trim() || null,
        note: form.note.trim() || null,
      };
      return editing
        ? (await leadsApi.update(id!, body)).data
        : (await leadsApi.create(body)).data;
    },
    onSuccess: (saved) => {
      toast.success(editing ? "Lead updated." : "Lead added.");
      qc.invalidateQueries({ queryKey: ["leads"] });
      if (editing) qc.invalidateQueries({ queryKey: ["lead", id] });
      // Straight to the lead either way: after adding one you almost always
      // want to set a follow-up on it.
      navigate(`/leads/${saved.id}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const missing = isAxiosError(lead.error) && lead.error.response?.status === 404;
  const valid = form.name.trim().length >= 2 && form.mobile.length === 10;

  return (
    <FormPage
      backTo={editing ? `/leads/${id}` : "/leads"}
      backLabel={editing ? "Back to lead" : "Back to leads"}
      title={editing ? "Edit lead" : "Add lead"}
      onSubmit={() => save.mutate()}
      submitLabel={editing ? "Save changes" : "Add lead"}
      submitting={save.isPending}
      disabled={!valid}
      loading={editing && lead.isLoading}
      error={missing ? undefined : lead.error}
      onRetry={() => lead.refetch()}
      notFound={missing}
    >
      <div className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Full name" required>
            <input className="input" value={form.name} autoFocus required
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Lead type" required>
            <select className="select" value={form.type}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value as LeadType })}>
              {LEAD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Mobile" required>
            <div className="flex">
              <span className="inline-flex h-10 items-center rounded-l-control
                border border-r-0 border-line bg-slate-50 px-3 text-sm
                text-slate-500">
                +91
              </span>
              <input className="input rounded-l-none" value={form.mobile}
                inputMode="numeric" maxLength={10} required
                placeholder="10-digit number"
                onChange={(e) => setForm({
                  ...form, mobile: e.target.value.replace(/\D/g, "") })} />
            </div>
          </Field>
          <Field label="Email">
            <input type="email" className="input" value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>

        <Field label="Interested in">
          <input className="input" value={form.interested_in} maxLength={20}
            placeholder="e.g. Health insurance"
            onChange={(e) =>
              setForm({ ...form, interested_in: e.target.value })} />
        </Field>

        <Field label="Note">
          <textarea className="input" rows={3} value={form.note}
            placeholder="Optional note about this lead"
            onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
    </FormPage>
  );
}
