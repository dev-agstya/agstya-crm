import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { rolesApi, usersApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { PersonDetailBody } from "../../components/PersonDetailBody";
import { StatusBadge } from "../../components/ui";
import { useAuth } from "../../store/auth";

/**
 * One employee or channel partner, as a page (this was a dialog until
 * 2026-08-03).
 *
 * `kind` comes from the ROUTE rather than the record, so /people/employees/:id
 * and /people/partners/:id each land on the list they came from — the two lists
 * are separate screens and Back has to respect that.
 */
export default function PersonDetailPage({ kind }: {
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
  // Only employees carry a permission set, so partners never need the roles.
  const roles = useQuery({
    queryKey: ["roles"],
    enabled: isEmp && has("manage_roles_permissions"),
    queryFn: async () => (await rolesApi.list()).data,
  });

  const missing = isAxiosError(person.error)
    && person.error.response?.status === 404;

  return (
    <RecordPage
      backTo={backTo}
      backLabel={isEmp ? "Back to employees" : "Back to channel partners"}
      title={u?.full_name ?? (isEmp ? "Employee" : "Channel partner")}
      meta={u && <span className="chip">{u.code}</span>}
      badges={u && (
        <>
          <StatusBadge value={u.status} />
          {u.relationship_manager_name && (
            <span className="chip">RM · {u.relationship_manager_name}</span>
          )}
        </>
      )}
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
          // The record is gone (deleted / removed) — there is nothing left to
          // show, so leave rather than sitting on a dead page.
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
