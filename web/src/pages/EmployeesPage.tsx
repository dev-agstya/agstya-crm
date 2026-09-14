import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { usersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Icon } from "../components/Icon";
import {
  Pagination, Segmented, SearchInput, ToggleField,
} from "../components/ui";
import { PeopleTable } from "../components/PeopleTable";
import { ManagerLeague } from "../components/ManagerLeague";
import type { PeriodValue } from "../components/finance/DateFilter";
import { useAuth } from "../store/auth";

/*
  Employees — the directory, and how each of their books is performing.

  TWO VIEWS, ONE PAGE (owner 2026-08-05). "Relationship Managers" used to be a
  separate nav entry with its own league table; the owner's verdict was that it
  "doesn't need to be a separate page". It is the Performance view here, and one
  employee's own partners are a tab on their record — so the same information
  lives next to the people it describes instead of in a screen of its own.
*/

type View = "directory" | "performance";

export default function EmployeesPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const canTargets = has("manage_targets") || has("view_targets");
  // Reading whose numbers is a management right; reading the directory is not.
  const canPerformance = has("view_employees");
  // Reading somebody ELSE's roster needs view_partners — the same rule
  // PersonDetailBody applies to whether the Team tab is drawn at all. Without
  // this check the directory would offer a "3 partners" button that opens the
  // record on the Profile tab with no Team tab in sight, which is worse than
  // not offering it: it looks broken rather than closed.
  const canSeeTeams = has("view_partners");

  // The view lives in the URL so a link to the league table is shareable and
  // Back does what it looks like it does.
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "performance" && canPerformance
    ? "performance" : "directory";
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
  const [period, setPeriod] = useState<PeriodValue>({
    period: "current_month" });
  const PAGE_SIZE = 15;

  const list = useQuery({
    queryKey: ["users", "employee", q, page, showInactive],
    enabled: view === "directory",
    queryFn: async () =>
      (await usersApi.list({ account_type: "employee",
        q: q || undefined, page, page_size: PAGE_SIZE,
        ...(showInactive ? { inactive: 1 } : {}) })).data,
  });
  const rows = list.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle={view === "performance"
          ? "Each employee's channel partners and what that book brought in."
          : "Everyone on the team, and what they can reach."}
        actions={
          <button className="btn-primary"
            onClick={() => navigate("/people/employees/new")}>
            <Icon.Plus size={16} /> Add employee
          </button>
        } />

      {canPerformance && (
        <div className="mb-4">
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: "directory", label: "Directory" },
              { value: "performance", label: "Performance" },
            ]} />
        </div>
      )}

      {view === "performance" ? (
        <ManagerLeague period={period} onPeriodChange={setPeriod} />
      ) : (
        <>
          <PeopleTable rows={rows} loading={list.isLoading} error={list.isError} onRetry={() => list.refetch()} kind="employee"
            inactive={showInactive}
            toolbar={
              <>
                <SearchInput placeholder="Search name, email or code…"
                  value={q} onChange={(v) => { setPage(1); setQ(v); }}
                  className="max-w-sm flex-1" />
                <ToggleField checked={showInactive} label="Show deactivated"
                  onChange={(v) => { setPage(1); setShowInactive(v); }} />
              </>
            }
            onView={(u) => navigate(`/people/employees/${u.id}`)}
            // Straight into the Team tab, which is deep-linkable. The tab has
            // been there since 2026-08-05 and was never signposted — see the
            // note on PeopleTable's `onTeam`.
            onTeam={canSeeTeams
              ? (u) => navigate(`/people/employees/${u.id}?tab=team`)
              : undefined}
            onTargets={canTargets
              ? (u) => navigate(`/people/employees/${u.id}/targets`) : undefined}
            onAnalytics={(u) =>
              navigate(`/people/employees/${u.id}/performance`)} />
          {list.data && list.data.total > PAGE_SIZE && (
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total}
              onChange={setPage} />
          )}
        </>
      )}
    </div>
  );
}
