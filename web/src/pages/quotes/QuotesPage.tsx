import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { quotesApi } from "../../api/endpoints";
import { ExportButton } from "../../components/ExportButton";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import {
  EmptyState, ErrorState, Ledger, LedgerCell, LedgerRow, ListShell, LTh,
  MobileCard, Pagination, PersonCell, SearchInput, Segmented, TableSkeleton,
} from "../../components/ui";
import { formatDate } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { QuoteStageBadge } from "../portal/shared";

/*
  The staff queue for channel-partner quote requests.

  Assigned AND a shared pool: every request has a name on it so it is somebody's
  job, and everyone can see the lot so it is never stuck behind one person's
  leave.

  THE AGE IS THE POINT OF THE PAGE. A queue with no clock is a pile. That was
  true of the first version too — and the age was rendered as a three-character
  grey cell in the middle of the row, so the urgent and the calm looked
  identical until you squinted at column five. Now an unanswered request past
  24h carries a coloured rail down its leading edge and a badge that says how
  long in words. Nobody has to look for it.

  The filters were two on/off Toggles, which is wrong twice over: a switch means
  "change a setting", and two switches offer four states where the user wanted
  one of three. They are a segmented control with counts now — the counts being
  the part that tells you what you are about to hide.
*/

const AMBER_HOURS = 24;
const RED_HOURS = 48;

type Scope = "open" | "mine" | "all";

function ageLabel(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * How loud the clock is.
 *
 * Answering stops the AGEING clock — but a quotation that has since expired
 * restarts it, and that case was invisible: the request had been answered, so
 * it read "calm" for ever while the partner's own screen was telling them the
 * price was dead and to ask for a new one. Nobody on this side could see which
 * rows those were.
 */
function urgency(hours: number, answered: boolean,
                 expired = false): "calm" | "warn" | "late" {
  if (expired) return "warn";
  if (answered) return "calm";
  if (hours >= RED_HOURS) return "late";
  if (hours >= AMBER_HOURS) return "warn";
  return "calm";
}

export default function QuotesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("open");

  const list = useQuery({
    queryKey: ["quotes", page, q, scope],
    queryFn: async () => (await quotesApi.list({
      page, page_size: 20, q: q || undefined,
      mine: scope === "mine" || undefined,
      open_only: scope !== "all",
    })).data,
  });
  const rows = list.data?.items ?? [];
  const waiting = rows.filter((r) => !r.answered).length;
  const late = rows.filter(
    (r) => urgency(r.age_hours, r.answered) === "late").length;
  const expired = rows.filter((r) => r.expired).length;

  // ONE badge, showing the loudest thing true right now. Ordered by how much it
  // costs to ignore: unanswered past 48h, then unanswered at all, then a
  // quotation that has run out (nobody is waiting on us, but the case is stuck).
  const ageBadge = late > 0 ? (
    <span className="badge bg-money-out/10 px-2.5 py-1 text-money-out">
      <Icon.Alert size={13} />
      {late} over {RED_HOURS}h with no reply
    </span>
  ) : waiting > 0 ? (
    <span className="badge bg-due/10 px-2.5 py-1 text-due">
      <Icon.Clock size={13} /> {waiting} not yet answered
    </span>
  ) : expired > 0 ? (
    <span className="badge bg-due/10 px-2.5 py-1 text-due">
      <Icon.Clock size={13} /> {expired} quotation
      {expired === 1 ? "" : "s"} expired
    </span>
  ) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Work"
        title="Quote Requests"
        subtitle="Cases your channel partners have asked you to price."
        actions={<div className="flex items-center gap-2">
          {/* Every other list in the app exports and this one did not, which
              made "what did we quote last month, and what came of it" a manual
              count off the screen. It carries the SAME filters the queue has
              on, so the download can never disagree with the page. */}
          <ExportButton filename="quote-requests"
            onExport={(fmt) => quotesApi.export({
              q: q || undefined,
              mine: scope === "mine" || undefined,
              open_only: scope !== "all",
              fmt })} />
          {ageBadge}
        </div>} />

      <div>
        <div className="ledger-bar">
          <Segmented<Scope>
            value={scope}
            onChange={(v) => { setScope(v); setPage(1); }}
            options={[
              { value: "open", label: "Open" },
              { value: "mine", label: "Assigned to me" },
              { value: "all", label: "All" },
            ]} />
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }}
            placeholder="Customer, partner, code…"
            className="max-w-xs flex-1" />
        </div>
        {list.isError ? <ErrorState onRetry={() => list.refetch()} /> : list.isLoading ? (
          <TableSkeleton cols={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Icon.Lead size={20} />}
            title={scope === "open" ? "Nothing waiting" : "Nothing here"}
            hint={scope === "open"
              ? "When a channel partner asks for a quotation it lands here."
              : "No quote requests match this filter."} />
        ) : (
          <>
            <ListShell
              bare
              cards={rows.map((r) => {
                const tone = urgency(r.age_hours, r.answered, r.expired);
                return (
                  <MobileCard key={r.id} to={`/quotes/${r.id}`}
                    rail={tone === "late" ? "out"
                      : tone === "warn" ? "due" : undefined}
                    title={r.customer_name}
                    meta={<>{r.code} · {r.category_label}</>}
                    right={<QuoteStageBadge stage={r.stage} />}
                    footer={
                      <>
                        {r.answered ? "Answered" : ageLabel(r.age_hours)}
                        {r.partner_name ? ` · ${r.partner_name}` : ""}
                      </>
                    }
                  />
                );
              })}
              table={
                <Ledger
                  head={
                    <>
                      <LTh>Customer</LTh>
                      <LTh>Partner</LTh>
                      <LTh>Type</LTh>
                      <LTh>Waiting</LTh>
                      <LTh>Assigned</LTh>
                      <LTh>Stage</LTh>
                    </>
                  }
                >
                  {rows.map((r) => {
                    const tone = urgency(r.age_hours, r.answered, r.expired);
                    const rail = tone === "late" ? "out" as const
                      : tone === "warn" ? "due" as const : undefined;
                    return (
                      <LedgerRow key={r.id}
                        onClick={() => navigate(`/quotes/${r.id}`)}>
                        {/* The rail is the whole urgency signal: it needs no
                            column, cannot be sorted away, and reads before any
                            text on the row does. */}
                        <LedgerCell
                          rail={rail}
                          to={`/quotes/${r.id}`}
                          title={r.customer_name}
                          sub={`${r.code} · ${r.customer_mobile}`}
                        />

                        <td>
                          {r.partner_name
                            ? <PersonCell name={r.partner_name} size="xs" />
                            : <span className="text-slate-500">—</span>}
                        </td>

                        <td className="text-[13px]">
                          <span className="text-slate-700">
                            {r.category_label}</span>
                          {r.is_renewal && (
                            <span className="ml-2 chip">renewal</span>
                          )}
                        </td>

                        {/* Said in words, sized by urgency. "18h" in grey and
                            "3d" in grey are the same shape; these are not. */}
                        <td className="whitespace-nowrap">
                          {r.expired ? (
                            <span className="badge-due">
                              <Icon.Clock size={12} /> expired
                            </span>
                          ) : r.answered ? (
                            <span className="text-sm text-slate-500">
                              Answered
                            </span>
                          ) : (
                            <span className={tone === "late" ? "badge-out"
                              : tone === "warn" ? "badge-due"
                                : "badge-neutral"}>
                              {tone !== "calm" && <Icon.Clock size={12} />}
                              {ageLabel(r.age_hours)}
                            </span>
                          )}
                          <p className="mt-0.5 text-xs text-slate-500">
                            {formatDate(r.created_at)}</p>
                        </td>

                        <td>
                          {r.assigned_to_id === user?.id ? (
                            <span className="badge-ink">you</span>
                          ) : r.assigned_to_name ? (
                            <PersonCell name={r.assigned_to_name} size="xs" />
                          ) : (
                            <span className="text-slate-500">Unassigned</span>
                          )}
                        </td>

                        <td><QuoteStageBadge stage={r.stage} /></td>
                      </LedgerRow>
                    );
                  })}
                </Ledger>
              }
            />
            <Pagination page={page} pageSize={20}
              total={list.data?.total ?? 0} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
