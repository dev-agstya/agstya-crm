import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { usersApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { TargetsBody } from "../../components/TargetsBody";

/**
 * One person's targets, as a page (this was a dialog until 2026-08-03).
 *
 * Back goes to the PERSON, not to the list — you arrived here from their
 * record, and their record is what you want when you are done.
 */
export default function PersonTargetsPage({ kind }: {
  kind: "employee" | "channel_partner";
}) {
  const { id = "" } = useParams();
  const base = kind === "employee" ? "/people/employees" : "/people/partners";

  const person = useQuery({
    queryKey: ["user", id],
    retry: false,
    queryFn: async () => (await usersApi.get(id)).data,
  });
  const u = person.data;
  const missing = isAxiosError(person.error)
    && person.error.response?.status === 404;

  return (
    <RecordPage
      backTo={`${base}/${id}`}
      backLabel={u ? `Back to ${u.full_name}` : "Back"}
      title="Targets"
      documentTitle={u ? `Targets — ${u.full_name}` : "Targets"}
      subtitle={u ? `Goals and attainment for ${u.full_name}.` : undefined}
      loading={person.isLoading}
      error={missing ? undefined : person.error}
      onRetry={() => person.refetch()}
      notFound={missing}
    >
      {u && <div className="card card-body"><TargetsBody user={u} /></div>}
    </RecordPage>
  );
}
