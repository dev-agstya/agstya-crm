import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { usersApi } from "../api/endpoints";
import { PageHeader } from "../components/PageHeader";
import { Pagination, SearchInput, ToggleField } from "../components/ui";
import { PeopleTable } from "../components/PeopleTable";
import { ManagerRosterPanel } from "../components/ManagerRosterPanel";
import { useAuth } from "../store/auth";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "directory" | "team";

export default function ChannelPartnersPage() {
  const navigate = useNavigate();
  const { has, user } = useAuth();
  const canAdd = has("manage_partners");
  const canTargets =
    has("manage_targets") ||
    has("view_targets") ||
    user?.account_type === "employee";
  const everyone = has("view_partners");
  const canTeam = user?.account_type !== "channel_partner";

  const [params, setParams] = useSearchParams();
  const view: View =
    params.get("view") === "team" && canTeam ? "team" : "directory";
  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === "directory") next.delete("view");
    else next.set("view", v);
    setParams(next, { replace: true });
  };

  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 15;

  const list = useQuery({
    queryKey: ["users", "channel_partner", q, page, showInactive],
    enabled: view === "directory",
    queryFn: async () =>
      (
        await usersApi.list({
          account_type: "channel_partner",
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
        title="Channel Partners"
        subtitle={
          view === "team"
            ? "Your roster & target attainment"
            : everyone
              ? "All agency channel partners"
              : "Partners you manage"
        }
        actions={
          canAdd && (
            <Button
              size="sm"
              className="h-8"
              onClick={() => navigate("/people/partners/new")}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add partner
            </Button>
          )
        }
      />

      {canTeam && (
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList className="h-8">
            <TabsTrigger value="directory" className="h-6 px-3 text-xs">
              Directory
            </TabsTrigger>
            <TabsTrigger value="team" className="h-6 px-3 text-xs">
              My Team
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {view === "team" ? (
        <ManagerRosterPanel />
      ) : (
        <>
          <PeopleTable
            rows={rows}
            loading={list.isLoading}
            error={list.isError}
            onRetry={() => list.refetch()}
            kind="channel_partner"
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
            onView={(u) => navigate(`/people/partners/${u.id}`)}
            onTargets={
              canTargets
                ? (u) => navigate(`/people/partners/${u.id}/targets`)
                : undefined
            }
            onAnalytics={(u) =>
              navigate(`/people/partners/${u.id}/performance`)
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
