import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { documentsApi, financeApi } from "../../api/endpoints";
import { apiError } from "../../api/client";
import { RecordPage } from "../../components/RecordPage";
import { Icon } from "../../components/Icon";
import { DetailItem } from "../../components/ui";
import { toast } from "../../components/Toast";
import { formatDate, formatDateTime, formatINR } from "../../lib/format";
import { PARTY_LABEL, TypeTag, amountTone } from "./txnDisplay";

/**
 * One ledger row, as a page (this was a dialog until 2026-08-03).
 *
 * A transaction is the thing people argue about — "what was this ₹40,000?" —
 * so being able to send someone the URL rather than "open Transactions, filter
 * to August, scroll" is most of the point of the change.
 */
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

  const missing = isAxiosError(detail.error)
    && detail.error.response?.status === 404;
  const tone = d ? amountTone(d.txn_type, d.amount_paise)
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
        <div className="max-w-3xl space-y-4">
          <div className="card flex items-center justify-between gap-3 px-5
            py-4">
            <TypeTag t={d.txn_type} party={d.party_type} />
            <span className={`text-metric tabular-nums ${tone.cls}`}>
              {tone.sign}{formatINR(Math.abs(d.amount_paise))}
            </span>
          </div>

          <section className="card">
            <div className="card-head"><h2 className="card-title">Details</h2></div>
            <div className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">
              <DetailItem label="Party" value={
                <>
                  {d.party_name || "—"}
                  <span className="ml-1.5 text-xs text-slate-500">
                    {PARTY_LABEL[d.party_type]}</span>
                </>
              } />
              <DetailItem label="Transaction date"
                value={formatDate(d.occurred_at)} />
              <DetailItem label="Recorded"
                value={formatDateTime(d.created_at)} />
              <DetailItem label="Recorded by"
                value={d.created_by_name || "—"} />
              <DetailItem label="Reference" value={d.reference || "—"} />
              <DetailItem label="Note" value={d.note || "—"} />
              {d.attachment_doc_id && (
                <DetailItem className="sm:col-span-2" label="Attachment" value={
                  <button className="btn-secondary btn-sm"
                    onClick={() => openAttachment(d.attachment_doc_id!)}>
                    <Icon.Download size={14} /> View attachment
                  </button>
                } />
              )}
            </div>
          </section>

          {d.policy_id && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Linked policy</h2>
              </div>
              <div className="px-5 py-4">
                <p className="text-sm leading-relaxed text-slate-600">
                  {d.txn_type === "premium_paid_by_agency"
                    ? "This premium was paid by the agency for policy "
                    : "This transaction is linked to policy "}
                  <b className="text-slate-900">{policyLabel || "—"}</b>
                  {d.customer_name && (
                    <> — customer <b className="text-slate-900">
                      {d.customer_name}</b></>
                  )}
                  {d.partner_name && (
                    <> · channel partner <b className="text-slate-900">
                      {d.partner_name}</b></>
                  )}
                  {d.broker_name && (
                    <> · broker <b className="text-slate-900">
                      {d.broker_name}</b></>
                  )}
                </p>
                <button className="btn-secondary mt-3"
                  onClick={() => navigate(`/policies/${d.policy_id}`)}>
                  <Icon.Policy size={15} /> Open policy
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </RecordPage>
  );
}
