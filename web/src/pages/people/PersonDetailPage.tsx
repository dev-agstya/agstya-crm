import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { rolesApi, usersApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { PersonDetailBody } from "../../components/PersonDetailBody";
import { StatusBadge } from "../../components/ui";
import { useAuth } from "../../store/auth";
import { Badge } from "@/components/ui/badge";

export default function PersonDetailPage({
  kind,
}: {
  kind: "employee" | "channel_partner";
}) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { has } = useAuth();
  const isEmp = kind === "employee";
  const backTo = isEmp ? "/people/employees" : "/people/partners";

  const person = useQuery({
    queryKey: ["user", id],
    retry: false,
    queryFn: async () => (await usersApi.get(id)).data,
  });
  const u = person.data;

  const managers = useQuery({
    queryKey: ["assignable-managers"],
    enabled: has("view_employees"),
    queryFn: async () => (await usersApi.assignableManagers()).data,
  });
  const roles = useQuery({
    queryKey: ["roles"],
    enabled: isEmp && has("manage_roles_permissions"),
    queryFn: async () => (await rolesApi.list()).data,
  });

  const missing =
    isAxiosError(person.error) && person.error.response?.status === 404;

  return (
    <RecordPage
      backTo={backTo}
      backLabel={isEmp ? "Back to employees" : "Back to channel partners"}
      title={u?.full_name ?? (isEmp ? "Employee" : "Channel partner")}
      meta={
        u && (
          <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[11px]">
            {u.code}
          </Badge>
        )
      }
      badges={
        u && (
          <>
            <StatusBadge value={u.status} />
            {u.relationship_manager_name && (
              <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
                RM · {u.relationship_manager_name}
              </Badge>
            )}
          </>
        )
      }
      loading={person.isLoading}
      error={missing ? undefined : person.error}
      onRetry={() => person.refetch()}
      notFound={missing}
    >
      {u && (
        <PersonDetailBody
          user={u}
          kind={kind}
          managers={managers.data ?? []}
          roles={roles.data ?? []}
          onClose={() => {
            qc.invalidateQueries({ queryKey: ["users"] });
            navigate(backTo);
          }}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ["users"] });
            qc.invalidateQueries({ queryKey: ["user", id] });
          }}
        />
      )}
    </RecordPage>
  );
}
