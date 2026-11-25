import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { servicesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { CardGridSkeleton } from "../../components/shared/LoadingSkeleton";
import { toast } from "../../components/Toast";
import type { PortalCapabilities } from "../../lib/types";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export default function PartnerPortalSettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["services"],
    queryFn: async () => (await servicesApi.get()).data,
  });
  const portal = settings.data?.partner_portal;

  const save = useMutation({
    mutationFn: (patch: Record<string, boolean | number>) =>
      servicesApi.update({ partner_portal: patch }),
    onSuccess: () => {
      toast.success("Saved.");
      qc.invalidateQueries({ queryKey: ["services"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const CAPABILITIES: {
    key: Exclude<keyof PortalCapabilities, "enabled" | "quote_validity_days">;
    label: string;
    help: string;
  }[] = [
    {
      key: "can_request_quotes",
      label: "Ask for a quote",
      help: "Send a case over for the team to price.",
    },
    {
      key: "can_raise_claims",
      label: "Raise and track claims",
      help: "Report a claim on a policy credited to them, then follow it.",
    },
    {
      key: "can_view_earnings",
      label: "See their earnings",
      help: "What they have earned, what is still owed either way, and every transaction between you.",
    },
    {
      key: "can_download_policy_pdf",
      label: "Download their policy PDFs",
      help: "Only documents on policies credited to them.",
    },
    {
      key: "can_view_renewals",
      label: "See their renewals",
      help: "So they can chase their own customers before expiry.",
    },
    {
      key: "can_upload_kyc",
      label: "Upload their own KYC",
      help: "PAN, Aadhaar and bank proof, from their profile.",
    },
  ];

  return (
    <RecordPage
      backTo="/settings"
      backLabel="Back to settings"
      title="Channel Partner portal"
      subtitle="The master switch, and what a signed-in partner may do."
    >
      <Card className="p-5">
        {settings.isLoading || !portal ? (
          <CardGridSkeleton count={3} />
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3.5">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Portal is {portal.enabled ? "on" : "off"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {portal.enabled
                    ? "Partners you have granted access to can sign in. Access is still per-partner."
                    : "Every partner is locked out right now, whatever their own access setting says."}
                </p>
              </div>
              <Switch
                checked={portal.enabled}
                aria-label="Portal enabled"
                onCheckedChange={(v) => save.mutate({ enabled: v })}
              />
            </div>

            <div
              className={
                portal.enabled ? "" : "pointer-events-none opacity-50"
              }
            >
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What a partner can do
              </p>
              <div className="divide-y divide-border/60 rounded-md border border-border">
                {CAPABILITIES.map((c) => (
                  <div
                    key={c.key}
                    className="flex items-start justify-between gap-4 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground">
                        {c.label}
                      </p>
                      <p className="text-xs text-muted-foreground">{c.help}</p>
                    </div>
                    <Switch
                      aria-label={c.label}
                      checked={!!portal[c.key]}
                      onCheckedChange={(v) => save.mutate({ [c.key]: v })}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3.5">
              <div className="pr-4">
                <p className="text-[13px] font-medium text-foreground">
                  How long a quote stays valid
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Days from when your team sends the price. Quotes already sent
                  keep the validity they were given.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={90}
                  className="w-20 text-right"
                  defaultValue={portal.quote_validity_days}
                  onBlur={(e) => {
                    const days = Number(e.target.value);
                    if (!Number.isInteger(days) || days < 1 || days > 90) {
                      e.target.value = String(portal.quote_validity_days);
                      toast.error(
                        "Enter a whole number of days between 1 and 90."
                      );
                      return;
                    }
                    if (days !== portal.quote_validity_days)
                      save.mutate({ quote_validity_days: days });
                  }}
                />
                <span className="text-xs text-muted-foreground">days</span>
              </div>
            </div>

            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              Partners never see the agency&apos;s reward, house profit, rate
              cards, brokers or anything about another partner — that is
              enforced by the server, not by these switches.
            </p>
          </div>
        )}
      </Card>
    </RecordPage>
  );
}
