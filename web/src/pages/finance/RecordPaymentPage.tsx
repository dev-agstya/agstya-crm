import { useNavigate, useSearchParams } from "react-router-dom";
import { RecordPaymentForm } from "../../components/RecordPaymentForm";
import type { PaymentParty } from "../../components/RecordPaymentForm";

/**
 * Record any money movement (/finance/transactions/new).
 *
 * The Balance Sheet and a party's finance page link here with the counterparty
 * already in the query string, so someone looking at one party's balance is not
 * made to search for them again.
 */
export default function RecordPaymentPage() {
  const navigate = useNavigate();
  const [sp] = useSearchParams();

  const kind = sp.get("party_kind");
  const id = sp.get("party_id");
  const label = sp.get("party_label");
  const initialParty: PaymentParty | null = kind && id
    ? { kind: kind as PaymentParty["kind"], id, label: label ?? "" }
    : null;

  return (
    <RecordPaymentForm
      initialParty={initialParty}
      onDone={() => navigate("/finance/transactions")}
    />
  );
}
