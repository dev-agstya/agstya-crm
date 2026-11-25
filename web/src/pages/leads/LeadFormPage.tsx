import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Loader2 } from "lucide-react";
import { leadsApi } from "../../api/endpoints";
import { api, apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { FormField, FormSection } from "../../components/shared/FormSection";
import { FormSkeleton } from "../../components/shared/LoadingSkeleton";
import { ErrorState } from "../../components/shared/ErrorState";
import { toast } from "../../components/Toast";
import { LEAD_TYPES } from "../../lib/types";
import type { Lead, LeadType } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface LeadFormState {
  name: string;
  type: LeadType;
  mobile: string;
  email: string;
  interested_in: string;
  note: string;
}

const EMPTY: LeadFormState = {
  name: "",
  type: "customer",
  mobile: "",
  email: "",
  interested_in: "",
  note: "",
};

export default function LeadFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;

  const [form, setForm] = useState<LeadFormState>(() => ({
    ...EMPTY,
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
      navigate(`/leads/${saved.id}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const missing =
    isAxiosError(lead.error) && lead.error.response?.status === 404;
  const mobileError =
    form.mobile.length > 0 && form.mobile.length !== 10
      ? "Enter a full 10-digit mobile number."
      : undefined;
  const valid = form.name.trim().length >= 2 && form.mobile.length === 10;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || save.isPending) return;
    save.mutate();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        backTo={editing ? `/leads/${id}` : "/leads"}
        backLabel={editing ? "Back to lead" : "Back to leads"}
        title={editing ? "Edit lead" : "Add lead"}
        subtitle={
          editing
            ? "Update prospect contact details."
            : "Capture a new prospect to follow up with and convert."
        }
      />

      {editing && lead.isLoading ? (
        <FormSkeleton sections={1} />
      ) : missing ? (
        <ErrorState
          title="Lead not found"
          message="This lead record does not exist."
        />
      ) : lead.isError ? (
        <ErrorState onRetry={() => lead.refetch()} />
      ) : (
        <form onSubmit={onSubmit} className="space-y-6">
          <FormSection
            title="Prospect Information"
            description="Name, lead type, and 10-digit mobile number are required."
            columns={2}
          >
            <FormField label="Full name" htmlFor="lead-name" required>
              <Input
                id="lead-name"
                value={form.name}
                autoFocus
                required
                placeholder="e.g. Amit Sharma"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </FormField>

            <FormField label="Lead category" htmlFor="lead-type" required>
              <Select
                value={form.type}
                onValueChange={(v) => setForm({ ...form, type: v as LeadType })}
              >
                <SelectTrigger id="lead-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEAD_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label="Mobile number"
              htmlFor="lead-mobile"
              required
              hint="10 digits without +91"
              error={mobileError}
            >
              <div className="flex">
                <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm font-medium text-muted-foreground">
                  +91
                </span>
                <Input
                  id="lead-mobile"
                  className="rounded-l-none"
                  value={form.mobile}
                  inputMode="numeric"
                  maxLength={10}
                  required
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
              htmlFor="lead-email"
              hint="Optional"
            >
              <Input
                id="lead-email"
                type="email"
                value={form.email}
                placeholder="name@example.com"
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </FormField>

            <FormField
              label="Interested in"
              htmlFor="lead-interest"
              hint="e.g. Motor Insurance, Health, Term Life"
            >
              <Input
                id="lead-interest"
                value={form.interested_in}
                placeholder="Policy type or product"
                onChange={(e) =>
                  setForm({ ...form, interested_in: e.target.value })
                }
              />
            </FormField>

            <FormField
              label="Initial note"
              htmlFor="lead-note"
              className="md:col-span-2"
            >
              <Textarea
                id="lead-note"
                rows={3}
                value={form.note}
                placeholder="Context from first call or inquiry"
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </FormField>
          </FormSection>

          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(editing ? `/leads/${id}` : "/leads")}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {editing ? "Save changes" : "Add lead"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
