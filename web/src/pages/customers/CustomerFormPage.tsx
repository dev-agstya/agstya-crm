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
  const valid = form.name.trim().length >= 2 && (form.mobile.length === 0 || form.mobile.length === 10);

  return (
    <FormPage
      backTo={editing ? `/customers/${id}` : "/customers"}
      backLabel={editing ? "Back to customer" : "Back to customers"}
      title={editing ? "Edit customer" : "Add customer"}
      subtitle={editing ? undefined
        : "Basic details. Policies and KYC documents can be attached anytime."}
      wide={true}
      maxWidth="max-w-6xl"
      onSubmit={() => save.mutate()}
      submitLabel={editing ? "Save changes" : "Add customer"}
      submitting={save.isPending}
      disabled={!valid}
      loading={editing && customer.isLoading}
      error={missing ? undefined : customer.error}
      onRetry={() => customer.refetch()}
      notFound={missing}
    >
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Main Form Fields */}
        <div className="space-y-6 lg:col-span-8">
          <div className="rounded-control border border-line bg-white p-5 shadow-xs space-y-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Primary Contact Details
            </h3>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Customer full name" required>
                <input className="input" value={form.name} autoFocus required
                  placeholder="e.g. Rajesh Kumar"
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field
                label="Mobile number (optional)"
                tooltip="Customers with a phone number are checked to prevent duplicate accounts."
                hint="Optional. 10 digits without +91"
              >
                <div className="flex">
                  <span className="inline-flex h-10 items-center rounded-l-control
                    border border-r-0 border-line bg-slate-50 px-3 text-sm
                    text-slate-500 font-medium">+91</span>
                  <input className="input rounded-l-none" value={form.mobile}
                    inputMode="numeric" maxLength={10}
                    placeholder="10-digit number"
                    onChange={(e) => setForm({
                      ...form, mobile: e.target.value.replace(/\D/g, "") })} />
                </div>
              </Field>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Email address" hint="Optional. Used for policy notices.">
                <input type="email" className="input" value={form.email}
                  placeholder="customer@example.com"
                  onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label="Notes or remarks" hint="Any specific client requirements or tags.">
                <input className="input" value={form.notes}
                  placeholder="e.g. VIP client, preferred insurer"
                  onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
            </div>
          </div>
        </div>

        {/* Informational Guidance Sidebar */}
        <div className="space-y-4 lg:col-span-4">
          <div className="rounded-control border border-line-soft bg-white p-4 shadow-xs text-xs space-y-3">
            <h4 className="font-semibold text-slate-800 text-sm">
              Quick Customer Guide
            </h4>
            <div className="space-y-2 text-slate-600">
              <div className="p-2.5 rounded bg-slate-50 border border-line-soft">
                <p className="font-medium text-slate-800">Phone Number is Optional</p>
                <p className="text-slate-500 mt-0.5">
                  You only need the customer's full name to create their profile and book insurance policies.
                </p>
              </div>

              <div className="p-2.5 rounded bg-slate-50 border border-line-soft">
                <p className="font-medium text-slate-800">Duplicate Check</p>
                <p className="text-slate-500 mt-0.5">
                  If a 10-digit mobile number is entered, the system ensures no duplicate account exists with the same number.
                </p>
              </div>

              <div className="p-2.5 rounded bg-slate-50 border border-line-soft">
                <p className="font-medium text-slate-800">After Creating Customer</p>
                <p className="text-slate-500 mt-0.5">
                  You can immediately book policies, link channel partners, and upload KYC documents (Aadhaar, PAN, RC book) from the customer details page.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </FormPage>
  );
}
