import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { policiesApi, policyAccessApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { Icon } from "../Icon";
import {
  EmptyState, ErrorState, Field, Modal, Pagination, Spinner,
} from "../ui";
import { toast } from "../Toast";
import { confirmDialog } from "../Confirm";
import { formatDateTime } from "../../lib/format";
import { useAuth } from "../../store/auth";
import type { PolicyAccessRequest, RestrictedPolicy } from "../../lib/types";

/*
  "IT EXISTS, AND IT IS NOT YOURS."

  From 2026-08-24 an employee reads their own book — what they booked, plus what
  the channel partners on their roster booked. The owner asked for the other
  half in the same breath:

    "If I search for a policy number which is 102 and I am one employee A, and
     other employee B has this 101 policy, so I will be shown that this policy
     exists, but I do not have the permission to view this... there should be
     one request like button. So when I click on that request access, it should
     send one request to the owner, or the one who has this role of JIT
     approval, like a manager. Then he can approve my request so that I can view
     this policy for like 12 hours."

  A SCOPED SYSTEM WITH NO WAY TO DISCOVER WHAT YOU ARE MISSING is one where
  people ring each other up, and the ringing-up is what this replaces. So this
  is the one surface in the app that confirms a record exists to somebody who
  cannot open it — and the leak is bounded by the server to exactly three
  things: the code, the policy number, and who holds it.

  THE HOLDER'S NAME IS SHOWN ON PURPOSE. The fastest resolution to "I need this
  policy" is usually a two-minute conversation with the person whose desk it is
  on, and a request queue that hides who to talk to makes that harder rather
  than easier. The button is there for when the conversation is not possible.
*/

/* ---------------------------------------------------------------- the note -- */

/**
 * One line under the Policies heading saying what this list is.
 *
 * A scoped list that does not SAY it is scoped reads as a list with rows
 * missing, and the first assumption anybody makes is that the software lost
 * them. The sentence comes from the SERVER (`GET /api/policies/scope`) so the
 * page cannot claim a scope different from the one the query applied.
 */
export function PolicyScopeNote() {
  const scope = useQuery({
    queryKey: ["policies", "scope"],
    queryFn: async () => (await policiesApi.scope()).data,
    staleTime: 5 * 60_000,
  });
  // Nothing to say to somebody who sees everything, and a banner reading "you
  // can see everything" on every visit is noise.
  if (!scope.data?.scoped) return null;
  return (
    <p className="mb-3 flex items-start gap-2 text-xs text-slate-500">
      <Icon.Shield size={13} className="mt-px shrink-0 text-slate-400" />
      <span>
        {scope.data.label}{" "}
        Searching a policy number that is not on this list will still find it,
        so you can ask for access.
      </span>
    </p>
  );
}

/* --------------------------------------------------- what you cannot see -- */

/**
 * Policies matching the search that this person may not read.
 *
 * Rendered UNDER the results rather than mixed into them, and visually quieter,
 * because these are not results — they are an answer to a different question
 * ("is it not there, or is it not mine?").
 *
 * `q` is the DEBOUNCED search term. Nothing runs until somebody has actually
 * typed something: this endpoint exists to answer a specific question and
 * should not be firing on an empty list.
 */
export function RestrictedMatches({ q, focusPolicyId }: {
  q: string;
  /** From `?request=<id>`, so the top-bar search can link straight into the
   *  request form for one policy. */
  focusPolicyId?: string;
}) {
  const [asking, setAsking] = useState<RestrictedPolicy | null>(null);
  // Which policy the deep link has ALREADY been honoured for.
  //
  // Without this the dialog cannot be closed: `?request=<id>` stays in the URL,
  // so the moment `asking` goes back to null the auto-open fires again and the
  // form reopens on top of the person trying to dismiss it. Recording that the
  // link has been acted on — rather than clearing the URL — keeps the address
  // shareable and keeps the back button meaning what it says.
  const [autoOpened, setAutoOpened] = useState<string | null>(null);
  const term = q.trim();

  const found = useQuery({
    queryKey: ["policy-access", "search", term],
    queryFn: async () => (await policyAccessApi.search(term)).data,
    enabled: term.length >= 2,
  });

  const items = found.data?.items ?? [];
  // Open the request form straight away when somebody arrived from a search
  // hit. The alternative is landing them on a list of one and asking them to
  // click the thing they already clicked.
  const focused = focusPolicyId && focusPolicyId !== autoOpened
    ? items.find((p) => p.id === focusPolicyId) : undefined;
  if (focused) {
    // Adjusting state during render on a prop change — React's own documented
    // pattern, and it terminates because `autoOpened` is set in the same pass.
    setAutoOpened(focused.id);
    setAsking(focused);
  }

  if (found.data?.unscoped || items.length === 0) return null;

  return (
    <>
      <div className="mt-4 rounded-card border border-dashed border-line
        bg-slate-50/60 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium
          text-slate-700">
          <Icon.Lock size={14} className="text-slate-400" />
          {items.length} more {items.length === 1 ? "policy matches"
            : "policies match"} “{term}”, on somebody else's desk
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          You can see that {items.length === 1 ? "it exists" : "they exist"} and
          who handles {items.length === 1 ? "it" : "them"} — nothing else. Ask
          for access if you need to open {items.length === 1 ? "it" : "one"}.
        </p>
        <ul className="mt-2.5 divide-y divide-line-soft">
          {items.map((p) => (
            <li key={p.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="font-medium text-slate-900">
                {p.policy_number || p.code}
              </span>
              {p.policy_number && (
                <span className="chip">{p.code}</span>
              )}
              <span className="text-xs text-slate-500">
                {p.held_by ? `Handled by ${p.held_by}` : "Not on your desk"}
              </span>
              <span className="ml-auto">
                <RequestButton policy={p} onAsk={() => setAsking(p)} />
              </span>
            </li>
          ))}
        </ul>
      </div>

      {asking && (
        <RequestAccessDialog policy={asking}
          onClose={() => setAsking(null)} />
      )}
    </>
  );
}

/**
 * The button, in whichever of its four states applies.
 *
 * A request that has ALREADY been made must not offer to be made again — four
 * presses is four rows in somebody's approval queue about one policy, which is
 * how an approver learns to stop reading it. A REFUSED one is shown as refused
 * rather than reset to "Request access", or the same question gets asked three
 * times without anybody ever being told no.
 */
function RequestButton({ policy, onAsk }: {
  policy: RestrictedPolicy; onAsk: () => void;
}) {
  switch (policy.request_status) {
    case "pending":
      return (
        <span className="badge-due">
          <Icon.Clock size={11} /> Waiting for approval
        </span>
      );
    case "rejected":
      return <span className="badge-neutral">Not approved</span>;
    case "approved":
      // The grant may have lapsed since — the server decides, and the row will
      // simply stop appearing here once it is live. Linking straight in is the
      // right move for the window where it IS live.
      return (
        <Link to={`/policies/${policy.id}`} className="btn-secondary btn-sm">
          Open it <Icon.ChevronRight size={13} />
        </Link>
      );
    default:
      return (
        <button className="btn-secondary btn-sm" onClick={onAsk}>
          <Icon.Key size={13} /> Request access
        </button>
      );
  }
}

function RequestAccessDialog({ policy, onClose }: {
  policy: RestrictedPolicy; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");

  const ask = useMutation({
    mutationFn: () => policyAccessApi.request(policy.id, reason.trim()),
    onSuccess: () => {
      toast.success("Asked. You will get a notification when it is decided.");
      qc.invalidateQueries({ queryKey: ["policy-access"] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Modal open onClose={onClose}
      title={`Ask to see ${policy.policy_number || policy.code}`}
      size="sm">
      <form className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); ask.mutate(); }}>
        {policy.held_by && (
          // Offered BEFORE the form, because it is usually the better answer.
          // A feature that quietly discourages people from talking to each
          // other is not an improvement on people talking to each other.
          <p className="note-in">
            {policy.held_by} handles this policy. A quick word with them is
            often faster than waiting for an approval.
          </p>
        )}
        {/* MANDATORY. An approver deciding a queue of five needs one line each;
            a request with no reason is one they have to chase before they can
            decide, which makes the whole flow slower than walking over. */}
        <Field label="Why do you need it?" required
          hint="One line. Whoever approves this sees it and nothing else.">
          <input className="input" value={reason} required minLength={3}
            autoFocus
            placeholder="Customer rang about a claim on it"
            onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="text-xs text-slate-500">
          If it is approved you can open this one policy for 12 hours. It does
          not let you edit it, and it does not show you anything else.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary"
            disabled={ask.isPending || reason.trim().length < 3}>
            {ask.isPending ? "Asking…" : "Ask for access"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------- the queue -- */

/**
 * The access-request view on the Policies page (`?view=access-requests`).
 *
 * A VIEW, not a page — the owner's standing "no random pages for each and every
 * shit thing", and the same call Attendance and Employees already got. It shows
 * two different things depending on who is looking, from one endpoint that
 * scopes itself:
 *
 *   an approver   the queue, with Approve / Refuse
 *   everybody     their own asks, and what happened to them
 */
const PAGE_SIZE = 25;

export function PolicyAccessQueue() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const canApprove = has("manage_policy_access");
  const [tab, setTab] = useState<"queue" | "mine">(
    canApprove ? "queue" : "mine");
  const [page, setPage] = useState(1);

  // Paginated (owner 2026-09-12) — a queue running for months easily passes 25
  // rows, so the server slices it rather than handing the browser everything.
  const rows = useQuery({
    queryKey: ["policy-access", "list", tab, page],
    queryFn: async () => (await policyAccessApi.list({
      mine: tab === "mine", status: "all", page, page_size: PAGE_SIZE,
    })).data,
  });

  // The "to decide" badge counts EVERY pending request, not just the ones on
  // the current page — a separate, cheap query (page_size 1) that reads only
  // the total the server already counted.
  const pendingTotal = useQuery({
    queryKey: ["policy-access", "pending-total"],
    queryFn: async () => (await policyAccessApi.list({
      mine: false, status: "pending", page: 1, page_size: 1,
    })).data.total,
    enabled: canApprove,
  });

  const changeTab = (v: "queue" | "mine") => { setTab(v); setPage(1); };

  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; hours: number }) =>
      policyAccessApi.decide(v.id, v.approve, v.hours),
    onSuccess: (_r, v) => {
      toast.success(v.approve
        ? `Approved for ${v.hours} hours.` : "Refused.");
      qc.invalidateQueries({ queryKey: ["policy-access"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => policyAccessApi.revoke(id),
    onSuccess: () => {
      toast.success("Access closed.");
      qc.invalidateQueries({ queryKey: ["policy-access"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => policyAccessApi.cancel(id),
    onSuccess: () => {
      toast.success("Withdrawn.");
      qc.invalidateQueries({ queryKey: ["policy-access"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const items = rows.data?.items ?? [];
  const total = rows.data?.total ?? 0;

  return (
    <div className="space-y-4">
      {canApprove && (
        <div className="flex flex-wrap gap-2">
          <button className={`chip ${tab === "queue"
            ? "ring-1 ring-ink text-slate-900" : ""}`}
            onClick={() => changeTab("queue")}>
            To decide
            {(pendingTotal.data ?? 0) > 0 && (
              <span className="ml-1.5 text-slate-500">{pendingTotal.data}</span>
            )}
          </button>
          <button className={`chip ${tab === "mine"
            ? "ring-1 ring-ink text-slate-900" : ""}`}
            onClick={() => changeTab("mine")}>
            My requests
          </button>
        </div>
      )}

      {rows.isError ? (
        <ErrorState onRetry={() => rows.refetch()} />
      ) : rows.isLoading ? (
        <div className="card card-body"><Spinner className="h-5 w-5" /></div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Icon.Key size={20} />}
          title={tab === "queue" ? "Nothing to decide"
            : "You have not asked for anything"}
          hint={tab === "queue"
            ? "When somebody asks to see a policy that is not theirs, it lands "
              + "here."
            : "Search a policy number that is not on your list and you will be "
              + "offered the chance to ask for it."} />
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <RequestCard key={r.id} request={r}
              canApprove={canApprove && tab === "queue"}
              onDecide={(approve, hours) =>
                decide.mutate({ id: r.id, approve, hours })}
              onRevoke={() => revoke.mutate(r.id)}
              onCancel={() => cancel.mutate(r.id)} />
          ))}
        </div>
      )}
      {total > PAGE_SIZE && (
        <Pagination page={page} pageSize={PAGE_SIZE} total={total}
          onChange={setPage} />
      )}
    </div>
  );
}

function RequestCard({ request: r, canApprove, onDecide, onRevoke, onCancel }: {
  request: PolicyAccessRequest;
  canApprove: boolean;
  onDecide: (approve: boolean, hours: number) => void;
  onRevoke: () => void;
  onCancel: () => void;
}) {
  // The window is the approver's decision, not a constant. Twelve hours is the
  // owner's default; a sensitive record deserves less, somebody covering a week
  // of leave deserves more, and anybody who needs a week needs the flag instead.
  const [hours, setHours] = useState(12);

  return (
    <div className={`card px-4 py-3 ${r.is_live
      ? "border-l-4 border-l-money-in"
      : r.status === "pending" ? "border-l-4 border-l-due" : ""}`}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-slate-900">
              {r.policy_number || r.policy_code}
            </span>
            <span className="chip">{r.code}</span>
            <StatusChip request={r} />
          </p>
          <p className="mt-0.5 text-sm text-slate-600">
            <b>{r.requester_name}</b> — “{r.reason}”
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Asked {formatDateTime(r.created_at)}
            {r.decided_by_name && ` · decided by ${r.decided_by_name}`}
            {r.is_live && r.expires_at
              && ` · open until ${formatDateTime(r.expires_at)}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canApprove && r.status === "pending" && (
            <>
              <select className="select w-28" value={hours}
                onChange={(e) => setHours(Number(e.target.value))}>
                <option value={4}>4 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={72}>3 days</option>
              </select>
              <button className="btn-secondary btn-sm"
                onClick={async () => {
                  if (await confirmDialog({
                    title: "Refuse this request?",
                    message: `${r.requester_name} will be told, and will not `
                      + "be able to open the policy.",
                    confirmLabel: "Refuse",
                  })) onDecide(false, hours);
                }}>
                Refuse
              </button>
              <button className="btn-primary btn-sm"
                onClick={() => onDecide(true, hours)}>
                <Icon.Check size={13} /> Approve for {hours}h
              </button>
            </>
          )}
          {canApprove && r.is_live && (
            <button className="btn-secondary btn-sm" onClick={onRevoke}>
              Close it now
            </button>
          )}
          {!canApprove && r.status === "pending" && (
            <button className="btn-ghost btn-sm" onClick={onCancel}>
              Withdraw
            </button>
          )}
          {r.is_live && (
            <Link to={`/policies/${r.policy_id}`} className="btn-secondary btn-sm">
              Open <Icon.ChevronRight size={13} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The state, in one chip.
 *
 * `is_live` is COMPUTED SERVER-SIDE against the clock, never read off `status` —
 * an approved grant whose window closed a minute ago has to read as closed
 * without waiting for a sweep, and the client must not do that arithmetic
 * itself (a laptop eleven minutes fast would claim access it does not have).
 */
function StatusChip({ request: r }: { request: PolicyAccessRequest }) {
  if (r.is_live) {
    return (
      <span className="badge-in">
        <Icon.Check size={11} /> Open for {r.hours}h
      </span>
    );
  }
  switch (r.status) {
    case "pending":
      return <span className="badge-due">
        <Icon.Clock size={11} /> Waiting
      </span>;
    case "approved":
    case "expired":
      return <span className="badge-neutral">Window closed</span>;
    case "rejected":
      return <span className="badge-neutral">Refused</span>;
    case "revoked":
      return <span className="badge-neutral">Closed early</span>;
    default:
      return <span className="badge-neutral">Withdrawn</span>;
  }
}
