import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Download, FileText } from "lucide-react";
import { documentsApi, financeApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { toast } from "../../components/Toast";
import { formatDate, formatDateTime, formatINR } from "../../lib/format";
import { PARTY_LABEL, TypeTag, amountTone } from "./txnDisplay";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function TransactionDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();

  const detail = useQuery({
    queryKey: ["finance", "ledger-detail", id],
    retry: false,
    queryFn: async () => (await financeApi.ledgerDetail(id)).data,
  });
  const d = detail.data;

  const openAttachment = async (docId: string) => {
    try {
      const { url } = (await documentsApi.download(docId)).data;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  const missing =
    isAxiosError(detail.error) && detail.error.response?.status === 404;
  const tone = d
    ? amountTone(d.txn_type, d.amount_paise)
    : { cls: "", sign: "" };
  const policyLabel = d?.policy_number || d?.policy_code;

  return (
    <RecordPage
      backTo="/finance/transactions"
      backLabel="Back to transactions"
      title={d ? formatINR(Math.abs(d.amount_paise)) : "Transaction"}
      documentTitle="Transaction"
      subtitle={d ? formatDate(d.occurred_at) : undefined}
      badges={d && <TypeTag t={d.txn_type} party={d.party_type} />}
      loading={detail.isLoading}
      error={missing ? undefined : detail.error}
      onRetry={() => detail.refetch()}
      notFound={missing}
    >
      {d && (
        <div className="space-y-4">
          <Card className="flex items-center justify-between gap-3 px-4 py-3.5">
            <TypeTag t={d.txn_type} party={d.party_type} />
            <span className={`text-2xl font-bold tabular-nums ${tone.cls}`}>
              {tone.sign}
              {formatINR(Math.abs(d.amount_paise))}
            </span>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold text-foreground">Details</h2>
            </div>
            <div className="grid gap-x-6 gap-y-3 px-4 py-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Party
                </p>
                <p className="mt-0.5 text-[13px] text-foreground">
                  {d.party_name || "—"}{" "}
                  <span className="text-xs text-muted-foreground">
                    {PARTY_LABEL[d.party_type]}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Transaction date
                </p>
                <p className="mt-0.5 text-[13px] text-foreground">
                  {formatDate(d.occurred_at)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Recorded
                </p>
                <p className="mt-0.5 text-[13px] text-foreground">
                  {formatDateTime(d.created_at)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Recorded by
                </p>
                <p className="mt-0.5 text-[13px] text-foreground">
                  {d.created_by_name || "—"}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Reference
                </p>
                <p className="mt-0.5 text-[13px] text-foreground">
                  {d.reference || "—"}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Note
                </p>
                <p className="mt-0.5 text-[13px] text-foreground">
                  {d.note || "—"}
                </p>
              </div>
              {d.attachment_doc_id && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Attachment
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => openAttachment(d.attachment_doc_id!)}
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" /> View attachment
                  </Button>
                </div>
              )}
            </div>
          </Card>

          {d.policy_id && (
            <Card className="overflow-hidden">
              <div className="border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold text-foreground">
                  Linked policy
                </h2>
              </div>
              <div className="p-4">
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {d.txn_type === "premium_paid_by_agency"
                    ? "This premium was paid by the agency for policy "
                    : "This transaction is linked to policy "}
                  <strong className="text-foreground">
                    {policyLabel || "—"}
                  </strong>
                  {d.customer_name && (
                    <>
                      {" "}
                      — customer{" "}
                      <strong className="text-foreground">
                        {d.customer_name}
                      </strong>
                    </>
                  )}
                  {d.partner_name && (
                    <>
                      {" "}
                      · channel partner{" "}
                      <strong className="text-foreground">
                        {d.partner_name}
                      </strong>
                    </>
                  )}
                  {d.broker_name && (
                    <>
                      {" "}
                      · broker{" "}
                      <strong className="text-foreground">
                        {d.broker_name}
                      </strong>
                    </>
                  )}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3 h-8 text-xs"
                  onClick={() => navigate(`/policies/${d.policy_id}`)}
                >
                  <FileText className="mr-1.5 h-3.5 w-3.5" /> Open policy
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </RecordPage>
  );
}
