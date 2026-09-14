// Small, easily-undone UI decisions, pinned.
//
// Owner 2026-07-26: no emoji anywhere in the interface, and the Customers list
// drops its Customer ID column. Both are the kind of thing that quietly comes
// back the next time someone writes a friendly empty state.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

function source(path: string): string {
  const text = SOURCES[`/src/${path}`];
  if (text === undefined) throw new Error(`${path} not found — did it move?`);
  return text;
}

// Ranges that render as full-colour pictographs. Typographic marks the app
// legitimately uses (— … ₹ · → ✓ ▲ ▼) sit outside these, except for the few
// arrows/shapes listed in ALLOW, which Chrome draws as plain glyphs.
const EMOJI_BLOCKS: [number, number][] = [
  [0x1f000, 0x1faff],   // pictographs, transport, symbols, supplemental
  [0x2600, 0x27bf],     // misc symbols + dingbats
  [0x2b00, 0x2bff],     // arrows/shapes that Chrome renders as emoji
];
const ALLOW = new Set([..."→←↑↓✓✔✕✗▲▼●○■□★☆"]);

function emojiIn(text: string): string[] {
  return [...text].filter((ch) => {
    if (ALLOW.has(ch)) return false;
    const cp = ch.codePointAt(0)!;
    return EMOJI_BLOCKS.some(([lo, hi]) => cp >= lo && cp <= hi);
  });
}

describe("no emoji anywhere in the UI", () => {
  it("finds none across the whole source tree", () => {
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(SOURCES)) {
      if (/\.test\.tsx?$/.test(path)) continue;   // this file describes them
      text.split("\n").forEach((line, i) => {
        const found = emojiIn(line);
        if (found.length)
          offenders.push(`${path}:${i + 1} ${found.join("")} — ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the detector actually recognises the ones that were removed", () => {
    // Guard the guard: an owl (late-night greeting), a party popper (onboarding
    // heading) and the arrows on the record-payment buttons.
    expect(emojiIn("The policies can wait \u{1F989}")).toHaveLength(1);
    expect(emojiIn("Welcome to the Team! \u{1F389}")).toHaveLength(1);
    expect(emojiIn("⬇ Received")).toHaveLength(1);
  });

  it("does not flag the typography the app relies on", () => {
    expect(emojiIn("₹1,00,000.00 — 26 Jul 2026 · Net → ✓")).toEqual([]);
    expect(emojiIn("Reorder ▲ ▼ … no value")).toEqual([]);
  });

  /*
    INVERTED 2026-08-07.

    This asserted the dashboard still said "The policies can wait" — the
    late-night greeting, kept when its owl emoji was removed. The greeting was
    then deleted WHOLESALE in the 2026-08-06 board rebuild (a person who opens
    this screen forty times a day is not here to be welcomed), and this test
    went red and stayed red, pinning copy that no longer existed.

    The no-emoji rule is what this file is FOR, and it is unaffected: it is
    enforced by `emojiIn` over the whole source tree, above. What is asserted
    here now is the decision that actually holds — the dashboard greets nobody.
  */
  it("does not greet anybody on the dashboard", () => {
    const text = source("pages/DashboardPage.tsx");
    expect(text).not.toContain("The policies can wait");
    expect(text).not.toContain("Good morning");
    expect(text).not.toContain("Good evening");
  });

  it("keeps the direction wording on the payment buttons", () => {
    // The arrows meant something (money in vs out), so they became icons
    // rather than simply disappearing.
    const text = source("components/RecordPaymentForm.tsx");
    expect(text).toContain('d === "received" ? "Received" : "Paid"');
    expect(text).toContain("Icon.ChevronDown");
  });
});

describe("the Customers list", () => {
  const page = () => source("pages/customers/CustomersListPage.tsx");

  it("no longer shows a Customer ID column", () => {
    expect(page()).not.toContain(">Customer ID<");
  });

  it("still shows the facts that were kept", () => {
    // AMENDED 2026-08-07 (ledger rebuild). This asserted the literal
    // `<Th>Name</Th>` markup, which broke the moment the list became a
    // `<Ledger>` — and it was asserting the wrong thing anyway. What matters
    // is that the three facts survived, not what tag or heading carries them:
    // "Name" is now the ledger's primary cell, "Active policies" is the row's
    // hero figure headed "Policies", and email moved to the sub-line.
    const text = page();
    expect(text).toContain("c.name");
    expect(text).toContain("c.mobile");
    expect(text).toContain("c.active_policies");
    expect(text).toContain("c.total_policies");
  });

  it("keeps the archived badge, moved onto the name", () => {
    // "Show archived" is only useful if you can tell which rows are archived —
    // the badge used to live in the column that was removed.
    const text = page();
    expect(text).toContain("c.is_archived &&");
    expect(text).toContain("Archived");
  });

  it("has a loading skeleton with the right number of columns", () => {
    // A 6-column skeleton over a 3-column table jumps on load.
    expect(page()).toContain("<TableSkeleton cols={3} />");
  });
});
