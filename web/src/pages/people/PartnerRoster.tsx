import { Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, RefreshCw, Target, UserPlus } from "lucide-react";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { TableSkeleton } from "../../components/shared/LoadingSkeleton";
import { GroupHeader, Meter } from "../../components/ui";
import { AttainmentPct, toneFor } from "../../components/TargetProgress";
import { formatDate, formatINR, initials } from "../../lib/format";
import type { ManagerRoster, PartnerRosterRow } from "../../lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Bucket = "attention" | "active" | "dormant";

function bucketOf(r: PartnerRosterRow): Bucket {
  if (!r.active_account) return "dormant";
  if (r.renewals_due > 0 || r.is_quiet) return "attention";
  if (r.has_target && r.attainment_pct < 50) return "attention";
  return "active";
}

const BUCKET_LABEL: Record<Bucket, string> = {
  attention: "Needs a call",
  active: "Active",
  dormant: "Inactive accounts",
};

const BAR_TONE: Record<ReturnType<typeof toneFor>, string> = {
  done: "bg-emerald-600",
  close: "bg-amber-500",
  behind: "bg-slate-400",
};

function TargetCell({
  r,
  onSetTarget,
}: {
  r: PartnerRosterRow;
  onSetTarget?: (row: PartnerRosterRow) => void;
}) {
  if (!r.has_target) {
    return (
      <div className="ml-auto w-32 text-right">
        <p className="text-xs text-muted-foreground">No target</p>
        {onSetTarget && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1 h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onSetTarget(r);
            }}
          >
            <Target className="mr-1 h-3 w-3" /> Set
          </Button>
        )}
      </div>
    );
  }
  const tone = toneFor(r.attainment_pct);
  return (
    <div className="ml-auto w-32 text-right">
      <AttainmentPct pct={r.attainment_pct} />
      <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <span
          className={`block h-full rounded-full ${BAR_TONE[tone]} transition-[width] duration-700`}
          style={{
            width: `${Math.min(100, Math.max(2, r.attainment_pct))}%`,
          }}
        />
      </span>
      <p
        className="mt-1 truncate text-[11px] text-muted-foreground"
        title={r.target_metrics
          .map(
            (m) =>
              `${m.label}: ${
                m.is_money ? formatINR(m.target_value) : m.target_value
              }`
          )
          .join(" · ")}
      >
        {r.target_metrics
          .slice(0, 2)
          .map((m) =>
            m.is_money
              ? formatINR(m.target_value)
              : `${m.target_value} ${m.label.toLowerCase()}`
          )
          .join(" · ")}
      </p>
      {onSetTarget && (
        <button
          type="button"
          className="mt-0.5 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onSetTarget(r);
          }}
        >
          Change
        </button>
      )}
    </div>
  );
}

export function PartnerRoster({
  data,
  loading,
  error = false,
  onRetry,
  onSetTarget,
}: {
  data?: ManagerRoster;
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
  onSetTarget?: (row: PartnerRosterRow) => void;
}) {
  const navigate = useNavigate();
  const rows = data?.rows ?? [];

  if (error) {
    return (
      <Card>
        <ErrorState onRetry={onRetry} />
      </Card>
    );
  }
  if (loading) {
    return (
      <Card className="overflow-hidden">
        <TableSkeleton cols={6} />
      </Card>
    );
  }

  if (!rows.length) {
    return (
      <Card>
        <EmptyState
          icon={<UserPlus className="h-5 w-5" />}
          title="No channel partners yet"
          description={
            data?.can_manage
              ? "Partners are assigned a relationship manager when their account is created. Add one from the Channel Partners page."
              : "Nobody has been assigned to this relationship manager."
          }
        />
      </Card>
    );
  }

  const peak = Math.max(...rows.map((r) => r.premium), 1);

  const groups = (["attention", "active", "dormant"] as Bucket[])
    .map((b) => ({ bucket: b, items: rows.filter((r) => bucketOf(r) === b) }))
    .filter((g) => g.items.length > 0);

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="h-9 text-xs">Channel partner</TableHead>
              <TableHead className="h-9 text-right text-xs">Target</TableHead>
              <TableHead className="h-9 text-right text-xs">
                Their book
              </TableHead>
              <TableHead className="h-9 text-right text-xs">Balance</TableHead>
              <TableHead className="h-9 text-xs">Attention</TableHead>
              <TableHead className="h-9 w-24 text-right text-xs" />
            </TableRow>
          </TableHeader>
          {groups.map((g) => (
            <Fragment key={g.bucket}>
              <TableBody>
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="border-b-0 p-0">
                    <GroupHeader
                      label={BUCKET_LABEL[g.bucket]}
                      count={g.items.length}
                      tone={
                        g.bucket === "attention"
                          ? "due"
                          : g.bucket === "dormant"
                            ? "muted"
                            : undefined
                      }
                    />
                  </TableCell>
                </TableRow>
              </TableBody>
              <TableBody>
                {g.items.map((r) => (
                  <TableRow
                    key={r.partner_id}
                    className="cursor-pointer"
                    title={`Open ${r.partner_name}`}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        navigate(`/people/partners/${r.partner_id}`);
                    }}
                    onClick={() =>
                      navigate(`/people/partners/${r.partner_id}`)
                    }
                  >
                    <TableCell className="py-2">
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-7 w-7 shrink-0">
                          <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                            {initials(r.partner_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium text-foreground">
                              {r.partner_name}
                            </span>
                            {r.is_quiet && (
                              <Badge
                                variant="outline"
                                className="h-4 border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800"
                              >
                                quiet
                              </Badge>
                            )}
                            {!r.active_account && (
                              <Badge
                                variant="secondary"
                                className="h-4 px-1.5 text-[10px]"
                              >
                                inactive
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {r.partner_code}
                            {r.mobile ? ` · ${r.mobile}` : ""}
                          </p>
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className="py-2 text-right">
                      <TargetCell r={r} onSetTarget={onSetTarget} />
                    </TableCell>

                    <TableCell className="py-2 text-right">
                      <div className="ml-auto w-32">
                        <p className="text-[13px] font-semibold tabular-nums text-foreground">
                          {formatINR(r.premium)}
                        </p>
                        <Meter
                          value={r.premium}
                          total={peak}
                          className="mt-1"
                          title="Premium relative to the largest book on this roster"
                        />
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {r.policies}{" "}
                          {r.policies === 1 ? "policy" : "policies"} ·{" "}
                          {formatINR(r.their_reward)} earned
                        </p>
                      </div>
                    </TableCell>

                    <TableCell className="py-2 text-right">
                      {r.net_balance === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          settled
                        </span>
                      ) : (
                        <>
                          <span
                            className={`text-[13px] font-semibold tabular-nums ${
                              r.net_balance > 0
                                ? "text-destructive"
                                : "text-emerald-700"
                            }`}
                          >
                            {formatINR(Math.abs(r.net_balance))}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {r.net_balance > 0 ? "to pay" : "to collect"}
                          </span>
                        </>
                      )}
                    </TableCell>

                    <TableCell className="py-2">
                      <div className="flex flex-col gap-1">
                        {r.renewals_due > 0 && (
                          <Badge
                            variant="outline"
                            className="h-5 w-fit border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800"
                          >
                            <RefreshCw className="mr-1 h-2.5 w-2.5" />
                            {r.renewals_due} renewal
                            {r.renewals_due === 1 ? "" : "s"} due
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {r.last_policy_at
                            ? `Last policy ${formatDate(r.last_policy_at)}`
                            : "No policy yet"}
                          {r.days_quiet != null &&
                            r.days_quiet > 0 &&
                            ` · ${r.days_quiet}d ago`}
                        </span>
                      </div>
                    </TableCell>

                    <TableCell className="py-2 text-right">
                      <div
                        className="flex items-center justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {data?.can_manage && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            title={`Book a policy for ${r.partner_name}`}
                            onClick={() =>
                              navigate(
                                `/policies/new?partner=${r.partner_id}`
                              )
                            }
                          >
                            <Plus className="mr-1 h-3 w-3" /> Policy
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Fragment>
          ))}
        </Table>
      </div>
    </Card>
  );
}
