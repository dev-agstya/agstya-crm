import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, Search } from "lucide-react";
import { rolesApi } from "../api/endpoints";
import {
  PERMISSION_GROUPS,
  expandPermissions,
  revokePermission,
} from "../lib/types";
import type { OrgRole, PermissionGroup, PermissionSection } from "../lib/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoTooltip } from "./shared/InfoTooltip";

export function PermissionEditor({
  perms,
  onPermsChange,
  roles,
  canGrant,
}: {
  perms: string[];
  onPermsChange: (p: string[]) => void;
  roles: OrgRole[];
  canGrant: (perm: string) => boolean;
}) {
  const [filter, setFilter] = useState("");

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
          (s) =>
            s.name.toLowerCase().includes(needle) ||
            g.group.toLowerCase().includes(needle) ||
            s.help.toLowerCase().includes(needle)
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
      flags.forEach((f) => {
        next = revokePermission(next, f);
      });
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
      r.permissions.forEach((p) => {
        next = revokePermission(next, p);
      });
      onPermsChange(next);
    } else {
      const grantable = r.permissions.filter(canGrant);
      onPermsChange(expandPermissions([...set, ...grantable]).filter(canGrant));
    }
  };

  const granted = perms.length;

  return (
    <div className="space-y-4">
      {roles.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Start from a role
            </p>
            <InfoTooltip content="Clicking a role applies its permission set as a starting point. You can customize individual ticks below." />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {roles.map((r) => {
              const active = roleChecked(r);
              return (
                <Button
                  key={r.id}
                  type="button"
                  variant={active ? "default" : "outline"}
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  title={r.description ?? undefined}
                  onClick={() => toggleRole(r)}
                >
                  <span>{r.name}</span>
                  <Badge
                    variant={active ? "secondary" : "outline"}
                    className="h-4 px-1 text-[10px] font-normal"
                  >
                    {r.permissions.length}
                  </Badge>
                </Button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Permissions Matrix
          </p>
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
            {granted} granted
          </Badge>
          <InfoTooltip content="View opens the page; Manage grants create, edit, and delete inside it. Checking Manage automatically includes View." />
        </div>
        <div className="relative w-full sm:w-60">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a section…"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing matches &ldquo;{filter}&rdquo;.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {shown.map((g) => (
            <PermissionBlock
              key={g.group}
              group={g}
              held={set}
              canGrant={canGrant}
              state={groupState(g)}
              onToggleGroup={() => toggleGroup(g)}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PermissionBlock({
  group,
  held,
  canGrant,
  state,
  onToggleGroup,
  onToggle,
}: {
  group: PermissionGroup;
  held: Set<string>;
  canGrant: (p: string) => boolean;
  state: "none" | "some" | "all";
  onToggleGroup: () => void;
  onToggle: (key: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-sm font-semibold text-foreground">
            {group.group}
          </p>
          {group.hint && <InfoTooltip content={group.hint} />}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onToggleGroup}
          className="h-7 shrink-0 px-2.5 text-xs"
        >
          {state === "all" ? "Clear all" : "Select all"}
        </Button>
      </header>

      <div className="grid grid-cols-[1fr_56px_64px] items-center gap-x-2 border-b border-border/60 bg-muted/20 px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Section</span>
        <span className="text-center">View</span>
        <span className="text-center">Manage</span>
      </div>

      <div className="divide-y divide-border/50">
        {group.sections.map((s) => (
          <PermissionRow
            key={s.view}
            section={s}
            held={held}
            canGrant={canGrant}
            onToggle={onToggle}
          />
        ))}
      </div>
    </section>
  );
}

function PermissionRow({
  section,
  held,
  canGrant,
  onToggle,
}: {
  section: PermissionSection;
  held: Set<string>;
  canGrant: (p: string) => boolean;
  onToggle: (key: string) => void;
}) {
  const lockedByManage = !!section.manage && held.has(section.manage);

  return (
    <div className="grid grid-cols-[1fr_56px_64px] items-center gap-x-2 px-3.5 py-2 transition-colors hover:bg-muted/30">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm text-foreground">{section.name}</span>
        {section.help && <InfoTooltip content={section.help} />}
      </div>
      <Box
        flag={section.view}
        held={held}
        canGrant={canGrant}
        onToggle={onToggle}
        locked={lockedByManage}
        label={`View ${section.name}`}
      />
      {section.manage ? (
        <Box
          flag={section.manage}
          held={held}
          canGrant={canGrant}
          onToggle={onToggle}
          label={`Manage ${section.name}`}
        />
      ) : (
        <span className="text-center text-xs text-muted-foreground/50">—</span>
      )}
    </div>
  );
}

function Box({
  flag,
  held,
  canGrant,
  onToggle,
  locked,
  label,
}: {
  flag: string;
  held: Set<string>;
  canGrant: (p: string) => boolean;
  onToggle: (key: string) => void;
  locked?: boolean;
  label: string;
}) {
  const allowed = canGrant(flag);
  const checked = held.has(flag);
  return (
    <div
      className="flex items-center justify-center gap-1"
      title={locked ? "Included with Manage" : undefined}
    >
      <Checkbox
        checked={checked}
        disabled={!allowed}
        aria-label={label}
        onCheckedChange={() => onToggle(flag)}
      />
      {locked && checked && (
        <Lock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
}
