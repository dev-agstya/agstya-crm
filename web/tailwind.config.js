/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Light-only app: no dark variant is generated (see src/index.css).
  theme: {
    extend: {
      colors: {
        // Brand palette — monochrome (black / white / grey). The old royal
        // indigo was retired; "brand" is now a neutral graphite ramp so every
        // brand-* accent (active states, links, chips, focus rings) reads as
        // black/grey. Semantic status colours (green/amber/red) live elsewhere.
        brand: {
          50: "#fafafa",
          100: "#f4f4f5",
          200: "#e8e8ea",
          300: "#d3d3d7",
          400: "#9d9da5",
          500: "#71717a",
          600: "#52525b",
          700: "#3f3f46",
          800: "#27272a",
          900: "#18181b",
        },

        // ------------------------------------------------------------------
        // `slate` is REDEFINED, not extended (2026-08-05).
        //
        // Tailwind's stock slate is blue-tinted (#64748b has a visible cool
        // cast). In a product whose whole palette is "black, white and grey",
        // that tint is the difference between looking monochrome and looking
        // washed-out-blue — and the app writes text-slate-* on roughly every
        // element it has.
        //
        // Overriding the ramp here re-tunes all ~25,000 lines of JSX at once,
        // with no page edits and no risk of half the app converting. The values
        // are a true neutral (Tailwind's `zinc`, which is the reference neutral
        // grey), so `text-slate-500` now means neutral grey everywhere.
        //
        // Do NOT "fix" this by reverting to stock slate and remapping pages —
        // that is 25k lines of churn for the same result.
        // ------------------------------------------------------------------
        slate: {
          50: "#fafafa",
          100: "#f4f4f5",
          200: "#e8e8ea",
          300: "#d3d3d7",
          400: "#9d9da5",   // icons + placeholders ONLY (fails contrast as text)
          500: "#71717a",   // secondary text — the lightest legal body colour
          600: "#52525b",
          700: "#3f3f46",
          800: "#27272a",
          900: "#18181b",
        },

        // The named surfaces from the design system. Spelling them out stops
        // "#f4f4f5" and "slate-100" being used interchangeably for the same
        // thing on different pages.
        ink: "#18181b",        // sidebar, primary button, headings
        "ink-hover": "#27272a",
        canvas: "#f7f7f8",     // page background — cards sit on it in white
        line: "#e8e8ea",       // every border
        "line-soft": "#f0f0f2", // dividers INSIDE a card, quieter than its edge

        // The ONLY saturated colours in the product, and each has one meaning.
        // Never re-map these: the money colours are load-bearing.
        money: {
          in: "#16a34a",       // positive / credit
          out: "#dc2626",      // negative / debit
        },
        due: "#d97706",        // warning / due soon
        info: "#2563eb",       // neutral figure

        // ------------------------------------------------------------------
        // The CATEGORICAL chart ramp (2026-08-19, owner).
        //
        // Charts went monochrome on 2026-08-06 — six greys — for a good
        // reason: eight ad-hoc hues had been maintained in JavaScript, outside
        // every token sweep, to colour one bar chart. That fixed the drift and
        // it also made a six-slice donut genuinely hard to read, which is the
        // owner's verdict ("very black and dull").
        //
        // So the hues are back, but as TOKENS this time. That is the whole
        // difference: they live here, designSystem.test.ts allows exactly this
        // list and nothing else, and there is no second palette to drift from.
        //
        // WHAT THESE ARE NOT: they never colour a figure that means money.
        // Green/red/amber/blue keep their single meanings (money in, money out,
        // due, exactly zero), and none of the hues below is close enough to one
        // of those four to be mistaken for it in the same chart — that is why
        // there is no plain red, plain green or plain amber in the ramp even
        // though a categorical palette would normally reach for all three.
        // Category identity only: which insurer, which policy type, which payer.
        //
        // Ordered so the FIRST hues are the darkest, because the first series is
        // the biggest one, and so consecutive entries differ in lightness as
        // well as in hue — colour alone is never the only cue (every chart
        // using these also carries a legend or direct labels).
        // ------------------------------------------------------------------
        chart: {
          1: "#4f46e5",   // indigo
          2: "#0d9488",   // teal
          3: "#db2777",   // magenta
          4: "#7c3aed",   // violet
          5: "#0891b2",   // cyan
          6: "#ea580c",   // orange — clearly redder than `due` amber
          7: "#65a30d",   // lime — clearly yellower than `money-in` green
          8: "#52525b",   // graphite, the neutral tail ("Others")
        },
      },

      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto",
               "sans-serif"],
      },

      fontSize: {
        // The type scale, so a page cannot invent a fourteen-and-a-half.
        //
        // Negative tracking on the display sizes is deliberate: Inter is drawn
        // slightly wide at large sizes and tightening it is most of what makes
        // a heading read as "designed" rather than "default".
        "display": ["1.875rem", {
          lineHeight: "2.25rem", fontWeight: "700", letterSpacing: "-0.021em" }],
        "page-title": ["1.375rem", {
          lineHeight: "1.75rem", fontWeight: "700", letterSpacing: "-0.018em" }],
        "section": ["1rem", {
          lineHeight: "1.5rem", fontWeight: "600", letterSpacing: "-0.011em" }],
        "card-title": ["0.875rem", {
          lineHeight: "1.25rem", fontWeight: "600", letterSpacing: "-0.006em" }],
        "secondary": ["0.8125rem", { lineHeight: "1.25rem" }],
        "caption": ["0.6875rem", {
          lineHeight: "1rem", letterSpacing: "0.04em", fontWeight: "600" }],
        // Big figures. Tabular-lining numerals need tight tracking or they
        // drift apart at size.
        //
        // THREE steps, and that is the whole ladder: `metric-lg` is the ONE
        // number a page is about (an entity's balance, the profit on the
        // Overview hero), `metric` is a tile, `metric-sm` is a figure in a row.
        // Pages were reaching for text-4xl / 3xl / 2xl / xl / lg to say the same
        // three things, which is five sizes doing three jobs — and the sizes
        // disagreed between screens showing the same kind of figure.
        "metric-lg": ["2.25rem", {
          lineHeight: "2.5rem", fontWeight: "700", letterSpacing: "-0.028em" }],
        "metric": ["1.75rem", {
          lineHeight: "2rem", fontWeight: "700", letterSpacing: "-0.024em" }],
        "metric-sm": ["1.25rem", {
          lineHeight: "1.5rem", fontWeight: "700", letterSpacing: "-0.018em" }],
      },

      borderRadius: {
        // 8px controls, 12px cards, pills. Nothing in between.
        control: "0.5rem",
        card: "0.75rem",
      },

      // ----------------------------------------------------------------------
      // ONE LADDER FOR EVERYTHING THAT FLOATS (2026-08-21).
      //
      // THE BUG. Clicking a notification opened its detail dialog BEHIND the
      // notification panel. Two causes, and the second is why this token block
      // exists rather than one number being bumped:
      //
      //   1. The panel was z-50 and the shared Modal was z-40. Nine different
      //      z-index values had been picked by hand across the app in different
      //      months by different passes, and these two finally met.
      //
      //   2. The top bar is `sticky top-0 z-nav`. A positioned element with a
      //      z-index creates a STACKING CONTEXT: everything rendered inside it
      //      is sealed into that one layer of the page, and its children's
      //      z-indexes only sort them against each other INSIDE the seal. The
      //      bell lives in the top bar, so the dialog it opened was sealed in
      //      there too — a full-screen `fixed` overlay that could not cover the
      //      app however high its number went.
      //
      // So the numbers below are only half the fix. The other half is that
      // `Modal` and `Confirm` PORTAL to <body> (components/ui.tsx,
      // components/Confirm.tsx), which is what puts them in the document root
      // where `dialog` and `confirm` actually mean what they say. A dialog is a
      // viewport-level object; it must not care which corner of the app opened
      // it.
      //
      // Add a layer here rather than writing a number in a page. Pinned by
      // lib/designSystem.test.ts.
      zIndex: {
        raised: "10",    // in-page: sticky table heads/columns, chart tooltips
        scrim: "20",     // the mobile nav's dimming layer
        nav: "30",       // the sidebar and the top bar
        menu: "40",      // anchored to a control: dropdowns, pickers, nav chrome
        panel: "50",     // the top bar's OWN panels: search, notifications, account
        dialog: "60",    // Modal    — portalled, so this sorts against the root
        confirm: "70",   // Confirm  — portalled; raisable from inside a Modal
        toast: "80",     // reports on what a dialog just did; clears everything
      },

      boxShadow: {
        // Borders do the work; shadows only separate planes. Both are much
        // softer and more diffuse than a default Tailwind shadow, which is what
        // stops a page of cards looking like a page of buttons.
        card: "0 1px 2px rgba(24,24,27,.04), 0 1px 3px rgba(24,24,27,.03)",
        // Resting -> hover on an interactive card.
        raise: "0 2px 4px rgba(24,24,27,.05), 0 4px 12px -2px rgba(24,24,27,.06)",
        // Only for things that float above the page: modals, menus, popovers.
        pop: "0 12px 32px -8px rgba(24,24,27,.16), 0 4px 12px -4px rgba(24,24,27,.08)",
      },

      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "modal-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(.99)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },

      animation: {
        "fade-in": "fade-in .15s ease-out",
        "modal-in": "modal-in .16s cubic-bezier(.16,1,.3,1)",
        "slide-up": "slide-up .2s cubic-bezier(.16,1,.3,1)",
      },
    },
  },
  plugins: [],
};
