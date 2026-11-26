import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Loader2 } from "lucide-react";
import { customersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { FormField, FormSection } from "../../components/shared/FormSection";
import { FormSkeleton } from "../../components/shared/LoadingSkeleton";
import { ErrorState } from "../../components/shared/ErrorState";
import { toast } from "../../components/Toast";
import { refreshFinance } from "../../lib/live";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface CustForm {
  name: string;
  mobile: string;
  email: string;
  notes: string;
}

const EMPTY: CustForm = { name: "", mobile: "", email: "", notes: "" };

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

  const missing =
    isAxiosError(customer.error) && customer.error.response?.status === 404;

  const mobileError =
    form.mobile.length > 0 && form.mobile.length !== 10
      ? "Enter a full 10-digit mobile number, or leave it blank."
      : undefined;

  const valid =
    form.name.trim().length >= 2 &&
    (form.mobile.length === 0 || form.mobile.length === 10);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || save.isPending) return;
    save.mutate();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        backTo={editing ? `/customers/${id}` : "/customers"}
        backLabel={editing ? "Back to customer" : "Back to customers"}
        title={editing ? "Edit customer" : "Add customer"}
        subtitle={
          editing
            ? "Update contact details for this customer."
            : "Enter basic contact details. You can add policies and documents afterwards."
        }
      />

      {editing && customer.isLoading ? (
        <FormSkeleton sections={1} />
      ) : missing ? (
        <ErrorState
          title="Customer not found"
          message="This customer record may have been removed."
        />
      ) : customer.isError ? (
        <ErrorState onRetry={() => customer.refetch()} />
      ) : (
        <form onSubmit={onSubmit} className="space-y-6">
          <FormSection
            title="Contact Details"
            description="Only the customer's full name is required."
            columns={2}
          >
            <FormField label="Full name" htmlFor="cust-name" required>
              <Input
                id="cust-name"
                value={form.name}
                autoFocus
                required
                placeholder="e.g. Rajesh Kumar"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </FormField>

            <FormField
              label="Mobile number (optional)"
              htmlFor="cust-mobile"
              hint="10 digits without +91"
              tooltip="When a 10-digit number is entered, we check for existing customers to prevent duplicates."
              error={mobileError}
            >
              <div className="flex">
                <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm font-medium text-muted-foreground">
                  +91
                </span>
                <Input
                  id="cust-mobile"
                  className="rounded-l-none"
                  value={form.mobile}
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="10-digit number"
                  onChange={(e) =>
                    setForm({
                      ...form,
                      mobile: e.target.value.replace(/\D/g, ""),
                    })
                  }
                />
              </div>
            </FormField>

            <FormField
              label="Email address"
              htmlFor="cust-email"
              hint="Optional — used for sending policy notices."
            >
              <Input
                id="cust-email"
                type="email"
                value={form.email}
                placeholder="customer@example.com"
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </FormField>

            <FormField
              label="Notes"
              htmlFor="cust-notes"
              hint="Optional remarks or preferences."
              className="md:col-span-2"
            >
              <Textarea
                id="cust-notes"
                rows={3}
                value={form.notes}
                placeholder="e.g. Preferred insurer, family details, or reminder notes"
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </FormField>
          </FormSection>

          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                navigate(editing ? `/customers/${id}` : "/customers")
              }
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {editing ? "Save changes" : "Add customer"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
