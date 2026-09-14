import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { usersApi } from "../../api/endpoints";
import { RecordPage } from "../../components/RecordPage";
import { AnalyticsBody } from "../../components/AnalyticsBody";

/** Six months of target performance for one person, as a page. */
export default function PersonPerformancePage({ kind }: {
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
      title="Performance"
      documentTitle={u ? `Performance — ${u.full_name}` : "Performance"}
      loading={person.isLoading}
      error={missing ? undefined : person.error}
      onRetry={() => person.refetch()}
      notFound={missing}
    >
      {u && (
        <div className="card card-body">
          <AnalyticsBody assigneeId={u.id} />
        </div>
      )}
    </RecordPage>
  );
}
