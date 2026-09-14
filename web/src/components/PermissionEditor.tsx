import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { rolesApi } from "../api/endpoints";
import {
  PERMISSION_GROUPS,
  expandPermissions,
  revokePermission,
} from "../lib/types";
import type { OrgRole, PermissionGroup, PermissionSection } from "../lib/types";
import { Icon } from "../components/Icon";
import { SearchInput } from "./ui";

// Assemble someone's permission set.
//
// ONE ROW PER SECTION, two columns: View opens the page, Manage adds create +
// edit + delete inside it. Ticking Manage ticks View for you and unticking View
// unticks the Manage that depended on it — the server applies the same rule, so
// what you see saved is what you ticked.
//
// The matrix is the point. The 2026-08-07 split took the catalogue from 20 flags
// to 42 so that "give this person renewals and nothing else" is expressible at
// all, and 42 checkboxes stacked in a column is the screen the owner rejected in
// the first place. Laid out as a grid it is the same number of decisions in five
// scannable blocks, with the sidebar's own vocabulary as the row labels.
//
// Roles are a bulk-apply helper: ticking a role ticks its permissions, which you
// can then adjust. Roles are not stored on the employee.
export function PermissionEditor({
  perms,
  onPermsChange,
  roles,
  canGrant,
}: {
  perms: string[];
  onPermsChange: (p: string[]) => void;
  roles: OrgRole[];
  canGrant: (perm: string) => boolean; // gate: only perms the actor holds
}) {
  const [filter, setFilter] = useState("");

  // Prefer the server's copy of the catalogue (it carries the help text and is
  // the source of truth); fall back to the bundled one so the screen still
  // works offline or if the call fails.
  const catalog = useQuery({
    queryKey: ["permission-catalog"],
    queryFn: async () => (await rolesApi.catalog()).data,
    staleTime: 60 * 60 * 1000,
  });
  const groups: PermissionGroup[] = catalog.data?.groups ?? PERMISSION_GROUPS;

  const set = new Set(perms);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({
        ...g,
        sections: g.sections.filter(
          (s) => s.name.toLowerCase().includes(needle)
            || g.group.toLowerCase().includes(needle)
            || s.help.toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.sections.length > 0);
  }, [groups, filter]);

  const toggle = (key: string) => {
    if (!canGrant(key)) return;
    if (set.has(key)) {
      onPermsChange(revokePermission([...set], key));
    } else {
      onPermsChange(expandPermissions([...set, key]).filter(canGrant));
    }
  };

  // Every flag in a group, so the group header can grant or clear the block.
  const flagsIn = (g: PermissionGroup) =>
    g.sections.flatMap((s) => [s.view, s.manage].filter(Boolean) as string[]);

  const groupState = (g: PermissionGroup) => {
    const flags = flagsIn(g).filter(canGrant);
    if (flags.length === 0) return "none" as const;
    const on = flags.filter((f) => set.has(f)).length;
    if (on === 0) return "none" as const;
    return on === flags.length ? ("all" as const) : ("some" as const);
  };

  const toggleGroup = (g: PermissionGroup) => {
    const flags = flagsIn(g).filter(canGrant);
    if (groupState(g) === "all") {
      let next = [...set];
      flags.forEach((f) => { next = revokePermission(next, f); });
      onPermsChange(next);
    } else {
      onPermsChange(expandPermissions([...set, ...flags]).filter(canGrant));
    }
  };

  const roleChecked = (r: OrgRole) =>
    r.permissions.length > 0 && r.permissions.every((p) => set.has(p));

  const toggleRole = (r: OrgRole) => {
    if (roleChecked(r)) {
      let next = [...set];
      r.permissions.forEach((p) => { next = revokePermission(next, p); });
      onPermsChange(next);
    } else {
      const grantable = r.permissions.filter(canGrant);
      onPermsChange(expandPermissions([...set, ...grantable]).filter(canGrant));
    }
  };

  const granted = perms.length;

  return (
    <div className="space-y-4">
      {/* Roles (quick-add) */}
      {roles.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase text-slate-500">
            Start from a role
          </p>
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => (
              <label key={r.id} title={r.description ?? undefined}
                className={`flex cursor-pointer items-center gap-2
                  rounded-control border px-3 py-1.5 text-sm
                  transition-colors ${
                    roleChecked(r)
                      ? "border-ink bg-ink text-white"
                      : "border-line text-slate-600 hover:bg-slate-50"}`}>
                <input type="checkbox" className="sr-only"
                  checked={roleChecked(r)} onChange={() => toggleRole(r)} />
                {r.name}
                <span className={roleChecked(r)
                  ? "text-[11px] text-white/70" : "text-[11px] text-slate-400"}>
                  {r.permissions.length}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase text-slate-500">
          Permissions
          <span className="ml-2 font-normal normal-case text-slate-400">
            {granted} granted
          </span>
        </p>
        <SearchInput value={filter} onChange={setFilter}
          placeholder="Find a section…" className="w-56" />
      </div>

      {shown.length === 0 ? (
        <p className="rounded-card border border-line px-4 py-6 text-center
          text-sm text-slate-500">
          Nothing matches “{filter}”.
        </p>
      ) : (
        <div className="space-y-3">
          {shown.map((g) => (
            <PermissionBlock
              key={g.group} group={g} held={set} canGrant={canGrant}
              state={groupState(g)} onToggleGroup={() => toggleGroup(g)}
              onToggle={toggle} />
          ))}
        </div>
      )}
    </div>
  );
}

function PermissionBlock({
  group, held, canGrant, state, onToggleGroup, onToggle,
}: {
  group: PermissionGroup;
  held: Set<string>;
  canGrant: (p: string) => boolean;
  state: "none" | "some" | "all";
  onToggleGroup: () => void;
  onToggle: (key: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-line">
      <header className="flex items-start justify-between gap-4 border-b
        border-line bg-slate-50 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800">{group.group}</p>
          <p className="mt-0.5 text-xs leading-snug text-slate-500">
            {group.hint}
          </p>
        </div>
        <button type="button" onClick={onToggleGroup}
          className="shrink-0 whitespace-nowrap rounded-control border
            border-line bg-white px-2.5 py-1 text-xs font-medium text-slate-600
            transition-colors hover:bg-slate-100">
          {state === "all" ? "Clear all" : "Select all"}
        </button>
      </header>

      {/* The two-column header appears once per block, so a row does not have to
          repeat the words "View" and "Manage" 42 times. */}
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4
        border-b border-line/70 px-4 py-1.5 text-[11px] font-medium uppercase
        tracking-wide text-slate-500">
        <span>Section</span>
        <span className="w-14 text-center">View</span>
        <span className="w-16 text-center">Manage</span>
      </div>

      <div className="divide-y divide-line/60">
        {group.sections.map((s) => (
          <PermissionRow key={s.view} section={s} held={held}
            canGrant={canGrant} onToggle={onToggle} />
        ))}
      </div>
    </section>
  );
}

function PermissionRow({ section, held, canGrant, onToggle }: {
  section: PermissionSection;
  held: Set<string>;
  canGrant: (p: string) => boolean;
  onToggle: (key: string) => void;
}) {
  // A view flag that a ticked manage flag depends on is shown checked and
  // locked, so it is obvious WHY it is on rather than looking like a box that
  // will not untick.
  const lockedByManage = !!section.manage && held.has(section.manage);

  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 px-4
      py-2.5 transition-colors hover:bg-slate-50/70">
      <div className="min-w-0">
        <p className="text-sm text-slate-700">{section.name}</p>
        <p className="mt-0.5 text-xs leading-snug text-slate-500">
          {section.help}
        </p>
      </div>
      <Box flag={section.view} held={held} canGrant={canGrant}
        onToggle={onToggle} width="w-14" locked={lockedByManage}
        label={`View ${section.name}`} />
      {section.manage ? (
        <Box flag={section.manage} held={held} canGrant={canGrant}
          onToggle={onToggle} width="w-16"
          label={`Manage ${section.name}`} />
      ) : (
        // Not every flag is a page. Rendering an em-dash rather than a third
        // disabled checkbox keeps the column reading as "there is nothing to
        // manage here" instead of "you are not allowed to".
        <span className="w-16 text-center text-slate-300">—</span>
      )}
    </div>
  );
}

function Box({ flag, held, canGrant, onToggle, width, locked, label }: {
  flag: string;
  held: Set<string>;
  canGrant: (p: string) => boolean;
  onToggle: (key: string) => void;
  width: string;
  locked?: boolean;
  label: string;
}) {
  const allowed = canGrant(flag);
  const checked = held.has(flag);
  return (
    <label className={`flex ${width} items-center justify-center
      ${allowed ? "cursor-pointer" : "cursor-not-allowed"}`}
      title={locked ? "Included with Manage" : undefined}>
      <input type="checkbox" checked={checked} disabled={!allowed}
        aria-label={label} onChange={() => onToggle(flag)} />
      {locked && checked && (
        <Icon.Lock size={11} className="ml-1 text-slate-400" />
      )}
    </label>
  );
}
