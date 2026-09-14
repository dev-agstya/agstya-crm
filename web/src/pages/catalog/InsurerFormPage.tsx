import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { insurersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field, Spinner } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { askDelete } from "../../lib/deleteGuard";
import type { Insurer } from "../../lib/types";

const EMPTY = {
  name: "", short_name: "", contact_person: "", email: "", phone: "",
};

/** Add (/insurers/new) and edit (/insurers/:id/edit). */
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
  const record: Insurer | undefined = list.data?.items
    .find((i) => i.id === id);

  useEffect(() => {
    if (loaded || !record) return;
    setForm({
      name: record.name,
      short_name: record.short_name || "",
      contact_person: record.contact_person || "",
      email: record.email || "",
      // Older records may hold a longer/formatted number — show the last 10
      // digits so the field matches what the form will now accept.
      phone: (record.phone || "").replace(/\D/g, "").slice(-10),
    });
    setLoaded(true);
  }, [loaded, record]);

  // Live short-name availability: a clash belongs under the field while you
  // type, not in a red toast after Save (owner 2026-07-26). The field is
  // OPTIONAL, so a blank box is always fine.
  const [nameState, setNameState] =
    useState<"idle" | "checking" | "ok" | "taken">("idle");
  const shortName = form.short_name.trim();
  // Case-insensitively unchanged: the server treats "HE" and "he" as the same
  // short name, so re-saving an insurer must never flag its own value.
  const shortUnchanged = !!record
    && (record.short_name || "").trim().toLowerCase() === shortName.toLowerCase();
  useEffect(() => {
    if (!shortName || shortUnchanged) { setNameState("idle"); return; }
    setNameState("checking");
    const t = setTimeout(async () => {
      try {
        const res = (await insurersApi.shortNameAvailable(shortName, id)).data;
        setNameState(res.available ? "ok" : "taken");
      } catch { setNameState("idle"); }
    }, 400);
    return () => clearTimeout(t);
  }, [shortName, shortUnchanged, id]);
  // Blank or untouched needs no check; otherwise wait for the green tick.
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

  // Deactivate blocks NEW policies under this insurer; existing ones stay.
  const toggleActive = useMutation({
    mutationFn: () => insurersApi.update(id!, { active: !record!.active }),
    onSuccess: () => {
      toast.success(record!.active
        ? "Insurer deactivated — no new policies can use it."
        : "Insurer activated.");
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
      onSubmit={submit}
      submitLabel="Save"
      submitting={save.isPending}
      disabled={!form.name.trim() || !shortOk}
      loading={editing && list.isLoading}
      notFound={editing && !list.isLoading && !record}
      secondaryAction={editing && record && (
        <div className="flex flex-wrap gap-2">
          <button type="button"
            className={`btn-secondary ${record.active
              ? "text-due" : "text-money-in"}`}
            disabled={toggleActive.isPending}
            onClick={async () => {
              if (await confirmDialog({
                message: record.active
                  ? `Deactivate ${record.name}? New policies can't use it; `
                    + "existing ones stay."
                  : `Activate ${record.name}?`,
                confirmLabel: record.active ? "Deactivate" : "Activate",
                danger: record.active,
              })) toggleActive.mutate();
            }}>
            {record.active ? "Deactivate" : "Activate"}
          </button>
          {/* Always offered. Whether it goes through is decided by the LINKS,
              not by who is asking: an insurer nothing points at can go, one a
              policy names has to be deactivated instead. */}
          <button type="button" className="btn-danger-soft"
            disabled={del.isPending}
            onClick={async () => {
              const choice = await askDelete({
                noun: "insurer", name: record.name,
                inUse: record.in_use !== false,
                fallbackLabel: "Deactivate",
                fallbackHint: "new policies can't use it, and every existing "
                  + "one keeps working exactly as it does now.",
              });
              if (choice === "delete") del.mutate();
              if (choice === "fallback" && record.active) toggleActive.mutate();
            }}>
            <Icon.Trash size={15} /> Delete
          </button>
        </div>
      )}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" required>
          <input className="input" value={form.name} autoFocus required
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Short name"
          hint="Optional, but must be unique — e.g. HDFC Ergo → HE.">
          <input className="input" value={form.short_name} maxLength={40}
            placeholder="e.g. HE"
            onChange={(e) => setForm({ ...form, short_name: e.target.value })} />
          {!shortUnchanged && nameState === "checking" && (
            <span className="mt-1.5 flex items-center gap-1 text-xs
              text-slate-500">
              <Spinner className="h-3 w-3" /> Checking…
            </span>
          )}
          {!shortUnchanged && nameState === "ok" && (
            <span className="mt-1.5 inline-flex items-center gap-1 text-xs
              font-medium text-money-in">
              <Icon.Check size={13} /> “{shortName}” is available
            </span>
          )}
          {!shortUnchanged && nameState === "taken" && (
            <span className="mt-1.5 inline-flex items-center gap-1 text-xs
              font-medium text-money-out">
              <Icon.Alert size={13} /> “{shortName}” is already used by another
              insurer
            </span>
          )}
        </Field>
        <Field label="Contact person">
          <input className="input" value={form.contact_person}
            onChange={(e) =>
              setForm({ ...form, contact_person: e.target.value })} />
        </Field>
        <Field label="Email">
          <input className="input" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Phone">
          {/* 10 digits only, like every other number in the app — anything
              longer is a typo, not a landline (owner 2026-07-26). */}
          <div className="flex">
            <span className="inline-flex h-10 items-center rounded-l-control
              border border-r-0 border-line bg-slate-50 px-3 text-sm
              text-slate-500">+91</span>
            <input className="input rounded-l-none" value={form.phone}
              inputMode="numeric" maxLength={10} placeholder="10-digit number"
              onChange={(e) => setForm({
                ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10),
              })} />
          </div>
        </Field>
      </div>
    </FormPage>
  );
}
