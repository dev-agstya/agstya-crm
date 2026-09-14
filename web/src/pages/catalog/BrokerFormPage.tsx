import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { brokersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { FormPage } from "../../components/RecordPage";
import { Field, Spinner } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { refreshFinance } from "../../lib/live";
import { askDelete } from "../../lib/deleteGuard";
import type { Broker } from "../../lib/types";

const CODE_RE = /^[A-Z0-9][A-Z0-9\-_]{1,19}$/;

type FormState = {
  name: string; short_code: string; tds_pct: string;
  account_login: string; reg_mobile: string; notes: string;
};
const EMPTY: FormState = {
  name: "", short_code: "", tds_pct: "",
  account_login: "", reg_mobile: "", notes: "",
};

/** Add (/brokers/new) and edit (/brokers/:id/edit). */
export default function BrokerFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editing = !!id;

  const [f, setF] = useState<FormState>(EMPTY);
  const set = (k: keyof FormState, v: string) => setF((s) => ({ ...s, [k]: v }));
  const [loaded, setLoaded] = useState(!editing);

  const list = useQuery({
    queryKey: ["brokers", ""],
    enabled: editing,
    queryFn: async () => (await brokersApi.list({})).data,
  });
  const record: Broker | undefined = list.data?.find((b) => b.id === id);

  useEffect(() => {
    if (loaded || !record) return;
    setF({
      name: record.name, short_code: record.short_code,
      tds_pct: record.tds_percent ? String(record.tds_percent / 100) : "",
      account_login: record.account_login ?? "",
      reg_mobile: (record.reg_mobile ?? "").replace(/\D/g, "").slice(-10),
      notes: record.notes ?? "",
    });
    setLoaded(true);
  }, [loaded, record]);

  // Broker rate/TDS edits feed the finance calculations, so refresh those too.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["brokers"] });
    refreshFinance(qc);
  };

  // Live short-code availability check (skip when editing & unchanged).
  const [codeState, setCodeState] =
    useState<"idle" | "checking" | "ok" | "taken">("idle");
  const codeFormatOk = CODE_RE.test(f.short_code);
  const codeUnchanged = !!record && record.short_code === f.short_code;
  useEffect(() => {
    if (codeUnchanged) { setCodeState("ok"); return; }
    if (!codeFormatOk) { setCodeState("idle"); return; }
    setCodeState("checking");
    const t = setTimeout(async () => {
      try {
        const res = (await brokersApi.shortCodeAvailable(
          f.short_code, id)).data;
        setCodeState(res.available ? "ok" : "taken");
      } catch { setCodeState("idle"); }
    }, 400);
    return () => clearTimeout(t);
  }, [f.short_code, codeFormatOk, codeUnchanged, id]);
  const codeOk = codeUnchanged || (codeFormatOk && codeState === "ok");

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: f.name.trim(),
        short_code: f.short_code,
        tds_percent: f.tds_pct ? Math.round(parseFloat(f.tds_pct) * 100) : 0,
        account_login: f.account_login || null,
        reg_mobile: f.reg_mobile || null,
        notes: f.notes || null,
      };
      return editing ? brokersApi.update(id!, body) : brokersApi.create(body);
    },
    onSuccess: () => {
      toast.success(editing ? "Broker updated." : "Broker added.");
      invalidate();
      navigate("/brokers");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const del = useMutation({
    mutationFn: () => brokersApi.remove(id!),
    onSuccess: () => {
      toast.success("Broker deleted.");
      invalidate();
      navigate("/brokers");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const toggleActive = useMutation({
    mutationFn: () => brokersApi.update(id!, { active: !record!.active }),
    onSuccess: () => {
      toast.success(record!.active
        ? "Broker deactivated — no new policies can be placed through it."
        : "Broker activated.");
      invalidate();
      navigate("/brokers");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Guard the SUBMIT as well as the button: Enter in a text field submits a
  // form whether or not the button is disabled.
  const submit = () => {
    if (!f.name.trim() || !codeOk) return;
    save.mutate();
  };

  return (
    <FormPage
      backTo="/brokers"
      backLabel="Back to brokers"
      title={editing ? "Edit broker" : "Add broker"}
      subtitle="Each broker carries its own rate card and TDS %."
      onSubmit={submit}
      submitLabel="Save"
      submitting={save.isPending}
      disabled={!f.name.trim() || !codeOk}
      loading={editing && list.isLoading}
      notFound={editing && !list.isLoading && !record}
      secondaryAction={editing && record && (
        <div className="flex flex-wrap gap-2">
          {/* Deactivating is the normal way to retire a broker: existing
              policies, ledger rows and TDS entries all keep working, it just
              can't be picked for new business. */}
          <button type="button"
            className={`btn-secondary ${record.active
              ? "text-due" : "text-money-in"}`}
            disabled={toggleActive.isPending}
            onClick={async () => {
              if (await confirmDialog({
                message: record.active
                  ? `Deactivate ${record.name}? New policies can't be placed `
                    + "through it; existing ones stay."
                  : `Activate ${record.name}?`,
                confirmLabel: record.active ? "Deactivate" : "Activate",
                danger: record.active,
              })) toggleActive.mutate();
            }}>
            {record.active ? "Deactivate" : "Activate"}
          </button>
          <button type="button" className="btn-danger-soft"
            disabled={del.isPending}
            onClick={async () => {
              const choice = await askDelete({
                noun: "broker", name: record.name,
                inUse: record.in_use, fallbackLabel: "Deactivate",
                fallbackHint: "no new policies can be placed through it, and "
                  + "every existing one keeps working exactly as it does now.",
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
              <input className="input" value={f.name} required
                placeholder="e.g. PolicyBazaar"
                onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Short code" required
              hint="Unique. 2–20 chars: A–Z, 0–9, - or _. Shown on policies.">
              <input className="input tracking-wider" value={f.short_code} required
                maxLength={20} placeholder="e.g. PB"
                onChange={(e) => set("short_code",
                  e.target.value.toUpperCase().replace(/[^A-Z0-9\-_]/g, ""))} />
              {f.short_code.length > 0 && !codeFormatOk && (
                <span className="text-xs font-medium text-due">
                  2–20 chars: capital letters, digits, - or _
                </span>
              )}
              {!codeUnchanged && codeFormatOk && codeState === "checking" && (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Spinner className="h-3 w-3" /> Checking…
                </span>
              )}
              {!codeUnchanged && codeState === "ok" && (
                <span className="inline-flex items-center gap-1 text-xs
                  font-medium text-money-in">
                  <Icon.Check size={13} /> “{f.short_code}” is available
                </span>
              )}
              {!codeUnchanged && codeState === "taken" && (
                <span className="inline-flex items-center gap-1 text-xs
                  font-medium text-money-out">
                  <Icon.Alert size={13} /> “{f.short_code}” is already in use
                </span>
              )}
            </Field>
            <Field label="TDS %" required
              hint="Deducted from our reward when this broker pays us (e.g. 2).">
              <input type="number" step="0.01" min="0" className="input"
                value={f.tds_pct} placeholder="e.g. 2"
                onChange={(e) => set("tds_pct", e.target.value)} />
            </Field>
            <Field label="Account / login id">
              <input className="input" value={f.account_login}
                placeholder="Your account on this broker's portal"
                onChange={(e) => set("account_login", e.target.value)} />
            </Field>
            <Field label="Registered mobile">
              <div className="flex">
                <span className="inline-flex items-center h-10 rounded-l-control border
                  border-r-0 border-line bg-slate-50 px-3 text-sm
                  text-slate-500">+91</span>
                <input className="input rounded-l-none" value={f.reg_mobile}
                  inputMode="numeric" maxLength={10}
                  placeholder="10-digit number"
                  onChange={(e) => set("reg_mobile",
                    e.target.value.replace(/\D/g, "").slice(0, 10))} />
              </div>
            </Field>
      </div>

      <Field label="Notes">
        <textarea className="input" rows={3} value={f.notes}
          onChange={(e) => set("notes", e.target.value)} />
      </Field>
    </FormPage>
  );
}
