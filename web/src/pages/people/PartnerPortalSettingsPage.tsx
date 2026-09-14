import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { servicesApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { PageLoader, Toggle } from "../../components/ui";
import { toast } from "../../components/Toast";
import type { PortalCapabilities } from "../../lib/types";

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

  // These are the capability flags that actually exist on the server
  // (models/settings.PartnerPortalSettings). The list used to carry six that
  // were deleted when the portal was rebuilt — "Submit policies", "Request a
  // payout", "Always require approval" and so on — so those switches wrote
  // keys nothing reads and read back `undefined` as "off". A switch that does
  // nothing is worse than no switch: it is a setting the owner believes is in
  // force. Pinned by lib/partnerPortalV2.test.ts against the type.
  // Typed to the boolean capability keys, so a flag that is renamed or deleted
  // on the server fails the build here rather than silently doing nothing.
  const CAPABILITIES: {
    key: Exclude<keyof PortalCapabilities, "enabled" | "quote_validity_days">;
    label: string; help: string;
  }[] = [
    { key: "can_request_quotes", label: "Ask for a quote",
      help: "Send a case over for the team to price. This is one of the only "
        + "two things a partner can create." },
    { key: "can_raise_claims", label: "Raise and track claims",
      help: "Report a claim on a policy credited to them, then follow it." },
    { key: "can_view_earnings", label: "See their earnings",
      help: "What they have earned, what is still owed either way, and every "
        + "transaction between you." },
    { key: "can_download_policy_pdf", label: "Download their policy PDFs",
      help: "Only documents on policies credited to them." },
    { key: "can_view_renewals", label: "See their renewals",
      help: "So they can chase their own customers before expiry." },
    { key: "can_upload_kyc", label: "Upload their own KYC",
      help: "PAN, Aadhaar and bank proof, from their profile." },
  ];

  return (
    <RecordPage
      backTo="/settings"
      backLabel="Back to settings"
      title="Channel Partner portal"
      subtitle="The master switch, and what a signed-in partner may do."
    >
      <div className="card max-w-2xl px-6 py-5">
      {settings.isLoading || !portal ? <PageLoader /> : (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-control
            border border-line p-4">
            <div>
              <p className="text-sm font-medium text-slate-700">
                Portal is {portal.enabled ? "on" : "off"}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {portal.enabled
                  ? "Partners you have granted access to can sign in. Access "
                    + "is still per-partner — switch it on for each one."
                  : "Every partner is locked out right now, whatever their "
                    + "own access setting says. This is checked on every "
                    + "request, so switching it off signs them all out at once."}
              </p>
            </div>
            <Toggle checked={portal.enabled} label="Portal enabled"
              onChange={(v) => save.mutate({ enabled: v })} />
          </div>

          <div className={portal.enabled ? "" : "pointer-events-none opacity-50"}>
            <p className="mb-2 text-sm font-medium text-slate-600">
              What a partner can do</p>
            <div className="space-y-1">
              {CAPABILITIES.map((c) => (
                <div key={c.key}
                  className="flex items-start justify-between gap-4 rounded-control
                    px-3 py-2 hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-700">{c.label}</p>
                    <p className="text-xs text-slate-500">{c.help}</p>
                  </div>
                  <Toggle label={c.label} checked={!!portal[c.key]}
                    onChange={(v) => save.mutate({ [c.key]: v })} />
                </div>
              ))}
            </div>
          </div>

          {/* Owner B3: premiums move, so a quote that never expires is a price
              the agency did not promise. The server stamps this onto each
              quote when it is sent — changing it here does not re-date the
              ones already out. */}
          <div className="flex items-start justify-between gap-4 rounded-control
            border border-line p-4">
            <div className="pr-4">
              <p className="text-sm font-medium text-slate-700">
                How long a quote stays valid</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Days from when your team sends the price. Quotes already sent
                keep the validity they were given.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input type="number" min={1} max={90}
                className="input w-20 text-right"
                defaultValue={portal.quote_validity_days}
                onBlur={(e) => {
                  const days = Number(e.target.value);
                  if (!Number.isInteger(days) || days < 1 || days > 90) {
                    e.target.value = String(portal.quote_validity_days);
                    toast.error("Enter a whole number of days between 1 and 90.");
                    return;
                  }
                  if (days !== portal.quote_validity_days)
                    save.mutate({ quote_validity_days: days });
                }} />
              <span className="text-sm text-slate-500">days</span>
            </div>
          </div>

          <p className="border-t border-line/70 pt-3 text-xs text-slate-500">
            Partners never see the agency's reward, house profit, rate cards,
            brokers or anything about another partner — that is enforced by the
            server, not by these switches.
          </p>
        </div>
      )}
      </div>
    </RecordPage>
  );
}
