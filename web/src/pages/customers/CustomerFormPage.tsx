import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { customersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field } from "../../components/ui";
import { toast } from "../../components/Toast";
import { refreshFinance } from "../../lib/live";

interface CustForm {
  name: string;
  mobile: string;
  email: string;
  notes: string;
}

const EMPTY: CustForm = { name: "", mobile: "", email: "", notes: "" };

/**
 * Add (/customers/new) and edit (/customers/:id/edit).
 *
 * Documents are added from the customer's own page, not here (owner
 * 2026-07-24) — this stays a quick contact capture.
 */
export default function CustomerFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;

  const [form, setForm] = useState<CustForm>({ ...EMPTY });
  const [loaded, setLoaded] = useState(!editing);

  const customer = useQuery({
    queryKey: ["customer", id],
    enabled: editing,
    retry: false,
    queryFn: async () => (await customersApi.get(id!)).data,
  });

  useEffect(() => {
    if (loaded || !customer.data) return;
    const c = customer.data;
    setForm({
      name: c.name,
      mobile: c.mobile || "",
      email: c.email || "",
      notes: c.notes || "",
    });
    setLoaded(true);
  }, [loaded, customer.data]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        mobile: form.mobile || null,
        email: form.email.trim() || null,
        notes: form.notes.trim() || null,
      };
      return editing
        ? (await customersApi.update(id!, body)).data
        : (await customersApi.create(body)).data;
    },
    onSuccess: (saved) => {
      toast.success(editing ? "Customer updated." : "Customer added.");
      qc.invalidateQueries({ queryKey: ["customers"] });
      if (editing) qc.invalidateQueries({ queryKey: ["customer", id] });
      refreshFinance(qc);
      navigate(`/customers/${saved.id}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const missing = isAxiosError(customer.error)
    && customer.error.response?.status === 404;
  const valid = form.name.trim().length >= 2 && form.mobile.length === 10;

  return (
    <FormPage
      backTo={editing ? `/customers/${id}` : "/customers"}
      backLabel={editing ? "Back to customer" : "Back to customers"}
      title={editing ? "Edit customer" : "Add customer"}
      subtitle={editing ? undefined
        : "Documents and policies are added later."
          }
      onSubmit={() => save.mutate()}
      submitLabel={editing ? "Save changes" : "Add customer"}
      submitting={save.isPending}
      disabled={!valid}
      loading={editing && customer.isLoading}
      error={missing ? undefined : customer.error}
      onRetry={() => customer.refetch()}
      notFound={missing}
    >
      <div className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Full name" required>
            <input className="input" value={form.name} autoFocus required
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Mobile" required
            hint="Customers are unique by mobile number.">
            <div className="flex">
              <span className="inline-flex h-10 items-center rounded-l-control
                border border-r-0 border-line bg-slate-50 px-3 text-sm
                text-slate-500">+91</span>
              <input className="input rounded-l-none" value={form.mobile}
                inputMode="numeric" maxLength={10} required
                placeholder="10-digit number"
                onChange={(e) => setForm({
                  ...form, mobile: e.target.value.replace(/\D/g, "") })} />
            </div>
          </Field>
        </div>
        <Field label="Email">
          <input type="email" className="input" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Notes">
          <textarea className="input" rows={3} value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </div>
    </FormPage>
  );
}
