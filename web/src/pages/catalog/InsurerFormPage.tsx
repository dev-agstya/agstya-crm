import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Loader2, Trash2 } from "lucide-react";
import { insurersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { FormField } from "../../components/shared/FormSection";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { askDelete } from "../../lib/deleteGuard";
import type { Insurer } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const EMPTY = {
  name: "",
  short_name: "",
  contact_person: "",
  email: "",
  phone: "",
};

export default function InsurerFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;

  const [form, setForm] = useState({ ...EMPTY });
  const [loaded, setLoaded] = useState(!editing);

  const list = useQuery({
    queryKey: ["insurers", "all-for-edit"],
    enabled: editing,
    queryFn: async () =>
      (await insurersApi.list({ page_size: 500, active_only: 0 })).data,
  });
  const record: Insurer | undefined = list.data?.items.find((i) => i.id === id);

  useEffect(() => {
    if (loaded || !record) return;
    setForm({
      name: record.name,
      short_name: record.short_name || "",
      contact_person: record.contact_person || "",
      email: record.email || "",
      phone: (record.phone || "").replace(/\D/g, "").slice(-10),
    });
    setLoaded(true);
  }, [loaded, record]);

  const [nameState, setNameState] = useState<
    "idle" | "checking" | "ok" | "taken"
  >("idle");
  const shortName = form.short_name.trim();
  const shortUnchanged =
    !!record &&
    (record.short_name || "").trim().toLowerCase() === shortName.toLowerCase();
  useEffect(() => {
    if (!shortName || shortUnchanged) {
      setNameState("idle");
      return;
    }
    setNameState("checking");
    const t = setTimeout(async () => {
      try {
        const res = (await insurersApi.shortNameAvailable(shortName, id)).data;
        setNameState(res.available ? "ok" : "taken");
      } catch {
        setNameState("idle");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [shortName, shortUnchanged, id]);
  const shortOk = !shortName || shortUnchanged || nameState === "ok";

  const submit = () => {
    if (!form.name.trim() || !shortOk) return;
    save.mutate();
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        short_name: shortName || null,
        contact_person: form.contact_person || null,
        email: form.email || null,
        phone: form.phone || null,
      };
      return editing ? insurersApi.update(id!, body) : insurersApi.create(body);
    },
    onSuccess: () => {
      toast.success(editing ? "Insurer updated." : "Insurer added.");
      qc.invalidateQueries({ queryKey: ["insurers"] });
      navigate("/insurers");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const del = useMutation({
    mutationFn: () => insurersApi.remove(id!),
    onSuccess: () => {
      toast.success("Insurer deleted.");
      qc.invalidateQueries({ queryKey: ["insurers"] });
      navigate("/insurers");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const toggleActive = useMutation({
    mutationFn: () => insurersApi.update(id!, { active: !record!.active }),
    onSuccess: () => {
      toast.success(
        record!.active
          ? "Insurer deactivated — no new policies can use it."
          : "Insurer activated."
      );
      qc.invalidateQueries({ queryKey: ["insurers"] });
      navigate("/insurers");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <FormPage
      backTo="/insurers"
      backLabel="Back to insurers"
      title={editing ? "Edit insurer" : "Add insurer"}
      wide
      onSubmit={submit}
      submitLabel="Save"
      submitting={save.isPending}
      disabled={!form.name.trim() || !shortOk}
      loading={editing && list.isLoading}
      notFound={editing && !list.isLoading && !record}
      secondaryAction={
        editing &&
        record && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={record.active ? "text-amber-700" : "text-emerald-700"}
              disabled={toggleActive.isPending}
              onClick={async () => {
                if (
                  await confirmDialog({
                    message: record.active
                      ? `Deactivate ${record.name}? New policies can't use it; existing ones stay.`
                      : `Activate ${record.name}?`,
                    confirmLabel: record.active ? "Deactivate" : "Activate",
                    danger: record.active,
                  })
                )
                  toggleActive.mutate();
              }}
            >
              {record.active ? "Deactivate" : "Activate"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-destructive/30 text-destructive hover:bg-destructive/10"
              disabled={del.isPending}
              onClick={async () => {
                const choice = await askDelete({
                  noun: "insurer",
                  name: record.name,
                  inUse: record.in_use !== false,
                  fallbackLabel: "Deactivate",
                  fallbackHint:
                    "new policies can't use it, and every existing one keeps working exactly as it does now.",
                });
                if (choice === "delete") del.mutate();
                if (choice === "fallback" && record.active)
                  toggleActive.mutate();
              }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        )
      }
    >
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        <FormField label="Name" required>
          <Input
            value={form.name}
            autoFocus
            required
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </FormField>
        <FormField
          label="Short name"
          hint="Optional, but must be unique — e.g. HDFC Ergo → HE."
        >
          <Input
            value={form.short_name}
            maxLength={40}
            placeholder="e.g. HE"
            onChange={(e) => setForm({ ...form, short_name: e.target.value })}
          />
          {!shortUnchanged && nameState === "checking" && (
            <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Checking…
            </span>
          )}
          {!shortUnchanged && nameState === "ok" && (
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <Check className="h-3.5 w-3.5" /> &ldquo;{shortName}&rdquo; is
              available
            </span>
          )}
          {!shortUnchanged && nameState === "taken" && (
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> &ldquo;{shortName}&rdquo;
              is already used by another insurer
            </span>
          )}
        </FormField>
        <FormField label="Contact person">
          <Input
            value={form.contact_person}
            onChange={(e) =>
              setForm({ ...form, contact_person: e.target.value })
            }
          />
        </FormField>
        <FormField label="Email">
          <Input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </FormField>
        <FormField label="Phone">
          <div className="flex">
            <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 text-xs text-muted-foreground">
              +91
            </span>
            <Input
              className="rounded-l-none"
              value={form.phone}
              inputMode="numeric"
              maxLength={10}
              placeholder="10-digit number"
              onChange={(e) =>
                setForm({
                  ...form,
                  phone: e.target.value.replace(/\D/g, "").slice(0, 10),
                })
              }
            />
          </div>
        </FormField>
      </div>
    </FormPage>
  );
}
