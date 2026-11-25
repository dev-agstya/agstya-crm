import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Bell, Plus } from "lucide-react";
import { announcementsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/shared/EmptyState";
import { ErrorState } from "../../components/shared/ErrorState";
import { TableSkeleton } from "../../components/shared/LoadingSkeleton";
import { Meter } from "../../components/ui";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatDate, initials } from "../../lib/format";
import { useAuth } from "../../store/auth";
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

export const CATEGORIES = [
  { value: "offer", label: "Offer" },
  { value: "rate_change", label: "Rate change" },
  { value: "notice", label: "Notice" },
  { value: "training", label: "Training" },
];

export const AUDIENCES = [
  { value: "all", label: "Every channel partner" },
  { value: "manager", label: "Everyone under one relationship manager" },
  { value: "new_partners", label: "Partners who joined recently" },
  { value: "selected", label: "Specific partners" },
];

export default function NoticesPage() {
  const { has } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canSend = has("manage_announcements");

  const list = useQuery({
    queryKey: ["announcements"],
    queryFn: async () => (await announcementsApi.list({ page_size: 50 })).data,
  });
  const rows = list.data?.items ?? [];

  const withdraw = useMutation({
    mutationFn: (id: string) => announcementsApi.withdraw(id),
    onSuccess: (r) => {
      toast.success(r.data.detail);
      qc.invalidateQueries({ queryKey: ["announcements"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const compose = (
    <Button
      size="sm"
      className="h-8"
      onClick={() => navigate("/people/notices/new")}
    >
      <Plus className="mr-1.5 h-3.5 w-3.5" /> New notice
    </Button>
  );

  return (
    <div className="space-y-3">
      <PageHeader
        title="Notices to Channel Partners"
        subtitle="Offers, rate changes, and partner broadcasts."
        info="Once sent, a notice cannot be recalled. Withdrawing hides it from the portal."
        actions={canSend ? compose : undefined}
      />

      <Card className="overflow-hidden">
        {list.isError ? (
          <ErrorState onRetry={() => list.refetch()} />
        ) : list.isLoading ? (
          <TableSkeleton cols={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Bell className="h-5 w-5" />}
            title="Nothing sent yet"
            description="Tell your channel partners about a new offer, a rate change or anything else they should know."
            action={canSend ? compose : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="h-9 text-xs">Notice</TableHead>
                  <TableHead className="h-9 text-xs">Audience</TableHead>
                  <TableHead className="h-9 text-xs">Sent</TableHead>
                  <TableHead className="h-9 w-40 text-xs">Read</TableHead>
                  <TableHead className="h-9 w-24 text-right text-xs" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const category =
                    CATEGORIES.find((c) => c.value === a.category)?.label ??
                    a.category;
                  return (
                    <TableRow
                      key={a.id}
                      className={a.withdrawn_at ? "opacity-55" : ""}
                    >
                      <TableCell className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium text-foreground">
                            {a.title}
                          </span>
                          {a.withdrawn_at && (
                            <Badge
                              variant="secondary"
                              className="h-4 px-1.5 text-[10px]"
                            >
                              withdrawn
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className="h-4 px-1.5 text-[10px]"
                          >
                            {category}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">
                            Portal{a.send_email ? " · email" : ""}
                            {a.send_whatsapp ? " · WhatsApp" : ""}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className="py-2">
                        <p className="text-[13px] text-foreground">
                          {AUDIENCES.find((x) => x.value === a.audience)
                            ?.label ?? a.audience}
                        </p>
                        {a.manager_name && (
                          <p className="text-xs text-muted-foreground">
                            {a.manager_name}
                          </p>
                        )}
                      </TableCell>

                      <TableCell className="whitespace-nowrap py-2">
                        <p className="text-[13px] text-foreground">
                          {formatDate(a.created_at)}
                        </p>
                        {a.created_by_name && (
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <Avatar className="h-4 w-4">
                              <AvatarFallback className="bg-primary/10 text-[8px] font-semibold text-primary">
                                {initials(a.created_by_name)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="text-xs text-muted-foreground">
                              {a.created_by_name}
                            </span>
                          </div>
                        )}
                      </TableCell>

                      <TableCell className="py-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-semibold tabular-nums text-foreground">
                            {a.read_count}
                          </span>
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            of {a.recipients}
                          </span>
                        </div>
                        <Meter
                          value={a.read_count}
                          total={a.recipients}
                          className="mt-1"
                        />
                      </TableCell>

                      <TableCell className="py-2 text-right">
                        {canSend && !a.withdrawn_at && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                            onClick={async () => {
                              if (
                                await confirmDialog({
                                  title: "Withdraw this notice?",
                                  message:
                                    "It disappears from the partner portal. Emails and WhatsApp messages already sent CANNOT be recalled.",
                                  confirmLabel: "Withdraw",
                                })
                              )
                                withdraw.mutate(a.id);
                            }}
                          >
                            Withdraw
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
