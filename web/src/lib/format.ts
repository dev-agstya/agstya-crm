// Formatting helpers. Money is stored in paise (integer); dates in UTC ISO.
// We render dates in the viewer's local timezone (no fixed IST).

// Owner's rule, unchanged: amounts ALWAYS render as full Indian-format numbers
// — never abbreviated (no 100k / 10L / 18.3k).
//
// What DID change (2026-08-06): the paise are shown only when there ARE paise.
// Every figure used to carry a hard `.00`, so a dashboard tile read
// "₹3,44,630.00" and a phone screen "₹31,200.00" — two characters of nothing,
// on every number in the product, competing with the digits that matter.
//
// Blanket-dropping them would have been wrong: reward-on-GST-net genuinely
// produces fractional paise (the "₹1,234.99" the owner checked in July and
// confirmed was correct maths, not a bug), and hiding that would make a real
// figure look rounded. `minimumFractionDigits: 0` with `maximum: 2` gives
// exactly the right rule — ₹3,44,630 stays clean, ₹1,234.99 keeps its paise.
/*
  An unknown figure is an em-dash, NOT a zero.

  This function already did the right thing — and thirteen call sites defeated
  it by writing `formatINR(d?.premium ?? 0)`, which turns "we have not been told"
  into a confident "₹0". On the partner portal that read "You earned ₹0" when a
  request failed. Never re-add the `?? 0`; `designSystem.test.ts` bans it.
*/
export function formatINR(paise: number | null | undefined): string {
  if (paise == null) return "—";
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(rupees);
}

// Same Indian grouping as formatINR but WITHOUT the trailing paise (.00) — for
// dense tables where the decimals only cost width (owner 2026-07-24). Still a
// full number, never abbreviated (no 1.2k / 10L).
export function formatINRShort(paise: number | null | undefined): string {
  if (paise == null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

// Plain rupee string from paise, no currency symbol, two decimals — for CSV
// cells and the print/PDF builders that lay out their own ₹ column.
// Blank/null renders as "". (Shared: was re-declared as a local `rupees` helper
// in several files.)
export function paiseToRupeeStr(paise?: number | null): string {
  return paise == null ? "" : (paise / 100).toFixed(2);
}

// "33%" / "—". A tiny helper duplicated across finance pages — centralised here.
export function pctText(v?: number | null): string {
  return v == null ? "—" : `${v}%`;
}

// Mask all but the last `keep` characters of an identifier, e.g. a policy
// number "12345678" -> "****5678". Short values are shown whole; blanks -> "—".
export function maskTail(value: string | null | undefined, keep = 4): string {
  const s = (value ?? "").trim();
  if (!s) return "—";
  if (s.length <= keep) return s;
  return `****${s.slice(-keep)}`;
}

// Dates are pinned to en-IN, NOT the viewer's locale. Passing `undefined` used
// to hand the ordering to the browser, and en-US puts the month first even with
// these exact options ("Jul 26, 2026") — so the same record read differently
// depending on whose laptop it was opened on. India reads day-first, always
// (owner 2026-07-26). The timezone stays local; only the ordering is fixed.
const DATE_LOCALE = "en-IN";

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(DATE_LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(DATE_LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "July 2026" for a Date. Same pinned locale as the rest — a month label has no
// day to misread, but leaving one call locale-guessed is how the whole class of
// bug creeps back.
export function formatMonthYear(d: Date): string {
  return d.toLocaleDateString(DATE_LOCALE, { month: "long", year: "numeric" });
}

// yyyy-mm-dd for a Date in the viewer's LOCAL timezone. Using an ISO slice
// (UTC) would flip to the previous/next day around midnight for non-UTC users,
// so day boundaries are always computed locally (matches the finance rule).
function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")}`;
}

// Today as yyyy-mm-dd in the viewer's local timezone — for date-input defaults.
export function todayInput(): string {
  return localYmd(new Date());
}

// For <input type="date"> values from an ISO string. Local date (see above) so
// a value stored at UTC midnight doesn't render as the day before in IST.
export function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return localYmd(d);
}

// Convert a date input (yyyy-mm-dd) to an ISO datetime at UTC midnight.
export function fromDateInput(value: string): string | null {
  if (!value) return null;
  return new Date(value + "T00:00:00Z").toISOString();
}

/* --------------------------------------------------------- day-first dates -- */
// India writes dates day-first: 26/07/2026. A native <input type="date"> renders
// in the BROWSER's locale — 07/26/2026 on a US-configured machine — and nothing
// in HTML or CSS can change that, which is why every date field in this app is
// the DateInput component (components/DateInput.tsx) rather than a raw date
// input (owner 2026-07-26).
//
// The wire format is untouched: yyyy-mm-dd goes in and comes out, exactly as the
// native input did. Only the characters a person reads and types are day-first.
// These four helpers are DateInput's whole contract, kept here so the parsing
// rules can be tested without rendering anything.

// Slashes inserted as someone types: "2607" -> "26/07", "26072026" ->
// "26/07/2026". Anything that isn't a digit is dropped, so a pasted "26-07-2026"
// lands correctly too.
export function maskDmy(text: string): string {
  const d = (text ?? "").replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

// yyyy-mm-dd -> "dd/mm/yyyy". Blank or malformed input gives "" (never "NaN").
export function toDmy(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

// "dd/mm/yyyy" -> yyyy-mm-dd, or "" when the text is still half-typed or isn't a
// real day. Separators are ignored (a paste of "26-07-2026" works), and 31/02 is
// rejected rather than silently rolled forward into March the way `new Date`
// would — a wrong-but-plausible date is worse than an empty one.
export function fromDmy(text: string): string {
  const d = (text ?? "").replace(/\D/g, "");
  if (d.length !== 8) return "";
  const day = Number(d.slice(0, 2));
  const month = Number(d.slice(2, 4));
  const year = Number(d.slice(4));
  if (month < 1 || month > 12 || day < 1 || year < 1000) return "";
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return "";
  return `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
}

// Stored ISO -> "26/07/2026", for the few places that show a purely numeric
// date. Most of the UI uses formatDate ("26 Jul 2026") instead, which is already
// day-first and can't be misread whatever the reader is used to.
export function formatDateNumeric(iso: string | null | undefined): string {
  return toDmy(toDateInput(iso)) || "—";
}

// A datetime-local value ("2026-07-26T17:36") split into the two controls that
// replace it, and put back together. A missing time counts as midnight so the
// date alone is still a usable value.
export function splitLocalDateTime(value: string | null | undefined) {
  const [date = "", time = ""] = (value ?? "").split("T");
  return { date, time: time.slice(0, 5) };
}

export function joinLocalDateTime(date: string, time: string): string {
  if (!date) return "";
  return `${date}T${time || "00:00"}`;
}

// Whole days from now until the given date (negative = already past).
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

export function titleCase(s: string): string {
  return s.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-07" -> "Jul" (or "Jul '26" with year).
export function monthShort(key: string, withYear = false): string {
  const [y, m] = key.split("-");
  const name = MONTHS[Number(m) - 1] ?? key;
  return withYear ? `${name} '${y.slice(2)}` : name;
}

export function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}
