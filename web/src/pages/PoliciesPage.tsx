import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  brokersApi,
  categoriesApi,
  insurersApi,
  policiesApi,
  usersApi,
} from "../api/endpoints";
import { Icon } from "../components/Icon";
import { ListPage } from "../components/ListPage";
import { PageHeader } from "../components/PageHeader";
import { FilterPill } from "../components/FilterPill";
import {
  LedgerCell,
  LedgerFigure,
  LedgerRow,
  LTh,
  MobileCard,
  RowMenu,
  RowMenuItem,
} from "../components/ui";
import { ExportButton } from "../components/ExportButton";
import { ExpiryChip } from "../components/PolicyDetailBody";
import { Menu, MenuItem, MenuSoonChip } from "../components/Menu";
import {
  DateFilter, periodParams, type PeriodValue,
} from "../components/finance/DateFilter";
import {
  formatDate,
  formatINRShort,
  titleCase,
} from "../lib/format";
import { describePath } from "../lib/rating";
import {
  PolicyAccessQueue, PolicyScopeNote, RestrictedMatches,
} from "../components/policies/PolicyAccess";
import { useAuth } from "../store/auth";
import {
  type Policy, type PolicyCategory, type PolicyStatus,
} from "../lib/types";

const STATUSES: PolicyStatus[] = [
  "draft", "active", "renewal_due", "renewed", "lapsed", "cancelled", "expired",
];

/*
  Compact reward term.

  This now carries its own "%" because the rate is no longer under a column
  headed "Reward %" — agency and partner share ONE cell (owner: the rates are
  scanned down the list, so they stay), and a bare "12.5" next to a bare "5"
  with no unit is a puzzle.
*/
const rewardCompact = (basis: string, value: number): string =>
  basis === "percent"
    ? `${+(value / 100).toFixed(2)}%`
    : formatINRShort(value);

/*
  The row's leading edge — the ONLY place urgency is drawn in a ledger.

  A status column on every row means forty chips on a page of forty policies,
  which is forty things claiming attention and therefore none. A rail is
  invisible until it isn't: three amber edges in a list read instantly, and the
  status is still on the record itself for anyone who opens it.
*/
const RENEWAL_HORIZON_DAYS = 30;

function railFor(p: Policy): "due" | "out" | undefined {
  if (p.status === "lapsed" || p.status === "cancelled") return "out";
  if (p.status === "renewal_due") return "due";
  if (!p.expiry_date) return undefined;
  const days = Math.ceil(
    (new Date(p.expiry_date).getTime() - Date.now()) / 86_400_000);
  return days >= 0 && days <= RENEWAL_HORIZON_DAYS ? "due" : undefined;
}


export default function PoliciesPage() {
  const navigate = useNavigate();
  const { has, user } = useAuth();
  const isPartner = user?.account_type === "channel_partner";
  const [sp, setSp] = useSearchParams();

  /*
    ACCESS REQUESTS ARE A VIEW OF THIS PAGE, not a page of their own — the
    owner's standing "no random pages for each and every shit thing", and the
    same call Attendance and Employees already got. Two questions about one
    subject: what is on my desk, and who is asking to get onto it.
  */
  const accessView = sp.get("view") === "access-requests";
  const setAccessView = (on: boolean) => {
    const next = new URLSearchParams(sp);
    if (on) next.set("view", "access-requests"); else next.delete("view");
    setSp(next, { replace: true });
  };
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [qDebounced, setQDebounced] = useState(sp.get("q") ?? "");
  const [categoryF, setCategoryF] = useState<string>("");
  const [insurerF, setInsurerF] = useState<string>("");
  const [brokerF, setBrokerF] = useState<string>("");
  const [partnerF, setPartnerF] = useState<string>("");
  // Till date, not current month. This is the BOOK, not a period report — a
  // list that opens pre-filtered tells you your data is missing.
  const [period, setPeriod] = useState<PeriodValue>({ period: "till_date" });

  useEffect(() => {
    const t = setTimeout(() => { setPage(1); setQDebounced(q.trim()); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  /*
    THE SEARCH BOX FOLLOWS THE URL WHEN THE URL CHANGES.

    `q` is seeded from `?q=` on mount, which is enough for a fresh navigation
    and NOT enough for the case that matters: somebody already on /policies
    clicks a locked hit in the top-bar search. React Router changes the query
    string without remounting the page, so the box would keep its old value, the
    restricted panel would never render, and the "request access" link would
    land on a list that says nothing about why they were sent there. A feature
    nobody can find is a feature nobody has — this repo has that scar three
    times over.

    Adjusting state during render on a prop change (React's own documented
    pattern) rather than in an effect, so the list never flashes the wrong
    results first. It terminates because `urlQ` is recorded in the same pass,
    and it does not fight the debounce: typing changes `q`, not the URL, so
    `urlQ` is unchanged and this branch is not taken.
  */
  const urlQ = sp.get("q") ?? "";
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  if (urlQ !== lastUrlQ) {
    setLastUrlQ(urlQ);
    setQ(urlQ);
    setQDebounced(urlQ);
    setPage(1);
  }

  // Whether anything is narrowing the list — decides which empty state to show.
  const filtered = !!(status || qDebounced || categoryF || insurerF || brokerF
    || partnerF || period.period !== "till_date");
  const clearFilters = () => {
    setPage(1); setStatus(""); setQ(""); setQDebounced("");
    setCategoryF(""); setInsurerF(""); setBrokerF(""); setPartnerF("");
    setPeriod({ period: "till_date" });
  };

  const list = useQuery({
    queryKey: ["policies", page, status, qDebounced, categoryF,
      insurerF, brokerF, partnerF, period],
    queryFn: async () =>
      (await policiesApi.list({
        page, page_size: 15, status: status || undefined,
        q: qDebounced || undefined,
        category_key: categoryF || undefined,
        insurer_id: insurerF || undefined,
        broker_id: brokerF || undefined,
        partner_id: partnerF || undefined,
        ...periodParams(period),
      })).data,
  });
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: async () => (await categoriesApi.list()).data,
  });
  const insurers = useQuery({
    queryKey: ["insurers-all"],
    queryFn: async () => (await insurersApi.list({ page_size: 200 })).data,
  });
  // Brokers for the list filter (staff only — partners never filter by broker).
  const brokersFilter = useQuery({
    queryKey: ["brokers-filter"],
    queryFn: async () => (await brokersApi.list({})).data,
    enabled: !isPartner,
  });
  // Channel partners for the list filter (staff only).
  const partnersFilter = useQuery({
    queryKey: ["partners-filter"],
    queryFn: async () => (await usersApi.attributablePartners()).data,
    enabled: !isPartner,
  });
  // Category tree -> full description for the hover tooltip on the Category cell.
  const catByKey = useMemo(() => {
    const m = new Map<string, PolicyCategory>();
    (cats.data ?? []).forEach((c) => m.set(c.key, c));
    return m;
  }, [cats.data]);
  const categoryTitle = (p: Policy): string => {
    const cat = catByKey.get(p.category_key);
    if (!cat) return p.category_key;
    const path = describePath(cat.children, p.subcategory_path || []);
    return path && path !== "Whole type" ? `${cat.label} › ${path}` : cat.label;
  };
  // Reward %/flat columns are income economics — only for finance viewers.
  const seesFinance = has("view_balance_sheet");
  // What the reward % is calculated on: "Default" (GST-net premium) or the
  // custom amount field's label (OD / TP / …) when reward_base_field is set.
  const baseSourceLabel = (p: Policy): string => {
    const key = p.reward_base_field;
    if (!key || key === "commissionable") return "Default";
    const cat = catByKey.get(p.category_key);
    const field = cat?.custom_fields?.find((f) => f.key === key);
    return field?.label ?? key;
  };


  if (accessView) {
    return (
      <>
        <PageHeader
          title="Policy access"
          eyebrow="Policies"
          subtitle="Time-limited access to a policy that is not on your desk.
            Approved requests open one policy, for a few hours, and never allow
            editing."
          actions={
            <button className="btn-secondary" onClick={() => setAccessView(false)}>
              <Icon.ChevronLeft size={15} /> Back to policies
            </button>
          } />
        <div className="mt-5"><PolicyAccessQueue /></div>
      </>
    );
  }

  return (
    <ListPage<Policy>
      title="Policies"
      eyebrow="Insurance"
      actions={
        <>
          <DateFilter value={period}
            onChange={(v) => { setPage(1); setPeriod(v); }} />
          <ExportButton filename="policies"
            onExport={(fmt) => policiesApi.export({
              status: status || undefined,
              category_key: categoryF || undefined,
              insurer_id: insurerF || undefined,
              broker_id: brokerF || undefined,
              partner_id: partnerF || undefined,
              ...periodParams(period), fmt })} />
          {/*
            The way IN to the access view, and the way BACK. A view nobody can
            find is a view nobody has — the lesson /targets had to learn on
            2026-08-21, twice over.
          */}
          {!isPartner && (
            <button className="btn-secondary"
              onClick={() => setAccessView(!accessView)}>
              <Icon.Key size={15} />
              {accessView ? "Back to policies" : "Access requests"}
            </button>
          )}
          {has("manage_policies") && !accessView && (
            <AddPolicyButton onManual={() => navigate("/policies/new")} />
          )}
        </>
      }
      search={{
        value: q, onChange: setQ,
        placeholder: "Search policy number or customer…",
      }}
      /*
        Pills, not a row of six `<select>`s. Each states its own value when set
        and clears in one click, so the bar answers "what am I looking at?"
        instead of being six dropdowns all reading "All …".
      */
      filters={
        <>
          <FilterPill label="Status" value={status} icon="Check"
            onChange={(v) => { setPage(1); setStatus(v); }}
            options={STATUSES.map((s) => ({
              value: s, label: titleCase(s) }))} />
          <FilterPill label="Category" value={categoryF}
            onChange={(v) => { setPage(1); setCategoryF(v); }}
            options={(cats.data ?? []).map((c) => ({
              value: c.key, label: c.label }))} />
          <FilterPill label="Insurer" value={insurerF}
            onChange={(v) => { setPage(1); setInsurerF(v); }}
            options={(insurers.data?.items ?? []).map((i) => ({
              value: i.id, label: i.name }))} />
          {!isPartner && (
            <FilterPill label="Broker" value={brokerF}
              onChange={(v) => { setPage(1); setBrokerF(v); }}
              options={(brokersFilter.data ?? []).map((b) => ({
                value: b.id, label: b.name }))} />
          )}
          {!isPartner && (
            <FilterPill label="Partner" value={partnerF}
              allLabel="All channel partners"
              onChange={(v) => { setPage(1); setPartnerF(v); }}
              options={(partnersFilter.data ?? []).map((pp) => ({
                value: pp.id, label: pp.full_name, sub: pp.code }))} />
          )}
        </>
      }
      filtered={filtered}
      onClearFilters={clearFilters}
      query={list}
      /*
        Above the list: what this list IS, and — when a search finds nothing on
        your own desk — what it found on somebody else's. Both are silent for a
        caller who sees the whole book, so an owner's Policies page is unchanged.
      */
      items={list.data?.items ?? []}
      minWidth={760}
      loadingCols={7}
      empty={{
        title: "No policies yet",
        hint: "Create your first policy to start tracking rewards.",
      }}
      filteredEmpty={{ title: "No policies match these filters" }}
      pagination={list.data
        ? { page, pageSize: 15, total: list.data.total, onChange: setPage }
        : undefined}
      /* One line saying what this list IS. Silent for anybody who sees the
         whole book, so an owner's Policies page is unchanged. */
      children={!isPartner ? <PolicyScopeNote /> : undefined}
      /* And, under it, what the SAME search found on somebody else's desk.
         Below the list because it answers a different question from the
         results — and it has to show on the EMPTY state, which is when the
         question ("is it not there, or is it not mine?") actually gets asked. */
      footer={!isPartner && qDebounced.length >= 2 ? (
        <RestrictedMatches q={qDebounced}
          focusPolicyId={sp.get("request") ?? undefined} />
      ) : undefined}
      head={
        <>
          <LTh>Policy</LTh>
          <LTh>Cover</LTh>
          <LTh>Term</LTh>
          <LTh align="right">Premium</LTh>
          {seesFinance && (
            <LTh align="right"
              title="Agency reward rate over partner reward rate">Reward</LTh>
          )}
          <LTh>Channel partner</LTh>
          <LTh />
        </>
      }
      card={(p) => (
        <MobileCard
          key={p.id}
          to={`/policies/${p.id}`}
          rail={railFor(p)}
          title={p.policy_number || "—"}
          meta={
            <>
              {p.customer_name || "No customer"}
              <span className="block">
                {catByKey.get(p.category_key)?.label || p.category_key}
                {p.insurer_name ? ` · ${p.insurer_name}` : ""}
              </span>
            </>
          }
          right={
            <>
              <span className="block whitespace-nowrap text-metric-sm
                tabular-nums text-slate-900">
                {formatINRShort(p.premium_amount)}
              </span>
              {seesFinance && (
                <span className="mt-0.5 block whitespace-nowrap text-xs
                  tabular-nums text-slate-500">
                  {rewardCompact(p.reward.agency_basis, p.reward.agency_value)}
                </span>
              )}
            </>
          }
          footer={
            <span className="flex items-center gap-1.5">
              {formatDate(p.start_date)} → {formatDate(p.expiry_date)}
              <ExpiryChip expiry={p.expiry_date} status={p.status} />
            </span>
          }
        />
      )}
      row={(p) => (
        <LedgerRow key={p.id} onClick={() => navigate(`/policies/${p.id}`)}>
          {/*
            Customer under the policy number rather than in its own column: it
            was never an independent fact, it is whose policy this is. The
            number is the link, so this row has a keyboard route, opens in a
            new tab on middle-click and offers copy-link.

            The number is shown IN FULL (2026-08-07). It used to render through
            `maskTail` as "****4821", which is the one string on the row you
            match against an insurer's email — a page of fifteen rows all
            reading **** cannot be scanned and Ctrl-F finds nothing in it. The
            detail page never masked it, so the masking bought no
            confidentiality either.
          */}
          <LedgerCell
            mono
            rail={railFor(p)}
            to={`/policies/${p.id}`}
            title={p.policy_number || "—"}
            sub={p.customer_name || "—"}
          />
          {/* Category, insurer and broker were three columns saying one thing:
              what was placed, and with whom. */}
          <LedgerCell
            title={
              <span title={categoryTitle(p)}>
                {catByKey.get(p.category_key)?.label || p.category_key}
              </span>
            }
            sub={[
              p.insurer_name,
              !isPartner ? (p.broker_code || p.broker_name) : null,
            ].filter(Boolean).join(" · ") || "—"}
          />
          <td className="whitespace-nowrap">
            <span className="block text-[13px] text-slate-700">
              {formatDate(p.start_date)} → {formatDate(p.expiry_date)}
            </span>
            <span className="mt-0.5 block">
              <ExpiryChip expiry={p.expiry_date} status={p.status} />
            </span>
          </td>
          {/* The hero figure. Commissionable premium keeps its place as the
              quiet second line — it is the base the reward is worked out on,
              so it belongs to the premium, not to a column of its own. */}
          <LedgerFigure
            value={formatINRShort(p.premium_amount)}
            sub={
              <span title={`Reward base: ${baseSourceLabel(p)}`}>
                {formatINRShort(p.commissionable_premium
                  || Math.round(p.premium_amount
                    / (1 + p.gst_percent / 10000)))}
                {" "}{baseSourceLabel(p)}
              </span>
            }
          />
          {/* Agency rate over partner rate. Two columns became one cell; both
              rates are still scannable down the list. */}
          {seesFinance && (
            <td className="num"
              title="Agency reward rate (top) over partner reward rate (bottom)">
              <span className="block text-[13px] tabular-nums text-slate-800">
                {rewardCompact(p.reward.agency_basis, p.reward.agency_value)}
              </span>
              <span className="mt-0.5 block text-[13px] tabular-nums
                text-slate-500">
                {p.partner_id
                  ? rewardCompact(p.reward.partner_basis,
                    p.reward.partner_value)
                  : "—"}
              </span>
            </td>
          )}
          <td className="text-[13px] text-slate-600">
            {p.partner_id ? (p.partner_name || "…") : "—"}
          </td>
          {/* One overflow target, not four loose icons — and every other
              ledger had no row actions at all. */}
          <td>
            <RowMenu>
              {(close) => (
                <>
                  <RowMenuItem icon="Eye" to={`/policies/${p.id}`}>
                    Open policy
                  </RowMenuItem>
                  {has("manage_policies") && (
                    <RowMenuItem icon="Refresh" to={`/renewals/${p.id}`}>
                      Renew
                    </RowMenuItem>
                  )}
                  {p.customer_id && (
                    <RowMenuItem icon="Users"
                      to={`/customers/${p.customer_id}`}>
                      Open customer
                    </RowMenuItem>
                  )}
                  <RowMenuItem icon="Copy" onClick={() => {
                    navigator.clipboard?.writeText(p.policy_number || "");
                    close();
                  }}>
                    Copy policy number
                  </RowMenuItem>
                </>
              )}
            </RowMenu>
          </td>
        </LedgerRow>
      )}
    />
  );
}

function AddPolicyButton({ onManual }: { onManual: () => void }) {
  return (
    <Menu label="Add Policy" variant="primary" icon={<Icon.Plus size={18} />}>
      {(close) => (
        <>
          <MenuItem icon={<Icon.Edit size={16} />}
            onClick={() => { close(); onManual(); }}>Add Manually</MenuItem>
          <MenuItem icon={<Icon.Lock size={16} />} disabled
            trailing={<MenuSoonChip />}>Add with PDF</MenuItem>
        </>
      )}
    </Menu>
  );
}
