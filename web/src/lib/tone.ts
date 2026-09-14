/*
  The money sign → colour rule, in ONE place.

  This is the most load-bearing visual rule the product has: in a finance app,
  the colour of a figure is read before the figure is. It was implemented five
  separate times, and no two agreed:

      BalanceSheetPage      red-600 / green-600 / blue-500
      DashboardPage         red-600 / green-600 / blue-600
      FinanceOverviewPage   red-500 / green-500 / blue-400
      FinanceReportsPage    red-500 / green-500 / blue-400
      NetBalance            red-600 / green-600 / blue-600

  Three different greens, two reds and three blues — so the SAME net profit was
  drawn in a different green on the Overview than on the Balance Sheet, and the
  Reports page used a lighter one again. Nobody would file that as a bug; it
  just makes the app feel like it was built by five people who never met.

  Now every one of them calls this, and there is exactly one green, one red and
  one neutral, taken from the tokens. Changing the rule means changing it here.

  ZERO IS NOT GREEN. A net position of nought is neither a gain nor a loss, and
  painting it green claims a profit that did not happen — that is why `info`
  exists as the third state and why it is the one saturated colour in the
  product that is not about money. It is deliberately not grey either: grey
  reads as "no data", and zero is a real, known answer.
*/

/** Positive / negative / zero, for a signed money figure. */
export function moneyTone(value: number | null | undefined): string {
  const v = value ?? 0;
  if (v > 0) return "text-money-in";
  if (v < 0) return "text-money-out";
  return "text-info";
}

/**
 * The same rule where zero should read as ordinary text rather than as a
 * result — a table cell that happens to be nought, a running total mid-column.
 */
export function moneyToneQuiet(value: number | null | undefined): string {
  const v = value ?? 0;
  if (v > 0) return "text-money-in";
  if (v < 0) return "text-money-out";
  return "text-slate-500";
}

/**
 * Attainment against a goal: hit it, nearly there, behind.
 *
 * Shares the 100 / 70 thresholds with `components/TargetProgress.toneFor`,
 * which owns the same rule for progress BARS. Kept as its own function because
 * this returns a text colour and that returns a bar fill — but if the
 * thresholds ever move, they move in both.
 */
export function goalTone(pct: number): string {
  if (pct >= 100) return "text-money-in";
  if (pct >= 70) return "text-due";
  return "text-slate-700";
}

/**
 * How close a deadline is, for a countdown in days.
 *
 * `null` (no date) is not urgent and must not be coloured — an unknown expiry
 * drawn in red is an alarm about nothing.
 */
export function dueTone(days: number | null | undefined): string {
  if (days === null || days === undefined) return "text-slate-500";
  if (days <= 7) return "text-money-out";
  if (days <= 30) return "text-due";
  return "text-slate-600";
}
