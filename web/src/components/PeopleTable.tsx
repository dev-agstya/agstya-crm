import { ReactNode } from "react";
import { Icon } from "./Icon";
import { ErrorState, EmptyState, PersonCell, TableSkeleton } from "./ui";
import type { UserRow } from "../lib/types";

/*
  Shared list table for Employees and Channel Partners (People section).

  REBUILT 2026-08-05. It was a hand-rolled <table> with its own header casing
  and its own padding, rendering people as three columns of grey text and
  carrying up to THREE full-width text buttons in every row — so the actions
  shouted louder than the names, and a page entirely about people had no people
  on it.

  Now: the row itself opens the profile (which is what everyone was clicking
  "View profile" for), the secondary actions are icon buttons that stay quiet
  until you hover the row, and each person has a face.
*/
export function PeopleTable({
  rows,
  loading,
  error = false,
  onRetry,
  kind,
  onTeam,
  inactive = false,
  onView,
  onTargets,
  onAnalytics,
  toolbar,
}: {
  rows: UserRow[];
  loading: boolean;
  /**
   * The request failed (2026-08-07).
   *
   * Without this the component only knew "loading" and "no rows", so a dropped
   * connection rendered "No channel partners yet — add your first one" over a
   * roster of forty. An empty state is a claim about the data; it must not be
   * what a failure looks like.
   */
  error?: boolean;
  onRetry?: () => void;
  /**
   * The search / filter row, rendered INSIDE this card as the shared
   * `.filter-bar` (2026-08-06). Both People pages used to float it above the
   * card in a `mb-4 flex gap-3` div, so the search box hung in the canvas while
   * the table it filtered sat in a card below it, aligned with nothing — and it
   * disappeared entirely on the loading and empty states, which is exactly when
   * you want to change the filter.
   */
  toolbar?: ReactNode;
  kind: "employee" | "channel_partner";
  /**
   * Open this employee's TEAM. Employees only.
   *
   * The Team tab has existed on an employee's record since 2026-08-05 and the
   * owner could not find it — because nothing in this table said a team was
   * behind any particular row. Every row looked identical, so opening one to
   * check was a gamble, and you do not take that gamble twenty times. The count
   * IS the signpost, and it is also the button.
   */
  onTeam?: (u: UserRow) => void;
  // When true this is the switched-off view — deactivated or removed
  // accounts, shown read-only with no row actions.
  inactive?: boolean;
  onView: (u: UserRow) => void;
  onTargets?: (u: UserRow) => void;
  /** Opens the performance deep-dive (actuals vs target, trend, mix). */
  onAnalytics?: (u: UserRow) => void;
}) {
  const noun = kind === "employee" ? "employee" : "channel partner";
  const isEmp = kind === "employee";

  // One card, whatever the state — so the filter row never moves or vanishes
  // between loading, empty and loaded.
  const shell = (children: ReactNode) => (
    <div className="card overflow-hidden">
      {toolbar && <div className="filter-bar">{toolbar}</div>}
      {children}
    </div>
  );

  // Error BEFORE loading and before empty — the order matters, because both of
  // the others are statements about data that was actually fetched.
  if (error) {
    return shell(<ErrorState onRetry={onRetry} />);
  }
  if (loading) {
    return shell(<TableSkeleton cols={4} />);
  }
  if (rows.length === 0) {
    return shell(
      <div>
        <EmptyState
          icon={<Icon.Users size={20} />}
          title={inactive ? `No deactivated ${noun}s` : `No ${noun}s yet`}
          hint={inactive ? "Accounts that have been switched off appear here."
            : `Add your first ${noun} to get started.`} />
      </div>
    );
  }

  return shell(
    <div className="overflow-x-auto">
        <table className="table-sticky">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              {isEmp && <th>Designation</th>}
              {isEmp && onTeam && <th>Team</th>}
              {!isEmp && <th>Relationship manager</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              // A REMOVED person is gone and read-only; a DEACTIVATED one is
              // switched off but intact and must stay openable, because
              // reactivating them is done from their own profile.
              const openable = !u.is_deleted;
              return (
                <tr key={u.id}
                  className={`${openable ? "row-link" : ""} ${
                    inactive ? "opacity-70" : ""}`}
                  tabIndex={openable ? 0 : undefined}
                  onKeyDown={openable ? (e) => {
                    if (e.key === "Enter") onView(u);
                  } : undefined}
                  onClick={openable ? () => onView(u) : undefined}>
                  <td>
                    <PersonCell
                      name={u.full_name}
                      sub={u.code}
                      badges={
                        u.is_deleted ? (
                          <span className="badge bg-slate-100 text-slate-600">
                            removed</span>
                        ) : inactive ? (
                          <span className="badge bg-due/10 text-due">
                            deactivated</span>
                        ) : undefined
                      } />
                  </td>

                  <td>
                    <p className="text-slate-700">{u.mobile || "—"}</p>
                    <p className="truncate text-xs text-slate-500">{u.email}</p>
                  </td>

                  {isEmp && (
                    <td className="text-slate-600">
                      {u.employee_profile?.designation || "—"}</td>
                  )}
                  {isEmp && onTeam && (
                    <td onClick={(e) => e.stopPropagation()}>
                      {u.partners_under ? (
                        <button type="button"
                          className="badge-ink transition-colors
                            hover:bg-ink hover:text-white"
                          title={`Open ${u.full_name}'s team`}
                          onClick={() => onTeam(u)}>
                          <Icon.Users size={12} />
                          {u.partners_under} partner
                          {u.partners_under === 1 ? "" : "s"}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500">
                          No partners</span>
                      )}
                    </td>
                  )}
                  {!isEmp && (
                    <td className="text-slate-600">
                      {u.relationship_manager_name || (
                        <span className="text-slate-500">—</span>
                      )}</td>
                  )}

                  {/* Quiet until the row is hovered. The primary action IS the
                      row; these two are shortcuts past it. */}
                  <td className="num">
                    <div className="flex items-center justify-end gap-1
                      opacity-0 transition-opacity focus-within:opacity-100
                      group-hover:opacity-100 [tr:hover_&]:opacity-100"
                      onClick={(e) => e.stopPropagation()}>
                      {!inactive && onAnalytics && (
                        <button className="icon-btn" title="Analytics"
                          aria-label={`Analytics for ${u.full_name}`}
                          onClick={() => onAnalytics(u)}>
                          <Icon.Trend size={15} />
                        </button>
                      )}
                      {!inactive && onTargets && (
                        <button className="icon-btn" title="Targets"
                          aria-label={`Targets for ${u.full_name}`}
                          onClick={() => onTargets(u)}>
                          <Icon.Target size={15} />
                        </button>
                      )}
                      {openable && (
                        <button className="icon-btn" title="View profile"
                          aria-label={`View ${u.full_name}`}
                          onClick={() => onView(u)}>
                          <Icon.ChevronRight size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
    </div>
  );
}
