import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { usersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  Pagination, SearchInput, Segmented, ToggleField,
} from "../components/ui";
import { PeopleTable } from "../components/PeopleTable";
import { ManagerRosterPanel } from "../components/ManagerRosterPanel";
import { useAuth } from "../store/auth";

/*
  Channel Partners — everyone's, or just yours.

  TWO VIEWS, ONE PAGE, the same arrangement as Employees.

    Directory — the accounts. Search, deactivated, add, open a record.
    My Team   — your own target and the partners under you against the
                numbers you gave them (components/ManagerRosterPanel).

  Owner G1 (2026-08-06): "the employee can only see the channel partners that
  are under him on that page". The page was behind `view_team`, which was the
  STAFF DIRECTORY right — so an ordinary employee could not open the page their
  own partners live on, and had to use a second page ("My Partners") that showed
  the same people from a different angle.

  Now the SERVER decides what the Directory contains: with `view_partners` every
  partner, without it the ones whose relationship manager you are, filtered in
  the query (routers/users.list_users). Typing a URL cannot widen it, and
  nothing on this page has to be trusted.

  This is not a return of record-level scoping, which was deleted on purpose.
  Every in-house user can still open every customer, policy and lead. What is
  scoped is a ROSTER, because that is what a roster is.

  The "Portal settings" button is gone (owner, 2026-08-06). The portal master
  switch, the six capability flags and the quote validity moved to Settings,
  where an owner-level switch belongs, rather than sitting above a list of
  people it says nothing about.
*/

type View = "directory" | "team";

export default function ChannelPartnersPage() {
  const navigate = useNavigate();
  const { has, user } = useAuth();
  // Adding a partner is still a manage_partners action (owner G3): an employee sees
  // and works their own roster, but the agency decides who joins it.
  const canAdd = has("manage_partners");
  const canTargets = has("manage_targets") || has("view_targets")
    // A relationship manager sets their own partners' targets (owner F1), so
    // the shortcut to that screen is theirs whether or not they hold the flag.
    || user?.account_type === "employee";
  // Whether this person is seeing everyone or only their own roster. It changes
  // the subtitle, because a list that silently hides most of its rows is worse
  // than one that says what it is showing.
  const everyone = has("view_partners");
  // The owner can be a relationship manager too, so they get the team view as
  // well — it simply shows their own roster, which is often empty.
  const canTeam = user?.account_type !== "channel_partner";

  // The view lives in the URL so a link to the team is shareable and Back does
  // what it looks like it does.
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "team" && canTeam
    ? "team" : "directory";
  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === "directory") next.delete("view"); else next.set("view", v);
    setParams(next, { replace: true });
  };

  const [q, setQ] = useState("");
  // Two states, never overlapping: working accounts by default, everyone
  // switched off (deactivated or removed) behind the toggle.
  const [showInactive, setShowInactive] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 15;

  const list = useQuery({
    queryKey: ["users", "channel_partner", q, page, showInactive],
    enabled: view === "directory",
    queryFn: async () =>
      (await usersApi.list({ account_type: "channel_partner",
        q: q || undefined, page, page_size: PAGE_SIZE,
        ...(showInactive ? { inactive: 1 } : {}) })).data,
  });
  const rows = list.data?.items ?? [];

  return (
    <div>
      <PageHeader title="Channel Partners"
        subtitle={view === "team"
          ? "Your target, and how the partners under you are tracking against "
            + "theirs."
          : everyone
            ? "Add or manage Channel Partners"
            : "The channel partners you are the relationship manager for"}
        actions={canAdd && (
          <button className="btn-primary"
            onClick={() => navigate("/people/partners/new")}>
            <Icon.Plus size={18} /> Add Channel Partner
          </button>
        )} />

      {canTeam && (
        <div className="mb-4">
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: "directory", label: "Directory" },
              { value: "team", label: "My Team" },
            ]} />
        </div>
      )}

      {view === "team" ? (
        // No managerId — the panel asks for "me". The SAME component the owner
        // sees on an employee's Team tab, so the two views of one roster cannot
        // disagree (owner G6).
        <ManagerRosterPanel />
      ) : (
        <>
          <PeopleTable rows={rows} loading={list.isLoading} error={list.isError} onRetry={() => list.refetch()}
            kind="channel_partner" inactive={showInactive}
            toolbar={
              <>
                <SearchInput placeholder="Search name, email or code…"
                  value={q} onChange={(v) => { setPage(1); setQ(v); }}
                  className="max-w-sm flex-1" />
                <ToggleField checked={showInactive} label="Show deactivated"
                  onChange={(v) => { setPage(1); setShowInactive(v); }} />
              </>
            }
            onView={(u) => navigate(`/people/partners/${u.id}`)}
            onTargets={canTargets
              ? (u) => navigate(`/people/partners/${u.id}/targets`) : undefined}
            onAnalytics={(u) =>
              navigate(`/people/partners/${u.id}/performance`)} />
          {list.data && list.data.total > PAGE_SIZE && (
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total}
              onChange={setPage} />
          )}
        </>
      )}
    </div>
  );
}
