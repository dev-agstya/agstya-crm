import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { searchApi } from "../api/endpoints";
import { Icon } from "./Icon";
import { useAuth } from "../store/auth";
import { searchDestinations, type DestKind } from "../lib/searchIndex";
import type { SearchHit } from "../lib/types";

const TYPE_ICON: Record<SearchHit["type"], keyof typeof Icon> = {
  customer: "Customers", policy: "Policy", lead: "Lead", person: "Users",
  log: "Audit",
};
const TYPE_LABEL: Record<SearchHit["type"], string> = {
  customer: "Customer", policy: "Policy", lead: "Lead", person: "Person",
  log: "Log",
};
const DEST_ICON: Record<DestKind, keyof typeof Icon> = {
  page: "Dashboard", setting: "Settings", feature: "Bolt",
};
const DEST_LABEL: Record<DestKind, string> = {
  page: "Page", setting: "Setting", feature: "Feature",
};

// Shared search results: client-side destinations (pages/settings/features,
// scoped) + server-side records (customers/policies/leads/people/logs).
//
// Rendered by the top bar's anchored dropdown (layout/TopBarSearch). Every
// result carries `data-result` so the field's arrow-key handler can walk the
// real DOM rather than keeping a parallel index of what it believes is on
// screen — the two cannot drift if there is only one list.
export function SearchResults({ query, onNavigate }: {
  query: string;
  onNavigate: (link: string) => void;
}) {
  const { user, has } = useAuth();
  const q = query.trim();

  const destinations = useMemo(
    () => searchDestinations(q, user?.account_type, has),
    [q, user?.account_type, has]);

  const results = useQuery({
    queryKey: ["search", q],
    queryFn: async () => (await searchApi.query(q)).data,
    enabled: q.length >= 2,
  });
  const hits = results.data?.hits ?? [];

  if (q.length < 2) {
    return (
      <p className="px-3 py-6 text-center text-sm text-slate-500">
        Type at least 2 characters to search pages, customers, policies, leads
        and logs.</p>
    );
  }

  const empty = destinations.length === 0 && !results.isLoading
    && hits.length === 0;

  return (
    <div className="space-y-1">
      {destinations.length > 0 && (
        <>
          <p className="px-3 pt-2 text-[10px] font-semibold uppercase
            tracking-wider text-slate-500">Go to</p>
          {destinations.map((d) => {
            const Ico = Icon[DEST_ICON[d.kind]];
            return (
              <button key={`${d.kind}-${d.to}-${d.label}`}
                data-result role="option"
                onClick={() => onNavigate(d.to)}
                className="flex w-full items-center gap-3 rounded-control px-3 py-2.5
                  text-left hover:bg-slate-50">
                <span className="rounded-md bg-slate-100 p-1.5 text-slate-500"><Ico size={16} /></span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium
                  text-slate-800">{d.label}</span>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5
                  text-[10px] font-medium uppercase tracking-wide text-slate-500">{DEST_LABEL[d.kind]}</span>
              </button>
            );
          })}
        </>
      )}

      {(results.isLoading || hits.length > 0) && (
        <p className="px-3 pt-2 text-[10px] font-semibold uppercase
          tracking-wider text-slate-500">Records</p>
      )}
      {/* An inline line, not the full `ErrorState` — this is a dropdown panel
          a few hundred pixels tall, and a centred icon with py-16 around it
          would push the results it is replacing off the bottom of the screen.
          Same job, sized for where it lives. */}
      {results.isError ? (
        <p className="px-3 py-4 text-center text-sm text-money-out">
          Couldn't search just now.{" "}
          <button className="link" onClick={() => results.refetch()}>
            Try again
          </button>
        </p>
      ) : results.isLoading ? (
        <p className="px-3 py-4 text-center text-sm text-slate-500">Searching…</p>
      ) : (
        hits.map((h) => {
          /*
            A LOCKED HIT is a policy that exists and that this person may not
            open (2026-08-24). The server sends only the code, the number and
            who holds it, and points `link` at the request flow rather than at
            the record — so activating one lands on the Policies page with the
            "ask for access" form already open.

            It is drawn as a RESULT, quietly marked, rather than in a section of
            its own: the whole point is that somebody searching a policy number
            finds out it exists, in the place they were already looking.
          */
          const Ico = h.locked ? Icon.Lock : Icon[TYPE_ICON[h.type]];
          return (
            <button key={`${h.type}-${h.id}`} data-result role="option"
              onClick={() => onNavigate(h.link)}
              className="flex w-full items-center gap-3 rounded-control px-3 py-2.5
                text-left hover:bg-slate-50">
              <span className={`rounded-md p-1.5 ${h.locked
                ? "bg-due/10 text-due" : "bg-slate-100 text-slate-500"}`}>
                <Ico size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-800">{h.label}</span>
                <span className="block truncate text-xs text-slate-500">
                  {h.sub}</span>
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5
                text-[10px] font-medium uppercase tracking-wide ${h.locked
                  ? "bg-due/10 text-due" : "bg-slate-100 text-slate-500"}`}>
                {h.locked ? "Ask for it" : TYPE_LABEL[h.type]}</span>
            </button>
          );
        })
      )}

      {empty && (
        <p className="px-3 py-6 text-center text-sm text-slate-500">
          No matches for “{q}”.</p>
      )}
    </div>
  );
}
