import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { payslipsApi, usersApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { Icon } from "../../components/Icon";
import {
  EmptyState, ErrorState, Field, Ledger, LedgerCell, LedgerFigure, LedgerRow,
  ListShell, LTh, MobileCard, Modal, Pagination, Segmented, StatCard, StatRow,
  TableSkeleton,
} from "../../components/ui";
import { PayslipDetail } from "../../components/hr/PayslipDetail";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { blobError, downloadBlob } from "../../lib/download";
import { formatDate, formatINR, rupeesToPaise } from "../../lib/format";
import { isCurrentMonth, monthKey, monthLabel, shiftMonth } from "../../lib/hr";
import {
  PAYSLIP_STATUS_LABELS, deductionSummary, payDays, payslipBadge,
  payslipMonthLabel, payslipRail, windowSentence, windowTone,
} from "../../lib/payroll";
import { useAuth } from "../../store/auth";
import type { PayRunBlocker, Payslip } from "../../lib/types";

/*
  PAYSLIPS — one page, two views (owner's standing "no random pages for each and
  every shit thing").

    MINE     my own payslips, newest first. NO PERMISSION NEEDED — being told
             what you are owed is not a privilege, the same rule attendance,
             leave and targets already follow.
    PAY RUN  everybody's month, what it costs, and what is in the way of paying
             it. Needs `view_payslips`; `manage_payslips` adds the buttons.

  THE PAY RUN DEFAULTS TO LAST MONTH, not this one. A pay run is about the month
  that has FINISHED; opening on the current month would put a half-built figure
  in the largest type on the page, which is the one thing a pay screen must not
  do.

  WHAT IS ON SCREEN BEFORE ANY BUTTON: the two things that ruin a pay run and
  are otherwise invisible — an employee with no salary on record, and a register
  with unresolved days. Both are named PEOPLE, not counts, because "3 employees
  have no salary" sends somebody hunting and three names is a to-do list.

  THE CORRECTION WINDOW (owner 2026-09-06) IS THE FIRST THING ON THE PAGE.
  Payslips generate themselves as drafts on the 1st and lock themselves a couple
  of working days later, and between those two moments somebody is supposed to
  fix the register. A deadline nobody can see is not a deadline — so the window
  sits above the figures, says the DATE it closes, and names everybody it is
  waiting on with a way to fix each of them from here. Every sentence it says
  comes from `lib/payroll`; the date itself is computed by the server, working
  days and declared holidays included.
*/

type View = "mine" | "run";

const PAGE_SIZE = 25;

export default function PayslipsPage() {
  const { has } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const canSeeAll = has("view_payslips");
  const canManage = has("manage_payslips");
  const canExport = has("export_data") && canSeeAll;

  const requested = params.get("view") as View | null;
  const [view, setView] = useState<View>(
    requested === "run" && canSeeAll ? "run" : canSeeAll ? "run" : "mine");
  // Last month by default — see the note above.
  const [month, setMonth] = useState(
    () => params.get("month") || shiftMonth(monthKey(new Date()), -1));

  // WHICH PAYSLIP IS OPEN LIVES IN THE URL, not in state.
  //
  // Every row is then a real <Link>, which is the rule `LedgerCell` exists to
  // enforce (2026-08-07): lists that opened from `onClick` on a bare <tr> were
  // not focusable, had no Enter key and no middle-click, so a keyboard user
  // could not open a record at all and nobody could open two in two tabs. It
  // also makes "look at Asha's August payslip" a link somebody can send.
  const [minePage, setMinePage] = useState(1);

  const openId = params.get("slip") || "";
  const setOpenId = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("slip", id); else next.delete("slip");
    setParams(next, { replace: !id });
  };

  const switchView = (v: View) => {
    setView(v);
    const next = new URLSearchParams(params);
    if (v === "mine") next.delete("view"); else next.set("view", v);
    setParams(next, { replace: true });
  };

  /* ------------------------------------------------------------- queries -- */

  // Paginated (owner 2026-09-12) — one payslip a month passes 25 well within
  // a career here.
  const mine = useQuery({
    queryKey: ["payslips", "mine", minePage],
    queryFn: async () =>
      (await payslipsApi.list({ page: minePage, page_size: PAGE_SIZE })).data,
    enabled: view === "mine",
  });

  const run = useQuery({
    queryKey: ["payslips", "run", month],
    queryFn: async () => (await payslipsApi.run(month)).data,
    enabled: view === "run" && canSeeAll,
  });

  // The one on screen, fetched by id rather than found in the list — so a
  // pasted link opens the right payslip even when the list behind it is showing
  // a different month, and so the dialog re-reads itself after an action
  // instead of closing and making somebody find the row again.
  const openSlip = useQuery({
    queryKey: ["payslips", "one", openId],
    queryFn: async () => (await payslipsApi.get(openId)).data,
    enabled: !!openId,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["payslips"] });

  const generate = useMutation({
    mutationFn: (regenerate: boolean) =>
      payslipsApi.generate({ month, regenerate }),
    onSuccess: (res) => {
      const missing = res.data.totals.missing_salary.length;
      toast.success(
        `${res.data.totals.payslips} payslip${
          res.data.totals.payslips === 1 ? "" : "s"} for ${
          payslipMonthLabel(month)}.`
        + (missing ? ` ${missing} still have no salary on record.` : ""));
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const finalise = useMutation({
    mutationFn: () => payslipsApi.finalise(month),
    onSuccess: (res) => {
      toast.success(`${res.data.totals.finalised} payslip${
        res.data.totals.finalised === 1 ? "" : "s"} finalised. Everybody has `
        + "been told what they are getting.");
      refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const exportRun = useMutation({
    mutationFn: async () => {
      const res = await payslipsApi.exportRun(month);
      downloadBlob(res.data as Blob, `payroll-${month}.xlsx`);
    },
    // `blobError`, not `apiError`: a responseType "blob" request hands the
    // ERROR body back as a Blob too, so the usual reader finds no `detail`.
    onError: async (e) => toast.error(await blobError(e)),
  });

  const totals = run.data?.totals;

  /* ---------------------------------------------------------------- view -- */

  return (
    <div>
      <PageHeader
        title="Payslips"
        eyebrow="Workplace HR"
        subtitle="Worked out from the attendance register and the salary on each
          employee's record. Generated automatically on the 1st for the month
          that just ended, then locked once the correction window closes."
        actions={
          <button className="btn-secondary"
            onClick={() => navigate("/hr/attendance")}>
            <Icon.Clock size={15} /> Attendance
          </button>
        }
      />

      {canSeeAll && (
        <div className="mt-5">
          <Segmented
            semantics="tabs"
            value={view}
            onChange={(v) => switchView(v as View)}
            options={[
              { value: "run", label: "Pay run", icon: "Users" },
              { value: "mine", label: "My payslips", icon: "User" },
            ]}
          />
        </div>
      )}

      {/* ---------------------------------------------------------- mine -- */}
      {view === "mine" && (
        <div className="mt-5">
          {mine.isError ? (
            <ErrorState onRetry={() => mine.refetch()} />
          ) : mine.isLoading ? (
            <TableSkeleton cols={4} />
          ) : (mine.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No payslips yet"
              hint="Your first one is generated on the 1st of next month, from
                this month's attendance. You are told as soon as it is final." />
          ) : (
            <>
              <MyPayslips rows={mine.data!.items} />
              {mine.data!.total > PAGE_SIZE && (
                <Pagination page={minePage} pageSize={PAGE_SIZE}
                  total={mine.data!.total} onChange={setMinePage} />
              )}
            </>
          )}
        </div>
      )}

      {/* -------------------------------------------------------- pay run -- */}
      {view === "run" && canSeeAll && (
        <div className="mt-5 space-y-4">
          <div className="ledger-bar">
            <button className="icon-btn" aria-label="Previous month" title="Previous month"
              onClick={() => setMonth(shiftMonth(month, -1))}>
              <Icon.ChevronLeft size={15} />
            </button>
            <span className="min-w-[9rem] text-center text-sm font-medium
              text-slate-900">{monthLabel(month)}</span>
            <button className="icon-btn" aria-label="Next month" title="Next month"
              disabled={isCurrentMonth(month)}
              onClick={() => setMonth(shiftMonth(month, 1))}>
              <Icon.ChevronRight size={15} />
            </button>
            {isCurrentMonth(month) && (
              // Said plainly rather than left to be discovered. A figure for a
              // month still running is not wrong, it is just not finished.
              <span className="badge-due">
                <Icon.Alert size={11} /> Still running
              </span>
            )}
            <div className="ledger-bar-end">
              {canExport && (
                <button className="btn-secondary btn-sm"
                  disabled={exportRun.isPending}
                  onClick={() => exportRun.mutate()}>
                  <Icon.Download size={14} />
                  {exportRun.isPending ? "Preparing…" : "Pay sheet"}
                </button>
              )}
              {canManage && (
                <button className="btn-secondary btn-sm"
                  disabled={generate.isPending}
                  onClick={() => generate.mutate(false)}>
                  <Icon.Refresh size={14} /> Generate
                </button>
              )}
              {canManage && (totals?.draft ?? 0) > 0 && (
                <button className="btn-primary btn-sm"
                  disabled={finalise.isPending}
                  onClick={async () => {
                    if (await confirmDialog({
                      title: `Finalise ${totals!.draft} payslip${
                        totals!.draft === 1 ? "" : "s"}?`,
                      message: "Everybody gets told what they are being paid, "
                        + "and the figures lock. A payslip can be reopened "
                        + "afterwards if a correction lands.",
                      confirmLabel: "Finalise them",
                    })) finalise.mutate();
                  }}>
                  <Icon.Check size={14} /> Finalise all
                </button>
              )}
            </div>
          </div>

          {run.isError ? (
            <ErrorState onRetry={() => run.refetch()} />
          ) : run.isLoading ? (
            <TableSkeleton cols={6} />
          ) : !totals || totals.payslips === 0 ? (
            <EmptyState
              title={`No payslips for ${monthLabel(month)}`}
              hint={canManage
                ? "They are generated automatically on the 1st. Press Generate "
                  + "to build them now."
                : "They are generated automatically on the 1st of the month."}
              action={canManage ? (
                <button className="btn-primary"
                  disabled={generate.isPending}
                  onClick={() => generate.mutate(false)}>
                  Generate them now
                </button>
              ) : undefined} />
          ) : (
            <>
              <StatRow cols={4}>
                <StatCard label="Net payable"
                  value={formatINR(totals.net_paise)}
                  hint={`${totals.payslips} of ${totals.employees} employees`} />
                <StatCard label="Deducted"
                  value={formatINR(totals.deduction_paise)}
                  tone={totals.deduction_paise > 0 ? "out" : undefined}
                  hint="Absences, unpaid leave and late marks" />
                <StatCard label="Still to pay"
                  value={formatINR(totals.outstanding_paise)}
                  tone={totals.outstanding_paise > 0 ? "due" : undefined}
                  hint={`${totals.finalised} finalised, ${totals.draft} draft`} />
                <StatCard label="Paid" value={String(totals.paid)}
                  tone={totals.paid > 0 ? "in" : undefined}
                  meter={totals.payslips
                    ? totals.paid / totals.payslips : 0}
                  hint={`of ${totals.payslips}`} />
              </StatRow>

              {/* THE WINDOW: what happens next, and when, in one line. */}
              <p className={windowTone(totals)}>{windowSentence(totals)}</p>

              {/* And exactly who it is waiting on, with a way to fix each. */}
              {totals.blocked.length > 0 && (
                <BlockedList rows={totals.blocked} month={month}
                  canManage={canManage} onFixed={refresh} />
              )}

              <PayRunTable rows={run.data!.rows} />
            </>
          )}
        </div>
      )}

      {openId && openSlip.data && (
        <PayslipDetail
          payslip={openSlip.data}
          canManage={canManage}
          onClose={() => setOpenId("")}
          onChanged={refresh} />
      )}
    </div>
  );
}

/** Where a row points. One definition, so the card and the table agree. */
function slipLink(p: Payslip): string {
  return `?slip=${p.id}`;
}

/* --------------------------------------------------- what the month waits on */

/**
 * The people blocking the month, each with the reason and the way to fix it.
 *
 * A LIST OF NAMES WITH ACTIONS, not a warning paragraph. The two notes this
 * replaced said the right thing and left somebody to go and find the profile or
 * the register themselves, three screens away — which is how a pay run that is
 * "nearly ready" stays nearly ready for a week. Every reason here has a control
 * next to it that leads to the fix.
 *
 * The reasons are SERVER-COMPUTED (`payroll.blockers_for`), the same function
 * the automatic job refuses to lock on. The screen therefore cannot promise
 * something the job will not do, which is the failure this whole feature would
 * be judged by.
 */
function BlockedList({ rows, month, canManage, onFixed }: {
  rows: PayRunBlocker[];
  month: string;
  canManage: boolean;
  onFixed: () => void;
}) {
  const { has } = useAuth();
  // Setting a salary is `manage_employees`, not `manage_payslips` — the pay
  // desk is not automatically the desk that hires people. Drawn only when the
  // person can actually do it, rather than drawn and 403'd.
  const canSetSalary = has("manage_employees") && has("view_salary");
  const [salaryFor, setSalaryFor] = useState<PayRunBlocker | null>(null);

  return (
    <div className="card card-body">
      <h3 className="text-sm font-semibold text-slate-900">
        Waiting on {rows.length === 1 ? "one person" : `${rows.length} people`}
      </h3>
      <p className="mt-0.5 text-sm text-slate-500">
        These stay as drafts — automatic locking never forces a figure nobody
        has checked.
      </p>
      <ul className="mt-3 divide-y divide-line-soft">
        {rows.map((b) => {
          const noSalary = b.reasons.some((r) => r.includes("no salary"));
          const disputed = b.reasons.some((r) => r.includes("correction"));
          return (
            <li key={b.payslip_id}
              className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-900">
                  {b.name}
                </span>
                <span className="block text-sm text-slate-500">
                  {b.reasons.join(" · ")}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {noSalary && canSetSalary && (
                  <button className="btn-secondary btn-sm"
                    onClick={() => setSalaryFor(b)}>
                    <Icon.Wallet size={14} /> Set salary
                  </button>
                )}
                {noSalary && !canSetSalary && (
                  <Link className="btn-secondary btn-sm"
                    to={`/people/employees/${b.user_id}?tab=hr`}>
                    Open profile
                  </Link>
                )}
                <Link className="btn-secondary btn-sm"
                  to={disputed
                    ? "/hr/attendance?view=corrections"
                    : `/hr/attendance?view=month&month=${month}`}>
                  <Icon.Clock size={14} />
                  {disputed ? "Corrections" : "Register"}
                </Link>
              </span>
            </li>
          );
        })}
      </ul>
      {salaryFor && (
        <SetSalaryDialog blocker={salaryFor} month={month} canManage={canManage}
          onClose={() => setSalaryFor(null)}
          onSaved={() => { setSalaryFor(null); onFixed(); }} />
      )}
    </div>
  );
}

/**
 * Set somebody's monthly salary without leaving the pay run.
 *
 * THE WRITER IS STILL `PATCH /api/users/{id}` — the one place a salary is
 * written, the same call the employee record's own Edit form makes. A second
 * endpoint for "just the salary" would be a second set of rules about who may
 * change one, and the two would diverge the first time somebody added a check
 * to only one of them.
 *
 * It reads the profile back before writing, and SPREADS it. The server replaces
 * `employee_profile` wholesale rather than merging it, so a payload carrying
 * only the salary would silently wipe the joining date, the shift and the bank
 * details — exactly the trap `PersonDetailBody` documents.
 */
function SetSalaryDialog({ blocker, month, canManage, onClose, onSaved }: {
  blocker: PayRunBlocker;
  month: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rupees, setRupees] = useState("");

  const person = useQuery({
    queryKey: ["user", blocker.user_id],
    queryFn: async () => (await usersApi.get(blocker.user_id)).data,
  });

  const save = useMutation({
    mutationFn: async () => {
      const profile = person.data?.employee_profile ?? {};
      await usersApi.update(blocker.user_id, {
        employee_profile: {
          ...profile,
          monthly_salary_paise: rupeesToPaise(Number(rupees || 0)),
        },
      });
      // Rebuild THIS person's draft straight away, so the figure appears on the
      // row behind the dialog instead of at some point tomorrow morning. A
      // salary set and a payslip still reading zero is the same bug as not
      // having set it.
      if (canManage) {
        await payslipsApi.generate({
          month, user_id: blocker.user_id, regenerate: true,
        }).catch(() => undefined);
      }
    },
    onSuccess: () => {
      toast.success(`Saved. ${blocker.name}'s payslip has been rebuilt.`);
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Modal open onClose={onClose} size="sm"
      title={`Monthly salary for ${blocker.name}`}>
      <form className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="note">
          This is the figure the whole payslip is worked out from — a day costs
          this divided by 30, so the same absence costs the same in every month.
          It is saved on their employee record.
        </p>
        <Field label="Monthly salary" required
          hint="What they are paid for a full month, before any deduction.">
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg border
              border-r-0 border-slate-300 bg-slate-50 px-3 text-sm
              text-slate-500">Rs</span>
            <input className="input rounded-l-none" inputMode="decimal" autoFocus
              value={rupees} placeholder="15000"
              onChange={(e) =>
                setRupees(e.target.value.replace(/[^\d.]/g, ""))} />
          </div>
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary"
            disabled={save.isPending || person.isLoading || !rupees}>
            {save.isPending ? "Saving…" : "Save the salary"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------- mine -- */

function MyPayslips({ rows }: { rows: Payslip[] }) {
  return (
    <ListShell
      bare
      cards={rows.map((p) => (
        <MobileCard key={p.id} to={slipLink(p)} title={payslipMonthLabel(p.month)}
          rail={payslipRail(p.status)}
          meta={
            <>
              {payDays(p.payable_days)} payable days
              {p.status === "paid" && p.paid_at
                ? ` · paid ${formatDate(p.paid_at)}` : ""}
            </>
          }
          right={
            <span className="block whitespace-nowrap text-metric-sm
              tabular-nums text-slate-900">
              {formatINR(p.net_payable_paise)}
            </span>
          }
          footer={
            <span className={`badge ${payslipBadge(p.status)}`}>
              {PAYSLIP_STATUS_LABELS[p.status]}
            </span>
          } />
      ))}
      table={
        <Ledger head={
          <>
            <LTh>Month</LTh>
            <LTh>Days</LTh>
            <LTh>Deductions</LTh>
            <LTh align="right">Net payable</LTh>
            <LTh>Status</LTh>
          </>
        }>
          {rows.map((p) => (
            <LedgerRow key={p.id}>
              <LedgerCell to={slipLink(p)}
                title={payslipMonthLabel(p.month)}
                sub={p.status === "paid" && p.paid_at
                  ? `Paid ${formatDate(p.paid_at)}` : p.code}
                rail={payslipRail(p.status)} />
              <td className="text-sm tabular-nums text-slate-600">
                {payDays(p.payable_days)} / {p.calendar_days}
              </td>
              <td className="text-sm text-slate-500">
                {deductionSummary(p) || "—"}
              </td>
              <LedgerFigure value={formatINR(p.net_payable_paise)} />
              <td>
                <span className={`badge ${payslipBadge(p.status)}`}>
                  {PAYSLIP_STATUS_LABELS[p.status]}
                </span>
              </td>
            </LedgerRow>
          ))}
        </Ledger>
      } />
  );
}

/* ---------------------------------------------------------------- pay run -- */

function PayRunTable({ rows }: { rows: Payslip[] }) {
  return (
    <ListShell
      bare
      cards={rows.map((p) => (
        <MobileCard key={p.id} to={slipLink(p)} title={p.user_name}
          rail={payslipRail(p.status)}
          meta={<>{payDays(p.payable_days)} days · {deductionSummary(p) || "full month"}</>}
          right={
            <span className="block whitespace-nowrap text-metric-sm
              tabular-nums text-slate-900">
              {formatINR(p.net_payable_paise)}
            </span>
          }
          footer={
            <span className={`badge ${payslipBadge(p.status)}`}>
              {PAYSLIP_STATUS_LABELS[p.status]}
            </span>
          } />
      ))}
      table={
        <Ledger head={
          <>
            <LTh>Employee</LTh>
            <LTh align="right">Salary</LTh>
            <LTh>Days</LTh>
            <LTh>Deductions</LTh>
            <LTh align="right">Net payable</LTh>
            <LTh>Status</LTh>
          </>
        }>
          {rows.map((p) => (
            <LedgerRow key={p.id}>
              <LedgerCell to={slipLink(p)} title={p.user_name}
                sub={p.designation || p.user_code}
                rail={payslipRail(p.status)} />
              <td className="text-right text-sm tabular-nums text-slate-600">
                {p.monthly_salary_paise > 0
                  ? formatINR(p.monthly_salary_paise)
                  // NOT `formatINR(x ?? 0)`. A zero here is a record nobody has
                  // filled in, and rendering it as "₹0" claims somebody is
                  // unpaid — the exact trap `designSystem.test.ts` bans.
                  : <span className="text-money-out">Not set</span>}
              </td>
              <td className="text-sm tabular-nums text-slate-600">
                {payDays(p.payable_days)} / {p.calendar_days}
              </td>
              <td className="text-sm text-slate-500">
                {deductionSummary(p) || "—"}
              </td>
              <LedgerFigure value={formatINR(p.net_payable_paise)} />
              <td>
                <span className={`badge ${payslipBadge(p.status)}`}>
                  {PAYSLIP_STATUS_LABELS[p.status]}
                </span>
                {p.unresolved_days > 0 && (
                  <span className="ml-1 badge-due" title={
                    `${p.unresolved_days} days in the register are unresolved`}>
                    <Icon.Alert size={11} />
                  </span>
                )}
              </td>
            </LedgerRow>
          ))}
        </Ledger>
      } />
  );
}
