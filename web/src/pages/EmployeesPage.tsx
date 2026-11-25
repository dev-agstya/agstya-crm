import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { usersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { SearchInput, ToggleField, Pagination } from "../components/ui";
import { PeopleTable } from "../components/PeopleTable";
import { ManagerLeague } from "../components/ManagerLeague";
import type { PeriodValue } from "../components/finance/DateFilter";
import { useAuth } from "../store/auth";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "directory" | "performance";

export default function EmployeesPage() {
  const navigate = useNavigate();
  const { has } = useAuth();
  const canTargets = has("manage_targets") || has("view_targets");
  const canPerformance = has("view_employees");
  const canSeeTeams = has("view_partners");

  const [params, setParams] = useSearchParams();
  const view: View =
    params.get("view") === "performance" && canPerformance
      ? "performance"
      : "directory";
  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === "directory") next.delete("view");
    else next.set("view", v);
    setParams(next, { replace: true });
  };

  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<PeriodValue>({
    period: "current_month",
  });
  const PAGE_SIZE = 15;

  const list = useQuery({
    queryKey: ["users", "employee", q, page, showInactive],
    enabled: view === "directory",
    queryFn: async () =>
      (
        await usersApi.list({
          account_type: "employee",
          q: q || undefined,
          page,
          page_size: PAGE_SIZE,
          ...(showInactive ? { inactive: 1 } : {}),
        })
      ).data,
  });
  const rows = list.data?.items ?? [];

  return (
    <div className="space-y-3">
      <PageHeader
        eyebrow="People"
        title="Employees"
        subtitle={
          view === "performance"
            ? "Team partner books & revenue"
            : "Staff directory & access"
        }
        actions={
          <Button
            size="sm"
            className="h-8"
            onClick={() => navigate("/people/employees/new")}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add employee
          </Button>
        }
      />

      {canPerformance && (
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList className="h-8">
            <TabsTrigger value="directory" className="h-6 px-3 text-xs">
              Directory
            </TabsTrigger>
            <TabsTrigger value="performance" className="h-6 px-3 text-xs">
              Performance
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {view === "performance" ? (
        <ManagerLeague period={period} onPeriodChange={setPeriod} />
      ) : (
        <>
          <PeopleTable
            rows={rows}
            loading={list.isLoading}
            error={list.isError}
            onRetry={() => list.refetch()}
            kind="employee"
            inactive={showInactive}
            toolbar={
              <>
                <SearchInput
                  placeholder="Search name, email or code..."
                  value={q}
                  onChange={(v) => {
                    setPage(1);
                    setQ(v);
                  }}
                  className="max-w-xs flex-1"
                />
                <ToggleField
                  checked={showInactive}
                  label="Show deactivated"
                  onChange={(v) => {
                    setPage(1);
                    setShowInactive(v);
                  }}
                />
              </>
            }
            onView={(u) => navigate(`/people/employees/${u.id}`)}
            onTeam={
              canSeeTeams
                ? (u) => navigate(`/people/employees/${u.id}?tab=team`)
                : undefined
            }
            onTargets={
              canTargets
                ? (u) => navigate(`/people/employees/${u.id}/targets`)
                : undefined
            }
            onAnalytics={(u) =>
              navigate(`/people/employees/${u.id}/performance`)
            }
          />
          {list.data && list.data.total > PAGE_SIZE && (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={list.data.total}
              onChange={setPage}
            />
          )}
        </>
      )}
    </div>
  );
}
