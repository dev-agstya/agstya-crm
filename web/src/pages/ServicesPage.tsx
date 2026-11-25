import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageCircle, Zap } from "lucide-react";
import { servicesApi } from "../api/endpoints";
import { apiError } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { CardGridSkeleton } from "../components/shared/LoadingSkeleton";
import { toast } from "../components/Toast";
import type { ServiceSettings, WhatsAppSettings } from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
    if (q.data) {
      setWa(q.data.whatsapp);
      setEmailEnabled(q.data.email.enabled);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: () =>
      servicesApi.update({
        whatsapp: wa,
        email: { enabled: emailEnabled },
      }),
    onSuccess: () => {
      toast.success("Settings saved.");
      qc.invalidateQueries({ queryKey: ["services"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (q.isLoading || !wa || !q.data) return <CardGridSkeleton count={3} />;
  const set = (patch: Partial<WhatsAppSettings>) => setWa({ ...wa, ...patch });
  const credsReady = q.data.whatsapp_credentials_ready;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Third Party Services"
        subtitle="Enable, disable and configure the integrations this portal uses."
        actions={
          <Button
            size="sm"
            className="h-8"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {q.data.services.map((s) => (
          <Card key={s.key} className="flex items-start gap-3 p-3.5">
            <span
              className={`mt-0.5 rounded-md p-2 ${
                s.configured
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Zap className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-foreground">
                {s.label}
              </p>
              <p className="text-xs text-muted-foreground">{s.detail}</p>
              <Badge
                variant="outline"
                className={`mt-1.5 h-5 px-1.5 text-[10px] ${
                  s.configured
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-800"
                }`}
              >
                {s.configured ? "Configured" : "Not configured"}
              </Badge>
            </div>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-foreground">
              WhatsApp Messaging
            </h3>
          </div>
          <Switch
            checked={wa.enabled}
            onCheckedChange={(v) => set({ enabled: v })}
          />
        </div>
        <div className="p-4">
          {!credsReady && (
            <p className="mb-3 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
              WhatsApp API credentials are not set in the server environment.
              Messages will not be delivered until they are configured.
            </p>
          )}
          <div className={wa.enabled ? "" : "pointer-events-none opacity-50"}>
            <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              On policy creation
            </p>
            <div className="divide-y divide-border/60">
              <Row label="Auto-send policy PDF to the customer">
                <Switch
                  checked={wa.send_policy_on_create_customer}
                  onCheckedChange={(v) =>
                    set({ send_policy_on_create_customer: v })
                  }
                />
              </Row>
              <Row
                label="Auto-send policy PDF to the channel partner"
                hint="Only when the policy is attributed to a partner"
              >
                <Switch
                  checked={wa.send_policy_on_create_partner}
                  onCheckedChange={(v) =>
                    set({ send_policy_on_create_partner: v })
                  }
                />
              </Row>
            </div>

            <p className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Renewal reminders
            </p>
            <div className="divide-y divide-border/60">
              <Row
                label="Send renewal reminders to customers"
                hint="Respects each customer's own opt-in"
              >
                <Switch
                  checked={wa.renewal_reminders_customers}
                  onCheckedChange={(v) =>
                    set({ renewal_reminders_customers: v })
                  }
                />
              </Row>
              <Row label="Send renewal reminders to channel partners">
                <Switch
                  checked={wa.renewal_reminders_partners}
                  onCheckedChange={(v) =>
                    set({ renewal_reminders_partners: v })
                  }
                />
              </Row>
            </div>

            <p className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Restrictions
            </p>
            <Row label="Which customers may be messaged">
              <Select
                value={wa.customer_send_scope}
                onValueChange={(v) =>
                  set({
                    customer_send_scope:
                      v as WhatsAppSettings["customer_send_scope"],
                  })
                }
              >
                <SelectTrigger className="h-9 w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All customers</SelectItem>
                  <SelectItem value="inhouse">
                    In-house customers only
                  </SelectItem>
                  <SelectItem value="channel_partner">
                    Channel-partner customers only
                  </SelectItem>
                </SelectContent>
              </Select>
            </Row>

            <p className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Approved Meta template names
            </p>
            <p className="mb-1 text-xs text-muted-foreground">
              Business-initiated WhatsApp messages must use pre-approved
              templates. Paste the exact template name from Meta Business
              Manager for each.
            </p>
            <div className="divide-y divide-border/60">
              {(
                [
                  ["tpl_policy_customer", "Policy document → customer"],
                  ["tpl_policy_partner", "Policy document → channel partner"],
                  ["tpl_statement_partner", "Statement → channel partner"],
                  ["tpl_renewal_customer", "Renewal reminder → customer"],
                  ["tpl_renewal_partner", "Renewal reminder → channel partner"],
                ] as [keyof WhatsAppSettings, string][]
              ).map(([key, label]) => (
                <Row key={key} label={label}>
                  <Input
                    className="max-w-[220px]"
                    placeholder="template_name"
                    value={String(wa[key] ?? "")}
                    onChange={(e) =>
                      set({
                        [key]: e.target.value,
                      } as Partial<WhatsAppSettings>)
                    }
                  />
                </Row>
              ))}
              <Row label="Template language code">
                <Input
                  className="max-w-[120px]"
                  placeholder="en"
                  value={wa.default_lang}
                  onChange={(e) => set({ default_lang: e.target.value })}
                />
              </Row>
            </div>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              Transactional Email
            </h3>
          </div>
          <Switch
            checked={emailEnabled}
            onCheckedChange={setEmailEnabled}
          />
        </div>
        <div className="px-4 py-3 text-xs text-muted-foreground">
          When off, notification and document emails are suppressed. Security
          codes (login OTP) are always delivered so no one is locked out.
        </div>
      </Card>
    </div>
  );
}
