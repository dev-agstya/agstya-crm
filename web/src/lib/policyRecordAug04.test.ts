// The policy record and the partner invite, 2026-08-04.
//
// Three decisions from that pass, none of which a render test would observe
// without standing up most of the app:
//
//   1. Every document attached to a policy is on the policy page. It used to
//      show the policy PDF and silently drop the supporting files collected at
//      booking.
//   2. The reward block reads as a small P&L, and a NOT ELIGIBLE policy says so
//      rather than leaving a dropdown to be the only clue.
//   3. The edit form collects what the Add form collects. Custom fields, the
//      reward base, the sub-type, the broker and the attribution were all
//      offered at booking and on nothing afterwards.
//
// Plus: adding a channel partner now emails them their sign-in details, so no
// screen may still tell the user that it doesn't.
//
// Source-reading, in the style of partnerPortal.test.ts.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(rel: string): string {
  const text = SOURCES[`/src/${rel}`];
  if (text === undefined) throw new Error(`No such source file: ${rel}`);
  return text;
}

/** Source with comments stripped — several of these files explain in prose the
 *  very thing being asserted absent. */
function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const body = () => code("components/PolicyDetailBody.tsx");
const docsPanel = () => code("components/PolicyDocuments.tsx");

/* ------------------------------------------------ every document is on show -- */

describe("the policy page shows every document", () => {
  it("renders the shared Documents panel instead of one PDF card", () => {
    expect(body()).toContain("<PolicyDocuments");
    // The card it replaced showed `pdf.filename` and nothing else.
    expect(body()).not.toContain("Policy document\n");
  });

  it("hands the panel the whole document list, not the picked PDF", () => {
    expect(body()).toMatch(/docs=\{docs\.data\}/);
  });

  it("hands it the policy TYPE's configured slots, so gaps are visible", () => {
    expect(body()).toMatch(/slots=\{cat\?\.required_documents/);
  });

  it("builds its rows from the one shared builder", () => {
    expect(docsPanel()).toContain("buildPolicyDocRows");
  });

  it("can upload, replace and delete (owner B1c)", () => {
    const src = docsPanel();
    expect(src).toContain("policiesApi.uploadExtraDocument");
    expect(src).toContain("policiesApi.uploadDocument");
    expect(src).toContain("documentsApi.remove");
  });

  it("confirms before deleting a file for good", () => {
    expect(docsPanel()).toContain("confirmDialog");
  });

  it("never offers to DELETE the policy PDF, only to replace it", () => {
    // Deleting it breaks the customer's emailed copy and the partner portal's
    // download; the row is replace-only by construction.
    expect(docsPanel()).toMatch(/canManage && row\.doc && !isPdf/);
  });

  it("takes PDFs or images for supporting files, PDF only for the policy",
    () => {
      const src = docsPanel();
      expect(src).toMatch(/DOC_ACCEPT = "\.pdf,\.jpg,\.jpeg,\.png,\.webp"/);
      expect(src).toMatch(/PDF_ACCEPT = "application\/pdf,\.pdf"/);
      expect(src).toContain("isPdf ? PDF_ACCEPT : DOC_ACCEPT");
    });

  it("says WHY the list is empty when the viewer cannot see documents", () => {
    // "No documents" and "you may not look at them" are different facts.
    expect(docsPanel()).toContain("canView");
    expect(docsPanel()).toContain("don't have access");
  });

  it("refetches the list after any change rather than guessing", () => {
    expect(body()).toMatch(/onChanged=\{\(\) =>[\s\S]*?policy-docs/);
  });
});

/* ------------------------------------------------------------ the reward ----- */

describe("the reward block reads as a ledger", () => {
  it("is its own component, not an inline grey box", () => {
    expect(body()).toContain("function RewardPanel");
    expect(body()).toContain("<RewardPanel");
  });

  it("no longer sets three figures as one run-on sentence", () => {
    const src = body();
    expect(src).not.toContain("flex flex-wrap gap-x-6 gap-y-1 text-sm");
  });

  it("right-aligns money with tabular figures", () => {
    // `.num` is the app's one money-cell class (index.css).
    expect(body()).toMatch(/num[^"]*px-4 py-2\.5/);
  });

  it("rules House off as the bottom line", () => {
    expect(body()).toContain("House keeps");
    expect(body()).toContain("border-t-2 border-ink/80");
  });

  it("colours house profit with the app's money colours, THREE ways", () => {
    // Was `money.house < 0 ? out : in`, which is only two ways — a policy that
    // earned the agency exactly nothing went down the green branch and was
    // drawn as a gain. Caught by screenshotting the app on 2026-08-06.
    //
    // `moneyToneQuiet` is the right one here rather than `moneyTone`: a single
    // policy has no "settled" state to report, so a zero margin should read as
    // ordinary text, not as the blue that means a net position of nought.
    expect(body()).toContain("moneyToneQuiet(money.house)");
    expect(body()).not.toContain('money.house < 0 ? "text-money-out"');
  });

  it("shows the rate AND the base under each figure", () => {
    expect(body()).toMatch(/const of = `of \$\{formatINR\(money\.base\)\}`/);
  });

  it("strikes the figures through when the policy earns nothing", () => {
    const src = body();
    expect(src).toContain("notEligible");
    expect(src).toContain("line-through");
  });

  it("says in a sentence what NOT ELIGIBLE means (owner C2)", () => {
    expect(body()).toContain("Nothing is receivable on this policy");
  });

  it("keeps house profit behind view_agency_profit", () => {
    // The gating is unchanged by the redesign, and that is the point.
    expect(body()).toContain("seesAgency = !isPartner && has(\"view_agency_profit\")");
    expect(body()).toMatch(/seesHouse=\{seesHouse\}/);
  });

  it("does not reach for finance state it has not loaded (owner C3a)", () => {
    // "Received from broker" / "Paid to partner" live on the party ledger.
    expect(body()).not.toContain("Received from broker");
  });
});

describe("changing eligibility updates the page you are looking at", () => {
  // The bug: saveReward invalidated ["policies"] — the LIST — and never
  // ["policy", id], which is the query PolicyDetailPage is built on. So the
  // struck-through figures, the Not eligible badge and the Update button all
  // kept reading a stale record until a hard browser refresh.
  it("invalidates THIS record, not only the list", () => {
    const src = body();
    const onSuccess = src.slice(src.indexOf("const saveReward"),
      src.indexOf("const submit"));
    expect(onSuccess).toContain('queryKey: ["policy", policy.id]');
    expect(onSuccess).toContain('queryKey: ["policies"]');
  });

  it("still refreshes finance, since a reversal moves the partner wallet", () => {
    const src = body();
    const onSuccess = src.slice(src.indexOf("const saveReward"),
      src.indexOf("const submit"));
    expect(onSuccess).toContain("refreshFinance(qc)");
  });

  it("re-seeds the dropdown when the record changes underneath it", () => {
    // useState seeds once. Without this the control would keep showing the
    // old choice even after the refetch brought the new one in.
    const src = body();
    expect(src).toContain("seenEligibility");
    expect(src).toContain("setRewardStatus(serverEligibility)");
  });

  it("reads the badge and the dirty check off the SERVER value", () => {
    // Not off the local draft — otherwise the panel would claim the policy is
    // not eligible the moment the dropdown moved, before anything was saved.
    const src = body();
    expect(src).toContain('notEligible={serverEligibility === "not_eligible"}');
    expect(src).toContain("dirty={rewardStatus !== serverEligibility}");
  });
});

/* ------------------------------------------------------ add / edit parity ---- */

describe("the edit form collects what the add form collects", () => {
  const addForm = () => code("pages/policies/PolicyFormPage.tsx");

  it("renders the type's own custom fields, both groups", () => {
    for (const component of ["AmountCustomFields", "OtherCustomFields"]) {
      expect(addForm(), `add form lost ${component}`).toContain(component);
      expect(body(), `edit form is missing ${component}`).toContain(component);
    }
  });

  it("sends the collected details and the reward base on save", () => {
    expect(body()).toMatch(/details,\s*\n\s*reward_base_field: rewardBaseField/);
  });

  it("validates the details client-side with the same shared function", () => {
    expect(body()).toContain("validateDetailsClient");
    expect(addForm()).toContain("validateDetailsClient");
  });

  it("lets staff correct the broker, the sub-type and the attribution", () => {
    const src = body();
    expect(src).toContain("body.broker_id");
    expect(src).toContain("body.partner_id");
    expect(src).toContain("body.subcategory_path");
    // Sub-type levels come from the same helper the add form uses.
    expect(src).toContain("pathLevels");
  });

  it("keeps all three away from a channel partner", () => {
    // A partner may not choose their own broker or re-attribute a policy —
    // the server strips them, and the form must not offer them either.
    expect(body()).toMatch(/if \(!isPartner\) \{\s*\n\s*body\.broker_id/);
  });

  it("follows the picker, not the saved value, for the discount rule", () => {
    // Clearing the partner has to open the discount field in the same edit.
    expect(body()).toContain("{!f.partner_id && (");
    expect(body()).not.toContain("{!policy.partner_id && (");
  });

  it("refreshes finance after a save that can re-price the reward", () => {
    expect(body()).toContain("refreshFinance(qc)");
  });

  it("discards typed values when the edit is cancelled", () => {
    expect(body()).toContain("const cancelEdit = ()");
    expect(body()).toContain("onClick={cancelEdit}");
  });

  it("does not re-collect supporting documents in the form", () => {
    // They are managed on the record itself; a second uploader that only works
    // mid-edit is how the two go out of step.
    expect(body()).not.toContain("<RequiredDocuments");
  });
});

/* ------------------------------------------- adding a partner invites them --- */

describe("adding a channel partner invites them", () => {
  const addPartner = () => code("pages/people/AddPartnerPage.tsx");

  // These used to assert the OPPOSITE — that every sentence follows a
  // `partner_portal_launched` flag and says nobody is emailed. That flag was
  // deleted when the portal shipped (2026-08-05), so it read as false forever:
  // the toast reported "no invitation was sent" while the server had just sent
  // one, and the Portal access toggle and Send invite button were both
  // permanently disabled. The tests passed the whole time, because they were
  // pinning the paused copy rather than the behaviour.
  //
  // The flag is now gone from the client too, and these assert its absence.
  it("carries no trace of the launch gate on any partner screen", () => {
    for (const file of ["pages/people/AddPartnerPage.tsx",
      "pages/policies/QuickAdd.tsx", "components/PersonDetailBody.tsx",
      "pages/people/PartnerPortalSettingsPage.tsx", "lib/types.ts"]) {
      expect(code(file), `${file} still reads the deleted launch flag`)
        .not.toContain("partner_portal_launched");
    }
  });

  it("states one outcome, because creating a partner has only one", () => {
    const src = addPartner();
    expect(src).toContain("emailed");
    expect(src).toContain("onboarding email");
    // No branch left that could report the opposite of what the server did.
    expect(src).not.toContain("launched");
  });

  it("never tells anyone the portal is shut", () => {
    for (const file of ["pages/people/AddPartnerPage.tsx",
      "pages/policies/QuickAdd.tsx", "components/PersonDetailBody.tsx",
      "pages/people/PartnerPortalSettingsPage.tsx"]) {
      const src = code(file);
      expect(src, `${file}`).not.toContain("not open yet");
      expect(src, `${file}`).not.toContain("no invitation was sent");
      expect(src, `${file}`).not.toContain("nobody is emailed a login");
    }
  });

  it("no longer carries the old v1 wording", () => {
    const src = addPartner();
    expect(src).not.toContain("No onboarding email was sent");
    expect(src).not.toContain("No temporary password or portal onboarding");
    expect(src).not.toContain("in v1");
  });

  it("leaves Send invite enabled — the only reason to grey it out is access",
    () => {
      const detail = code("components/PersonDetailBody.tsx");
      expect(detail).toContain("disabled={!portalOn || invite.isPending}");
      expect(detail).toContain("Switch on portal access first");
    });

  it("leaves the Portal access toggle usable, so access can be revoked", () => {
    // Revoking is the whole point of a per-partner switch. A disabled toggle
    // meant a partner who left could not be locked out from this screen.
    const detail = code("components/PersonDetailBody.tsx");
    expect(detail).not.toContain("disabled={!portalLaunched}");
  });

  it("offers only capability switches the server actually has", () => {
    // Six of these wrote keys that were deleted with the old portal, so the
    // switch moved, saved, and changed nothing.
    const page = code("pages/people/PartnerPortalSettingsPage.tsx");
    for (const dead of ["can_create_leads", "can_submit_policies",
      "can_view_wallet", "can_request_withdrawal", "show_amount_payable",
      "require_policy_approval"]) {
      expect(page, `${dead} is not a setting any more`).not.toContain(dead);
    }
    for (const live of ["can_request_quotes", "can_raise_claims",
      "can_view_earnings", "can_download_policy_pdf", "can_view_renewals",
      "can_upload_kyc", "quote_validity_days"]) {
      expect(page, `${live} has no switch`).toContain(live);
    }
  });

  it("does not promise a 7-day window a partner's password does not have",
    () => {
      const detail = code("components/PersonDetailBody.tsx");
      expect(detail).toContain("until their first sign-in");
      expect(detail).not.toContain("temporary password valid for 7 days. Send");
    });
});
