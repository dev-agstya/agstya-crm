import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import {
  Archive,
  ChevronRight,
  Edit,
  FileText,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { customersApi, documentsApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { CustomerDocuments } from "./CustomerDocuments";
import { ErrorState } from "../../components/shared/ErrorState";
import { EmptyState } from "../../components/shared/EmptyState";
import { FormSkeleton } from "../../components/shared/LoadingSkeleton";
import { toast } from "../../components/Toast";
import { confirmDialog } from "../../components/Confirm";
import { formatINR, maskTail, pctText, titleCase } from "../../lib/format";
import { refreshFinance } from "../../lib/live";
import { askDelete } from "../../lib/deleteGuard";
import { useAuth } from "../../store/auth";
import type { Policy } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function CustomerDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { has } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "details";

  const customer = useQuery({
    queryKey: ["customer", id],
    retry: false,
    queryFn: async () => (await customersApi.get(id)).data,
  });
  const c = customer.data;

  const policies = useQuery({
    queryKey: ["customer-policies", id],
    enabled: !!c,
    queryFn: async () => (await customersApi.policies(id)).data,
  });
  const stats = useQuery({
    queryKey: ["customer-stats", id],
    enabled: !!c,
    queryFn: async () => (await customersApi.stats(id)).data,
  });
  const docs = useQuery({
    queryKey: ["customer-docs", id],
    enabled: !!c,
    queryFn: async () => (await documentsApi.listFor("customer", id)).data,
  });

  const afterChange = () => {
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["customer", id] });
    refreshFinance(qc);
  };

  const archive = useMutation({
    mutationFn: (v: boolean) => customersApi.setArchive(id, v),
    onSuccess: (_r, v) => {
      toast.success(v ? "Customer archived." : "Customer unarchived.");
      afterChange();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: () => customersApi.remove(id),
    onSuccess: () => {
      toast.success("Customer deleted.");
      qc.invalidateQueries({ queryKey: ["customers"] });
      refreshFinance(qc);
      navigate("/customers");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canEdit = !!c?.can_edit && has("manage_customers");
  const missing =
    isAxiosError(customer.error) && customer.error.response?.status === 404;

  const sortedPolicies = [...(policies.data ?? [])].sort((a, b) => {
    const rank = (p: Policy) =>
      p.status === "active" ? 0 : p.status === "renewal_due" ? 1 : 2;
    return rank(a) - rank(b);
  });

  return (
    <div className="space-y-6">
      <PageHeader
        backTo="/customers"
        backLabel="Back to customers"
        title={c?.name ?? "Customer"}
        subtitle={c ? [c.code, `Added by ${c.created_by_name || "—"}`].filter(Boolean).join(" · ") : undefined}
        actions={
          canEdit &&
          c && (
            <>
              <Button
                variant="outline"
                onClick={() => navigate(`/customers/${id}/edit`)}
              >
                <Edit className="mr-1.5 h-4 w-4" />
                Edit
              </Button>
              <Button
                variant="outline"
                disabled={archive.isPending}
                onClick={async () => {
                  const next = !c.is_archived;
                  if (
                    next &&
                    !(await confirmDialog({
                      title: "Archive customer?",
                      message: `Archive "${c.name}"? They'll be hidden from lists, but all policies and payment history are kept.`,
                      confirmLabel: "Archive",
                      danger: true,
                    }))
                  )
                    return;
                  archive.mutate(next);
                }}
              >
                <Archive className="mr-1.5 h-4 w-4" />
                {c.is_archived ? "Unarchive" : "Archive"}
              </Button>
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={async () => {
                  const choice = await askDelete({
                    noun: "customer",
                    name: c.name,
                    inUse: c.in_use !== false,
                    fallbackLabel: "Archive",
                    fallbackHint:
                      "they're hidden from lists while every policy, payment and statement stays intact.",
                  });
                  if (choice === "delete") remove.mutate();
                  if (choice === "fallback" && !c.is_archived)
                    archive.mutate(true);
                }}
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                Delete
              </Button>
            </>
          )
        }
      />

      {customer.isLoading ? (
        <FormSkeleton sections={1} />
      ) : missing ? (
        <ErrorState
          title="Customer not found"
          message="This customer record does not exist."
        />
      ) : customer.isError ? (
        <ErrorState onRetry={() => customer.refetch()} />
      ) : c ? (
        <div className="space-y-4">
          {c.is_archived && (
            <Badge variant="secondary" className="bg-amber-100 text-amber-800">
              Archived Customer
            </Badge>
          )}

          <Tabs
            value={tab}
            onValueChange={(v) =>
              setSp(v === "details" ? {} : { tab: v }, { replace: true })
            }
          >
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="analytics">Summary</TabsTrigger>
              <TabsTrigger value="policies">
                Policies ({sortedPolicies.length})
              </TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="mt-4">
              <Card>
                <CardContent className="grid gap-6 p-6 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Mobile number
                    </p>
                    <p className="mt-1 text-sm font-medium tabular-nums">
                      {c.mobile || "Not provided"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Email address
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {c.email || "Not provided"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Added by
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {c.created_by_name || "—"}
                    </p>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Notes
                    </p>
                    <p className="mt-1 text-sm text-foreground">
                      {c.notes || "No notes added."}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="analytics" className="mt-4">
              <Card>
                <CardContent className="divide-y divide-border p-0">
                  <div className="flex items-center justify-between px-6 py-4">
                    <span className="text-sm text-muted-foreground">
                      Policies
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {stats.data?.active_policies ?? 0} active /{" "}
                      {stats.data?.total_policies ?? 0} total
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-6 py-4">
                    <span className="text-sm text-muted-foreground">Source</span>
                    <span className="text-sm font-semibold">
                      {stats.data?.source ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-6 py-4">
                    <span className="text-sm text-muted-foreground">
                      Renewal rate
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {pctText(stats.data?.renewal_rate)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-6 py-4">
                    <span className="text-sm text-muted-foreground">
                      Total premium
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatINR(stats.data?.total_premium)}
                    </span>
                  </div>
                  {stats.data?.can_view_profit && (
                    <div className="flex items-center justify-between px-6 py-4">
                      <span className="text-sm text-muted-foreground">
                        Profit contribution
                      </span>
                      <span className="text-sm font-bold tabular-nums text-emerald-600">
                        {formatINR(stats.data?.profit_contribution)}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="policies" className="mt-4">
              {policies.isError ? (
                <ErrorState onRetry={() => policies.refetch()} />
              ) : sortedPolicies.length === 0 ? (
                <EmptyState
                  icon={<ShieldCheck className="h-6 w-6" />}
                  title="No policies yet"
                  description="This customer does not have any booked policies yet."
                />
              ) : (
                <div className="space-y-2.5">
                  {sortedPolicies.map((p) => (
                    <Card
                      key={p.id}
                      onClick={() => navigate(`/policies/${p.id}`)}
                      className="cursor-pointer transition-colors hover:border-primary/40 hover:bg-muted/30"
                    >
                      <CardContent className="flex items-center gap-4 p-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <FileText className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-sm font-semibold text-foreground">
                            {maskTail(p.policy_number || p.code)}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {p.insurer_name || "—"} ·{" "}
                            <span className="capitalize">{p.category_key}</span>
                          </p>
                        </div>
                        <Badge
                          variant={
                            p.status === "active"
                              ? "default"
                              : p.status === "renewal_due"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {titleCase(p.status.replace(/_/g, " "))}
                        </Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="documents" className="mt-4">
              <Card>
                <CardContent className="p-6">
                  <CustomerDocuments
                    customerId={id}
                    docs={docs.data ?? []}
                    canEdit={canEdit}
                    loading={docs.isLoading}
                    onChanged={() =>
                      qc.invalidateQueries({ queryKey: ["customer-docs", id] })
                    }
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      ) : null}
    </div>
  );
}
