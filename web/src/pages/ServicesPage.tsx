import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { servicesApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import { PageLoader, Toggle } from "../components/ui";
import { toast } from "../components/Toast";
import type { ServiceSettings, WhatsAppSettings } from "../lib/types";

function Row({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-700">
          {label}</p>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export default function ServicesPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["services"],
    queryFn: async () => (await servicesApi.get()).data as ServiceSettings,
  });
  const [wa, setWa] = useState<WhatsAppSettings | null>(null);
  const [emailEnabled, setEmailEnabled] = useState(true);

  useEffect(() => {
    if (q.data) { setWa(q.data.whatsapp); setEmailEnabled(q.data.email.enabled); }
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => servicesApi.update({
      whatsapp: wa, email: { enabled: emailEnabled },
    }),
    onSuccess: () => {
      toast.success("Settings saved.");
      qc.invalidateQueries({ queryKey: ["services"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (q.isLoading || !wa || !q.data) return <PageLoader />;
  const set = (patch: Partial<WhatsAppSettings>) => setWa({ ...wa, ...patch });
  const credsReady = q.data.whatsapp_credentials_ready;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Third Party Services"
        subtitle="Enable, disable and configure the integrations this portal uses." />

      {/* Service status strip */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        {q.data.services.map((s) => (
          <div key={s.key} className="card flex items-start gap-3 p-4">
            <span className={`mt-0.5 rounded-control p-2 ${
              s.configured ? "bg-money-in/15 text-money-in"
                : "bg-slate-100 text-slate-500"}`}>
              <Icon.Bolt size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-800">
                {s.label}</p>
              <p className="text-xs text-slate-500">{s.detail}</p>
              <span className={`mt-1 inline-block rounded-full px-2 py-0.5
                text-[10px] font-medium ${
                  s.configured ? "bg-money-in/15 text-money-in"
                    : "bg-due/15 text-due"}`}>
                {s.configured ? "Configured" : "Not configured"}</span>
            </div>
          </div>
        ))}
      </div>

      {/* WhatsApp */}
      <div className="card mb-5">
        <div className="flex items-center justify-between border-b border-line/70
          px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="text-money-in"><Icon.WhatsApp size={20} /></span>
            <h3 className="font-semibold text-slate-800">
              WhatsApp Messaging</h3>
          </div>
          <Toggle checked={wa.enabled}
            onChange={(v) => set({ enabled: v })} />
        </div>
        <div className="px-5 py-3">
          {!credsReady && (
            <p className="mb-3 rounded-control bg-due/10 px-3 py-2 text-xs
              text-due">
              WhatsApp API credentials are not set in the server environment.
              Messages will not be delivered until they are configured.
            </p>
          )}
          <div className={wa.enabled ? "" : "pointer-events-none opacity-50"}>
            <p className="pt-1 text-xs font-semibold uppercase tracking-wide
              text-slate-500">On policy creation</p>
            <Row label="Auto-send policy PDF to the customer">
              <Toggle checked={wa.send_policy_on_create_customer}
                onChange={(v) => set({ send_policy_on_create_customer: v })} />
            </Row>
            <Row label="Auto-send policy PDF to the channel partner"
              hint="Only when the policy is attributed to a partner">
              <Toggle checked={wa.send_policy_on_create_partner}
                onChange={(v) => set({ send_policy_on_create_partner: v })} />
            </Row>

            <p className="pt-3 text-xs font-semibold uppercase tracking-wide
              text-slate-500">Renewal reminders</p>
            <Row label="Send renewal reminders to customers"
              hint="Respects each customer's own opt-in">
              <Toggle checked={wa.renewal_reminders_customers}
                onChange={(v) => set({ renewal_reminders_customers: v })} />
            </Row>
            <Row label="Send renewal reminders to channel partners">
              <Toggle checked={wa.renewal_reminders_partners}
                onChange={(v) => set({ renewal_reminders_partners: v })} />
            </Row>

            <p className="pt-3 text-xs font-semibold uppercase tracking-wide
              text-slate-500">Restrictions</p>
            <Row label="Which customers may be messaged">
              <select className="select max-w-[200px]"
                value={wa.customer_send_scope}
                onChange={(e) => set({
                  customer_send_scope: e.target.value as
                    WhatsAppSettings["customer_send_scope"] })}>
                <option value="all">All customers</option>
                <option value="inhouse">In-house customers only</option>
                <option value="channel_partner">Channel-partner customers only</option>
              </select>
            </Row>

            <p className="pt-3 text-xs font-semibold uppercase tracking-wide
              text-slate-500">Approved Meta template names</p>
            <p className="mb-1 text-xs text-slate-500">
              Business-initiated WhatsApp messages must use pre-approved templates.
              Paste the exact template name from Meta Business Manager for each.
            </p>
            {([
              ["tpl_policy_customer", "Policy document → customer"],
              ["tpl_policy_partner", "Policy document → channel partner"],
              ["tpl_statement_partner", "Statement → channel partner"],
              ["tpl_renewal_customer", "Renewal reminder → customer"],
              ["tpl_renewal_partner", "Renewal reminder → channel partner"],
            ] as [keyof WhatsAppSettings, string][]).map(([key, label]) => (
              <Row key={key} label={label}>
                <input className="input max-w-[220px]"
                  placeholder="template_name"
                  value={String(wa[key] ?? "")}
                  onChange={(e) => set({ [key]: e.target.value } as Partial<WhatsAppSettings>)} />
              </Row>
            ))}
            <Row label="Template language code">
              <input className="input max-w-[120px]" placeholder="en"
                value={wa.default_lang}
                onChange={(e) => set({ default_lang: e.target.value })} />
            </Row>
          </div>
        </div>
      </div>

      {/* Email */}
      <div className="card mb-5">
        <div className="flex items-center justify-between border-b border-line/70
          px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="text-slate-900"><Icon.Mail size={20} /></span>
            <h3 className="font-semibold text-slate-800">
              Transactional Email</h3>
          </div>
          <Toggle checked={emailEnabled} onChange={setEmailEnabled} />
        </div>
        <div className="px-5 py-3 text-xs text-slate-500">
          When off, notification and document emails are suppressed. Security
          codes (login OTP) are always delivered so no one is locked out.
        </div>
      </div>

      <div className="flex justify-end">
        <button className="btn-primary" disabled={save.isPending}
          onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
