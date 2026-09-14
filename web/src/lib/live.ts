// Live-data helpers — one place to tune how "realtime" the finance surfaces feel.
import type { QueryClient } from "@tanstack/react-query";

// How often live pages (Dashboard, Finance Overview, Reports, Balance Sheet)
// silently re-check the server for changes made by OTHER users/devices.
// Polling automatically PAUSES while the browser tab is hidden (TanStack Query
// default: refetchIntervalInBackground = false), so idle tabs cost nothing —
// this keeps it friendly to the MongoDB Atlas free tier even with several users.
// 15s is a deliberate balance: with N users each open on a finance page it is
// one refresh per user per 15s, a third less load than 10s for no real UX loss.
// Change this single value to speed up / slow down every live page at once.
export const LIVE_REFRESH_MS = 15_000;

// Spread onto a useQuery() to make it live: poll on the interval above and
// refetch the instant the user returns to the tab. Everything else (the actual
// invalidation on your OWN edits) is handled by refreshFinance() below.
export const liveQueryOptions = {
  refetchInterval: LIVE_REFRESH_MS,
  refetchOnWindowFocus: true,
} as const;

// Call after ANY money-affecting action (new/edited/deleted policy, payment,
// payout, renewal, broker rate/TDS, target, customer/partner change) so every
// finance surface updates immediately. refetchType: "all" also refetches pages
// that are NOT currently mounted, so they are already fresh the moment you open
// them — no 2-3s catch-up, no manual refresh.
export function refreshFinance(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["finance"], refetchType: "all" }),
    qc.invalidateQueries({ queryKey: ["dashboard"], refetchType: "all" }),
    qc.invalidateQueries({ queryKey: ["wallet"], refetchType: "all" }),
  ]);
}
